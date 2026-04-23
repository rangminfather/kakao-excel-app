# 카톡보고정리 (Kakao Report Organizer)

카카오톡 행사보고 메시지를 Gemini AI로 정형화하여 엑셀에 자동 누적하는 Windows 데스크톱 앱.

## 개요

PC 카톡에서 "대화 내보내기"로 받은 `KakaoTalk*.txt` 파일을 자동 감지해, 날짜별 행사 보고
메시지를 정형화된 엑셀 행으로 변환하고 지정한 엑셀 파일에 누적 저장합니다.

- **Electron** 기반 Windows 데스크톱 앱 (.exe 설치파일로 배포)
- **자동 파일 감지** — 다운로드 폴더에서 최신 .txt 자동 검출
- **중복 방지** — 메시지 해시 기반으로 같은 파일 두 번 처리해도 신규 0건
- **누적 엑셀** — 한 파일에 새 행이 계속 append (덮어쓰기 아님)
- **아카이브 정책** — 처리된 .txt를 유지/이동/삭제/N일 후 정리 중 선택
- **API 키 암호화** — Windows safeStorage(자격 증명 관리자)로 로컬 암호화

## 배포 & 자동 업데이트

### 저장소
- GitHub: https://github.com/rangminfather/kakao-excel-app
- 릴리스 목록: https://github.com/rangminfather/kakao-excel-app/releases
- 친구는 **Releases 페이지의 최신 Setup .exe** 를 한 번만 내려받아 설치하면 됨.

### 자동 업데이트 동작
- 앱 시작 3초 후 GitHub Releases를 조회해 새 버전이 있으면 **백그라운드 다운로드**
- 다운로드 완료되면 상단 배너에 **"지금 설치"** 버튼 표시 (수동 설치 방식)
- 버튼 클릭 → 앱 종료 → NSIS 설치 → 새 버전으로 재실행
- 헤더 우측 "**업데이트 내역**" 링크로 전체 릴리스 노트 모달 확인

### 새 버전 배포 루틴 (개발자)
```bash
# 1. 코드 수정 후 버전 올림
npm version patch  # 1.0.1 → 1.0.2 (자동 commit + tag)

# 2. GitHub 푸시
git push && git push --tags

# 3. 빌드 + GitHub Releases 업로드 (자동)
export GH_TOKEN=$(gh auth token)
npm run release
```
3번 단계에서 electron-builder가:
- `.exe` 설치파일 빌드
- `latest.yml` (버전 메타데이터) 생성
- GitHub Releases에 **draft** 로 업로드

업로드 후 GitHub에서 draft 릴리스를 **publish** 하면 기존 설치본이 다음 실행 시 감지.
(자동으로 publish 하고 싶으면 `package.json` 의 `releaseType` 을 `release` → 유지 중.
즉 `npm run release` 한 번으로 끝. 현재 설정이 그렇게 되어 있음.)

### 첫 배포 (v1.0.0 → v1.0.1)
아무런 설치본이 없는 친구는 [Releases 페이지](https://github.com/rangminfather/kakao-excel-app/releases)에서
`카톡보고정리 Setup 1.0.1.exe` 를 내려받아 설치하면 된다.

### 친구의 설치 & 첫 실행

### Gemini API 키 준비
- https://aistudio.google.com/apikey 접속 (Google 계정 필요)
- "Create API key" → 키 복사
- 무료 티어 한도로 충분 (일 1500회 수준)

### 설치 순서
1. `카톡보고정리 Setup x.y.z.exe` 더블클릭
2. Windows Defender SmartScreen 경고 시 → **"더 많은 정보"** 클릭 → **"실행"**
3. 설치 경로 선택 → 바탕화면 바로가기 자동 생성
4. 앱 실행 → ⚙️ 설정에서:
   - Gemini API Key 등록 (등록명은 아무거나)
   - 감시 폴더 확인 (기본: 다운로드 폴더)
   - 누적 엑셀 저장 경로 지정 (예: `문서/카톡행사보고_누적.xlsx`)
   - 아카이브 모드 선택 (권장: "아카이브 폴더로 이동")

### 매일 사용 흐름
1. PC 카카오톡 → 단톡방 → ☰ → 대화 내용 저장 → **텍스트만** → 저장
   (다운로드 폴더에 `KakaoTalkChats_...txt` 저장됨)
2. 앱 실행 → 메인 화면에 최신 파일 자동 감지 표시
3. 처리 범위 "최근 처리 이후" 기본 → **🚀 추출 실행**
4. 진행률 바 → 완료 알림 → 누적 엑셀이 자동으로 업데이트됨
5. 필요시 **📂 누적 엑셀 열기** 로 결과 확인

## 개발자용 (빌드 방법)

### 필요 조건
- Node.js 18+ (24 권장)
- Windows 10/11

### 로컬 실행
```bash
cd kakao-excel-app
npm install
npm start          # 개발 모드 실행
npm run dev        # DevTools 분리창 열림
```

### 설치파일 빌드
```bash
npm run build
# → dist/카톡보고정리-Setup-1.0.0.exe 생성
```

### 디렉토리 구조
```
kakao-excel-app/
├── package.json
├── main.js              # Electron 메인 프로세스 (파일 시스템/IPC/Store/Excel)
├── preload.js           # contextBridge IPC 브릿지
├── renderer/
│   ├── index.html       # UI
│   └── app.js           # 렌더러 로직 (파싱/해시/Gemini 호출/테이블)
├── assets/
│   └── icon.ico         # 앱 아이콘 (build/make-icon.js로 생성)
├── build/
│   ├── license.txt      # NSIS 라이선스 문구
│   └── make-icon.js     # 아이콘 재생성 스크립트
└── dist/                # 빌드 산출물 (gitignore)
```

## 데이터 저장 위치

| 항목 | 위치 |
|---|---|
| 설정/이력 (processedHashes, accumulatedRows 등) | `%APPDATA%/카톡보고정리/settings.json` |
| API Key | 위 파일 내부에 Windows safeStorage로 암호화 저장 |
| 아카이브 폴더 (기본) | `%USERPROFILE%/KakaoArchive/YYYY-MM/` |
| 누적 엑셀 (기본) | `%USERPROFILE%/Documents/카톡행사보고_누적.xlsx` |

## 정형화 스키마 (엑셀 컬럼)

`날짜 | 작성자 | 지점 | 시작시간 | 종료시간 | 품목 | 단가 | 수량 | 금액 | 합계 | 검증오류 | 원본`

- `unit_price × qty !== amount` 이면 **검증오류=X** + 빨간 배경
- `총-...원` 같은 합계값은 해당 메시지의 **마지막 품목 행에만** 기록

## 한계 / 주의사항

- **Windows 전용 빌드** — 현재 설정은 `--win --x64`. 다른 플랫폼은 build 섹션 수정 필요.
- **코드 서명 없음** — Windows SmartScreen 경고가 뜰 수 있음. 친구에게 "더 많은 정보 → 실행"으로 안내.
- **카톡 .txt 한글 인코딩** — UTF-8/UTF-16 BOM 모두 지원 (PC 카톡 기본 UTF-8).
- **API 과금** — Gemini 무료 티어 초과 시 결제 필요. 한도 초과(429) 시 Lite 모델로 전환.
- **원본 메시지 전송** — 정형화 요청 시 카톡 메시지 본문이 Google Gemini API 서버로 전송됨.

## 자주 묻는 질문

**Q. 같은 파일을 다시 처리하면?**
A. 메시지 단위로 해시를 저장하므로 "신규 0건"으로 표시. 덮어쓰기 없음.

**Q. 친구가 여러 번 파일 저장해서 파일명이 쌓였을 때는?**
A. 감시 폴더에서 수정시각 기준 가장 최신 `KakaoTalk*.txt` 하나만 자동 감지. 다른 파일은 "직접 선택"으로.

**Q. 잘못 처리된 행을 수정하려면?**
A. 결과 테이블의 각 셀을 클릭하면 직접 편집 가능. 단가/수량/금액 수정 시 검증오류가 자동 재계산됨.

**Q. 월 단위로 엑셀을 분리하고 싶다면?**
A. 월초에 설정 → 누적 엑셀 저장 경로를 새 파일로 변경.

## 에러 매핑

| 오류 | 원인 | 해결 |
|---|---|---|
| 429 | Gemini 무료 티어 한도 초과 | 잠시 대기 또는 Lite 모델 전환 |
| 400 | 프롬프트 구조 문제 / 키 형식 오류 | 키 재확인 |
| 403 | 키 권한 부족 | 새 키 발급 |
| 엑셀 저장 실패 | 파일이 Excel에서 열려 있음 | 엑셀 종료 후 재시도 |
