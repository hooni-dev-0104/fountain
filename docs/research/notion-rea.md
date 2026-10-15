# Notion 공개 자산 조사

조사일: 2026-10-16 (Asia/Seoul). 공식 웹 앱의 공개 JavaScript 네 파일을 REA로 실제 분석했다. 전체 Notion, 유료 계정, 서버 구현을 역공학했다는 의미는 아니다. 원본 자산은 저장소에 포함하지 않았다.

## 직접 실행한 분석

환경은 Node 24.14.1, npm 11.11.0, macOS다. 로그인하지 않고 `https://www.notion.so/login`에서 발견한 스크립트 중 272,408바이트를 내려받았다. 파일별 URL·SHA-256과 결과 식별자는 [증거 메타데이터](./rea-notion-evidence.json)에 있다.

```sh
mkdir -p /tmp/fountain-rea-research/target /tmp/fountain-rea-research/npm-cache
curl -L --fail --max-time 45 --max-filesize 8388608 -o /tmp/fountain-rea-research/notion.html https://www.notion.so/login
```

메타데이터에 기록한 네 URL을 각각 `curl -L --fail --max-time 45 --max-filesize 16777216 -o /tmp/fountain-rea-research/target/파일명 URL`로 받았다. 첫 분석은 다음 명령이었다.

```sh
npm --cache /tmp/fountain-rea-research/npm-cache exec --yes --package=rea-agents@6.5.0 -- rea analyze-javascript-application /tmp/fountain-rea-research/target --max-heap-mb 512 --analysis-timeout-ms 60000 --max-semantic-nodes 12000 --max-semantic-nodes-per-file 5000 --format json > /tmp/fountain-rea-research/application-evidence.json 2> /tmp/fountain-rea-research/analysis-progress.jsonl
```

6.5.0은 macOS 프로세스 소유권 보조 프로그램을 `xcrun`으로 컴파일하다가 호스트의 미동의 Xcode 라이선스 때문에 실패했다(exit 69). 인벤토리 부분 증거만 반환했다. 시스템 라이선스나 설정을 변경하지 않고, REA 자체 Notion 사례에 사용된 4.1.0으로 재시도했다.

```sh
npm --cache /tmp/fountain-rea-research/npm-cache exec --yes --package=rea-agents@4.1.0 -- rea --version
npm --cache /tmp/fountain-rea-research/npm-cache exec --yes --package=rea-agents@4.1.0 -- rea analyze-javascript-application /tmp/fountain-rea-research/target --json > /tmp/fountain-rea-research/application-evidence-4.1.0.json 2> /tmp/fountain-rea-research/analysis-progress-4.1.0.jsonl
```

4.1.0은 exit 0으로 완료했다. 결과는 4개 파일 파싱, 331개 모듈, 1,402개 findings, AST 노드 77,327개, 파싱 실패와 잘린 범위 각각 0개다. 그래프의 완전성은 입력한 네 파일에만 적용된다. 외부 모듈 참조와 실제 런타임 실행은 별개다.

직접 관찰한 정적 사실은 사이드바 미리보기의 localStorage 읽기다. `contentPreview-9c63c27140a19dcc.js`의 1행 7913–7974열은 `LRU:KeyValueStore2:sidebar`, 11195–11254열은 `boot:exp:content_preview`를 읽는다. 열은 REA의 0 기준이다. 이 결과는 캐시 사용의 근거이며 오프라인 동기화, 권한 처리, 서버 보관 정책의 구현 증거가 아니다.

완전한 Evidence JSON은 로컬 `/tmp/fountain-rea-research/application-evidence-4.1.0.json`에 생성되었다(270,811,478바이트). 저장소에는 원문 없는 통계·관찰·해시의 축약본만 둔다. 축약본 자체는 REA가 인증한 전체 Evidence 입력을 대체하지 않는다.

## 재현

```sh
node scripts/research-rea.mjs --work-dir /tmp/fountain-rea-reproduction
node scripts/research-rea.mjs --work-dir /tmp/fountain-rea-reproduction --verify-only
```

스크립트는 고정된 공개 자산 네 개를 다운로드하고 해시를 검사한 뒤 REA 4.1.0을 독립 npm 캐시에서 실행한다. 추가 프로젝트 의존성이나 전역 MCP 설정은 만들지 않는다. 원본과 전체 증거는 저장소 밖에만 보관한다. CDN이 이전 자산을 삭제하거나 해시가 바뀌면 재현은 실패하며 다른 버전으로 조용히 대체하지 않는다. 전체 증거는 약 271 MB이며 npm 캐시 공간이 추가로 필요하다.

## 공식 문서에서 확인한 제품 범위

아래는 [Notion 요금표](https://www.notion.com/pricing)의 공개 설명이며 직접 역공학한 사실과 구분한다. 가격은 페이지 기본 연간 결제 표시다. 항목은 누적된다.

| 플랜 | 공식 요금표의 차별 기능 요약 |
| --- | --- |
| Plus ($10/인/월) | 협업블록·차트·첨부·게스트 무제한, 파일당 약 5GB, 기록 30일, 맞춤폼·사이트, 데이터베이스자동화, 기본연결 |
| Business ($20/인/월) | 기록 90일, Agent·회의노트·검색·리서치, SAML, 비공개팀스페이스, 세분화된 DB권한, 페이지검증, 도메인검증, 고급연결, 폼조건분기 |
| Enterprise (견적) | 기록 무제한, SCIM, 감사로그·분석·관리자검색·세분화역할, 조직보안·도메인관리·사용자관리·워크스페이스통합, DLP/SIEM, 보관정책·녹취삭제, LLM제공자 무보관, 고객성공지원 |
| 별도 과금 | 맞춤도메인, Custom Agents/Workers의 Notion크레딧 |

공통 기반에는 페이지·블록, 하위작업·의존관계·속성·필터, API·웹훅·임베드, 내보내기, 공개페이지, 캘린더가 있다. 요금표의 체크표시가 텍스트 추출에서 사라지는 항목은 최소 플랜을 추정하지 않았다. 지원 서비스와 제공자 계약은 로컬 기능만으로 충족했다고 표시할 수 없다.

## REA의 별도 사례와 한계

[REA의 Notion 사례](https://rea.tools/showcase/notion/)는 Desktop 7.6.1의 클립보드 IPC 연결과 2026-07-13 웹 자산의 구조화된 복사·Markdown 표 파서를 설명한다. 이는 REA 작성자의 별도 실행 결과다. 이번 네 파일 분석에서 해당 클립보드·Markdown 경로를 재검증하지 않았다.

이번 조사로 유료 플랜의 모든 동작을 검증하지 못했다. 실제 공동 편집, Notion AI 모델, 외부 서비스 연결, IdP/SCIM 운영, 기업 보안 보증에는 추가 서비스와 통합 검증이 필요하다. 제품 구현의 준비 상태는 별도 기능 목록에서 추적해야 한다.

참고: [REA 저장소](https://github.com/morluto/rea), [CLI 계약](https://github.com/morluto/rea/blob/main/docs/cli.md), [JavaScript 분석](https://github.com/morluto/rea/blob/main/docs/javascript-artifact-reconstruction.md).
