'use strict';
(function() {

/* =========================================================================
 * 0) 공통 유틸
 * ========================================================================= */
const kapi = window.kapi;

const MODEL_OPTIONS = [
  { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash (기본 권장)' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (가볍고 한도↑)' },
];
const DEFAULT_MODEL = 'gemini-2.5-flash';
const BULK_FILE_BYTES = 300 * 1024;
const BULK_MESSAGE_COUNT = 500;
const BULK_CANDIDATE_COUNT = 80;
const RESULT_PREVIEW_LIMIT = 300;

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
  processMode: 'hybrid',
  saveMode: 'append',
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
  if (!MODEL_OPTIONS.some(m => m.id === cache.model)) {
    cache.model = DEFAULT_MODEL;
    await kapi.store.set('model', cache.model);
  }
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
  cache.processMode = all.processMode || 'hybrid';
  if (!['hybrid', 'local', 'ai'].includes(cache.processMode)) {
    cache.processMode = 'hybrid';
    await kapi.store.set('processMode', cache.processMode);
  }
  cache.saveMode = all.saveMode || 'append';
  if (!['append', 'new', 'manual'].includes(cache.saveMode)) {
    cache.saveMode = 'append';
    await kapi.store.set('saveMode', cache.saveMode);
  }
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

function nowTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
// 포맷 1 (구형): "2026년 4월 20일 오후 8:02, 윤순희 : 본문"
const KAKAO_HEADER_RE = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2}),\s*([^:]+?)\s*:\s*(.*)$/;
// 포맷 2 (신형) 날짜 섹션 구분선: "--------------- 2026년 4월 20일 월요일 ---------------"
const DAY_SEPARATOR_RE = /^-+\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*[^-]*-+\s*$/;
// 포맷 2 (신형) 메시지: "[윤순희 SC 대구1] [오후 8:02] 본문"
const BRACKET_HEADER_RE = /^\[([^\]]+)\]\s*\[(오전|오후)\s*(\d{1,2}):(\d{2})\]\s*(.*)$/;

function parseKakaoTxt(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];
  let cur = null;
  let currentDate = null; // 신형 포맷용
  const pushCur = () => { if (cur) { messages.push(cur); cur = null; } };

  for (const line of lines) {
    // 신형: 날짜 구분선
    const ds = line.match(DAY_SEPARATOR_RE);
    if (ds) {
      pushCur();
      currentDate = `${ds[1]}-${String(ds[2]).padStart(2,'0')}-${String(ds[3]).padStart(2,'0')}`;
      continue;
    }
    // 구형: "2026년 4월 20일 오후 8:02, 이름: 본문"
    const m = line.match(KAKAO_HEADER_RE);
    if (m) {
      pushCur();
      let hh = parseInt(m[5], 10);
      if (m[4] === '오후' && hh !== 12) hh += 12;
      if (m[4] === '오전' && hh === 12) hh = 0;
      cur = {
        date: `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`,
        time: `${String(hh).padStart(2,'0')}:${m[6]}`,
        writer: m[7].trim(),
        bodyLines: m[8] ? [m[8]] : []
      };
      continue;
    }
    // 신형: "[이름] [오전/오후 H:MM] 본문"
    const b = line.match(BRACKET_HEADER_RE);
    if (b && currentDate) {
      pushCur();
      let hh = parseInt(b[3], 10);
      if (b[2] === '오후' && hh !== 12) hh += 12;
      if (b[2] === '오전' && hh === 12) hh = 0;
      cur = {
        date: currentDate,
        time: `${String(hh).padStart(2,'0')}:${b[4]}`,
        writer: b[1].trim(),
        bodyLines: b[5] ? [b[5]] : []
      };
      continue;
    }
    // 본문 연속
    if (cur) cur.bodyLines.push(line);
  }
  pushCur();
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
  const t = body.trim();
  if (t.length < 5) return false;
  // 명백한 non-report만 제외 (나머지는 AI에 위임 — 누락 방지가 토큰 절약보다 우선)
  if (/^.+님이 (들어왔습니다|나갔습니다)\.?$/.test(t)) return false;
  if (/^(사진|동영상|이모티콘|Voice Note|음성메시지)$/.test(t)) return false;
  if (/^사진 \d+장$/.test(t)) return false;
  if (/^동영상 \d+개$/.test(t)) return false;
  if (/^파일:\s*/.test(t)) return false;
  return true;
}

/* =========================================================================
 * 3) Gemini 프롬프트 & 호출
 * ========================================================================= */
const SYSTEM_PROMPT = `당신은 한국 마트 행사 보고 정형화 엔진이다.

[블록 분리]
- 입력은 여러 보고 메시지(블록)의 나열. 빈 줄 또는 새 작성자 이름/매장명이 나오면 새 블록 시작.
- 각 블록은 독립적으로 처리한다.

[작성자(writer)]
1. 우선순위:
   (a) **입력 헤더 [WRITER: XXX]가 있으면 XXX를 verbatim(글자 그대로, 자르지 말 것)으로 사용.** 예: "[WRITER: 김정아 트레이더스 비산점 행사(고정)]" → writer="김정아 트레이더스 비산점 행사(고정)". 이름만 잘라내지 말 것.
   (b) [WRITER:] 헤더가 없으면 블록 첫 줄 또는 매장명 직전의 한글 이름 (예: "윤순희 SC 대구1", "방 명화 010-...")
   (c) 헤더도 없고 첫 줄에도 없으면 괄호 안의 이름 (예: "유말점 행사(순희)" → "순희")
2. 한 블록에서 파악한 작성자는 그 블록의 **모든 행(품목 + 소계)에 동일하게 복사**.
3. (a)(b)(c) 어디에서도 찾을 수 없을 때만 null.

[전송시간(sent_time)]
4. 입력 헤더 [TIME: HH:MM]이 있으면 해당 블록의 모든 행에 sent_time으로 복사. 없으면 null.
5. 행사 시간(time_start/time_end)과는 다른 필드다. sent_time은 "카톡 메시지를 보낸 시각".

[품목 행]
4. 품목은 행 단위로 분리 (1 메시지 N 품목 → N 행).
5. 단가/수량/금액 중 일부만 있어도 가능한 만큼 채운다. 없는 값은 null.
6. 검증: unit_price × qty ≠ amount 이면 flag=true. 값 부족·일치면 flag=false.
7. 숫자는 콤마/원/×/x/X/*/~ 제거 후 정수. 단위("개", "원") 제거.

[소계 행 — 중요]
8. 블록에 "총-...원", "합계", "행사결과 NNN", 또는 마지막 줄의 단독 금액("211,440원", "행사결과 1040720")이 나오면:
   → 해당 블록의 품목 행들 뒤에 **별도 소계 행 하나를 추가**.
   → 소계 행 필드: item=null, unit_price=null, qty=null, amount=null, total=<총합>, flag=false, raw="소계".
   → date/writer/store/time_start/time_end는 같은 블록의 품목 행과 동일하게 복사.
9. 총합 표시가 없는 블록은 소계 행 생성 금지.

[시간·날짜]
10. "11~20시" → time_start="11:00", time_end="20:00". 단일 시각/불명확시 null.
11. date는 입력 헤더 [DATE:...] 기본값 사용. 메시지 내 명시 날짜가 있으면 그것이 우선.

[출력]
12. JSON 배열만. 설명·마크다운·코드펜스 금지. 아래 스키마 외 필드 금지.

[스키마]
{ "date": "YYYY-MM-DD"|null,
  "sent_time": "HH:MM"|null,
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

[예시 입력]
[DATE: 2026-04-20] [TIME: 10:23] [WRITER: 김포근 메가마트 울산점]
울산 남목마트
10~19
부추창펀
41×5980=245,180

---

[DATE: 2026-04-20] [TIME: 11:01] [WRITER: 김정아 트레이더스 비산점 행사(고정)]
비산트레이더스
11시~20시
들기름30봉 9480x30

[예시 출력]
[
 {"date":"2026-04-20","sent_time":"10:23","writer":"김포근 메가마트 울산점","store":"울산 남목마트","time_start":"10:00","time_end":"19:00","item":"부추창펀","unit_price":5980,"qty":41,"amount":245180,"total":null,"flag":true,"raw":"부추창펀 41×5980=245,180"},
 {"date":"2026-04-20","sent_time":"11:01","writer":"김정아 트레이더스 비산점 행사(고정)","store":"비산트레이더스","time_start":"11:00","time_end":"20:00","item":"들기름","unit_price":9480,"qty":30,"amount":null,"total":null,"flag":false,"raw":"들기름30봉 9480x30"}
]
(주의: writer는 [WRITER:] 헤더를 verbatim 사용 — "김정아"로 줄이지 말 것. sent_time은 [TIME:] 헤더 값.)
`;

function buildUserPrompt(inputText) {
  return SYSTEM_PROMPT + '\n[입력]\n' + inputText + '\n';
}

const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);
const GEMINI_RETRY_DELAYS = [1000, 2500, 5000];
// 429는 분당 한도가 대부분 — 짧은 재시도로는 못 벗어나므로 길게 기다린다
const GEMINI_RETRY_DELAYS_429 = [3000, 12000, 30000];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getGeminiModelFallbacks(primaryModel) {
  const fallbacks = {
    'gemini-2.5-flash': 'gemini-2.5-flash-lite',
    'gemini-2.0-flash': 'gemini-2.0-flash-lite'
  };
  const models = [primaryModel];
  const fallback = fallbacks[primaryModel];
  if (fallback && fallback !== primaryModel) models.push(fallback);
  return models;
}

async function readGeminiError(res) {
  let detail = '';
  try { detail = await res.text(); } catch {}
  let msg = detail;
  try { const j = JSON.parse(detail); msg = j?.error?.message || detail; } catch {}
  return msg || res.statusText || 'Unknown error';
}

function makeGeminiError(status, msg, model) {
  let text;
  if (status === 429) {
    text = `429 rate limit/quota: ${msg.slice(0, 300)}`;
  } else if (status === 400) {
    text = `400: ${msg.slice(0, 300)}`;
  } else if (status === 403) {
    text = `403 permission/API key error: ${msg.slice(0, 300)}`;
  } else if (status === 503) {
    text = `Gemini 503: ${model} is temporarily overloaded. The app retried and tried a Lite fallback when available. Please try again later. (${msg.slice(0, 180)})`;
  } else {
    text = `Gemini ${status}: ${msg.slice(0, 300)}`;
  }
  const err = new Error(text);
  err.status = status;
  err.model = model;
  err.retryable = RETRYABLE_GEMINI_STATUSES.has(status);
  return err;
}

async function fetchGeminiJson(apiKey, model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const msg = await readGeminiError(res);
    throw makeGeminiError(res.status, msg, model);
  }
  return res.json();
}

async function callGemini(apiKey, userText, images = [], modelOverride = null) {
  const parts = [{ text: buildUserPrompt(userText) }];
  for (const img of images) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
  let geminiData;
  let lastError;
  const modelsToTry = getGeminiModelFallbacks(modelOverride || cache.model);
  for (const model of modelsToTry) {
    for (let attempt = 0; attempt < GEMINI_RETRY_DELAYS.length; attempt++) {
      try {
        geminiData = await fetchGeminiJson(apiKey, model, body);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (!e.retryable || attempt === GEMINI_RETRY_DELAYS.length - 1) break;
        const delays = e.status === 429 ? GEMINI_RETRY_DELAYS_429 : GEMINI_RETRY_DELAYS;
        await sleep(delays[attempt]);
      }
    }
    if (geminiData) break;
    if (!lastError?.retryable) break;
  }
  const res = {
    ok: true,
    json: async () => {
      if (!geminiData) throw (lastError || new Error('Gemini request failed'));
      return geminiData;
    }
  };
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
let progressStartedAt = 0;
let progressTimer = null;

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function updateElapsed() {
  const el = document.getElementById('progressElapsed');
  if (!el || !progressStartedAt) return;
  el.textContent = formatElapsed(Date.now() - progressStartedAt);
}

function showProgress() {
  document.getElementById('progressPanel').classList.remove('hidden');
  progressStartedAt = Date.now();
  if (progressTimer) clearInterval(progressTimer);
  updateElapsed();
  progressTimer = setInterval(updateElapsed, 1000);
  document.querySelectorAll('#progressSteps .step').forEach(el => {
    el.classList.remove('done', 'current');
    el.classList.add('pending');
    el.querySelector('.icon').textContent = '○';
  });
  setProgress(0);
}
function hideProgress() {
  document.getElementById('progressPanel').classList.add('hidden');
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
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
  { key: 'date',             label: '\uB0A0\uC9DC',       type: 'text', align: 'left'  },
  { key: 'sent_time',        label: '\uC804\uC1A1\uC2DC\uAC04',   type: 'text', align: 'left'  },
  { key: 'writer',           label: '\uC791\uC131\uC790',     type: 'text', align: 'left'  },
  { key: 'store',            label: '\uC9C0\uC810',       type: 'text', align: 'left'  },
  { key: 'time_start',       label: '\uC2DC\uC791',       type: 'text', align: 'left'  },
  { key: 'time_end',         label: '\uC885\uB8CC',       type: 'text', align: 'left'  },
  { key: 'item',             label: '\uD488\uBAA9',       type: 'text', align: 'left'  },
  { key: 'unit_price',       label: '\uB2E8\uAC00',       type: 'int',  align: 'right' },
  { key: 'qty',              label: '\uC218\uB7C9',       type: 'int',  align: 'right' },
  { key: 'amount',           label: '\uAE08\uC561',       type: 'int',  align: 'right' },
  { key: 'amount_corrected', label: 'AI\uC815\uC815\uAE08\uC561', type: 'int',  align: 'right' },
  { key: 'total',            label: '\uD569\uACC4',       type: 'int',  align: 'right' },
  { key: 'total_corrected',  label: 'AI\uC815\uC815\uD569\uACC4', type: 'int',  align: 'right' },
  { key: 'source',           label: '\uBD84\uC11D\uBC29\uC2DD',   type: 'text', align: 'left'  },
  { key: 'remark',           label: '\uBE44\uACE0',       type: 'text', align: 'left'  },
];
function renderTable() {
  const tbody = document.getElementById('resultBody');
  tbody.innerHTML = '';
  document.getElementById('resultPanel').classList.toggle('hidden', currentRows.length === 0);
  const visibleRows = currentRows.slice(0, RESULT_PREVIEW_LIMIT);
  const hiddenCount = Math.max(0, currentRows.length - visibleRows.length);
  const notice = document.getElementById('resultPreviewNotice');
  if (notice) {
    notice.classList.toggle('hidden', hiddenCount === 0);
    notice.textContent = hiddenCount > 0
      ? `\uD654\uBA74 \uC131\uB2A5\uC744 \uC704\uD574 ${visibleRows.length.toLocaleString('ko-KR')}\uD589\uB9CC \uBBF8\uB9AC\uBCF4\uAE30\uB85C \uD45C\uC2DC\uD569\uB2C8\uB2E4. \uB098\uBA38\uC9C0 ${hiddenCount.toLocaleString('ko-KR')}\uD589\uC740 \uC800\uC7A5\uB41C \uC5D1\uC140 \uD30C\uC77C\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694.`
      : '';
  }
  document.getElementById('resultSummary').textContent =
    `${currentRows.length.toLocaleString('ko-KR')}\uD589 \u00B7 ${currentRows.filter(r=>r.flag).length.toLocaleString('ko-KR')}\uD589 \uAC80\uD1A0 \uD544\uC694`;

  visibleRows.forEach((row, idx) => {
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
    tdFlag.textContent = row.flag ? '\uD655\uC778' : '';
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
    delBtn.textContent = '\uC0AD\uC81C';
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
  const toIntOrNull = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[, ]/g,''));
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const out = rows.map(r => {
    const o = {
      date: r.date ?? null,
      sent_time: r.sent_time ?? null,
      writer: r.writer ?? null,
      store: r.store ?? null,
      time_start: r.time_start ?? null,
      time_end: r.time_end ?? null,
      item: r.item ?? null,
      unit_price: toIntOrNull(r.unit_price),
      qty: toIntOrNull(r.qty),
      amount: toIntOrNull(r.amount),
      amount_corrected: null,
      total: toIntOrNull(r.total),
      total_corrected: null,
      flag: !!r.flag,
      raw: r.raw ?? '',
      remark: r.remark ?? '',
      source: r.source ?? null,
      processed_at: r.processed_at ?? null,
      ambiguous: !!r.ambiguous,
      estimated: !!r.estimated
    };
    if (!o.ambiguous && !o.estimated && o.unit_price != null && o.qty != null && o.amount != null) {
      o.flag = (o.unit_price * o.qty) !== o.amount;
    }
    if (o.ambiguous) o.flag = true;
    return o;
  });
  // 방어적: 같은 블록에서 writer가 하나라도 있으면 null 행에 복사
  // 블록 키: date|store|time_start|time_end|sent_time — 같은 매장·시간대라도 다른 카톡 메시지면 다른 블록
  const blockKey = r => `${r.date || ''}|${r.store || ''}|${r.time_start || ''}|${r.time_end || ''}|${r.sent_time || ''}`;
  const byBlock = new Map();
  for (const r of out) {
    const k = blockKey(r);
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k).push(r);
  }
  for (const group of byBlock.values()) {
    const found = group.find(r => r.writer && String(r.writer).trim());
    if (!found) continue;
    for (const r of group) if (!r.writer) r.writer = found.writer;
  }
  // AI 정정 금액: 품목 행에서 unit_price×qty ≠ amount면 재계산 값 기록 (일치하면 null)
  for (const r of out) {
    r.amount_corrected = null;
    const hasItem = r.item !== null && r.item !== undefined && String(r.item).trim() !== '';
    if (!r.ambiguous && !r.estimated && hasItem && r.unit_price != null && r.qty != null) {
      const calc = r.unit_price * r.qty;
      if (r.amount != null && calc !== r.amount) r.amount_corrected = calc;
    }
  }
  // 블록별 합계 검증 + AI 정정 합계
  for (const group of byBlock.values()) {
    const itemRows = group.filter(r => r.item !== null && r.item !== undefined && String(r.item).trim() !== '');
    const subtotal = group.find(r => (r.item === null || r.item === undefined || String(r.item).trim() === '') && r.total != null);
    if (!subtotal) continue;
    subtotal.total_corrected = null;
    if (itemRows.length === 0) continue;
    // 검증용: Σ(amount) — 모든 품목에 amount 있을 때만
    if (itemRows.every(r => r.amount != null)) {
      const sumAmt = itemRows.reduce((s, r) => s + r.amount, 0);
      if (sumAmt !== subtotal.total) subtotal.flag = true;
    }
    // 정정용: Σ(unit_price × qty) — 단가·수량 있는 품목만 부분 합산 (일부 누락이어도 가능)
    if (itemRows.some(r => r.ambiguous || r.estimated)) continue;
    const calcable = itemRows.filter(r => !r.ambiguous && r.unit_price != null && r.qty != null);
    if (calcable.length === itemRows.length) {
      const sumCalc = calcable.reduce((s, r) => s + (r.unit_price * r.qty), 0);
      if (sumCalc !== subtotal.total) subtotal.total_corrected = sumCalc;
    }
  }
  // 최종 정렬: 날짜 → 전송시간 → 원래 순서 (안정 정렬로 블록 내 품목→소계 순서 유지)
  out.forEach((r, i) => r._idx = i);
  out.sort((a, b) => {
    const dA = a.date || '';
    const dB = b.date || '';
    if (dA !== dB) return dA < dB ? -1 : 1;
    const tA = a.sent_time || '';
    const tB = b.sent_time || '';
    if (tA !== tB) return tA < tB ? -1 : 1;
    return a._idx - b._idx;
  });
  out.forEach(r => delete r._idx);

  // 하루 단위 총합 행을 각 날짜 섹션 끝에 삽입
  // 총합 = Σ(소계의 total) / AI정정총합 = Σ(소계.total_corrected ?? total)
  const isSubtotal = r => (r.item === null || r.item === undefined || String(r.item).trim() === '') && r.total != null;
  const final = [];
  let curDate = undefined;
  let curStart = 0;
  const flushDaily = (endExclusive) => {
    if (curDate == null) return;
    const slice = out.slice(curStart, endExclusive);
    const subtotals = slice.filter(isSubtotal);
    if (subtotals.length === 0) return;
    const sumOrig = subtotals.reduce((s, r) => s + (r.total || 0), 0);
    const sumCorr = subtotals.reduce((s, r) => s + (r.total_corrected != null ? r.total_corrected : (r.total || 0)), 0);
    final.push({
      date: curDate,
      sent_time: null, writer: null, store: null,
      time_start: null, time_end: null,
      item: '📊 일일 총합',
      unit_price: null, qty: null, amount: null, amount_corrected: null,
      total: sumOrig,
      total_corrected: (sumOrig !== sumCorr) ? sumCorr : null,
      flag: sumOrig !== sumCorr,
      raw: '일일 총합',
      processed_at: null
    });
  };
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (r.date !== curDate) {
      flushDaily(i);
      curDate = r.date;
      curStart = i;
    }
    final.push(r);
  }
  flushDaily(out.length);
  return final;
}

function parseMoneyLike(text) {
  if (!text) return null;
  const src = String(text);
  const re = /\d[\d,.]*/g;
  let last = null;
  let lastEnd = -1;
  let m;
  while ((m = re.exec(src))) {
    last = m[0];
    lastEnd = m.index + m[0].length;
  }
  if (last == null) return null;
  let n = Number(last.replace(/[,.]/g, ''));
  if (!Number.isFinite(n)) return null;
  // "40만원" → 400,000
  if (/^\s*만/.test(src.slice(lastEnd))) n *= 10000;
  return Math.round(n);
}

function parseLocalNumberToken(v) {
  const n = Number(String(v || '').replace(/[,.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function formatWonLocal(n) {
  return Number.isFinite(n) ? `${n.toLocaleString('ko-KR')}\uC6D0` : '';
}

function inferTwoPointRangeBreakdown(low, high, qty, amount) {
  if (![low, high, qty, amount].every(Number.isFinite)) return null;
  if (low <= 0 || high <= 0 || qty <= 0 || low === high) return null;
  const diff = high - low;
  const highQtyRaw = (amount - (low * qty)) / diff;
  const highQty = Math.round(highQtyRaw);
  if (Math.abs(highQtyRaw - highQty) > 1e-9) return null;
  const lowQty = qty - highQty;
  if (lowQty < 0 || highQty < 0) return null;
  if ((low * lowQty) + (high * highQty) !== amount) return null;
  return { lowQty, highQty };
}

function makeRangeRemark(low, high, qty, amount) {
  const base = `\uBC94\uC704\uB85C \uBCF4\uACE0 \uB2E8\uAC00 ${formatWonLocal(low)} ~ ${formatWonLocal(high)}`;
  const inferred = inferTwoPointRangeBreakdown(low, high, qty, amount);
  if (!inferred) return base;
  return `${base}; ${formatWonLocal(low)} ${inferred.lowQty}\uAC1C + ${formatWonLocal(high)} ${inferred.highQty}\uAC1C = ${formatWonLocal(amount)} (\uCD94\uC815)`;
}

function parseTimeRangeLocal(text) {
  const src = String(text || '');
  let m = src.match(/(\d{1,2})\s*(?:시)?\s*[~\-]\s*(\d{1,2})\s*(?:시)?/);
  if (!m) m = src.match(/(\d{1,2})\s*(?:시|時|\?{2}|쒌뀫)\s*(?:~|\-|부터|쒌뀫)?\s*(\d{1,2})\s*(?:시|時|\?{2})/);
  if (!m) return { time_start: null, time_end: null };
  const start = Math.max(0, Math.min(23, Number(m[1])));
  const end = Math.max(0, Math.min(23, Number(m[2])));
  return {
    time_start: `${String(start).padStart(2, '0')}:00`,
    time_end: `${String(end).padStart(2, '0')}:00`
  };
}

function cleanLocalItemName(name) {
  const cleaned = String(name || '')
    .replace(/^[\s\-:·]+/, '')
    .replace(/[\s\-:·]+$/, '')
    .replace(/\b(행사결과|시간|총|합계)\b/g, '')
    .replace(/\d+\s*(개|봉|팩|박스|ea)$/i, '')
    .trim();
  if (!cleaned || !/[A-Za-z가-힣]/.test(cleaned)) return null;
  return cleaned;
}

function looksLikeTotalLine(line) {
  const s = String(line || '');
  // "목표 40만원"은 목표치일 뿐 실적 합계가 아니다 ("목포"는 흔한 오타)
  if (/목[표포]/.test(s) && !/(실적|총|합계|판매|매출|결과)/.test(s)) {
    // 단, "목표 40만원 / 382,340원"처럼 목표 뒤에 실적 금액을 병기하면 합계로 인정
    const tokens = s.match(/\d[\d,.]*\s*만?\s*원?/g) || [];
    return tokens.length >= 2 && /[\d,.]{4,}/.test(tokens[tokens.length - 1]);
  }
  return /(총|합계|소계|행사결과|실적|매출|판매액|판매금액|결과|total)/i.test(s)
    && (/[\d,]{3,}/.test(s) || /\d+\s*만\s*원/.test(s));
}

// 카톡 입력 중 계산식이 줄 중간에서 끊긴 경우 복원
// 예: "부추창펀 390×2" ↵ "6개×6980=41,880" ↵ "원" → 한 줄로 병합
function repairBrokenLines(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out.length ? out[out.length - 1] : null;
    if (prev) {
      if (/^원\.?$/.test(line)) { out[out.length - 1] = prev + line; continue; }
      const prevCutMidCalc = /[xX×*횞]\s*[\d,.]*$/.test(prev);
      const contHead = /^(?:[\d,.]{0,4}\s*개\s*[xX×*횞]|[xX×*횞]|=)/.test(line);
      if (prevCutMidCalc && contHead) { out[out.length - 1] = prev + line; continue; }
      if (/^=/.test(line) && /[\d,.]$/.test(prev)) { out[out.length - 1] = prev + line; continue; }
    }
    out.push(line);
  }
  return out;
}

// 금액/계산식이 있는 줄 = 품목 행으로 변환되어야 할 줄
function isSignalLine(line) {
  const s = String(line || '');
  if (looksLikeTotalLine(s)) return false;
  if (/목[표포]/.test(s)) return false;
  const hasCalc = /[0-9]\s*[xX×*횞]\s*[0-9]/.test(s) || (/[xX×*횞]/.test(s) && /[\d,.]{3,}/.test(s));
  const hasMoney = /[\d,][\d,.]{2,}\s*원/.test(s) || /=\s*[\d,.]{2,}/.test(s);
  return hasCalc || hasMoney;
}

// 로컬 파싱 결과가 원문을 충분히 커버했는지 검증.
// 불충분하면 하이브리드 모드에서 해당 메시지를 통째로 AI에 재처리시킨다.
function assessLocalParse(msg, parsed) {
  const reasons = [];
  const lines = parsed.lines
    || repairBrokenLines(String(msg?.body || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  const signalCount = lines.filter(isSignalLine).length;
  const itemRows = parsed.rows.filter(r => r.item != null && String(r.item).trim() !== '');
  const subtotal = parsed.rows.find(r => (r.item == null || String(r.item).trim() === '') && r.total != null);
  if (itemRows.length < signalCount) {
    reasons.push(`금액 줄 ${signalCount}개 중 ${itemRows.length}개만 인식`);
  }
  if (!subtotal && lines.some(looksLikeTotalLine)) {
    reasons.push('합계 줄 미인식');
  }
  if (subtotal && subtotal.total > 0 && itemRows.length > 0
      && itemRows.every(r => Number.isFinite(r.amount))) {
    const sum = itemRows.reduce((s, r) => s + r.amount, 0);
    if (Math.abs(sum - subtotal.total) / subtotal.total > 0.15) {
      reasons.push(`품목합(${sum.toLocaleString()})과 보고 합계(${subtotal.total.toLocaleString()}) 큰 차이`);
    }
  }
  if (signalCount > 0 && itemRows.some(r => r.amount == null && (r.unit_price == null || r.qty == null))) {
    reasons.push('금액 미확정 품목');
  }
  return { ok: reasons.length === 0, reasons };
}

function parseItemLineLocal(line, fallbackItem) {
  const text = String(line || '').trim();
  if (!text || looksLikeTotalLine(text)) return null;
  const mul = '[xX×*횞]';
  // ×가 두 번 나오는 계산식: "새우하가우 320g×2개×6980=41,880원", "부추창펀 390×26개×6980=41,880원"
  // 규격·수량·단가 해석이 엇갈리므로 금액÷단가로 수량을 검증/추정한다.
  const doubleMulRe = new RegExp(`^(.+?)\\s*([0-9][\\d,.]*)\\s*(?:g|kg|ml|l|L)?\\s*${mul}\\s*([0-9][\\d,.]*)\\s*(?:개|봉|팩|박스|ea)?\\s*${mul}\\s*([0-9][\\d,.]*)\\s*(?:원)?\\s*=\\s*([0-9][\\d,.]{2,})\\s*(?:원)?$`);
  const dm = text.match(doubleMulRe);
  if (dm) {
    const item = cleanLocalItemName(dm[1]) || fallbackItem || null;
    const n2 = parseLocalNumberToken(dm[3]);
    const price = parseLocalNumberToken(dm[4]);
    const amount = parseLocalNumberToken(dm[5]);
    if (item && Number.isFinite(price) && Number.isFinite(amount) && price > 0) {
      if (Number.isFinite(n2) && price * n2 === amount) {
        return { item, unit_price: price, qty: n2, amount, raw: text };
      }
      if (amount % price === 0) {
        return {
          item, unit_price: price, qty: amount / price, amount, raw: text,
          ambiguous: true,
          remark: `계산식 표기 불명확 — 수량은 금액÷단가(${formatWonLocal(amount)}÷${formatWonLocal(price)})로 추정`
        };
      }
      return {
        item, unit_price: price, qty: Number.isFinite(n2) ? n2 : null, amount, raw: text,
        ambiguous: true,
        remark: '계산식 표기 불명확 — 검토 필요'
      };
    }
  }
  const rangeRe = new RegExp(`^(.+?)[\\s\\-:]*([0-9][\\d,.]{1,7})\\s*[~\\-]\\s*([0-9][\\d,.]{1,7})\\s*${mul}\\s*([0-9][\\d,.]{0,5})?(?:\\s*(?:\\uAC1C|\\uBD09|\\uD329|\\uBC15\\uC2A4|ea))?\\s*=?\\s*([0-9][\\d,.]{2,})?$`);
  const rangeMatch = text.match(rangeRe);
  if (rangeMatch) {
    const low = parseLocalNumberToken(rangeMatch[2]);
    const high = parseLocalNumberToken(rangeMatch[3]);
    const qty = rangeMatch[4] ? parseLocalNumberToken(rangeMatch[4]) : null;
    const amount = rangeMatch[5] ? parseLocalNumberToken(rangeMatch[5]) : null;
    return {
      item: cleanLocalItemName(rangeMatch[1]) || fallbackItem || null,
      unit_price: null,
      qty,
      amount,
      raw: text,
      ambiguous: true,
      price_range_low: low,
      price_range_high: high,
      remark: makeRangeRemark(low, high, qty, amount),
      needsQtyAmount: qty == null,
      needsAmount: qty != null && amount == null
    };
  }
  const patterns = [
    new RegExp(`^(.+?)[\\s\\-:]*([0-9][\\d,.]{1,7})\\s*(?:원)?\\s*${mul}\\s*([0-9][\\d,.]{0,5})(?:\\s*(?:개|봉|팩|박스|ea))?(?:\\s*=\\s*([0-9][\\d,.]{2,}))?`),
    new RegExp(`^(.+?)[\\s\\-:]*([0-9][\\d,.]{0,5})\\s*(?:개|봉|팩|박스|ea)?\\s*${mul}\\s*([0-9][\\d,.]{1,7})(?:\\s*(?:원))?(?:\\s*=\\s*([0-9][\\d,.]{2,}))?`)
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    let item = cleanLocalItemName(m[1]);
    if (!item && fallbackItem && /^\s*[0-9]/.test(text)) continue;
    let a = Number(String(m[2]).replace(/[,.]/g, ''));
    let b = Number(String(m[3]).replace(/[,.]/g, ''));
    const amount = m[4] ? Number(String(m[4]).replace(/[,.]/g, '')) : null;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    let unit_price = a;
    let qty = b;
    if (a < 1000 && b >= 1000) {
      qty = a;
      unit_price = b;
    }
    return { item: item || fallbackItem || null, unit_price, qty, amount: Number.isFinite(amount) ? amount : null, raw: text, needsAmount: !Number.isFinite(amount) };
  }
  const qtyAmount = text.match(/^(.+?)[\s\-:]*([0-9][\d,.]{0,5})\s*(?:개|봉|팩|박스|ea)?\s*[~\-]\s*([0-9][\d,.]{2,})\s*(?:원)?$/i);
  if (qtyAmount) {
    const qty = Number(qtyAmount[2].replace(/[,.]/g, ''));
    const amount = Number(qtyAmount[3].replace(/[,.]/g, ''));
    return {
      item: cleanLocalItemName(qtyAmount[1]) || fallbackItem || null,
      unit_price: null,
      qty: Number.isFinite(qty) ? qty : null,
      amount: Number.isFinite(amount) ? amount : null,
      raw: text
    };
  }
  const numericOnly = new RegExp(`^([0-9][\\d,.]{0,7})\\s*(?:원)?\\s*${mul}\\s*([0-9][\\d,.]{0,5})(?:\\s*(?:개|봉|팩|박스|ea))?(?:\\s*\\([^)]*\\))?(?:\\s*=\\s*([0-9][\\d,.]{2,}))?\\s*(?:원)?$`).exec(text);
  if (numericOnly && fallbackItem) {
    let a = Number(numericOnly[1].replace(/[,.]/g, ''));
    let b = Number(numericOnly[2].replace(/[,.]/g, ''));
    const amount = numericOnly[3] ? Number(numericOnly[3].replace(/[,.]/g, '')) : null;
    let unit_price = a;
    let qty = b;
    if (a < 1000 && b >= 1000) {
      qty = a;
      unit_price = b;
    }
    return { item: fallbackItem, unit_price, qty, amount: Number.isFinite(amount) ? amount : null, raw: text };
  }
  // 품목명 + 금액만 있는 줄: "기타   34,100원"
  const nameAmount = text.match(/^([^\d=~×xX*]{1,40}?)\s+([\d,.]{4,})\s*원$/);
  if (nameAmount) {
    const item = cleanLocalItemName(nameAmount[1]);
    const amount = parseLocalNumberToken(nameAmount[2]);
    if (item && Number.isFinite(amount) && amount >= 1000) {
      return { item, unit_price: null, qty: null, amount, raw: text };
    }
  }
  return null;
}

function parseCalcOnlyLocal(line) {
  const text = String(line || '').trim();
  const m = text.match(/^([0-9][\d,.]{1,7})\s*(?:원)?\s*[xX×*횞]\s*([0-9][\d,.]{0,5})(?:\s*(?:개|봉|팩|박스|ea))?(?:\s*\([^)]*\))?\s*=?\s*([0-9][\d,.]{2,})?\s*(?:원)?$/);
  if (!m) return null;
  let a = Number(m[1].replace(/[,.]/g, ''));
  let b = Number(m[2].replace(/[,.]/g, ''));
  const amount = m[3] ? Number(m[3].replace(/[,.]/g, '')) : null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let unit_price = a;
  let qty = b;
  if (a < 1000 && b >= 1000) {
    qty = a;
    unit_price = b;
  }
  return {
    unit_price,
    qty,
    amount: Number.isFinite(amount) ? amount : null,
    raw: text,
    needsAmount: /=$/.test(text) || amount == null
  };
}

function parseQtyOnlyItemLocal(line) {
  const text = String(line || '').trim();
  if (!text || /^총/.test(text) || looksLikeTotalLine(text) || /[xX×*횞=]/.test(text)) return null;
  const m = text.match(/^(.+?)[\s\-:]*([0-9][\d,.]{0,5})\s*(?:개|봉|팩|박스|ea)$/i);
  if (!m) return null;
  const item = cleanLocalItemName(m[1]);
  const qty = parseLocalNumberToken(m[2]);
  if (!item || !Number.isFinite(qty)) return null;
  return {
    item,
    unit_price: null,
    qty,
    amount: null,
    raw: text,
    needsAmount: true,
    qtyOnly: true
  };
}

function parseInlineItemsLocal(line) {
  const text = String(line || '').trim();
  if (!text || looksLikeTotalLine(text)) return [];
  const out = [];
  const calcRe = /([^0-9=~\n]{2,40}?)([0-9][\d,.]{1,7})\s*[xX×*횞]\s*([0-9][\d,.]{0,5})(?:\s*(?:개|봉|팩|박스|ea))?\s*=?\s*([0-9][\d,.]{2,})?/g;
  for (const m of text.matchAll(calcRe)) {
    const item = cleanLocalItemName(m[1]);
    if (!item) continue;
    let a = Number(m[2].replace(/[,.]/g, ''));
    let b = Number(m[3].replace(/[,.]/g, ''));
    const amount = m[4] ? Number(m[4].replace(/[,.]/g, '')) : null;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    let unit_price = a;
    let qty = b;
    if (a < 1000 && b >= 1000) {
      qty = a;
      unit_price = b;
    }
    out.push({
      item,
      unit_price,
      qty,
      amount: Number.isFinite(amount) ? amount : null,
      raw: m[0].trim()
    });
  }
  const qtyAmountRe = /([^0-9=~\n]{2,40}?)([0-9][\d,.]{0,5})\s*(?:개|봉|팩|박스|ea)?\s*[~\-]\s*([0-9][\d,.]{2,})/g;
  for (const m of text.matchAll(qtyAmountRe)) {
    const item = cleanLocalItemName(m[1]);
    if (!item) continue;
    const qty = Number(m[2].replace(/[,.]/g, ''));
    const amount = Number(m[3].replace(/[,.]/g, ''));
    if (!Number.isFinite(qty) || !Number.isFinite(amount)) continue;
    out.push({
      item,
      unit_price: null,
      qty,
      amount,
      raw: m[0].trim()
    });
  }
  return out;
}

function parseReportLocal(msg) {
  const lines = repairBrokenLines(String(msg.body || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  const joined = lines.join('\n');
  const time = parseTimeRangeLocal(joined);
  let store = null;
  let pendingItem = null;
  let pendingCalcRow = null;
  let total = null;
  const residualRows = [];
  const rows = [];
  for (const line of lines) {
    if (pendingCalcRow && pendingCalcRow.needsQtyAmount) {
      const qtyAmount = String(line || '').trim().match(/^([0-9][\d,.]{0,5})\s*=\s*([0-9][\d,.]{2,})\s*(?:원)?$/);
      if (qtyAmount) {
        pendingCalcRow.qty = parseLocalNumberToken(qtyAmount[1]);
        pendingCalcRow.amount = parseLocalNumberToken(qtyAmount[2]);
        pendingCalcRow.raw = `${pendingCalcRow.raw} ${line}`;
        if (pendingCalcRow.ambiguous) {
          pendingCalcRow.remark = makeRangeRemark(pendingCalcRow.price_range_low, pendingCalcRow.price_range_high, pendingCalcRow.qty, pendingCalcRow.amount);
        }
        delete pendingCalcRow.needsQtyAmount;
        delete pendingCalcRow.needsAmount;
        rows.push(pendingCalcRow);
        pendingCalcRow = null;
        continue;
      }
    }
    if (pendingCalcRow && /^=?\s*[\d,.]{3,}\s*(?:원)?$/.test(line)) {
      const amount = parseMoneyLike(line);
      if (amount != null && pendingCalcRow.amount == null) pendingCalcRow.amount = amount;
      pendingCalcRow.raw = `${pendingCalcRow.raw} ${line}`;
      if (pendingCalcRow.ambiguous) {
        pendingCalcRow.remark = makeRangeRemark(pendingCalcRow.price_range_low, pendingCalcRow.price_range_high, pendingCalcRow.qty, pendingCalcRow.amount);
      }
      rows.push(pendingCalcRow);
      pendingCalcRow = null;
      continue;
    }
    if (pendingCalcRow) {
      rows.push(pendingCalcRow);
      pendingCalcRow = null;
    }
    if (!store && /(마트|점|트레이더스|이마트|홈플|코스트코|농협|매장|지점)/.test(line) && !/[xX×*=]/.test(line)) {
      store = line;
      continue;
    }
    if (looksLikeTotalLine(line)) {
      total = parseMoneyLike(line);
      continue;
    }
    // "목표 40만원" 등 목표치 줄은 품목/합계 어느 쪽으로도 쓰지 않는다
    if (/목[표포]/.test(line)) continue;
    if (/^\d{1,2}\s*(?:시)?\s*[~\-]\s*\d{1,2}\s*(?:시)?$/.test(line)) continue;
    if (/^(시간|행사결과|보고|정산)$/i.test(line)) continue;
    const inlineItems = parseInlineItemsLocal(line);
    if (inlineItems.length > 1) {
      for (const inline of inlineItems) {
        rows.push({
          date: msg.date || null,
          sent_time: msg.time || null,
          writer: msg.writer || null,
          store,
          time_start: time.time_start,
          time_end: time.time_end,
          item: inline.item,
          unit_price: inline.unit_price,
          qty: inline.qty,
          amount: inline.amount,
          total: null,
          flag: false,
          raw: inline.raw,
          source: 'local'
        });
      }
      pendingItem = null;
      continue;
    }
    const item = parseItemLineLocal(line, pendingItem);
    if (item && item.item) {
      const row = {
        date: msg.date || null,
        sent_time: msg.time || null,
        writer: msg.writer || null,
        store,
        time_start: time.time_start,
        time_end: time.time_end,
        item: item.item,
        unit_price: item.unit_price,
        qty: item.qty,
        amount: item.amount,
        total: null,
        flag: false,
        raw: item.raw,
        source: 'local',
        ambiguous: !!item.ambiguous,
        price_range_low: item.price_range_low,
        price_range_high: item.price_range_high,
        remark: item.remark ?? '',
        needsQtyAmount: !!item.needsQtyAmount,
        needsAmount: !!item.needsAmount
      };
      if (row.needsQtyAmount || row.needsAmount || (row.amount == null && /=\s*$/.test(item.raw))) pendingCalcRow = row;
      else rows.push(row);
      pendingItem = null;
      continue;
    }
    const qtyOnly = parseQtyOnlyItemLocal(line);
    if (qtyOnly && qtyOnly.item) {
      const row = {
        date: msg.date || null,
        sent_time: msg.time || null,
        writer: msg.writer || null,
        store,
        time_start: time.time_start,
        time_end: time.time_end,
        item: qtyOnly.item,
        unit_price: null,
        qty: qtyOnly.qty,
        amount: null,
        total: null,
        flag: false,
        raw: qtyOnly.raw,
        source: 'local',
        residual: true
      };
      pendingCalcRow = row;
      residualRows.push(row);
      pendingItem = null;
      continue;
    }
    const calcOnly = parseCalcOnlyLocal(line);
    if (calcOnly && pendingItem) {
      const row = {
        date: msg.date || null,
        sent_time: msg.time || null,
        writer: msg.writer || null,
        store,
        time_start: time.time_start,
        time_end: time.time_end,
        item: cleanLocalItemName(pendingItem),
        unit_price: calcOnly.unit_price,
        qty: calcOnly.qty,
        amount: calcOnly.amount,
        total: null,
        flag: false,
        raw: calcOnly.raw,
        source: 'local'
      };
      if (calcOnly.needsAmount) pendingCalcRow = row;
      else rows.push(row);
      pendingItem = null;
      continue;
    }
    if (!/[xX×*횞=]/.test(line) && /[A-Za-z가-힣]/.test(line) && line.length <= 40 && !looksLikeTotalLine(line) && !parseTimeRangeLocal(line).time_start && !/(님이|사진|동영상|이모티콘)/.test(line)) {
      pendingItem = line;
    }
  }
  if (pendingCalcRow) rows.push(pendingCalcRow);
  if (!store) {
    store = lines.find(line => !/[xX×*=]/.test(line) && !parseTimeRangeLocal(line).time_start && !looksLikeTotalLine(line)) || null;
    rows.forEach(r => { if (!r.store) r.store = store; });
  }
  // \uB2E8\uAC00\u00D7\uC218\uB7C9\uC774 \uD655\uC815\uB41C \uD589\uC740 \uD569\uACC4 \uC874\uC7AC \uC5EC\uBD80\uC640 \uBB34\uAD00\uD558\uAC8C \uAE08\uC561\uC744 \uCC44\uC6B4\uB2E4
  for (const r of rows) {
    if (!r.ambiguous && r.amount == null && r.unit_price != null && r.qty != null) {
      if (/1\s*\+\s*1/.test(String(r.raw || '')) && r.qty % 2 === 0) {
        r.amount = r.unit_price * (r.qty / 2);
        r.estimated = true;
        r.remark = r.remark || '1+1 \uAE30\uC900 \uC218\uB7C9 \uC808\uBC18\uC73C\uB85C \uCD94\uC815';
      } else {
        r.amount = r.unit_price * r.qty;
      }
    }
  }
  if (total != null && rows.length > 0) {
    const unresolvedResiduals = residualRows.filter(r => r.amount == null);
    if (unresolvedResiduals.length === 1) {
      const knownSum = rows.reduce((sum, r) => sum + (Number.isFinite(r.amount) ? r.amount : 0), 0);
      const rest = total - knownSum;
      if (rest >= 0) {
        unresolvedResiduals[0].amount = rest;
        unresolvedResiduals[0].remark = '\uD569\uACC4 \uCC28\uC561\uC73C\uB85C \uC0B0\uCD9C';
      }
    }
    rows.push({
      date: msg.date || null,
      sent_time: msg.time || null,
      writer: msg.writer || null,
      store,
      time_start: time.time_start,
      time_end: time.time_end,
      item: null,
      unit_price: null,
      qty: null,
      amount: null,
      total,
      flag: false,
      raw: '소계',
      source: 'local'
    });
  }
  return { rows, unresolved: rows.length === 0, lines };
}

function isBulkWorkload({ fileSize = 0, messageCount = 0, candidateCount = 0 } = {}) {
  return fileSize >= BULK_FILE_BYTES || messageCount >= BULK_MESSAGE_COUNT || candidateCount >= BULK_CANDIDATE_COUNT;
}

function modelForWorkload(primaryModel, bulk) {
  if (!bulk) return primaryModel || DEFAULT_MODEL;
  if (primaryModel === 'gemini-2.5-flash') return 'gemini-2.5-flash-lite';
  return primaryModel || 'gemini-2.5-flash-lite';
}

function shouldAskAiForReport(msg) {
  const body = String(msg?.body || '');
  if (!body.trim()) return false;
  if (/사진|동영상|이모티콘|Voice Note/.test(body) && body.trim().length < 20) return false;
  const hasMoney = /[\d,.]{3,}\s*(원|$)/m.test(body);
  const hasCalc = /[0-9][\d,.]*\s*[xX×*횞]\s*[0-9]/.test(body);
  const hasTotal = /(총|합계|소계|행사결과|결과|판매|금액|total)/i.test(body);
  const hasQtyAmount = /[0-9]+\s*(개|봉|팩|박스|ea)?\s*[~\-]\s*[\d,.]{3,}/i.test(body);
  return hasCalc || (hasMoney && hasTotal) || hasQtyAmount;
}

function makeReviewRow(item, reason) {
  const m = item.msg || {};
  return {
    date: m.date || null,
    sent_time: m.time || null,
    writer: m.writer || null,
    store: null,
    time_start: null,
    time_end: null,
    item: null,
    unit_price: null,
    qty: null,
    amount: null,
    amount_corrected: null,
    total: null,
    total_corrected: null,
    flag: true,
    raw: `[${reason}] ${m.body || ''}`.slice(0, 2000),
    source: 'review',
    processed_at: null
  };
}

async function processItemsWithMode(items, apiKey, runStamp, onProgress, modelOverride = null) {
  const mode = cache.processMode || 'hybrid';
  const allRows = [];
  const localRawRows = [];
  const aiItems = [];
  const reviewRows = [];
  let localCount = 0;
  let aiCount = 0;
  let skippedCount = 0;
  let reviewCount = 0;
  let escalatedCount = 0;
  if (mode !== 'ai') {
    let scanned = 0;
    for (const item of items) {
      scanned++;
      const parsed = parseReportLocal(item.msg);
      // 로컬 파싱이 행을 만들었어도 원문 커버리지를 검증한다.
      // 불완전하면(금액 줄 누락·합계 미인식·큰 합계 불일치) 메시지 전체를 AI로 넘긴다.
      const quality = parsed.rows.length ? assessLocalParse(item.msg, parsed) : null;
      if (parsed.rows.length && quality.ok) {
        localRawRows.push(...parsed.rows);
        localCount++;
      } else if (mode === 'hybrid' && (parsed.rows.length || shouldAskAiForReport(item.msg))) {
        if (parsed.rows.length) escalatedCount++;
        aiItems.push(item);
      } else if (parsed.rows.length) {
        // 로컬 전용 모드: 불완전해도 파싱된 행은 보존하고 검토 행으로 원문을 남긴다
        parsed.rows.forEach(r => { if (r.item != null) r.flag = true; });
        localRawRows.push(...parsed.rows);
        reviewRows.push(makeReviewRow(item, `로컬 분석 불완전: ${quality.reasons.join(', ')}`));
        localCount++;
        reviewCount++;
      } else {
        skippedCount++;
      }
      if (onProgress && (scanned % 50 === 0 || scanned === items.length)) {
        onProgress(localCount, aiCount, mode === 'hybrid' ? aiItems.length : 0, scanned, items.length);
      }
    }
  } else {
    aiItems.push(...items);
  }
  if (localRawRows.length > 0) {
    const normalized = normalizeRows(localRawRows);
    normalized.forEach(r => {
      r.processed_at = runStamp;
      if (!r.source) r.source = 'local';
    });
    allRows.push(...normalized);
  }
  if (aiItems.length > 0) {
    if (!apiKey) {
      for (const item of aiItems) {
        reviewRows.push(makeReviewRow(item, 'AI key missing'));
        reviewCount++;
      }
      aiItems.length = 0;
    }
    const BATCH = 15;
    let rateLimitedThisBatch = false;
    const runSlice = async (slice) => {
      const combined = slice.map(x => {
        const m = x.msg;
        return `[DATE: ${m.date}] [TIME: ${m.time}] [WRITER: ${m.writer}]\n${m.body}`;
      }).join('\n\n---\n\n');
      try {
        const rows = await callGemini(apiKey, combined, [], modelOverride);
        const normalized = normalizeRows(rows);
        normalized.forEach(r => {
          r.processed_at = runStamp;
          r.source = 'gemini';
        });
        allRows.push(...normalized);
        aiCount += slice.length;
      } catch (e) {
        const status = e && e.status;
        // 응답 파싱 실패 등은 배치 내 문제 메시지 1건이 원인일 수 있으므로
        // 반으로 쪼개 재시도해 나머지 메시지를 살린다. 키/한도 오류는 쪼개도 소용없음.
        if (slice.length > 1 && status !== 403 && status !== 429) {
          const mid = Math.ceil(slice.length / 2);
          await runSlice(slice.slice(0, mid));
          await runSlice(slice.slice(mid));
          return;
        }
        if (status === 429) rateLimitedThisBatch = true;
        for (const item of slice) {
          reviewRows.push(makeReviewRow(item, `AI failed: ${String(e.message || e).slice(0, 180)}`));
          reviewCount++;
        }
      }
      if (onProgress) onProgress(localCount, aiCount, aiItems.length);
    };
    // 3배치 연속 한도 초과면 남은 배치는 즉시 검토 행으로 — 헛된 재시도로 수십 분 끌지 않는다
    let consecutiveRateLimit = 0;
    for (let i = 0; i < aiItems.length; i += BATCH) {
      const slice = aiItems.slice(i, i + BATCH);
      if (consecutiveRateLimit >= 3) {
        for (const item of slice) {
          reviewRows.push(makeReviewRow(item, 'AI 한도 소진 — 나중에 "특정 날짜/기간 지정"으로 다시 처리하세요'));
          reviewCount++;
        }
        continue;
      }
      rateLimitedThisBatch = false;
      await runSlice(slice);
      if (rateLimitedThisBatch) {
        consecutiveRateLimit++;
        await sleep(15000);
      } else {
        consecutiveRateLimit = 0;
      }
    }
  }
  if (reviewRows.length > 0) {
    reviewRows.forEach(r => r.processed_at = runStamp);
    allRows.push(...reviewRows);
  }
  return { rows: allRows, localCount, aiCount, skippedCount, reviewCount, escalatedCount };
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
  const processingMode = cache.processMode || 'hybrid';
  if (processingMode !== 'local' && !cache.activeKeyValue) { toast('먼저 Gemini API Key를 설정에서 등록하세요', 'err'); return; }
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

    // 보고형 필터 + 해시 중복 제거 (명시적 날짜/기간 선택 시 중복검사 우회)
    setStep('dedupe', 'current');
    const candidates = filtered.filter(m => looksLikeReport(m.body));
    const bulk = isBulkWorkload({
      fileSize: selectedFile.size || readRes.size || 0,
      messageCount: filtered.length,
      candidateCount: candidates.length
    });
    const effectiveModel = modelForWorkload(cache.model, bulk);
    const prevHashes = new Set(cache.processedHashes);
    const hashed = candidates.map(m => ({ msg: m, hash: messageHash(m) }));
    const explicitPick = (mode === 'pickDate' || mode === 'custom' || mode === 'all');
    const fresh = explicitPick ? hashed : hashed.filter(x => !prevHashes.has(x.hash));
    const dupCount = hashed.length - fresh.length;
    setStep('dedupe', 'done',
      explicitPick ? `특정 날짜 모드: 중복검사 건너뜀 (${fresh.length}건)`
                   : `신규 ${fresh.length} / 중복 ${dupCount}`);
    setProgress(35);

    document.getElementById('txtPreview').classList.remove('hidden');
    document.getElementById('txtPreview').innerHTML = `
      <div><b>파일</b>: ${escapeHtml(selectedFile.name)}</div>
      <div><b>대상</b>: 전체 ${msgs.length} / 범위내 ${filtered.length} / 보고형 ${candidates.length} / 처리 ${fresh.length}${explicitPick ? ' <span class="text-amber-600">(특정 날짜 · 중복검사 OFF)</span>' : ` / 중복 ${dupCount}`}</div>
    `;
    document.getElementById('txtPreview').insertAdjacentHTML('beforeend',
      `<div><b>AI 모델</b>: ${escapeHtml(effectiveModel)}${bulk ? ' <span class="text-amber-600">(대량 감지: Lite 자동 사용)</span>' : ''}</div>`);

    if (!fresh.length) {
      setStep('ai', 'done', '스킵');
      setStep('excel', 'done', '스킵');
      setProgress(100);
      setTimeout(hideProgress, 800);
      if (candidates.length === 0) {
        toast(`선택한 범위 안에 보고 형태의 메시지가 없습니다 (범위내 ${filtered.length}건)`, 'err', 5000);
      } else if (!explicitPick && dupCount > 0) {
        toast(`전부 이미 처리됨 (${dupCount}건). 강제로 다시 처리하려면 "특정 날짜" 또는 "기간 지정"으로 선택하세요.`, 'err', 6000);
      } else {
        toast(`처리할 항목이 없습니다`, 'err', 4000);
      }
      return;
    }

    // AI 정형화 배치
    setStep('ai', 'current', `local/AI 0/${fresh.length}`);
    const runStamp = nowTimestamp();
    const newHashes = [];
    const processed = await processItemsWithMode(fresh, cache.activeKeyValue, runStamp, (localCount, aiCount, aiTotal, scanned, total) => {
      const doneCount = localCount + aiCount;
      const scanText = total ? ` scan ${scanned}/${total}` : '';
      setStep('ai', 'current', `local ${localCount} / AI ${aiCount}/${aiTotal}${scanText}`);
      setProgress(35 + Math.round((Math.max(doneCount, scanned || 0) / fresh.length) * 50));
    }, effectiveModel);
    const allRows = processed.rows;
    newHashes.push(...fresh.map(x => x.hash));
    setStep('ai', 'done', `local ${processed.localCount} / AI ${processed.aiCount} (재검증 ${processed.escalatedCount}) / review ${processed.reviewCount} / skip ${processed.skippedCount}`);
    setProgress(85);

    currentRows = allRows;
    renderTable();

    // 누적 엑셀에 먼저 append 시도 (해시/마지막날짜 업데이트는 엑셀 성공 시에만)
    setStep('excel', 'current');
    let excelOk = false;
    let excelPending = false;
    const saveRes = await saveRowsByMode(allRows);
    if (saveRes.ok) {
      excelOk = !saveRes.skipped;
      setStep('excel', 'done', saveRes.label || '저장 완료');
      if (!saveRes.skipped) {
        cache.accumulatedRows = cache.accumulatedRows.concat(allRows);
        await kapi.store.set('accumulatedRows', cache.accumulatedRows);
        cache.totalCount += allRows.length;
        await kapi.store.set('totalCount', cache.totalCount);
      }
    } else if (saveRes.code === 'EBUSY' || saveRes.code === 'EPERM' || saveRes.code === 'EACCES') {
      excelPending = true;
      setStep('excel', 'done', '엑셀 열림 - 대기');
      toast('엑셀이 열려있어 저장 불가. Excel을 닫은 뒤 결과 영역의 "누적 파일에 추가" 버튼을 눌러 저장하세요.', 'err', 10000);
    } else {
      throw new Error('엑셀 저장 실패: ' + saveRes.error);
    }

    // 해시/마지막날짜는 엑셀 성공(또는 경로 미설정)일 때만 업데이트
    if (!excelPending) {
      cache.processedHashes = Array.from(new Set([...cache.processedHashes, ...newHashes]));
      await kapi.store.set('processedHashes', cache.processedHashes);
      const maxDate = fresh.reduce((acc, x) => (x.msg.date > acc ? x.msg.date : acc), lastDate || '0000-00-00');
      cache.lastProcessedDate = maxDate;
      await kapi.store.set('lastProcessedDate', maxDate);
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
  const processingMode = cache.processMode || 'hybrid';
  if (processingMode !== 'local' && !cache.activeKeyValue) { toast('먼저 Gemini API Key를 설정에서 등록하세요', 'err'); return; }
  const text = document.getElementById('pasteText').value.trim();
  if (!text) { toast('붙여넣은 내용이 없습니다', 'err'); return; }
  const date = document.getElementById('pasteDate').value || todayYMD();
  cache.draftText = text;
  await kapi.store.set('draftText', text);
  const payload = `[DATE: ${date}]\n` + text;
  try {
    showProgress();
    setStep('read', 'done', '텍스트 입력');
    setStep('filter', 'done', '-');
    setStep('dedupe', 'done', '-');
    setStep('ai', 'current');
    setProgress(40);
    const runStamp = nowTimestamp();
    const item = {
      msg: { date, time: null, writer: null, body: text },
      hash: messageHash({ date, time: '', writer: '', body: text })
    };
    const processed = await processItemsWithMode([item], cache.activeKeyValue, runStamp);
    currentRows = processed.rows;
    renderTable();
    setStep('ai', 'done', `local ${processed.localCount} / AI ${processed.aiCount} (재검증 ${processed.escalatedCount}) / review ${processed.reviewCount} / skip ${processed.skippedCount}`);
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
    const runStamp = nowTimestamp();
    for (let i = 0; i < imgFiles.length; i++) {
      const f = imgFiles[i];
      const b64 = await fileToBase64(f);
      const payload = `[DATE: ${date}]\n위 스크린샷(카카오톡 대화)에서 행사 보고 메시지를 읽어 스키마대로 정형화하라. 메시지 내 날짜가 있으면 그것을 우선한다.`;
      const rows = await callGemini(cache.activeKeyValue, payload, [{ mimeType: f.type || 'image/png', data: b64 }]);
      const normalized = normalizeRows(rows);
      normalized.forEach(r => r.processed_at = runStamp);
      allRows.push(...normalized);
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

async function saveRowsByMode(rows) {
  const mode = cache.saveMode || 'append';
  if (mode === 'manual') return { ok: true, skipped: true, label: '수동 저장 대기' };
  if (mode === 'new') {
    const stamp = todayYMD().replace(/-/g, '') + '_' + new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    const res = await kapi.excel.saveAs(rows, `카톡행사보고_${stamp}.xlsx`);
    if (res.canceled) return { ok: true, skipped: true, label: '새 파일 저장 취소' };
    return { ...res, label: res.ok ? '새 파일 저장' : '새 파일 저장 실패' };
  }
  if (!cache.excelOutputPath) return { ok: true, skipped: true, label: '경로 미설정 - 스킵' };
  const res = await kapi.excel.appendRows(rows, cache.excelOutputPath);
  return { ...res, label: res.ok ? `${rows.length}행 append` : '누적 저장 실패' };
}

document.getElementById('saveAccumulate').addEventListener('click', async () => {
  if (!currentRows.length) { toast('저장할 행이 없습니다', 'err'); return; }
  if (!cache.excelOutputPath) { toast('설정에서 누적 엑셀 저장 경로를 지정하세요', 'err'); return; }
  const res = await kapi.excel.appendRows(currentRows, cache.excelOutputPath);
  if (!res.ok) {
    if (res.code === 'EBUSY' || res.code === 'EPERM' || res.code === 'EACCES') {
      toast('⚠ 엑셀이 열려있어 저장 불가. Excel을 닫고 이 버튼을 다시 누르세요.', 'err', 8000);
    } else {
      toast('저장 실패: ' + res.error, 'err', 6000);
    }
    return;
  }
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

async function doOpenExcel() {
  if (!cache.excelOutputPath) { toast('저장 경로 미설정', 'err'); return; }
  const res = await kapi.files.openPath(cache.excelOutputPath);
  if (!res.ok) toast('열기 실패: ' + res.error, 'err');
}
async function doShowInFolder() {
  if (!cache.excelOutputPath) { toast('저장 경로 미설정', 'err'); return; }
  await kapi.files.showInFolder(cache.excelOutputPath);
}
document.getElementById('openExcel').addEventListener('click', doOpenExcel);
document.getElementById('showInFolder').addEventListener('click', doShowInFolder);
document.getElementById('openExcelDirect')?.addEventListener('click', doOpenExcel);
document.getElementById('openExcelFolder')?.addEventListener('click', doShowInFolder);

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

function renderProcessModeSelect() {
  const sel = document.getElementById('processModeSelect');
  if (!sel) return;
  sel.value = cache.processMode || 'hybrid';
}

function renderSaveModeSelect() {
  const sel = document.getElementById('saveModeSelect');
  if (!sel) return;
  sel.value = cache.saveMode || 'append';
}

document.getElementById('processModeSelect')?.addEventListener('change', async (e) => {
  cache.processMode = e.target.value;
  await kapi.store.set('processMode', cache.processMode);
  toast(`처리 방식 변경: ${cache.processMode}`, 'ok');
});

document.getElementById('saveModeSelect')?.addEventListener('change', async (e) => {
  cache.saveMode = e.target.value;
  await kapi.store.set('saveMode', cache.saveMode);
  toast(`저장 방식 변경: ${cache.saveMode}`, 'ok');
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
  const hint = document.getElementById('accumPathHint');
  if (hint) hint.textContent = cache.excelOutputPath ? `→ ${cache.excelOutputPath}` : '(경로 미설정)';
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
  const hint = document.getElementById('lastDateHint');
  if (hint) {
    hint.textContent = cache.lastProcessedDate
      ? `${cache.lastProcessedDate} 이후만 처리`
      : '처음 실행 · 전체 처리';
  }
  updateApiKeyStatus();
}

async function init() {
  await loadAllSettings();
  document.getElementById('pasteDate').value = todayYMD();
  document.getElementById('imgDate').value = todayYMD();
  document.getElementById('rangePickOne').value = todayYMD();
  if (cache.draftText) document.getElementById('pasteText').value = cache.draftText;
  renderModelSelect();
  renderProcessModeSelect();
  renderSaveModeSelect();
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

  let hideTimer = null;
  function hideBanner() {
    banner.classList.add('hidden');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }
  function autoHide(ms) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { banner.classList.add('hidden'); hideTimer = null; }, ms);
  }

  dismissBtn.addEventListener('click', hideBanner);

  actionBtn.addEventListener('click', async () => {
    if (actionBtn.dataset.action === 'install') {
      if (!confirm('앱이 종료되고 새 버전으로 다시 시작됩니다. 계속할까요?')) return;
      await kapi.update.install();
    } else if (actionBtn.dataset.action === 'logs') {
      const r = await kapi.update.openLogs();
      if (!r.ok) toast('로그 폴더 열기 실패: ' + (r.error || ''), 'err');
    }
  });

  kapi.update.onEvent('checking', () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    showBanner('info');
    icon.textContent = '🔄';
    title.textContent = '업데이트 확인 중...';
    detail.textContent = 'GitHub 릴리스에서 최신 버전을 조회하고 있습니다';
    progWrap.classList.add('hidden');
    actionBtn.classList.add('hidden');
  });

  kapi.update.onEvent('available', (info) => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
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
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
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

  kapi.update.onEvent('notAvailable', (info) => {
    showBanner('info');
    icon.textContent = '✅';
    title.textContent = '최신 버전입니다';
    detail.textContent = info && info.version ? `현재: v${info.version}` : '';
    progWrap.classList.add('hidden');
    actionBtn.classList.add('hidden');
    autoHide(5000);
  });

  kapi.update.onEvent('error', (e) => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    showBanner('error');
    icon.textContent = '⚠️';
    title.textContent = '업데이트 확인 실패';
    detail.textContent = (e && e.message) ? e.message : '알 수 없는 오류';
    progWrap.classList.add('hidden');
    actionBtn.classList.remove('hidden');
    actionBtn.dataset.action = 'logs';
    actionBtn.textContent = '로그 열기';
    console.warn('[updater] error:', e);
  });

  // 헤더 "업데이트 확인" 버튼 (모달 바깥에서 바로 체크)
  document.getElementById('btnHeaderCheck')?.addEventListener('click', async () => {
    const res = await kapi.update.check();
    if (!res.ok) {
      // error 이벤트가 배너를 띄움 — 별도 처리 불필요
    }
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
    await kapi.update.check();
    // checking / notAvailable / error 이벤트가 배너로 결과 표시
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

})();
