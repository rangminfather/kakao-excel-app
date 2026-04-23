'use strict';

/* =========================================================================
 * 0) 공통 유틸
 * ========================================================================= */
const kapi = window.kapi;

const MODEL_OPTIONS = [
  { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash (기본 권장)' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (가볍고 한도↑)' },
  { id: 'gemini-2.0-flash',      label: 'Gemini 2.0 Flash' },
  { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' },
];
const DEFAULT_MODEL = 'gemini-2.5-flash';

// 메모리 캐시 (IPC 비동기 부담 완화 — 기존 동기 lsGet/lsSet 패턴 유지용)
const cache = {
  model: DEFAULT_MODEL,
  processedHashes: [],
  lastProcessedDate: null,
  accumulatedRows: [],
  totalCount: 0,
  draftText: '',
  apiKeys: [],
  activeKeyId: '',
  activeKeyValue: '',
  watchFolder: '',
  filePattern: 'kakaotalk',
  archiveMode: 'keep',
  archivePath: '',
  autoCleanupDays: 30,
  excelOutputPath: '',
  autoLaunch: false,
  minimizeToTray: false,
};

async function loadAllSettings() {
  const all = await kapi.store.getAll();
  cache.model = all.model || DEFAULT_MODEL;
  cache.processedHashes = Array.isArray(all.processedHashes) ? all.processedHashes : [];
  cache.lastProcessedDate = all.lastProcessedDate || null;
  cache.accumulatedRows = Array.isArray(all.accumulatedRows) ? all.accumulatedRows : [];
  cache.totalCount = Number(all.totalCount || 0);
  cache.draftText = all.draftText || '';
  cache.watchFolder = all.watchFolder || '';
  cache.filePattern = all.filePattern || 'KakaoTalk';
  cache.archiveMode = all.archiveMode || 'keep';
  cache.archivePath = all.archivePath || '';
  cache.autoCleanupDays = Number(all.autoCleanupDays || 30);
  cache.excelOutputPath = all.excelOutputPath || '';
  cache.minimizeToTray = !!all.minimizeToTray;
  cache.autoLaunch = await kapi.app.getAutoLaunch();
  cache.apiKeys = await kapi.apiKeys.list();
  cache.activeKeyId = all.activeKeyId || (cache.apiKeys[0] && cache.apiKeys[0].id) || '';
  cache.activeKeyValue = await kapi.apiKeys.getActive();
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 10) return k;
  return k.slice(0, 6) + '...' + k.slice(-4);
}

function newKeyId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function toast(msg, kind = 'info', ms = 2400) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toastRoot').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
}

function formatRelativeTime(ms) {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

/** UTF-8 안전 해시 (dedup용) */
function messageHash(msg) {
  const str = `${msg.date}|${msg.time||''}|${msg.writer}|${msg.body}`;
  let h1 = 0x811c9dc5, h2 = 5381;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return ((h1 >>> 0).toString(36)) + '-' + ((h2 >>> 0).toString(36));
}

/* =========================================================================
 * 1) 탭 전환
 * ========================================================================= */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const siblings = btn.parentElement.querySelectorAll('.tab-btn');
    siblings.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    document.querySelectorAll('[data-tab-content]').forEach(s => {
      s.classList.toggle('hidden', s.dataset.tabContent !== target);
    });
  });
});

/* 처리 범위 라디오 */
document.querySelectorAll('input[name=rangeMode]').forEach(r => {
  r.addEventListener('change', () => {
    document.getElementById('customRange').classList.toggle('hidden',
      !(r.value === 'custom' && r.checked));
    document.getElementById('pickDateRow').classList.toggle('hidden',
      !(r.value === 'pickDate' && r.checked));
  });
});

/* 파일 소스 라디오 */
document.querySelectorAll('input[name=fileSource]').forEach(r => {
  r.addEventListener('change', () => {
    if (r.value === 'manual' && r.checked) pickManualFile();
    if (r.value === 'auto' && r.checked) detectLatestFile();
  });
});

/* =========================================================================
 * 2) 카톡 .txt 파서
 * ========================================================================= */
const KAKAO_HEADER_RE = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2}),\s*([^:]+?)\s*:\s*(.*)$/;

function parseKakaoTxt(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw;
    const m = line.match(KAKAO_HEADER_RE);
    if (m) {
      if (cur) messages.push(cur);
      let hh = parseInt(m[5], 10);
      if (m[4] === '오후' && hh !== 12) hh += 12;
      if (m[4] === '오전' && hh === 12) hh = 0;
      const date = `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
      const time = `${String(hh).padStart(2,'0')}:${m[6]}`;
      const firstBody = m[8] || '';
      cur = {
        date, time,
        writer: m[7].trim(),
        bodyLines: firstBody ? [firstBody] : []
      };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  if (cur) messages.push(cur);
  return messages.map(msg => {
    const body = msg.bodyLines.join('\n').replace(/\s+$/,'').trim();
    return {
      date: msg.date,
      time: msg.time,
      writer: msg.writer,
      body,
      raw: `[${msg.date} ${msg.time}] ${msg.writer}: ${body}`
    };
  }).filter(m => m.body.length > 0);
}

function looksLikeReport(body) {
  if (!body) return false;
  if (body.length < 10) return false;
  if (/^.+님이 들어왔습니다\.?$/.test(body)) return false;
  if (/^.+님이 나갔습니다\.?$/.test(body)) return false;
  if (/^사진$/.test(body.trim())) return false;
  if (/^이모티콘$/.test(body.trim())) return false;
  if (/[xX×*]/.test(body) && /\d/.test(body)) return true;
  if (/=\s*[\d,]+/.test(body)) return true;
  if (/총[\s\-:]*[\d,]+/.test(body)) return true;
  if (/행사|시간|마트|지점|점$/.test(body)) return true;
  return false;
}

/* =========================================================================
 * 3) Gemini 프롬프트 & 호출
 * ========================================================================= */
const SYSTEM_PROMPT = `당신은 한국 마트 행사 보고 정형화 엔진이다.

[규칙]
1. 아래 스키마 외 필드는 절대 생성하지 않는다.
2. 원문에 명시되지 않은 값은 null로 둔다. 추론 금지.
3. 품목은 행 단위로 분리한다 (1 메시지 N 품목 → N 행).
4. 숫자 검증: unit_price × qty 가 amount와 다르면 flag=true, 같으면 flag=false.
5. 합계(total)는 "총-...원", "합계", "Total" 등으로 표시된 값을 **해당 메시지의 마지막 품목 행에만** 넣고 나머지는 null.
6. 시간 표현: "11~20시" → time_start="11:00", time_end="20:00". 단일 시각 불명확시 null.
7. 숫자는 콤마/기호 제거 후 정수. 단위(원, 개, ×, x, X, *) 제거.
8. date는 메시지 헤더나 입력에 명시된 날짜를 그대로 사용한다. 없으면 null.
9. 출력은 **JSON 배열만**. 설명·마크다운·코드펜스 금지.

[스키마]
{ "date": "YYYY-MM-DD"|null,
  "writer": string|null,
  "store": string|null,
  "time_start": "HH:MM"|null,
  "time_end": "HH:MM"|null,
  "item": string|null,
  "unit_price": int|null,
  "qty": int|null,
  "amount": int|null,
  "total": int|null,
  "flag": bool,
  "raw": string }

[예시 1 입력]
[DATE: 2026-04-23] [WRITER: 윤순희]
탑마트 죽도점
시간 11~20시
행사결과
리얼버터-3748×72=269,280
오리지널-3748×55=205,700
총-475,000원

[예시 1 출력]
[
 {"date":"2026-04-23","writer":"윤순희","store":"탑마트 죽도점","time_start":"11:00","time_end":"20:00","item":"리얼버터","unit_price":3748,"qty":72,"amount":269280,"total":null,"flag":false,"raw":"리얼버터-3748×72=269,280"},
 {"date":"2026-04-23","writer":"윤순희","store":"탑마트 죽도점","time_start":"11:00","time_end":"20:00","item":"오리지널","unit_price":3748,"qty":55,"amount":205700,"total":475000,"flag":false,"raw":"오리지널-3748×55=205,700"}
]

[예시 2 입력]
[DATE: 2026-04-22] [WRITER: 김현우]
이마트 동대구
시간 10~19시
행사결과
A상품-1200*10=12000
B상품-2500*4=9999
총-21,999원

[예시 2 출력]
[
 {"date":"2026-04-22","writer":"김현우","store":"이마트 동대구","time_start":"10:00","time_end":"19:00","item":"A상품","unit_price":1200,"qty":10,"amount":12000,"total":null,"flag":false,"raw":"A상품-1200*10=12000"},
 {"date":"2026-04-22","writer":"김현우","store":"이마트 동대구","time_start":"10:00","time_end":"19:00","item":"B상품","unit_price":2500,"qty":4,"amount":9999,"total":21999,"flag":true,"raw":"B상품-2500*4=9999"}
]
`;

function buildUserPrompt(inputText) {
  return SYSTEM_PROMPT + '\n[입력]\n' + inputText + '\n';
}

async function callGemini(apiKey, userText, images = []) {
  const parts = [{ text: buildUserPrompt(userText) }];
  for (const img of images) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 8192
    }
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cache.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    let msg = detail;
    try { const j = JSON.parse(detail); msg = j?.error?.message || detail; } catch {}
    if (res.status === 429) throw new Error(`429 한도/레이트리밋: ${msg.slice(0, 300)}`);
    if (res.status === 400) throw new Error(`400: ${msg.slice(0, 300)}`);
    if (res.status === 403) throw new Error(`403 권한/키 오류: ${msg.slice(0, 300)}`);
    throw new Error(`Gemini ${res.status}: ${msg.slice(0, 300)}`);
  }
  const data = await res.json();
  const txt = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
  if (!txt) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'EMPTY';
    throw new Error(`Gemini 응답이 비어있습니다 (${reason})`);
  }
  let arr;
  try { arr = JSON.parse(txt); }
  catch (e) {
    const cleaned = txt.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
    arr = JSON.parse(cleaned);
  }
  if (!Array.isArray(arr)) throw new Error('Gemini 응답이 JSON 배열이 아닙니다');
  return arr;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const res = String(r.result || '');
      const idx = res.indexOf(',');
      resolve(idx >= 0 ? res.slice(idx+1) : res);
    };
    r.readAsDataURL(file);
  });
}

/* =========================================================================
 * 4) 진행률 표시
 * ========================================================================= */
const STEP_ORDER = ['read', 'filter', 'dedupe', 'ai', 'excel'];

function showProgress() {
  document.getElementById('progressPanel').classList.remove('hidden');
  document.querySelectorAll('#progressSteps .step').forEach(el => {
    el.classList.remove('done', 'current');
    el.classList.add('pending');
    el.querySelector('.icon').textContent = '○';
  });
  setProgress(0);
}
function hideProgress() {
  document.getElementById('progressPanel').classList.add('hidden');
}
function setProgress(pct) {
  document.getElementById('progressFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  document.getElementById('progressPct').textContent = `${Math.round(pct)}%`;
}
function setStep(key, state, detail) {
  const el = document.querySelector(`#progressSteps .step[data-step="${key}"]`);
  if (!el) return;
  el.classList.remove('done', 'current', 'pending');
  el.classList.add(state);
  el.querySelector('.icon').textContent = state === 'done' ? '✓' : (state === 'current' ? '▶' : '○');
  if (detail !== undefined) {
    const base = el.dataset.baseLabel || el.textContent.trim().replace(/^[✓▶○]\s*/, '');
    el.dataset.baseLabel = base;
    el.innerHTML = `<span class="icon">${state === 'done' ? '✓' : (state === 'current' ? '▶' : '○')}</span> ${escapeHtml(base)} <span class="text-xs text-gray-500">${escapeHtml(detail)}</span>`;
  }
}

/* =========================================================================
 * 5) 결과 테이블 렌더링 & 편집
 * ========================================================================= */
let currentRows = [];

const COLUMNS = [
  { key: 'date',       label: '날짜',   type: 'text',  align: 'left'  },
  { key: 'writer',     label: '작성자', type: 'text',  align: 'left'  },
  { key: 'store',      label: '지점',   type: 'text',  align: 'left'  },
  { key: 'time_start', label: '시작',   type: 'text',  align: 'left'  },
  { key: 'time_end',   label: '종료',   type: 'text',  align: 'left'  },
  { key: 'item',       label: '품목',   type: 'text',  align: 'left'  },
  { key: 'unit_price', label: '단가',   type: 'int',   align: 'right' },
  { key: 'qty',        label: '수량',   type: 'int',   align: 'right' },
  { key: 'amount',     label: '금액',   type: 'int',   align: 'right' },
  { key: 'total',      label: '합계',   type: 'int',   align: 'right' },
];

function renderTable() {
  const tbody = document.getElementById('resultBody');
  tbody.innerHTML = '';
  document.getElementById('resultPanel').classList.toggle('hidden', currentRows.length === 0);
  document.getElementById('resultSummary').textContent =
    `${currentRows.length}개 행 · ${currentRows.filter(r=>r.flag).length}개 검증오류`;

  currentRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.className = row.flag ? 'row-flag border-t' : 'border-t';
    tr.innerHTML = `<td class="p-2 text-gray-400">${idx+1}</td>`;
    for (const col of COLUMNS) {
      const td = document.createElement('td');
      td.className = `p-2 cell-editable ${col.align === 'right' ? 'text-right' : 'text-left'}`;
      td.dataset.idx = idx; td.dataset.key = col.key; td.dataset.type = col.type;
      td.textContent = formatCell(row[col.key], col.type);
      td.addEventListener('click', startEdit);
      tr.appendChild(td);
    }
    const tdFlag = document.createElement('td');
    tdFlag.className = 'p-2 text-center';
    tdFlag.textContent = row.flag ? '⚠️' : '';
    tr.appendChild(tdFlag);
    const tdRaw = document.createElement('td');
    tdRaw.className = 'p-2 text-gray-500 text-xs';
    tdRaw.textContent = (row.raw || '').slice(0, 80);
    tdRaw.title = row.raw || '';
    tr.appendChild(tdRaw);
    const tdDel = document.createElement('td');
    tdDel.className = 'p-2 text-center';
    const delBtn = document.createElement('button');
    delBtn.className = 'text-red-600 text-xs underline';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', () => {
      currentRows.splice(idx, 1);
      renderTable();
    });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
}

function formatCell(v, type) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'int') {
    const n = Number(v);
    if (Number.isFinite(n)) return n.toLocaleString('ko-KR');
    return String(v);
  }
  return String(v);
}

function startEdit(e) {
  const td = e.currentTarget;
  if (td.querySelector('input')) return;
  const idx = Number(td.dataset.idx);
  const key = td.dataset.key;
  const type = td.dataset.type;
  const original = currentRows[idx][key];
  td.textContent = '';
  const inp = document.createElement('input');
  inp.type = (type === 'int') ? 'number' : 'text';
  inp.value = original === null || original === undefined ? '' : String(original);
  td.appendChild(inp);
  inp.focus(); inp.select();
  const commit = () => {
    let val = inp.value.trim();
    let newVal;
    if (val === '') newVal = null;
    else if (type === 'int') { const n = Number(val.replace(/[, ]/g,'')); newVal = Number.isFinite(n) ? Math.round(n) : null; }
    else newVal = val;
    currentRows[idx][key] = newVal;
    if (['unit_price','qty','amount'].includes(key)) {
      const r = currentRows[idx];
      if (r.unit_price != null && r.qty != null && r.amount != null) {
        r.flag = (r.unit_price * r.qty) !== r.amount;
      }
    }
    renderTable();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
    if (ev.key === 'Escape') { td.textContent = formatCell(original, type); }
  });
}

/* =========================================================================
 * 6) 행 후처리
 * ========================================================================= */
function normalizeRows(rows) {
  return rows.map(r => {
    const toIntOrNull = v => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(String(v).replace(/[, ]/g,''));
      return Number.isFinite(n) ? Math.round(n) : null;
    };
    const o = {
      date: r.date ?? null,
      writer: r.writer ?? null,
      store: r.store ?? null,
      time_start: r.time_start ?? null,
      time_end: r.time_end ?? null,
      item: r.item ?? null,
      unit_price: toIntOrNull(r.unit_price),
      qty: toIntOrNull(r.qty),
      amount: toIntOrNull(r.amount),
      total: toIntOrNull(r.total),
      flag: !!r.flag,
      raw: r.raw ?? ''
    };
    if (o.unit_price != null && o.qty != null && o.amount != null) {
      o.flag = (o.unit_price * o.qty) !== o.amount;
    }
    return o;
  });
}

/* =========================================================================
 * 7) 파일 감지 & 선택
 * ========================================================================= */
let selectedFile = null; // { path, name, mtime, size }

async function detectLatestFile() {
  const res = await kapi.files.detectLatest(cache.watchFolder, cache.filePattern);
  const el = document.getElementById('detectResult');
  if (!res) {
    selectedFile = null;
    el.innerHTML = `<span class="text-gray-500">감시 폴더에서 <code>${escapeHtml(cache.filePattern)}</code> 패턴의 .txt 파일을 찾지 못했습니다.</span><div class="text-xs text-gray-400 mt-1">${escapeHtml(cache.watchFolder)}</div>`;
    return;
  }
  if (res.error) {
    selectedFile = null;
    el.innerHTML = `<span class="text-red-600">폴더 접근 실패: ${escapeHtml(res.error)}</span>`;
    return;
  }
  selectedFile = res;
  const rel = formatRelativeTime(res.mtime);
  const size = formatBytes(res.size);
  el.innerHTML = `
    <div class="flex items-start gap-2">
      <span class="text-xl">📄</span>
      <div class="flex-1 min-w-0">
        <div class="font-mono text-xs truncate" title="${escapeHtml(res.path)}">${escapeHtml(res.name)}</div>
        <div class="text-xs text-gray-500 mt-1">📅 ${rel} · 📊 ${size}</div>
      </div>
    </div>
  `;
}

async function pickManualFile() {
  const p = await kapi.files.selectTxt();
  if (!p) {
    // 취소 시 원래 모드로 복원
    document.querySelector('input[name=fileSource][value=auto]').checked = true;
    return;
  }
  // 수동 선택한 파일 정보 구성
  const read = await kapi.files.readText(p);
  if (!read.ok) { toast('파일 읽기 실패: ' + read.error, 'err'); return; }
  const name = p.split(/[\\/]/).pop();
  selectedFile = { path: p, name, mtime: read.mtime, size: read.size, manual: true };
  const el = document.getElementById('detectResult');
  el.innerHTML = `
    <div class="flex items-start gap-2">
      <span class="text-xl">📄</span>
      <div class="flex-1 min-w-0">
        <div class="font-mono text-xs truncate" title="${escapeHtml(p)}">${escapeHtml(name)} <span class="text-blue-600 text-xs">(수동)</span></div>
        <div class="text-xs text-gray-500 mt-1">📊 ${formatBytes(read.size)}</div>
      </div>
    </div>
  `;
}

document.getElementById('btnRefreshDetect').addEventListener('click', () => {
  document.querySelector('input[name=fileSource][value=auto]').checked = true;
  detectLatestFile();
});

/* =========================================================================
 * 8) 실행 — 카톡 .txt (메인 흐름)
 * ========================================================================= */
document.getElementById('runTxt').addEventListener('click', async () => {
  if (!cache.activeKeyValue) { toast('먼저 Gemini API Key를 설정에서 등록하세요', 'err'); return; }
  if (!selectedFile) { toast('처리할 파일이 없습니다', 'err'); return; }

  const mode = document.querySelector('input[name=rangeMode]:checked')?.value || 'auto';
  const lastDate = cache.lastProcessedDate;
  const today = todayYMD();

  try {
    showProgress();
    setStep('read', 'current');
    setProgress(5);

    const readRes = await kapi.files.readText(selectedFile.path);
    if (!readRes.ok) throw new Error('파일 읽기 실패: ' + readRes.error);
    const msgs = parseKakaoTxt(readRes.text);
    setStep('read', 'done', `${msgs.length}건 파싱`);
    setProgress(15);

    // 날짜 필터
    setStep('filter', 'current');
    let filtered = msgs.slice();
    if (mode === 'today') {
      filtered = filtered.filter(m => m.date === today);
    } else if (mode === 'auto') {
      if (lastDate) filtered = filtered.filter(m => m.date > lastDate);
    } else if (mode === 'custom') {
      const f = document.getElementById('rangeFrom').value;
      const t = document.getElementById('rangeTo').value;
      if (!f || !t) throw new Error('시작/종료 날짜를 모두 선택하세요');
      filtered = filtered.filter(m => m.date >= f && m.date <= t);
    } else if (mode === 'pickDate') {
      const d = document.getElementById('rangePickOne').value;
      if (!d) throw new Error('날짜를 선택하세요');
      filtered = filtered.filter(m => m.date === d);
    }
    setStep('filter', 'done', `${filtered.length}건`);
    setProgress(25);

    // 보고형 필터 + 해시 중복 제거
    setStep('dedupe', 'current');
    const candidates = filtered.filter(m => looksLikeReport(m.body));
    const prevHashes = new Set(cache.processedHashes);
    const hashed = candidates.map(m => ({ msg: m, hash: messageHash(m) }));
    const fresh = hashed.filter(x => !prevHashes.has(x.hash));
    const dupCount = hashed.length - fresh.length;
    setStep('dedupe', 'done', `신규 ${fresh.length} / 중복 ${dupCount}`);
    setProgress(35);

    document.getElementById('txtPreview').classList.remove('hidden');
    document.getElementById('txtPreview').innerHTML = `
      <div><b>파일</b>: ${escapeHtml(selectedFile.name)}</div>
      <div><b>대상</b>: 전체 ${msgs.length} / 범위내 ${filtered.length} / 보고형 ${candidates.length} / 신규 ${fresh.length} / 중복 ${dupCount}</div>
    `;

    if (!fresh.length) {
      setStep('ai', 'done', '스킵');
      setStep('excel', 'done', '스킵');
      setProgress(100);
      setTimeout(hideProgress, 800);
      toast(`신규 0건 (중복 ${dupCount}건)`, 'info');
      return;
    }

    // AI 정형화 배치
    setStep('ai', 'current', `0/${fresh.length}`);
    const BATCH = 15;
    const allRows = [];
    const newHashes = [];
    for (let i = 0; i < fresh.length; i += BATCH) {
      const slice = fresh.slice(i, i + BATCH);
      const combined = slice.map(x => {
        const m = x.msg;
        return `[DATE: ${m.date}] [TIME: ${m.time}] [WRITER: ${m.writer}]\n${m.body}`;
      }).join('\n\n---\n\n');
      const rows = await callGemini(cache.activeKeyValue, combined);
      allRows.push(...normalizeRows(rows));
      newHashes.push(...slice.map(x => x.hash));
      const doneCount = Math.min(i + BATCH, fresh.length);
      setStep('ai', 'current', `${doneCount}/${fresh.length}`);
      setProgress(35 + Math.round((doneCount / fresh.length) * 50));
    }
    setStep('ai', 'done', `${fresh.length}건 완료`);
    setProgress(85);

    currentRows = allRows;
    renderTable();

    // 해시 저장
    cache.processedHashes = Array.from(new Set([...cache.processedHashes, ...newHashes]));
    await kapi.store.set('processedHashes', cache.processedHashes);
    const maxDate = fresh.reduce((acc, x) => (x.msg.date > acc ? x.msg.date : acc), lastDate || '0000-00-00');
    cache.lastProcessedDate = maxDate;
    await kapi.store.set('lastProcessedDate', maxDate);

    // 누적 엑셀에 즉시 append
    setStep('excel', 'current');
    if (cache.excelOutputPath) {
      const res = await kapi.excel.appendRows(allRows, cache.excelOutputPath);
      if (!res.ok) throw new Error('엑셀 저장 실패: ' + res.error);
      // 누적 캐시/카운트 업데이트
      cache.accumulatedRows = cache.accumulatedRows.concat(allRows);
      await kapi.store.set('accumulatedRows', cache.accumulatedRows);
      cache.totalCount += allRows.length;
      await kapi.store.set('totalCount', cache.totalCount);
      setStep('excel', 'done', `${allRows.length}행 append`);
    } else {
      setStep('excel', 'done', '경로 미설정 - 스킵');
    }
    setProgress(95);

    // 아카이브
    if (!selectedFile.manual && cache.archiveMode && cache.archiveMode !== 'keep') {
      const res = await kapi.files.archive(selectedFile.path, cache.archiveMode);
      if (res.ok) {
        if (res.action === 'moved') toast(`원본 이동: ${res.target}`, 'info');
        if (res.action === 'deleted') toast('원본 삭제됨', 'info');
      }
    }
    setProgress(100);
    setTimeout(hideProgress, 800);

    kapi.notify.toast('처리 완료', `신규 ${fresh.length}건 (중복 ${dupCount})`);
    toast(`✅ 신규 ${fresh.length}건 처리 완료`, 'ok', 3500);
    refreshStatusPanel();
    await detectLatestFile();
  } catch (e) {
    hideProgress();
    toast(String(e.message || e), 'err', 5000);
  }
});

/* =========================================================================
 * 9) 실행 — 텍스트 붙여넣기
 * ========================================================================= */
document.getElementById('runPaste').addEventListener('click', async () => {
  if (!cache.activeKeyValue) { toast('먼저 Gemini API Key를 설정에서 등록하세요', 'err'); return; }
  const text = document.getElementById('pasteText').value.trim();
  if (!text) { toast('붙여넣은 내용이 없습니다', 'err'); return; }
  const date = document.getElementById('pasteDate').value || todayYMD();
  const writer = document.getElementById('pasteWriter').value.trim();
  cache.draftText = text;
  await kapi.store.set('draftText', text);
  const header = `[DATE: ${date}]${writer ? ` [WRITER: ${writer}]` : ''}\n`;
  const payload = header + text;
  try {
    showProgress();
    setStep('read', 'done', '텍스트 입력');
    setStep('filter', 'done', '-');
    setStep('dedupe', 'done', '-');
    setStep('ai', 'current');
    setProgress(40);
    const rows = await callGemini(cache.activeKeyValue, payload);
    currentRows = normalizeRows(rows);
    renderTable();
    setStep('ai', 'done', `${currentRows.length}행`);
    setStep('excel', 'done', '수동 저장 대기');
    setProgress(100);
    setTimeout(hideProgress, 600);
    toast(`${currentRows.length}개 행 생성`, 'ok');
  } catch (e) {
    hideProgress();
    toast(String(e.message || e), 'err', 5000);
  }
});

/* =========================================================================
 * 10) 실행 — 스크린샷
 * ========================================================================= */
let imgFiles = [];
document.getElementById('imgFile').addEventListener('change', (e) => {
  imgFiles = Array.from(e.target.files || []);
  const list = document.getElementById('imgList');
  list.innerHTML = '';
  imgFiles.forEach(f => {
    const chip = document.createElement('span');
    chip.className = 'text-xs bg-gray-100 rounded px-2 py-1';
    chip.textContent = `🖼️ ${f.name} (${Math.round(f.size/1024)}KB)`;
    list.appendChild(chip);
  });
});

document.getElementById('runImg').addEventListener('click', async () => {
  if (!cache.activeKeyValue) { toast('먼저 Gemini API Key를 설정에서 등록하세요', 'err'); return; }
  if (!imgFiles.length) { toast('이미지를 먼저 선택하세요', 'err'); return; }
  const date = document.getElementById('imgDate').value || todayYMD();
  const allRows = [];
  try {
    showProgress();
    setStep('read', 'done', `이미지 ${imgFiles.length}장`);
    setStep('filter', 'done', '-');
    setStep('dedupe', 'done', '-');
    setStep('ai', 'current', `0/${imgFiles.length}`);
    for (let i = 0; i < imgFiles.length; i++) {
      const f = imgFiles[i];
      const b64 = await fileToBase64(f);
      const payload = `[DATE: ${date}]\n위 스크린샷(카카오톡 대화)에서 행사 보고 메시지를 읽어 스키마대로 정형화하라. 메시지 내 날짜가 있으면 그것을 우선한다.`;
      const rows = await callGemini(cache.activeKeyValue, payload, [{ mimeType: f.type || 'image/png', data: b64 }]);
      allRows.push(...normalizeRows(rows));
      setStep('ai', 'current', `${i+1}/${imgFiles.length}`);
      setProgress(20 + Math.round(((i+1) / imgFiles.length) * 70));
    }
    setStep('ai', 'done', `${imgFiles.length}장 완료`);
    setStep('excel', 'done', '수동 저장 대기');
    setProgress(100);
    setTimeout(hideProgress, 600);
    currentRows = allRows;
    renderTable();
    toast(`${currentRows.length}개 행 생성`, 'ok');
  } catch (e) {
    hideProgress();
    toast(String(e.message || e), 'err', 5000);
  }
});

/* =========================================================================
 * 11) 결과 버튼
 * ========================================================================= */
document.getElementById('downloadCurrent').addEventListener('click', async () => {
  if (!currentRows.length) { toast('저장할 행이 없습니다', 'err'); return; }
  const ymd = todayYMD().replace(/-/g,'');
  const res = await kapi.excel.saveAs(currentRows, `카톡행사보고_${ymd}.xlsx`);
  if (res.canceled) return;
  if (res.ok) toast(`저장됨: ${res.path}`, 'ok');
  else toast('저장 실패: ' + res.error, 'err');
});

document.getElementById('saveAccumulate').addEventListener('click', async () => {
  if (!currentRows.length) { toast('저장할 행이 없습니다', 'err'); return; }
  if (!cache.excelOutputPath) { toast('설정에서 누적 엑셀 저장 경로를 지정하세요', 'err'); return; }
  const res = await kapi.excel.appendRows(currentRows, cache.excelOutputPath);
  if (!res.ok) { toast('저장 실패: ' + res.error, 'err'); return; }
  cache.accumulatedRows = cache.accumulatedRows.concat(currentRows);
  await kapi.store.set('accumulatedRows', cache.accumulatedRows);
  cache.totalCount += currentRows.length;
  await kapi.store.set('totalCount', cache.totalCount);
  const maxDate = currentRows.reduce((acc, r) => (r.date && r.date > acc ? r.date : acc), cache.lastProcessedDate || '');
  if (maxDate) {
    cache.lastProcessedDate = maxDate;
    await kapi.store.set('lastProcessedDate', maxDate);
  }
  toast(`${currentRows.length}행 추가 · 누적 ${cache.accumulatedRows.length}행`, 'ok');
  refreshStatusPanel();
});

document.getElementById('openExcel').addEventListener('click', async () => {
  if (!cache.excelOutputPath) { toast('저장 경로 미설정', 'err'); return; }
  const res = await kapi.files.openPath(cache.excelOutputPath);
  if (!res.ok) toast('열기 실패: ' + res.error, 'err');
});
document.getElementById('showInFolder').addEventListener('click', async () => {
  if (!cache.excelOutputPath) { toast('저장 경로 미설정', 'err'); return; }
  await kapi.files.showInFolder(cache.excelOutputPath);
});

/* =========================================================================
 * 12) 설정 UI
 * ========================================================================= */
function renderModelSelect() {
  const sel = document.getElementById('modelSelect');
  sel.innerHTML = '';
  for (const m of MODEL_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === cache.model) opt.selected = true;
    sel.appendChild(opt);
  }
}

document.getElementById('modelSelect').addEventListener('change', async (e) => {
  cache.model = e.target.value;
  await kapi.store.set('model', cache.model);
  toast(`모델 변경: ${cache.model}`, 'ok');
});

function renderApiKeyList() {
  const root = document.getElementById('apiKeyList');
  root.innerHTML = '';
  if (cache.apiKeys.length === 0) {
    root.innerHTML = '<div class="text-xs text-gray-500 text-center py-2">등록된 키가 없습니다</div>';
    return;
  }
  for (const k of cache.apiKeys) {
    const isActive = k.id === cache.activeKeyId;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 bg-white rounded px-2 py-1 border';
    row.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="text-sm truncate"><b>${escapeHtml(k.name)}</b>${isActive ? ' <span class="text-xs text-green-600">● 사용중</span>' : ''}</div>
        <div class="text-xs text-gray-500 font-mono truncate">${escapeHtml(maskKey(k.key))}</div>
      </div>
      ${isActive ? '' : `<button data-act="use" data-id="${k.id}" class="text-xs px-2 py-1 rounded bg-gray-900 text-white">사용</button>`}
      <button data-act="del" data-id="${k.id}" class="text-xs px-2 py-1 rounded bg-red-500 text-white">삭제</button>
    `;
    root.appendChild(row);
  }
  root.querySelectorAll('button[data-act=use]').forEach(btn => {
    btn.addEventListener('click', async () => {
      cache.activeKeyId = btn.dataset.id;
      const found = cache.apiKeys.find(k => k.id === cache.activeKeyId);
      cache.activeKeyValue = found ? found.key : '';
      await kapi.store.set('activeKeyId', cache.activeKeyId);
      renderApiKeyList();
      updateApiKeyStatus();
      toast('사용 키 변경됨', 'ok');
    });
  });
  root.querySelectorAll('button[data-act=del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const entry = cache.apiKeys.find(k => k.id === id);
      if (!entry) return;
      if (!confirm(`"${entry.name}" 키를 삭제할까요?`)) return;
      cache.apiKeys = cache.apiKeys.filter(k => k.id !== id);
      await kapi.apiKeys.save(cache.apiKeys);
      if (cache.activeKeyId === id) {
        if (cache.apiKeys.length > 0) {
          cache.activeKeyId = cache.apiKeys[0].id;
          cache.activeKeyValue = cache.apiKeys[0].key;
          await kapi.store.set('activeKeyId', cache.activeKeyId);
        } else {
          cache.activeKeyId = '';
          cache.activeKeyValue = '';
          await kapi.store.delete('activeKeyId');
        }
      }
      renderApiKeyList();
      updateApiKeyStatus();
      toast('삭제됨', 'ok');
    });
  });
}

document.getElementById('addApiKey').addEventListener('click', async () => {
  const nameInp = document.getElementById('newKeyName');
  const valInp = document.getElementById('newKeyValue');
  const name = nameInp.value.trim();
  const val = valInp.value.trim();
  if (!name) { toast('등록명을 입력하세요', 'err'); return; }
  if (!val) { toast('API 키를 입력하세요', 'err'); return; }
  if (cache.apiKeys.some(k => k.key === val)) { toast('이미 등록된 키입니다', 'err'); return; }
  if (cache.apiKeys.some(k => k.name === name)) { toast('이미 같은 등록명이 있습니다', 'err'); return; }
  const id = newKeyId();
  cache.apiKeys.push({ id, name, key: val });
  await kapi.apiKeys.save(cache.apiKeys);
  cache.activeKeyId = id;
  cache.activeKeyValue = val;
  await kapi.store.set('activeKeyId', id);
  nameInp.value = '';
  valInp.value = '';
  renderApiKeyList();
  updateApiKeyStatus();
  toast(`"${name}" 등록됨`, 'ok');
});

document.getElementById('openKeyPage').addEventListener('click', (e) => {
  e.preventDefault();
  kapi.app.openExternal('https://aistudio.google.com/apikey');
});

/* === 경로 설정 === */
function renderPaths() {
  document.getElementById('watchFolder').value = cache.watchFolder;
  document.getElementById('filePattern').value = cache.filePattern;
  document.getElementById('excelOutputPath').value = cache.excelOutputPath;
  document.getElementById('archivePath').value = cache.archivePath;
  document.querySelector(`input[name=archiveMode][value="${cache.archiveMode}"]`).checked = true;
  document.getElementById('autoCleanupDays').value = cache.autoCleanupDays;
  document.getElementById('autoLaunch').checked = cache.autoLaunch;
  document.getElementById('minimizeToTray').checked = cache.minimizeToTray;
}

document.getElementById('pickWatchFolder').addEventListener('click', async () => {
  const p = await kapi.files.selectFolder('감시 폴더 선택');
  if (!p) return;
  cache.watchFolder = p;
  await kapi.store.set('watchFolder', p);
  renderPaths();
  detectLatestFile();
});

document.getElementById('filePattern').addEventListener('change', async (e) => {
  cache.filePattern = e.target.value.trim() || 'KakaoTalk';
  await kapi.store.set('filePattern', cache.filePattern);
  detectLatestFile();
});

document.getElementById('pickExcelPath').addEventListener('click', async () => {
  const p = await kapi.files.selectSaveXlsx(cache.excelOutputPath);
  if (!p) return;
  cache.excelOutputPath = p;
  await kapi.store.set('excelOutputPath', p);
  renderPaths();
  toast('누적 엑셀 경로 저장됨', 'ok');
});

document.getElementById('pickArchivePath').addEventListener('click', async () => {
  const p = await kapi.files.selectFolder('아카이브 폴더 선택');
  if (!p) return;
  cache.archivePath = p;
  await kapi.store.set('archivePath', p);
  renderPaths();
});

document.querySelectorAll('input[name=archiveMode]').forEach(r => {
  r.addEventListener('change', async () => {
    if (!r.checked) return;
    cache.archiveMode = r.value;
    await kapi.store.set('archiveMode', r.value);
  });
});

document.getElementById('autoCleanupDays').addEventListener('change', async (e) => {
  const n = Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 30));
  cache.autoCleanupDays = n;
  await kapi.store.set('autoCleanupDays', n);
});

document.getElementById('autoLaunch').addEventListener('change', async (e) => {
  await kapi.app.setAutoLaunch(e.target.checked);
  cache.autoLaunch = e.target.checked;
});

document.getElementById('minimizeToTray').addEventListener('change', async (e) => {
  await kapi.app.setMinimizeToTray(e.target.checked);
  cache.minimizeToTray = e.target.checked;
});

/* === 초기화 버튼 === */
document.getElementById('resetHistory').addEventListener('click', async () => {
  if (!confirm('처리 이력(해시/누적행/마지막 처리일)을 모두 초기화합니다. 진행할까요?')) return;
  cache.processedHashes = [];
  cache.accumulatedRows = [];
  cache.totalCount = 0;
  cache.lastProcessedDate = null;
  await kapi.store.set('processedHashes', []);
  await kapi.store.set('accumulatedRows', []);
  await kapi.store.set('totalCount', 0);
  await kapi.store.delete('lastProcessedDate');
  toast('처리 이력 초기화됨', 'ok');
  refreshStatusPanel();
});

document.getElementById('resetAll').addEventListener('click', async () => {
  if (!confirm('API Key를 제외한 모든 데이터를 초기화합니다. 진행할까요?')) return;
  cache.processedHashes = [];
  cache.accumulatedRows = [];
  cache.totalCount = 0;
  cache.lastProcessedDate = null;
  cache.draftText = '';
  await kapi.store.set('processedHashes', []);
  await kapi.store.set('accumulatedRows', []);
  await kapi.store.set('totalCount', 0);
  await kapi.store.delete('lastProcessedDate');
  await kapi.store.set('draftText', '');
  currentRows = [];
  renderTable();
  toast('전체 초기화 완료', 'ok');
  refreshStatusPanel();
});

/* =========================================================================
 * 13) 초기 로드
 * ========================================================================= */
function updateApiKeyStatus() {
  document.getElementById('apiKeyStatus').textContent = cache.activeKeyValue ? '🔑 API Key 설정됨' : '🔑 API Key 미설정';
}

function refreshStatusPanel() {
  document.getElementById('statAccum').textContent = (cache.accumulatedRows.length || 0).toLocaleString('ko-KR');
  document.getElementById('statTotal').textContent = (cache.totalCount || 0).toLocaleString('ko-KR');
  document.getElementById('statLastDate').textContent = cache.lastProcessedDate || '-';
  document.getElementById('statHash').textContent = (cache.processedHashes.length || 0).toLocaleString('ko-KR');
  updateApiKeyStatus();
}

async function init() {
  await loadAllSettings();
  document.getElementById('pasteDate').value = todayYMD();
  document.getElementById('imgDate').value = todayYMD();
  document.getElementById('rangePickOne').value = todayYMD();
  if (cache.draftText) document.getElementById('pasteText').value = cache.draftText;
  renderModelSelect();
  renderApiKeyList();
  renderPaths();
  updateApiKeyStatus();
  refreshStatusPanel();
  const v = await kapi.app.getVersion();
  document.getElementById('appVersion').textContent = `v${v}`;
  await detectLatestFile();
  setupUpdateUI();
  runSelfTest();
}

/* =========================================================================
 * 15) 자동 업데이트 UI
 * ========================================================================= */
function setupUpdateUI() {
  const banner = document.getElementById('updateBanner');
  const box = document.getElementById('updateBannerBox');
  const icon = document.getElementById('updateIcon');
  const title = document.getElementById('updateTitle');
  const detail = document.getElementById('updateDetail');
  const progWrap = document.getElementById('updateProgressWrap');
  const progFill = document.getElementById('updateProgressFill');
  const actionBtn = document.getElementById('btnUpdateAction');
  const dismissBtn = document.getElementById('btnUpdateDismiss');

  function showBanner(kind) {
    banner.classList.remove('hidden');
    box.className = 'rounded-lg border p-3 flex items-center gap-3 text-sm';
    if (kind === 'info') box.classList.add('bg-blue-50', 'border-blue-200');
    else if (kind === 'ready') box.classList.add('bg-green-50', 'border-green-300');
    else if (kind === 'error') box.classList.add('bg-red-50', 'border-red-200');
    else box.classList.add('bg-gray-50', 'border-gray-200');
  }

  dismissBtn.addEventListener('click', () => banner.classList.add('hidden'));

  actionBtn.addEventListener('click', async () => {
    if (actionBtn.dataset.action === 'install') {
      if (!confirm('앱이 종료되고 새 버전으로 다시 시작됩니다. 계속할까요?')) return;
      await kapi.update.install();
    }
  });

  kapi.update.onEvent('checking', () => {
    // 조용히 (배너 안 띄움)
  });

  kapi.update.onEvent('available', (info) => {
    showBanner('info');
    icon.textContent = '⬇️';
    title.textContent = `새 버전 v${info.version} 다운로드 중...`;
    detail.textContent = '완료되면 "지금 설치" 버튼이 나타납니다.';
    progWrap.classList.remove('hidden');
    progFill.style.width = '0%';
    actionBtn.classList.add('hidden');
  });

  kapi.update.onEvent('progress', (p) => {
    progFill.style.width = `${p.percent || 0}%`;
    const mb = (p.transferred / 1024 / 1024).toFixed(1);
    const total = (p.total / 1024 / 1024).toFixed(1);
    const speed = p.bytesPerSecond ? ` · ${(p.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : '';
    detail.textContent = `${mb} / ${total} MB (${Math.round(p.percent || 0)}%)${speed}`;
  });

  kapi.update.onEvent('downloaded', (info) => {
    showBanner('ready');
    icon.textContent = '✅';
    title.textContent = `v${info.version} 준비 완료`;
    detail.textContent = '지금 설치하면 앱이 재시작됩니다.';
    progWrap.classList.add('hidden');
    actionBtn.classList.remove('hidden');
    actionBtn.dataset.action = 'install';
    actionBtn.textContent = '지금 설치';
    kapi.notify.toast('업데이트 준비 완료', `v${info.version} 지금 설치 가능`);
  });

  kapi.update.onEvent('notAvailable', () => {
    // 수동 체크였을 때만 토스트로 알림
    if (banner.dataset.manualCheck === '1') {
      banner.dataset.manualCheck = '';
      toast('최신 버전입니다', 'ok');
    }
  });

  kapi.update.onEvent('error', (e) => {
    if (banner.dataset.manualCheck === '1') {
      banner.dataset.manualCheck = '';
      toast('업데이트 확인 실패: ' + e.message, 'err', 5000);
    }
    console.warn('[updater] error:', e);
  });

  // 업데이트 내역 모달
  const modal = document.getElementById('releasesModal');
  const body = document.getElementById('releasesBody');
  async function fetchReleases() {
    try {
      const r = await fetch('https://api.github.com/repos/rangminfather/kakao-excel-app/releases?per_page=20', {
        headers: { 'Accept': 'application/vnd.github+json' },
        cache: 'no-store'
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return { ok: false, error: `GitHub ${r.status}: ${txt.slice(0, 200)}` };
      }
      const arr = await r.json();
      if (!Array.isArray(arr)) return { ok: false, error: (arr && arr.message) || 'Unexpected response' };
      return {
        ok: true,
        releases: arr.map(x => ({
          version: (x.tag_name || '').replace(/^v/, ''),
          name: x.name || x.tag_name,
          published: x.published_at,
          body: x.body || '',
          prerelease: !!x.prerelease,
          url: x.html_url
        }))
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  function openModal() {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
  function closeModal() {
    modal.classList.add('hidden');
    modal.style.display = '';
  }

  document.getElementById('btnShowReleases').addEventListener('click', async () => {
    console.log('[releases] open modal');
    openModal();
    const current = await kapi.update.currentVersion();
    document.getElementById('releasesCurrentVersion').textContent = `현재 버전: v${current}`;
    body.innerHTML = '<div class="text-center text-gray-500 text-sm py-8">불러오는 중...</div>';
    const res = await fetchReleases();
    if (!res.ok) {
      body.innerHTML = `<div class="text-center text-red-600 text-sm py-8 px-2">${escapeHtml(res.error || '불러오기 실패')}</div>`;
      console.warn('[releases] fetch failed:', res.error);
      return;
    }
    if (!res.releases.length) {
      body.innerHTML = '<div class="text-center text-gray-500 text-sm py-8">릴리스가 없습니다</div>';
      return;
    }
    body.innerHTML = res.releases.map(r => {
      const d = r.published ? new Date(r.published).toLocaleDateString('ko-KR') : '';
      const isCurrent = r.version === current;
      return `
        <article class="border-b py-3 last:border-b-0">
          <header class="flex items-baseline gap-2 mb-1">
            <h3 class="font-bold text-sm">${escapeHtml(r.name || 'v' + r.version)}</h3>
            ${isCurrent ? '<span class="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">현재</span>' : ''}
            ${r.prerelease ? '<span class="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">프리릴리스</span>' : ''}
            <span class="text-xs text-gray-500 ml-auto">${d}</span>
          </header>
          <pre class="text-xs text-gray-700 whitespace-pre-wrap font-sans">${escapeHtml(r.body || '(내용 없음)')}</pre>
        </article>
      `;
    }).join('');
  });
  document.getElementById('btnCloseReleases').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.getElementById('btnCheckUpdate').addEventListener('click', async () => {
    banner.dataset.manualCheck = '1';
    toast('업데이트 확인 중...', 'info');
    const res = await kapi.update.check();
    if (!res.ok) toast('확인 실패: ' + res.error, 'err');
  });
}

/* =========================================================================
 * 14) 자가 점검
 * ========================================================================= */
function runSelfTest() {
  try {
    const sample = `2026년 4월 23일 오후 8:02, 윤순희 SC 대구1 : 탑마트 죽도점
시간 11~20시
행사결과
리얼버터-3748×72=269,280
오리지널-3748×55=205,700
총-475,000원
2026년 4월 23일 오후 8:05, 김현우 : 이마트 동대구
시간 10~19시
A상품-1200*10=12000
총-12,000원`;
    const parsed = parseKakaoTxt(sample);
    console.assert(parsed.length === 2, '파서: 2개 메시지 예상');
    console.assert(parsed[0].writer === '윤순희 SC 대구1', '파서: writer 오류');
    console.assert(parsed[0].date === '2026-04-23', '파서: date 오류');
    console.assert(parsed[0].time === '20:02', '파서: time 오류');
    const h1 = messageHash(parsed[0]);
    const h2 = messageHash(parsed[0]);
    console.assert(h1 === h2, '해시: 동일 입력 동일 해시');
    console.assert(h1 !== messageHash(parsed[1]), '해시: 다른 메시지 다른 해시');
    console.log('[self-test] 파서/해시 OK', parsed);
  } catch (e) {
    console.warn('[self-test] 실패', e);
  }
}

init();
