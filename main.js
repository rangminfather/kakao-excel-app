'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, safeStorage, nativeImage, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const Store = require('electron-store');
const ExcelJS = require('exceljs');
const { autoUpdater } = require('electron-updater');

const isDev = process.argv.includes('--dev');

// 업데이트 정책: 자동 다운로드 O, 자동 설치 X (사용자가 버튼 눌러야 설치)
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

const store = new Store({
  name: 'settings',
  defaults: {
    watchFolder: path.join(os.homedir(), 'Downloads'),
    filePattern: 'KakaoTalk',
    archiveMode: 'keep',
    archivePath: path.join(os.homedir(), 'KakaoArchive'),
    autoCleanupDays: 30,
    excelOutputPath: path.join(os.homedir(), 'Documents', '카톡행사보고_누적.xlsx'),
    autoLaunch: false,
    minimizeToTray: false,
    apiKeysEncrypted: null,
    activeKeyId: '',
    model: 'gemini-2.5-flash',
    processedHashes: [],
    lastProcessedDate: null,
    accumulatedRows: [],
    totalCount: 0,
    draftText: ''
  }
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

const EXCEL_HEADER = ['날짜','작성자','지점','시작시간','종료시간','품목','단가','수량','금액','합계','검증오류','원본'];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: '카톡보고정리',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    const img = fsSync.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    tray = new Tray(img);
    const contextMenu = Menu.buildFromTemplate([
      { label: '열기', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { type: 'separator' },
      { label: '종료', click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('카톡보고정리');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  } catch (e) {
    console.warn('Tray creation failed:', e.message);
  }
}

app.whenReady().then(() => {
  createWindow();
  if (store.get('minimizeToTray')) createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 시작 시 아카이브 자동 정리
  cleanupArchiveIfNeeded().catch(err => console.warn('Cleanup error:', err));

  // 앱 시작 후 3초 뒤 자동 업데이트 체크 (개발 모드 제외)
  if (!isDev) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        console.warn('Update check failed:', err.message);
      });
    }, 3000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !store.get('minimizeToTray')) app.quit();
});

app.on('before-quit', () => { isQuitting = true; });

/* ======================================================================
 * IPC: Store (일반 값)
 * ====================================================================== */
ipcMain.handle('store:get', (_e, key) => store.get(key));
ipcMain.handle('store:set', (_e, key, value) => { store.set(key, value); return true; });
ipcMain.handle('store:delete', (_e, key) => { store.delete(key); return true; });
ipcMain.handle('store:getAll', () => {
  const all = { ...store.store };
  delete all.apiKeysEncrypted;
  return all;
});

/* ======================================================================
 * IPC: API Keys (safeStorage 암호화)
 * ====================================================================== */
function readApiKeys() {
  const encrypted = store.get('apiKeysEncrypted');
  if (!encrypted) return [];
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(encrypted, 'base64');
      const decrypted = safeStorage.decryptString(buf);
      return JSON.parse(decrypted);
    }
    return JSON.parse(Buffer.from(encrypted, 'base64').toString('utf-8'));
  } catch (e) {
    console.warn('API keys decrypt failed:', e.message);
    return [];
  }
}

function writeApiKeys(keys) {
  const json = JSON.stringify(keys);
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(json);
    store.set('apiKeysEncrypted', encrypted.toString('base64'));
  } else {
    store.set('apiKeysEncrypted', Buffer.from(json, 'utf-8').toString('base64'));
  }
}

ipcMain.handle('apiKeys:list', () => readApiKeys());
ipcMain.handle('apiKeys:save', (_e, keys) => { writeApiKeys(keys); return true; });
ipcMain.handle('apiKeys:getActive', () => {
  const list = readApiKeys();
  const id = store.get('activeKeyId');
  const found = list.find(k => k.id === id);
  if (found) return found.key;
  if (list.length > 0) {
    store.set('activeKeyId', list[0].id);
    return list[0].key;
  }
  return '';
});

/* ======================================================================
 * IPC: File system — detect latest, read, archive
 * ====================================================================== */
ipcMain.handle('files:detectLatest', async (_e, folder, pattern) => {
  const dir = folder || store.get('watchFolder');
  const pat = (pattern || store.get('filePattern') || 'KakaoTalk').toLowerCase();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const name = ent.name;
      if (!name.toLowerCase().includes(pat)) continue;
      if (!name.toLowerCase().endsWith('.txt')) continue;
      const full = path.join(dir, name);
      const stat = await fs.stat(full);
      files.push({ path: full, name, mtime: stat.mtimeMs, size: stat.size });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files[0] || null;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('files:readText', async (_e, filePath) => {
  try {
    const buf = await fs.readFile(filePath);
    let text;
    if (buf[0] === 0xFF && buf[1] === 0xFE) {
      text = buf.slice(2).toString('utf16le');
    } else if (buf[0] === 0xFE && buf[1] === 0xFF) {
      text = buf.slice(2).swap16().toString('utf16le');
    } else if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      text = buf.slice(3).toString('utf8');
    } else {
      text = buf.toString('utf8');
    }
    const stat = await fs.stat(filePath);
    return { ok: true, text, size: stat.size, mtime: stat.mtimeMs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('files:selectTxt', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '카톡 대화 텍스트 파일 선택',
    filters: [{ name: 'Text Files', extensions: ['txt'] }, { name: 'All', extensions: ['*'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('files:selectFolder', async (_e, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title || '폴더 선택',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('files:selectSaveXlsx', async (_e, defaultPath) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '엑셀 저장 경로',
    defaultPath: defaultPath || path.join(os.homedir(), 'Documents', '카톡행사보고.xlsx'),
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('files:openPath', async (_e, p) => {
  const result = await shell.openPath(p);
  return result === '' ? { ok: true } : { ok: false, error: result };
});

ipcMain.handle('files:showInFolder', async (_e, p) => {
  shell.showItemInFolder(p);
  return true;
});

ipcMain.handle('files:archive', async (_e, sourcePath, mode) => {
  if (!sourcePath) return { ok: false, error: 'no path' };
  try {
    if (mode === 'keep') return { ok: true, action: 'kept' };
    if (mode === 'delete') {
      await fs.unlink(sourcePath);
      return { ok: true, action: 'deleted' };
    }
    if (mode === 'move' || mode === 'auto') {
      const archiveRoot = store.get('archivePath');
      const d = new Date();
      const ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const targetDir = path.join(archiveRoot, ym);
      await fs.mkdir(targetDir, { recursive: true });
      const base = path.basename(sourcePath);
      let target = path.join(targetDir, base);
      let i = 1;
      while (fsSync.existsSync(target)) {
        const ext = path.extname(base);
        const stem = path.basename(base, ext);
        target = path.join(targetDir, `${stem}_${i}${ext}`);
        i++;
      }
      await fs.rename(sourcePath, target).catch(async (err) => {
        if (err.code === 'EXDEV') {
          await fs.copyFile(sourcePath, target);
          await fs.unlink(sourcePath);
        } else throw err;
      });
      return { ok: true, action: 'moved', target };
    }
    return { ok: false, error: 'unknown mode' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

async function cleanupArchiveIfNeeded() {
  if (store.get('archiveMode') !== 'auto') return;
  const days = Number(store.get('autoCleanupDays') || 30);
  if (!days || days <= 0) return;
  const root = store.get('archivePath');
  if (!fsSync.existsSync(root)) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs < cutoff) await fs.unlink(full);
        } catch {}
      }
    }
  }
  try { await walk(root); } catch (e) { console.warn('cleanup walk:', e.message); }
}

/* ======================================================================
 * IPC: Excel (append 방식 누적 저장 + 단건 저장)
 * ====================================================================== */
function rowToArray(r) {
  return [
    r.date ?? '',
    r.writer ?? '',
    r.store ?? '',
    r.time_start ?? '',
    r.time_end ?? '',
    r.item ?? '',
    r.unit_price ?? '',
    r.qty ?? '',
    r.amount ?? '',
    r.total ?? '',
    r.flag ? 'X' : '',
    r.raw ?? ''
  ];
}

async function loadOrCreateWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  if (fsSync.existsSync(filePath)) {
    try {
      await wb.xlsx.readFile(filePath);
      let ws = wb.getWorksheet('카톡행사보고') || wb.worksheets[0];
      if (!ws) ws = wb.addWorksheet('카톡행사보고');
      if (ws.rowCount === 0) ws.addRow(EXCEL_HEADER);
      return { wb, ws };
    } catch (e) {
      // 파일 깨졌으면 백업 후 새로 생성
      const bak = filePath + '.broken-' + Date.now();
      try { await fs.rename(filePath, bak); } catch {}
    }
  }
  const ws = wb.addWorksheet('카톡행사보고');
  ws.addRow(EXCEL_HEADER);
  ws.columns = [
    { width: 12 }, { width: 10 }, { width: 18 }, { width: 8 }, { width: 8 },
    { width: 20 }, { width: 10 }, { width: 7 }, { width: 12 }, { width: 12 },
    { width: 9 }, { width: 40 }
  ];
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE500' } };
  return { wb, ws };
}

ipcMain.handle('excel:appendRows', async (_e, rows, targetPath) => {
  const filePath = targetPath || store.get('excelOutputPath');
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const { wb, ws } = await loadOrCreateWorkbook(filePath);
    for (const r of rows) {
      const row = ws.addRow(rowToArray(r));
      if (r.flag) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE2E2' } };
        });
      }
    }
    await wb.xlsx.writeFile(filePath);
    return { ok: true, path: filePath, appendedRows: rows.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('excel:saveAs', async (_e, rows, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '엑셀로 저장',
    defaultPath: suggestedName || `카톡행사보고_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('카톡행사보고');
    ws.addRow(EXCEL_HEADER);
    ws.columns = [
      { width: 12 }, { width: 10 }, { width: 18 }, { width: 8 }, { width: 8 },
      { width: 20 }, { width: 10 }, { width: 7 }, { width: 12 }, { width: 12 },
      { width: 9 }, { width: 40 }
    ];
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE500' } };
    for (const r of rows) {
      const row = ws.addRow(rowToArray(r));
      if (r.flag) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE2E2' } };
        });
      }
    }
    await wb.xlsx.writeFile(result.filePath);
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ======================================================================
 * IPC: 진행률 알림 & 토스트
 * ====================================================================== */
ipcMain.handle('notify:toast', (_e, title, body) => {
  try {
    if (Notification.isSupported()) {
      new Notification({ title: title || '카톡보고정리', body: body || '' }).show();
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
});

/* ======================================================================
 * IPC: 자동 시작
 * ====================================================================== */
ipcMain.handle('app:setAutoLaunch', (_e, enabled) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: []
    });
    store.set('autoLaunch', !!enabled);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('app:getAutoLaunch', () => {
  try {
    const s = app.getLoginItemSettings();
    return !!s.openAtLogin;
  } catch {
    return false;
  }
});

ipcMain.handle('app:setMinimizeToTray', (_e, enabled) => {
  store.set('minimizeToTray', !!enabled);
  if (enabled && !tray) createTray();
  if (!enabled && tray) { tray.destroy(); tray = null; }
  return true;
});

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });

ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));

/* ======================================================================
 * IPC: 자동 업데이트 (electron-updater)
 * ====================================================================== */
function sendUpdate(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

autoUpdater.on('checking-for-update', () => sendUpdate('update:checking'));
autoUpdater.on('update-available', (info) => sendUpdate('update:available', {
  version: info.version,
  releaseDate: info.releaseDate,
  releaseNotes: info.releaseNotes
}));
autoUpdater.on('update-not-available', (info) => sendUpdate('update:notAvailable', {
  version: info.version
}));
autoUpdater.on('error', (err) => sendUpdate('update:error', { message: String(err && err.message || err) }));
autoUpdater.on('download-progress', (p) => sendUpdate('update:progress', {
  percent: p.percent,
  transferred: p.transferred,
  total: p.total,
  bytesPerSecond: p.bytesPerSecond
}));
autoUpdater.on('update-downloaded', (info) => sendUpdate('update:downloaded', {
  version: info.version,
  releaseDate: info.releaseDate,
  releaseNotes: info.releaseNotes
}));

ipcMain.handle('update:check', async () => {
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r && r.updateInfo && r.updateInfo.version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('update:install', () => {
  // 지금 바로 종료 + 설치 + 재실행
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
});
ipcMain.handle('update:current', () => app.getVersion());

/* GitHub Releases API에서 릴리스 노트 목록 가져오기 (업데이트 내역 창용) */
ipcMain.handle('update:releases', async () => {
  return new Promise((resolve) => {
    const request = net.request({
      method: 'GET',
      url: 'https://api.github.com/repos/rangminfather/kakao-excel-app/releases?per_page=20',
      redirect: 'follow'
    });
    request.setHeader('User-Agent', 'kakao-excel-app');
    request.setHeader('Accept', 'application/vnd.github+json');
    let body = '';
    request.on('response', (res) => {
      res.on('data', (chunk) => { body += chunk.toString('utf8'); });
      res.on('end', () => {
        try {
          const arr = JSON.parse(body);
          if (!Array.isArray(arr)) {
            resolve({ ok: false, error: (arr && arr.message) || 'Unexpected response' });
            return;
          }
          resolve({
            ok: true,
            releases: arr.map(r => ({
              version: (r.tag_name || '').replace(/^v/, ''),
              name: r.name || r.tag_name,
              published: r.published_at,
              body: r.body || '',
              prerelease: !!r.prerelease,
              url: r.html_url
            }))
          });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });
    request.on('error', (err) => resolve({ ok: false, error: err.message }));
    request.end();
  });
});
