# Notion 데이터베이스 조사

조사일: 2026-10-16 (Asia/Seoul). [증거 메타데이터](./rea-database-evidence.json)는 실제 REA 실행과 직접 소스 검사, 공식 도움말을 구분한다. 유료 제한을 우회하거나 인증된 계정에 접근하지 않았다.

## 실제 REA 실행

공식 `https://www.notion.so/login`에서 앞서 발견하고 받은 공개 자산 `94168-34f2bc3c0226c22a.js`를 좁혀 분석했다. 원본은 20,176바이트이며 SHA-256은 `0d5907a1bd661dffe1bdaa007c7a6aafdc484b108f373068a130a12fd45c1311`이다. 새 로그인 페이지·앱 번들·추가 청크 요청이 HTTP 503으로 실패하여 같은 세션에서 확보한 동일 파일을 재사용했다. 웹 도구는 로그인 주소가 `https://app.notion.com/login`으로 이동함을 확인했지만 추가 JS는 읽지 못했다.

```sh
mkdir -p /tmp/fountain-rea-databases/target
cp /tmp/fountain-rea-research/target/94168-34f2bc3c0226c22a.js /tmp/fountain-rea-databases/target/94168-34f2bc3c0226c22a.js
npm --cache /tmp/fountain-rea-research/npm-cache exec --yes --package=rea-agents@4.1.0 -- rea analyze-javascript-application /tmp/fountain-rea-databases/target --json > /tmp/fountain-rea-databases/application-evidence.json 2> /tmp/fountain-rea-databases/analysis-stderr.log
```

재다운로드 명령은 아래와 같다. 이번 요청은 HTTP 503으로 실패했다. 과거 CDN 파일이 사라지면 동일 바이트 재현을 보장할 수 없다.

```sh
curl -L --fail --silent --show-error --max-time 45 --max-filesize 8388608 -o /tmp/fountain-rea-databases/target/94168-34f2bc3c0226c22a.js https://www.notion.so/_assets/94168-34f2bc3c0226c22a.js
```

REA 4.1.0은 exit 0으로 완료했다. 파일 1개, 모듈 13개, findings 47개, AST 노드 3,858개, 파싱 실패와 잘린 범위 각각 0개다. 전체 증거는 로컬에만 보관했다(9,004,067바이트). 신규 다운로드는 파일당 8MB, 전체 자산은 20MB로 제한했다. 프로젝트 의존성·전역 설정은 변경하지 않았다.

REA가 복원한 Rspack 모듈 `832375`의 원본 범위는 1행 13754–19847열이다. 해당 범위를 직접 읽어 아래 문자열을 확인했다. 위치는 따옴표를 포함하며 열은 0 기준, 끝은 배타적이다.

| 문자열 | 원본 열 | 근거 |
| --- | --- | --- |
| `collection_view` | 14672–14689 | REA 모듈 안의 직접 소스 검사 |
| `workflow_automation_run` | 15717–15742 | REA 모듈 안의 직접 소스 검사 |
| `automation_action` | 15853–15872 | REA 모듈 안의 직접 소스 검사 |
| `automation` | 19593–19605 | REA 모듈 안의 직접 소스 검사 |

이것은 엔티티 식별자가 존재한다는 증거다. REA의 의미 그래프에는 이 문자열들이 보존되지 않았으므로 REA가 해당 스케줄러나 뷰 동작을 복원했다고 표현하지 않는다. 의미 그래프의 상태는 `unknown`이고 미해결 항목은 416개다. 다른 모듈·서버·실제 실행은 검증하지 않았다.

## 공식 문서에서 확인한 동작

[하위 항목·종속성 도움말](https://www.notion.com/help/tasks-and-dependencies)을 직접 읽었다.

| 항목 | 문서에서 확인한 의미 |
| --- | --- |
| 하위 항목 표시 | 표·목록·타임라인은 접기/펼치기 또는 평면 목록. 보드·캘린더·갤러리는 부모 카드의 속성 또는 개별 카드. |
| 필터 | 표·목록·타임라인은 부모만/부모와자식/자식만. 나머지 세 뷰는 부모만. |
| 복제·삭제 | 부모를 복제하면 하위 항목도 복제하며, 삭제하면 하위 항목도 삭제한다. |
| 겹칠 때 이동 | 날짜가 겹치는 경우에만 후속 작업을 옮긴다. 기존 간격은 줄어들 수 있다. |
| 간격 유지 이동 | 선행 작업이 일주일 이동하면 후속 작업도 일주일 이동한다. |
| 이동 안 함 | 날짜를 자동 변경하지 않는다. |
| 주말 회피 | 이동된 항목의 시작일·종료일이 주말에 걸리지 않도록 하는 선택 옵션. |

[데이터베이스 자동화 도움말](https://www.notion.com/help/database-automations)을 직접 읽었다. 반복 트리거에는 주기·시각·시작일·종료일·시간대 설정이 있다. 반복과 다른 유형의 트리거를 결합할 수 없으며, 반복은 직접 `Edit property` 액션을 지원하지 않는다. `Edit pages in`은 별도 액션이다. 자동화가 다른 자동화를 실행시키지 않으며 반복 템플릿으로 생성한 페이지도 동일하다. 사용자가 누른 버튼으로 생성한 페이지는 자동화를 실행할 수 있다. 제한된 페이지는 자동화 대상에서 제외된다. 여러 일반 트리거의 AND/OR 조합을 지원하며, AND의 여러 `is edited` 조건은 약 3초 안에 발생해야 한다.

[타임라인 도움말](https://www.notion.com/help/timelines)을 직접 읽었다. 표시에는 날짜 범위가 필요하며 다른 날짜 속성으로 전환하거나 시작·종료 속성을 분리할 수 있다. 양 끝을 끌어 기간을 바꾸고 시간~연도 단위로 확대·축소한다. 보조 표, 속성 표시와 정렬, 현재 날짜로 이동, 표시 항목 수 제한이 있다.

## 구현 시 구분해야 할 부분

위 동작은 공개 제품 사양이며 이번 REA로 복원한 알고리즘이 아니다. 주말 이동의 기간 계산, 여러 선행 작업의 우선순위·순환 처리, 월말 반복·일광절약시간·밀린 실행 처리 방법은 이 세 문서로 확정할 수 없다. 해당 부분을 구현하면 로컬 제품의 설계 결정과 테스트로 기록해야 한다. 새 데이터베이스 UI, 권한 검사, 실제 스케줄 실행의 성공 여부는 별도 구현 검증이 필요하다.
