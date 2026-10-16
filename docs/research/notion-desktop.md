# 설치된 Notion Desktop 정적 조사

2026-10-16 (Asia/Seoul), 사용자가 설치한 `/Applications/Notion.app`의 배포 리소스를 읽기 전용으로 조사했다. [웹 공개 자산 조사](./notion-rea.md)와 별도의 실행이다. 앱을 실행하거나 원본을 수정하지 않았으며, 계정 데이터·브라우저 프로필·쿠키·토큰·개인 문서는 읽지 않았다. 앱 문자열은 분석 자료로만 취급했다.

## 원본 식별과 범위

Info.plist에서 버전과 빌드 `7.39.0`, Bundle ID `notion.id`를 확인했다. Info.plist, 실행 파일, ASAR의 SHA-256은 [축약 증거](./rea-desktop-evidence.json)에 있다. 실행 파일은 해시만 계산했으며 네이티브 코드나 Frameworks는 분석하지 않았다. 이 해시들은 개별 파일 식별자이며 전체 앱 번들 트리의 해시나 코드 서명 검증 결과가 아니다.

`Contents/Resources/app.asar`는 13,494,814바이트이고 SHA-256은 `889137431e69a9e8795b88cb071d451f5592797dcfe4ca13499dcb23ddc8d8ac`다. 헤더 JSON의 SHA-256 `40a7925026db8fbf7f11af44736987d0482d728bf242b6876decaae5a48a4c54`는 Info.plist의 ElectronAsarIntegrity 값과 일치했다. 전체 ASAR 해시와 헤더 해시는 서로 다른 범위를 식별한다.

Resources의 직계 항목은 65개다. ASAR 헤더의 파일 항목은 207개(JS 98, JSON 49, HTML 9 포함)이며 4개는 unpacked 표시다. 네이티브 unpacked 파일은 열거나 분석하지 않았다. 표준 Node 라이브러리로 헤더를 파싱하고 아래 세 파일만 REA 입력으로 추출했다.

| ASAR 내부 경로 | 바이트 | 분석 목적 |
| --- | ---: | --- |
| `.webpack/main/SqliteServer.js` | 100,970 | 로컬 SQLite 서버의 정적 구조 |
| `.webpack/renderer/migration/preload.js` | 3,048 | 저장소 마이그레이션과 IPC |
| `.webpack/renderer/windows_and_tabs/preload.js` | 2,074 | 작은 preload의 Electron API 연결 |

합계는 106,092바이트다. 추가로 `package.json`(3,712바이트), tab browser preload(399,524바이트)는 해시와 일부 문자열 위치만 확인했다. 이 두 파일은 REA 입력에 포함하지 않았다. 패키지의 main 선언은 `./.webpack/main`이었다. 4.4 MB main bundle이나 전체 앱을 분석했다는 의미는 아니다.

## 실제 실행한 REA 명령

기존 독립 npm 캐시에 있는 REA 4.1.0을 재사용했다. `rea --help`와 아래 명령의 도움말에서 `ASAR or extracted application path`, `--artifact-format <auto|asar|directory>` 지원을 확인했다. 전체 ASAR 분석은 피하고 선정 파일의 디렉터리를 입력했다.

```sh
npm --cache /tmp/fountain-rea-research/npm-cache exec --yes --package=rea-agents@4.1.0 -- rea analyze-javascript-application --help
npm --cache /tmp/fountain-rea-research/npm-cache exec --yes --package=rea-agents@4.1.0 -- rea analyze-javascript-application /tmp/fountain-notion-desktop-7.39.0/target --json > /tmp/fountain-notion-desktop-7.39.0/application-evidence-4.1.0.json 2> /tmp/fountain-notion-desktop-7.39.0/analysis-progress-4.1.0.jsonl
```

exit 0으로 완료했다. 파싱한 JS 3개, AST 노드 32,200개, findings 33개, graph 노드 40개·edge 42개, 파싱 실패 0개·잘린 범위 0개다. `modules` 통계는 0으로, 이번 입력에서 REA가 webpack 모듈을 복원했다고 주장할 수 없다. 동적 IPC 채널은 여전히 미해결이다.

전체 Evidence는 107,140,636바이트이며 `/tmp/fountain-notion-desktop-7.39.0/application-evidence-4.1.0.json`에만 보관했다. 원본 파일도 `/tmp` 아래에만 추출했다. 저장소에는 원문이나 전체 그래프 대신 해시·통계·관찰 식별자·위치를 기록했다. 축약 JSON은 REA의 전체 Evidence를 대체하지 않는다.

## 관찰과 해석의 구분

| 근거 종류 | 직접 관찰한 사실 | 이 근거만으로 입증하지 못한 것 |
| --- | --- | --- |
| REA AST | migration preload의 `migration-dump`, `migration-restore` 수신과 각각의 완료 IPC 전송; `localStorage.getItem/setItem`, `indexedDB.open` 호출 | 사용자 데이터의 실제 덤프·복원 결과, 마이그레이션 성공 여부 |
| 직접 정적 소스 확인 | SQLite 서버에 `offline_page`, `offline_action` 테이블을 읽는 백업 경로와 `attemptToBackupAndResetDatabase` 식별자가 존재 | 오프라인 편집의 실제 동기화·충돌 해결·손상 복구 성공 |
| 직접 정적 소스 확인 | tab browser preload에 `copyText`에서 `navigator.clipboard.writeText`로 이어지는 호출과 PNG `ClipboardItem` 생성 경로가 존재 | 클립보드 권한 승인·실제 복사 성공·구조화 블록 복사 동작 |
| 직접 정적 소스 확인 | window-list preload가 `__windowListApi`를 contextBridge로 노출하고 창·탭 목록용 IPC invoker를 선언 | 런타임 호출 가능성·IPC 송수신 짝의 실제 등록과 권한 검증 |

REA 관찰의 정확한 source range와 node/observation ID, 직접 문자열 확인의 byte offset 및 UTF-16 열은 축약 증거에 있다. REA source range 열은 0 기준이다. 문자열 위치와 REA AST 관찰은 별도의 근거로 기록했다. SQL 테이블과 백업 경로는 로컬 저장 및 복구 설계를 참고할 근거지만, 존재하는 문자열을 제품 전체의 실행 동작으로 확대하지 않았다. 첨부 업로드 정책·파일 크기 한도·유료 권한 처리는 이번 세 파일의 분석으로 검증하지 않았다.

독립 앱에서 자체 데이터의 저장·복원·클립보드·첨부 기능을 구현하는 데 참고할 수 있다. Notion의 로그인·구독 검사 우회나 개인 데이터 수집은 수행하지 않았다. Desktop의 정적 근거가 추가되었어도 유료 플랜 전체 기능 동등성, 서버 구현, Notion AI, 공동 편집, 기업 보안 보증까지 검증한 것은 아니다.

## 재현과 검증

```sh
node scripts/research-notion-desktop.mjs --npm-cache /tmp/fountain-rea-research/npm-cache
node scripts/research-notion-desktop.mjs --work-dir /tmp/fountain-notion-desktop-7.39.0 --verify-only
```

첫 명령은 새로운 `/tmp/fountain-notion-desktop-7.39.0-*` 디렉터리를 만들고 고정 해시를 검사해 세 파일을 추출·분석한다. 기존 npm 캐시가 없으면 별도 캐시에 REA를 내려받으며 프로젝트 의존성이나 전역 설정을 바꾸지 않는다. 두 번째 명령은 최초 실행 산출물을 재검증한다. 새 실행 경로를 검증하려면 첫 명령이 출력한 workDir을 지정한다.

스크립트는 앱 버전과 파일 해시가 달라지면 중단하며 다른 버전으로 대체하지 않는다. ASAR 경로·offset·size·헤더 무결성, 입력 파일 목록, 직접 문자열 위치, REA 입력 식별자·통계·관찰 ID를 확인한다. 분석 결과의 실행별 envelope 식별자는 경로에 따라 달라질 수 있어 재현 검사는 입력 root hash와 관찰 ID를 사용한다. `/tmp`가 정리되면 원본 앱이 같은 버전인 동안 다시 생성해야 한다.
