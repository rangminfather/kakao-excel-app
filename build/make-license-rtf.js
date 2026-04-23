// license.txt → license.rtf 변환 (NSIS Korean 대응)
// RTF \uN? 이스케이프로 한글 유니코드를 안전하게 표현
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'license.txt'), 'utf8');

function escapeRtf(ch) {
  const cp = ch.codePointAt(0);
  if (ch === '\\') return '\\\\';
  if (ch === '{')  return '\\{';
  if (ch === '}')  return '\\}';
  if (ch === '\r') return '';
  if (ch === '\n') return '\\par\n';
  if (cp < 0x80) return ch;
  // BMP 문자: 부호 있는 16bit 정수로 표현. 32767 초과는 65536 뺌.
  if (cp <= 0xFFFF) {
    const signed = cp > 32767 ? cp - 65536 : cp;
    return `\\u${signed}?`;
  }
  // Surrogate pair가 필요한 이모지 등 — 대부분 라이선스엔 없음
  const str = String.fromCodePoint(cp);
  const hi = str.charCodeAt(0);
  const lo = str.charCodeAt(1);
  const h = hi > 32767 ? hi - 65536 : hi;
  const l = lo > 32767 ? lo - 65536 : lo;
  return `\\u${h}?\\u${l}?`;
}

let body = '';
for (const ch of src) body += escapeRtf(ch);

// RTF 1.5, ANSI + 한글 코드페이지 fallback, 맑은 고딕(UI 기본) 사용
const rtf =
`{\\rtf1\\ansi\\ansicpg949\\deff0\\nouicompat\\deflang1042
{\\fonttbl{\\f0\\fnil\\fcharset129 Malgun Gothic;}}
\\viewkind4\\uc1\\pard\\sa120\\f0\\fs22 ${body}\\par
}`;

const outPath = path.join(__dirname, 'license.rtf');
fs.writeFileSync(outPath, rtf, 'utf8');
console.log(`RTF written: ${outPath} (${rtf.length} chars)`);
