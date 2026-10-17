# Supabase 백엔드 전환

최종 운영 목표는 웹·macOS·Windows·iOS·Android에서 같은 계정과 데이터를 사용하고, 업무 처리를 Supabase에서 수행하는 것이다. 운영 환경이 Python 프로세스, 항상 켜진 개발자 Mac, SQLite 파일이나 POSIX 첨부 디렉터리에 의존해서는 안 된다. 현재 Python 구현은 동작 비교와 이전을 위한 기준이며, 전체 기능 검증과 데이터 보존 확인 전에는 기존 운영 경로를 교체하지 않는다.

## 현재 범위와 완료 기준

2026-10-17 확인 시점의 Supabase 프로젝트는 `ehnovtfadpkwtubmwltl`이다. `fountain-api` version 19에 문서·DB·통합 검색·공동 편집·동기화·첨부·presence/SSE·AI·계정·백업·연동 권한 관리·SCIM bearer handler가 연결됐다. 서비스 객체는 actor를 공유하지 않고 사람의 요청은 각 쿠키, SCIM은 별도 위임 토큰으로 인증한다. 운영 원본은 entities 153개·meta 6개, 실사용 Auth 사용자·identity mapping은 0개다. `fountain-files`는 비공개 bucket이며 QA 정리 후 객체는 0개다. `/health`의 `ready:false`는 전체 전환이 아직 끝나지 않았다는 뜻이다. API 13에서는 배포 설정의 `setupEnabled`만 켰으며 39개 배포 파일을 다시 대조했다. 원본 `local` 소유자용 연결은 해시만 저장한 유효기간 있는 일회용 코드와 사용자의 명시적 앱 입력이 필요하다. 계정 생성·소유자 연결을 자동 수행하지 않았다. [연결 준비 검증](research/owner-onboarding-preparation.json).

API 14에서는 페이지 검증의 복수 담당자·활성/열람 자격·만료값·문서 revision 검사를 맞췄다. 격리된 실제 Supabase 계정 2개와 별도의 멤버 기록으로 담당자 1,000명 처리, 권한·비공개 응답·충돌·원본 보존을 확인하고 검증 자료를 정리했다. 새 권한이나 DB 스키마를 추가하지 않았다. [페이지 검증 안내](PAGE_VERIFICATION.md) · [실행 증거](research/page-verification-evidence.json).

API 15에서는 현재 검증 만료를 담당자별 알림함에 표시하고 읽음·보관을 계정별로 저장한다. 실제 Supabase 계정 2개·세션 3개로 수신자 격리·기기 간 상태·만료·재검증·접근 철회를 확인했다. 배포 40개 파일을 소스와 대조했고 격리 QA 데이터와 계정을 정리했다. 배경 전달·이메일/푸시는 아직 연결되지 않았다. [알림함 안내](INBOX.md) · [실행 증거](research/inbox-evidence.json).

Auth/Vault·Store부터 계정 생성·관리·백업·분할 백업·연동 권한 관리·예약 실행·SCIM·파일 물리 정리·기존 inline 첨부 읽기와 위키·DB 검증 메타데이터까지 migration 28개를 적용했다. 적용된 SQL은 `supabase/migrations`의 실제 버전 파일로만 보관하고 중복 초안은 제거했다. 공개 RPC는 service_role 전용이며, private 테이블은 강제 RLS와 직접 접근 거절을 유지한다. 익명·일반 로그인 역할의 실행 권한 거절, 연결되지 않은 세션의 백업/정리 거절 등 실제 PostgreSQL 검사 10개가 통과했다. 이 구조는 서버의 신뢰된 권한 검사이며 최종 사용자별 RLS를 사용한다는 뜻이 아니다.

원본 첨부 1개·80바이트는 이미 PostgreSQL의 inline base64 형식으로 저장돼 있으며 외부 chunk 행은 0개다. 일반 Store snapshot에서 이 바이트를 숨기는 계약은 유지하면서 전용 인증 RPC와 64KiB 다운로드 경로를 추가했다. 별도 계정 두 개로 최대 5,000,000바이트 전체 SHA·공유 권한·HEAD·Range·오류를 확인했고 실제 SQL의 인증 철회·원본 변경 거절 19개도 통과했다. 읽기는 원본·revision·receipt·쿼터를 바꾸지 않으며 Storage 객체를 만들지 않는다. 원본 첨부는 portable 백업과 동일하고, 원본 소유자 계정으로의 최종 접근 검증은 아직 남아 있다. [실행 결과·범위](research/inline-attachment-verification.md).

API 11은 권한 검사 뒤 페이지·DB·행의 작은 검색 DTO를 만들고 필터·정렬·페이지 나눔을 제공한다. 실제 계정의 멤버/관리자/게스트 역할과 권한 철회·행 삭제, 31개 감사 기록의 검색어 비저장, QA 계정·29개 테이블 정리를 확인했다. 최종 Node 383개, Python/SQLite 결과 대조 360건과 실제 Python/Chrome UI 검증이 통과했다. 의미 검색과 외부 앱 색인은 연결하지 않았으며 운영 소유자/호스팅 연결도 아직 남아 있다. [통합 검색 실행 결과·범위](research/advanced-search-verification.md).

기초 실제 클라우드 QA에서는 비밀번호 로그인·신뢰된 기존 역할 연결·동시 CAS·정확한 receipt 재시도·refresh lease·폐기된 세션 거절을 확인했다. 후속 문서·버전·typed row/수식·ACL·공동 편집/Undo·sync 10개 그룹, presence 6개, SSE 2개가 통과했다. 실제 비공개 Storage의 9MiB+123바이트 업로드·전체 SHA-256·청크 경계 Range·HEAD·416·다른 멤버 거절·물리 삭제, Realtime WebSocket 구독과 변경 알림도 확인했다. Realtime은 본문 없이 재조회를 깨운다.

실제 `createApplication`을 통한 초기 owner 생성·가족 계정 생성·비밀번호 변경·연결 해제/재연결·마지막 로그인 가능한 owner 보호도 검증했다. 불확실한 비밀번호 변경 중 연결 해제는 409로 막히며 다른 작업공간 연결도 거절된다. 같은 Auth UUID를 유지하고 기존 세션을 폐기하는 동작을 확인했다. 서비스 키·JWT·refresh token은 renderer로 보내지 않는다.

큰 백업은 `POST /api/backup/jobs`로 시작하고, 저장된 작업을 `POST /api/backup/jobs/{id}/step`으로 진행한다. 같은 transaction ID는 원래 결과를 돌려주며, checkpoint·원본 snapshot·계획·게시 영수증은 서버가 보관한다. 준비된 파일은 `GET /api/backup?job_id={id}`의 최대 256KiB Range로 내려받는다. 현재 owner·세션·내보내기 정책과 전체 파일 SHA를 검사한다. 다른 owner 로그인 세션이라도 기존 작업을 조회·취소·다운로드할 수 없다. 원본 업로드와 백업이 공유하는 용량 예약은 일반 Store 변경이나 백업 파일에 노출되지 않는다.

실제 Supabase/Deno에서 문서 1,001개와 9MiB+123바이트 첨부를 포함한 백업을 160단계로 생성했다. 9,814,016바이트를 38개 Range로 전부 내려받아 SHA-256·SQLite 무결성·첨부 전체 바이트를 확인했고 기존 `fountain.backup restore`로 새 DB에 복원했다. 생성 단계의 처리 시간 합계는 약 501초였으며 단계 사이 조회·업로드·다운로드 시간은 별도다. 이는 CPU 측정값이나 5GB 성능 보증이 아니다. 로컬 writer는 100,002개 행·9MiB 원본의 바이트 일치와 단계별 예산, 별도 48MiB 작업을 검증했지만 실제 클라우드 5GB 전송은 아직 검증하지 않았다. 기존 동기식 작은 백업 경로와 새 분할 작업의 범위를 구분한다.

실제 Chrome 두 개의 독립 세션에서 같은 계정으로 로그인해 문서 수정→다른 세션 조회→원상 복원을 확인했다. 실제 백업 UI의 진행·취소·정리도 통과했다. iOS Simulator와 Android API 36의 네이티브 HTTPS 전송은 같은 계정으로 각각 로그인해 같은 비공개 페이지를 읽고 로그아웃했다. 두 세션의 binding은 달랐으며 Secure 쿠키를 유지했다. 이 검사는 로컬의 얇은 QA presentation proxy로 실제 Supabase를 호출한 결과이며, 공개 HTTPS 운영 주소·전체 제품 UI·네이티브 편집 전파나 물리 기기 검증을 대신하지 않는다. [네이티브 실행 범위](../apps/mobile/tests/native-cloud-validation.md).

모든 검증은 격리한 workspace에서 수행했다. 검증 계정 2개·DB 행·세션 vault·백업 작업·Storage 객체를 정리했고 검증 함수는 version 19의 404 응답으로 교체했다. 기존 nonce가 거절되는 것과 임시 비밀번호 파일 삭제도 확인했다. 원본 6개 데이터 묶음의 fingerprint와 이전 portable 백업은 유지했다. 배포한 `fountain-api` version 3의 익명/거절 경계 8개도 통과했다. [실행 증거와 제한](research/cloud-backup-verification.json).

Node source runner 147개가 실패·skip 없이 통과했고 내부 Python/SQLite oracle도 실행됐다. 기존 Python의 실제 PostgreSQL 전체 검사 481개는 Python 소스 변경 없이 유지되는 별도 근거다. 실제 TypeScript 컴파일러 검사는 아직 없으며 Node 구문 검사나 LSP를 타입 검사 성공으로 취급하지 않는다. 실제 Deno bundle·HTTP 실행과 구분한다. Advisors의 WARN/ERROR는 없었다. private 접근을 의도적으로 모두 막는 RLS 테이블의 [정책 없음 INFO](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)와 사용되지 않은 보존/receipt 인덱스 2개의 [INFO](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)는 그대로 유지했다.

서비스 실행을 위한 별도 `ServiceContext`·`ServiceStore`와 비공개 공통 저장 커널도 적용했다. 사람용 세션 검증·canonical digest·receipt 범위는 유지했다. 실제 service RPC에서 현재 author의 member 권한과 owner 위임 권한으로 CRUD·전체 JSON SHA·같은 요청 재시도를 확인했다. 작성자 비활성화·issuer 강등·grant 만료·lease 세대 변경·grant 철회 후에는 현재 DB 상태로 거절한다. 외부 MCP가 권한을 바꾸는 동안 같은 Edge 호출 안에 보관한 이미 처리된 요청을 실제 SQL에 다시 보내 거절되는 것도 확인했다. ACK 누락은 실제 SQL 수락 뒤 응답만 버리는 운영자 fault injection이며 실제 네트워크 장애의 증거로 표시하지 않는다.

마지막 실제 owner 변경은 먼저 stage한 페이지 수정까지 409로 롤백했고, 새 SQL snapshot에서 revision·제목·owner 활성 상태가 유지됐다. maintenance는 principal 없이 문서 Store를 열 수 없고, 유효한 maintenance 권한도 SQL의 데이터 snapshot·commit에서 거절됐다. 로그인한 사람의 Auth session이 0개여도 명시적으로 위임된 서비스 권한은 유효했으며 별도 철회와 만료를 적용했다. 독립 Node 전체 151개 회귀와 기존 Store 26개를 통과했고, 이후 단일 작업만 선택하는 `Scheduler.tick_one`은 26개·달력/DST 5,632개·Advanced 109개를 추가 검증했다. Cron·SCIM HTTP가 연결됐다는 뜻은 아니다. 검증용 권한·lease·receipt·계정 2개를 모두 지우고 검증 함수 version 24를 404로 교체했다. 배포한 main version 5의 경계 8개도 확인했다. [실제 서비스 권한 검증](research/cloud-service-verification.json).

현재 owner의 세션으로 `GET/POST /api/scim/tokens`, `POST /api/scim/tokens/{id}/activate`, `DELETE /api/scim/tokens/{id}`를 호출할 수 있다. 발급 시 32바이트 토큰을 한 번만 반환하고 DB에는 SHA-256만 저장한다. 최초 발급은 비활성이며 같은 발급자의 토큰 증명으로 활성화한다. 발급 응답 유실 후 같은 transaction ID를 보내면 원문 대신 `token_unavailable`을 반환한다. 다른 현재 owner도 철회할 수 있고 철회한 토큰은 다시 활성화할 수 없다. 상태 변경·감사 기록·revision을 한 트랜잭션에 묶고 응답 직전에 원래 세션과 owner 권한을 다시 확인한다.

실제 Supabase QA에서 동시 발급·수락된 응답 폐기 후 재시도·활성화 전/철회 후 service 접근 거절·issuer 강등·네 가지 관리 응답 직전 실제 로그아웃을 확인했다. 127개 과거 UUIDv7을 포함한 135개 목록을 limit 50의 3개 페이지로 누락·중복 없이 읽었다. 발급·활성화·철회의 감사 기록 실패는 상태 변경까지 롤백했고, 발급한 8개 권한의 생성/철회 감사는 각각 한 번이었다. 검증 계정·권한·행을 정리하고 검증 함수 version 29를 404로 교체했다. main version 6의 거절 경계 10개, 전체 Node 검사 194개가 통과했다. [실행 증거와 제한](research/cloud-grant-verification.json).

예약 실행은 기존 달력·권한·작업 로직을 재사용하는 planner와 고정 슬롯 runner를 실제 SQL broker·Cron·`pg_net`·`fountain-worker` version 3에 연결했다. LOGGED 큐에 고정 시각·슬롯·세대를 보관하며, 일회용 호출 티켓 원문은 전송에만 사용한다. 새 snapshot/commit마다 현재 작성자·원본 hash·세대·기한을 검사한다. Cron 명령에는 workspace만 있고 서비스 키나 사람의 세션을 넣지 않는다. 원본 운영 workspace는 아직 등록하지 않았다.

격리한 실제 Supabase QA에서 Cron이 문서·DB 행을 각각 한 개 만들고 원래 행의 counter를 2로 바꾼 것을 owner API로 두 번 확인했다. 잘못된 일정·없는 작성자·종료·미래·기존 실행의 다섯 제어 경로도 각각 확인했다. 전송 유실 후 같은 작업의 다음 세대 재시도와 중복 HTTP 호출은 페이지를 한 번만 생성했다. 자기 비활성화 및 JSON 숫자 `1.0`→`1` 변경 뒤에도 이미 수락한 동일 commit만 ACK를 받으며 새 변경은 막힌다. 재시도에 사용한 시각은 TypeScript가 정규화하고 PostgreSQL 원문 cast는 보수적인 wake 힌트에만 사용한다.

provisional 완료 뒤 Store 오류는 작업·문서·receipt까지 원자적으로 롤백했다. 같은 UUID를 연결 해제/재연결하는 운영자 SQL fixture는 Cron을 일시 정지한 동안에도 이전 권한의 ACK를 거절했다. 별도 PostgreSQL 연결로 경합 구간을 확인하면서 실제 GoTrue 계정을 삭제한 경우에도 지연된 member trigger는 교착 없이 commit했다. 기존 일정 43개는 첫 호출에서 32개, 다음 호출에서 나머지를 처리했다. 같은 활성 grant의 두 실제 실행 중 오래된 authority만 정리하고 현재 authority·전체 업무 데이터 SHA·사용자 실행 이력 두 개는 보존했다. ACK·전송 유실과 2일 만료는 운영자 fault injection이며 실제 장애나 2일 경과를 주장하지 않는다.

전체 Node 239개와 실제 PostgreSQL의 기존 Python 481개 검사가 실패 없이 통과했다. 전송 20개 검사는 실제 loopback HTTP와 RPC 모델을 사용하며 SQL·Cron 실검증과 구분한다. 실제 타입 컴파일러 검증은 여전히 없다. 테스트 계정 2개·행·권한·작업·Cron을 정리했고 검증 함수 version 34는 기존 nonce에도 404를 반환한다. 원본 6개 데이터 지문은 유지됐다. [예약 실행 증거와 제한](research/cloud-scheduler-verification.json).

현재 Advisors에는 `pg_net`의 [public schema WARN](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public) 한 개가 남아 있다. 실제 catalog에서 이 확장은 이동 불가능하고 public 소속 함수는 0개였다. catalog 강제 수정이나 확장 삭제·재설치로 경고를 숨기지 않았다. 외래 키 조회 인덱스는 별도 migration으로 보완했으며 정책 없는 private RLS 23개와 아직 사용되지 않은 인덱스 11개는 INFO다. 외래 키 조회 인덱스 누락 INFO는 남아 있지 않다.

SCIM bearer 요청은 사람의 쿠키와 분리해 현재 활성·미만료 grant 및 실제 연결된 소유자를 SQL에서 확인한다. Users/Groups 처리와 삭제 시 ACL·멤버십 정리는 기존 `Advanced`·`ServiceStore`를 재사용한다. 응답 직전에도 같은 grant를 다시 확인해 철회된 권한으로 결과를 공개하지 않는다. 소유자 설정 화면에서 발급·명시적 활성화·페이지 목록·영구 철회를 할 수 있다. 토큰은 최초 응답과 해당 화면의 RAM에만 두며 닫기·설정 이동·로그아웃·계정 변경 때 지운다. 발급 응답이 불확실하면 같은 ID로만 재확인한다.

멤버 비활성화는 해당 workspace의 기존 Vault를 영구 철회하고, 삭제는 로그인 연결·과거 계정 작업 증거·사용 및 미사용 초대 claim도 함께 제거한다. 진행 중인 Admin 작업은 삭제하지 않고 409로 차단한다. 추가 잠금 경합도 NOWAIT·try-lock으로 쓰기 전에 거절한다. 로그인 Vault 생성은 같은 workspace 잠금 뒤 프로필을 다시 확인해 늦은 로그인 삽입이 철회를 피하지 못하게 한다. 마지막 실제 로그인 가능한 소유자 보호와 후속 오류의 전체 롤백은 기존 저장 커널에서 유지한다. 다른 workspace의 세션이나 전역 Auth 사용자를 SCIM이 삭제하지 않는다.

실제 Supabase에서 사용자·그룹 CRUD, 토큰 활성화 전/철회 후 거절, 동일 commit ACK 재시도, 응답 직전 철회, 마지막 소유자 보호, 비활성화·재활성화 후 이전 쿠키 거절과 비밀번호로 다시 로그인을 확인했다. 별도 PostgreSQL 연결로 동시 로그인 Vault가 잠금에서 기다리는 것을 확인했고, 비활성화 후 503·쿠키 없음으로 끝났다. 실제 로그인 세션을 유지한 SQL 검사에서도 local/다른 workspace의 pending 작업 6건을 거절하고, 삭제·같은 ID 재생성·후속 오류·revision 초과 뒤 관련 9개 상태의 SHA가 복구되는 것을 확인했다. pending·초대·실패는 운영자 fixture이며 실제 외부 Admin 요청이나 장애로 주장하지 않는다.

실제 Chrome 화면에서 발급·활성화·철회·닫기 시 토큰 폐기와 390px 화면을 검증했다. 이 화면은 로컬 presentation proxy로 실제 Supabase를 호출하며 네이티브 앱의 새 실행 검증을 대신하지 않는다. 웹 빌드는 16개 allowlist 파일이며, 모바일 빌드와 iOS·Android 복사본은 각 19개 public asset의 SHA가 일치했다. Node 전체 259개, UI 및 웹 호스트 21개, 실제 PostgreSQL의 기존 Python 481개 검사가 통과했다. main version 7의 실제 경계 12개도 확인했다. 잘못된 `%ZZ` URI는 앞단 gateway가 앱 실행 전에 HTML 400으로 거절하며, 앱 자체 오류 형식과 구분한다. 테스트 계정·데이터·권한은 모두 정리했고 검증 함수 version 38은 이전 nonce에도 404를 반환한다. [SCIM 실행 증거와 제한](research/cloud-scim-verification.json).

클라우드의 ServiceProviderConfig는 GET/HEAD만 허용하고 다른 메서드는 인증 후 405로 거절한다. 이는 메서드와 무관하게 응답하던 기존 Python의 예외를 의도적으로 수정한 계약이다. 필터·bulk는 계속 미지원으로 명시한다. SCIM이 만드는 논리 멤버의 실제 비밀번호 로그인 연결은 소유자의 별도 계정 작업이며, 외부 IdP나 SAML 로그인 연동이 완료됐다는 뜻은 아니다.

파일·백업의 예약 물리 정리는 전용 `fountain-maintenance` version 3에 연결했다. 사람의 세션 없이 짧은 티켓과 현재 grant·lease·세대·기한으로 실행한다. 수동 정리도 같은 SQL 삭제 허가를 사용한다. 진행 중인 백업의 원본 참조와 게시 중인 파일을 보호하고, 삭제를 허가한 물리 ID는 영구 tombstone으로 다시 참조하지 못하게 한다. 정리 이력만 만료시키며 불확실한 게시·용량 예약·tombstone은 이력 정리로 지우지 않는다.

실제 Supabase Cron 8회·워커 호출 16회가 모두 성공했다. 로그인 세션 0개에서 취소된 업로드와 36,864바이트 백업 파일을 삭제하고 예약 용량을 반환했다. 실제 게시된 업로드의 응답을 운영자가 한 번 폐기한 경우에는 SHA를 확인해 게시 기록만 복구하고 4바이트 예약을 유지했으며, 다음 정리에서 삭제했다. 실제 SQL 수락 응답을 폐기한 `observed`·`done`은 같은 body로 재시도했고 중복 예약 반환은 없었다. snapshot source 행 19개를 보관한 활성 백업은 원본 파일을 보호했다. 해당 QA 백업의 만료 시각을 운영자가 변경한 뒤에는 원본 참조를 정리한 후 파일이 삭제됐다. 실제 24시간 경과나 외부 네트워크 장애를 주장하지 않는다.

실제 PostgreSQL의 advisory 대기를 관측한 동시 참조 검사에서, 대기 중 commit된 새 참조를 읽고 삭제를 거절했다. REPEATABLE READ도 storage PT409·broker PT503으로 거절한다. 기존 실제 terminal receipt는 현재 권한에서 ACK를 받지만 grant 철회·세대 변경 후에는 거절했으며, 이 권한 변경 fixture는 롤백했다. 물리 파일이 없는 실제 Storage의 `400 not_found` 응답은 최초 검사에서 일반 연결 오류로 분류됐다. 이를 4KiB 이하의 엄격한 JSON 오류 형식으로 구분하도록 고친 후 기존 파일 3개의 부재 읽기를 통과했다. 부재를 새 게시나 불확실한 예약 해제의 근거로 사용하지 않는다. [공식 Storage 오류 형식](https://supabase.com/docs/guides/storage/debugging/error-codes).

최종 Node 전체 329개와 기존 Python의 실제 PostgreSQL 481개 검사가 통과했다. 타입 컴파일러 검증과 실제 5GB 전송은 아직 없다. 최종 main version 9·표준 maintenance version 3의 실제 HTTPS 경계는 각각 12개·8개다. Cron의 기능 검증은 표준 worker version 1과 격리된 응답 폐기용 version 2에서 실행했고 이후 표준 entry로 복구했다. 테스트 계정 2개·29개 테이블의 QA 행·물리 객체·Cron·임시 비밀번호 파일을 정리했다. 검증 함수 version 43은 기존 nonce의 5개 경로에도 404를 반환하며 원본 6개 데이터 지문은 유지됐다. [정리 실행 증거와 제한](research/cloud-maintenance-verification.json).

API 9 검증 당시 `deployment.setupEnabled`는 false였다. 현재는 위 초기 소유자 연결 준비를 위해 true이며 web origin과 실사용 계정·공개 HTTPS 호스트 연결은 아직 완료되지 않았다. 정적 웹 배포물은 16개 allowlist 파일이며 모바일에는 19개 public asset을 복사해 두 플랫폼의 SHA 38개를 비교했다. localhost:8787은 기존 동작 보존용 불변 Python 미리보기이며 새 클라우드 운영 전환이 아니다. 외부 IdP와 SAML·전체 다섯 플랫폼 편집 전파 검증은 남아 있다. 원본 운영 workspace의 예약 실행·파일 정리는 아직 등록하지 않았다. 연결된 Vercel MCP는 실제 팀 조회에서 플랜 정보를 반환하지 않아 무료 정적 웹 배포의 요금제를 확인하지 못했으며, 이는 다른 백엔드 구현을 막는 추가 승인 대기가 아니다.

[라우트 인벤토리](../supabase/tests/route-inventory.json)는 현재 Python 라우트의 **method/path 217개 행**을 기록한다. HEAD와 기존 suffix alias도 별도 행이다. 각 행에는 인증 경계, 익명 접근 여부, handler/domain/module, 실제 Python AST 분기의 근거와 cloud 상태가 있다. `public`은 익명 인증 경계를 뜻하며 단순히 게시된 콘텐츠라는 뜻이 아니다.

- `pending`: 이 인벤토리의 기본 `createBackend` fixture에서 업무 handler가 연결되지 않음. 현재 운영 배포의 기능 상태는 위 실제 검증 기록을 따른다.
- `staged-auth`: 세션 경계 구현 단계. 실제 사용자 연결과 다기기 흐름 검증이 남음.
- `staged-contract`: 별도 업무 계약과 회귀 검사가 있으며 전체 운영 동등성은 주장하지 않음.
- `static-relay-required`: 정적 호스트 및 같은 출처의 전달 경로가 필요함.
- `not-applicable`: 로컬 전용 세션 갱신. 계정 인증이 필수인 클라우드에서는 명시적으로 거절해야 함.

현재 모든 행의 `productionParityVerified`는 `false`다. fixture, 모델 테스트, 함수 배포, 타입 또는 health 검사만으로 이 값을 바꾸지 않는다. 실제 Supabase Auth/DB/Storage와 연결한 해당 HTTP 계약 및 권한·오류·재시도·데이터 보존 증거가 필요하다.

기본 위키는 API 18과 migration 27개에 반영됐다. 전환·해제·세 보기·담당자·검증을 구현하고 실제 Supabase의 큰 문서/깊은 계층/두 계정 권한과 400페이지 가져오기를 검사했다. 위키·검증 및 상속 ACL은 본문 없는 내부 헤더를 쓰고 실제 변경 대상의 원문을 보존한다. 검증용 계정·행·세션은 정리했으며 verifier 74는 이전 nonce에도 404다. 원본 153개 entity·6개 meta와 기존 미리보기는 보존했다. [위키 안내](WIKI.md) · [실행 증거와 남은 범위](research/wiki-evidence.json).

DB의 담당자·검증 속성은 API 19의 45개 파일과 migration 28개에 반영됐다. 담당자 기본값·인원 제한·검증/해제·행 및 속성 설정 CAS·오프라인 담당자 편집을 구현했다. 실제 두 계정·세 세션의 10개 검사, worker 4의 예약 성공/위조 롤백 두 작업과 각각의 pg_net HTTP 200·commit receipt를 확인했다. 약 85.4MB의 행 데이터에서도 만료 알림함은 원본 행·DB·페이지 본문을 읽지 않았고 읽음·보관 변경은 원문을 보존했다. maintenance 4는 변경된 공통 모듈을 포함하도록 갱신했으며 새로운 정리 업무 주기를 실행한 것은 아니다. 예약·정리 함수의 익명 거절 경계 총 16개를 확인했다. 테스트 계정·세션·29개 테이블의 자료와 Cron을 정리했고 verifier 77은 이전 nonce에도 404다. Python 실제 PostgreSQL 579개와 Node 62개 스크립트, 별도 접근 대조 1,651건을 통과했다. 원본과 기존 미리보기는 보존됐으며 실사용 소유자 연결·무료 공개 호스트·모든 플랫폼 가족 여정은 남아 있다. [DB 담당자·검증 안내](DATABASE_VERIFICATION.md) · [증거와 제한](research/database-verification-evidence.json).

## 구성

1. **Supabase Auth**가 클라우드 사용자 인증을 담당한다. 기존 member ID·role·ACL의 의미는 `identity_mapping(workspace_id, auth_user_id, member_id)`으로 유지한다. 이메일이나 user metadata로 owner를 자동 지정하거나 첫 가입자를 owner로 만들지 않는다. 기존 scrypt 해시를 Supabase의 비밀번호 해시로 간주하지 않는다.
2. **Edge Functions**가 기존 `/api/*`, SCIM, 공개 게시, SSE, Range 계약을 구현한다. 업무 요청을 Python으로 되돌려 보내는 경로는 최종 구성에 포함하지 않는다. `verify_jwt=false`인 entry는 자체 인증을 수행하며 이 설정을 익명 허용으로 해석하지 않는다.
3. **세션 Vault**는 43자 `fountain_session`을 서버 토큰 보관함의 식별자로 유지한다. DB에는 식별자의 해시와 암호문만 둔다. Supabase JWT·refresh token·service key는 웹 및 앱 renderer로 보내지 않는다. 웹의 HttpOnly 쿠키와 모바일의 Keychain/Keystore 계약을 유지한다. refresh는 lease/CAS로 직렬화하며 binding과 7일 opaque 만료 시각을 갱신 때마다 연장하지 않는다. Supabase 앞단의 Cloudflare가 붙이는 `__cf_bm`은 Fountain의 계정 쿠키가 아니며 실제 인증 쿠키 검증과 구분한다.
4. **Store RPC**는 실제 session hash·binding·Auth session·user·member mapping을 재검증하고 잠근다. 기존 Python writer와 같은 workspace advisory lock 및 revision CAS를 사용한다. 같은 세션의 txid/digest receipt는 정확한 재시도만 허용하고, 응답이 불확실하면 새 변경을 실행하지 않는다. 이 경로는 trusted service의 서버 권한 검사다. `SECURITY DEFINER`가 기존 workspace RLS를 우회하므로 사용자별 RLS로 보호된다고 설명하지 않는다. 클라이언트의 직접 RPC 실행과 기존 private schema에 대한 새 일반 grant는 허용하지 않는다.
5. **Storage** 비공개 bucket이 기존 첨부 파일의 영구 보관을 맡는다. 첨부 권한·offset·SHA·중단 후 재개·Range·백업 의미를 보존해야 한다. 무료 quota를 넘는 입력을 잘라 저장하거나 무제한 무료라고 표시하지 않는다.
6. **Realtime와 Cron**이 변경 알림·presence 및 예약 작업을 담당한다. renderer에 JWT를 노출하지 않는 SSE 중계는 현재 세션과 리소스 권한을 계속 검사해야 한다. 무료 Edge worker 수명에 맞춰 재연결하며 공유 알림에 비공개 본문을 넣지 않는다.

## 웹 및 설치 앱의 연결

무료 Supabase 기본 도메인은 HTML GET 응답을 `text/plain`으로 바꾼다. 따라서 정적 웹 호스트가 HTML/CSS/JS를 제공하고, `/api/*` 등을 Supabase Edge로 전달하는 얇은 같은 출처 relay가 필요하다. 업무 로직이나 사용자 데이터는 relay에 두지 않는다. 쿠키·EventSource·XHR를 같은 출처로 유지하면 제3자 쿠키 차단에 의존하지 않는다. API·쿠키·개인 응답의 CDN 캐시는 끄고, 실제 Set-Cookie·SSE·Range 전달을 검사한다. 공개 sites/forms HTML 역시 브라우저에서 렌더링되는 최종 content type을 확인해야 한다.

설치 앱은 같은 웹 HTTPS origin을 사용할 수 있다. iOS·Android는 정확한 기본 Supabase 프로젝트 도메인의 기본 HTTPS 포트에서만 네이티브 내부의 고정 `/functions/v1/fountain-api` 접두사를 붙인다. 주소 입력은 순수 origin, renderer 요청은 논리 `/api/...`로 유지하며 JSON·다운로드가 같은 URL 생성부를 사용한다. 다른 도메인·별도 포트는 기존 root API를 유지한다. 함수 URL 전체를 주소 칸에 붙이는 방식은 허용하지 않으며 TLS·경로·헤더·쿠키 격리는 유지한다. 익명 직접 연결과 후속 실제 모바일 UI 로그인·Android→iOS→Android 순차 변경 읽기를 별도 QA 공간에서 확인했다. 이는 다섯 플랫폼 동시 전파나 원본 소유자 연결 증거가 아니다. [네이티브 직접 연결](../apps/mobile/tests/native-direct-validation.md), [모바일 UI 검증](../apps/mobile/tests/native-cloud-client-validation.md).

데스크톱은 번들 UI와 별도의 비공개 Chromium 세션으로 Supabase에 직접 연결할 수 있다. macOS 설치 앱의 실제 로그인·문서 편집·프로필 간 동기화·첨부 전송을 확인했으며 Windows는 패키지 생성·파일 검사까지다. 문서 복사 링크에는 별도의 `publicWebOrigin`을 사용하고 데스크톱 내부 미리보기는 로컬 번들에 남는다. 기본값은 `null`이며 실제 공개 웹 호스팅은 아직 연결하지 않았다. [데스크톱 검증](research/desktop-cloud-verification.md), [공유 링크 검증](research/public-frontend-links.md).

기존 `/sites/{slug}`·`/forms/{id}`는 게시 정책을 검사하지만, 현행 Python HTTP wrapper에서는 family/accounts 모드의 세션 인증도 거친다. 현재 동작과 최종 익명 공개 요구를 구분하고 의도한 변경은 별도 권한 테스트로 검증한다. SCIM은 별도 bearer 인증이다. 일반 legacy OPTIONS endpoint는 없지만 SCIM ServiceProviderConfig는 메서드 확인 전에 응답하는 기존 예외가 있다. Advanced collection은 임의의 추가 suffix를 받는 GET/PATCH/DELETE alias도 있으므로 조용히 누락하지 않는다.

## 라우트 감사 실행

```sh
node supabase/tests/route-inventory.mjs
```

검사는 Python 표준 AST만 읽으며 서버 모듈을 import하거나 DB에 접속하지 않는다. 위키·DB 검증 위임을 포함한 Python 라우팅·인가 함수 10개의 fingerprint, 실제 분기가 도달하는 return/HTTP handler, 모든 비예외 terminal의 포함 여부와 각 대표 경로의 7개 HTTP method를 대조한다. Edge entry fingerprint도 검사하므로 handler 설치가 바뀌면 coverage를 다시 감사해야 한다. 격리된 Edge boundary 호출은 미구현 domain 요청이 성공으로 위장하지 않고 503을 반환하는지 확인하는 검사이며 실제 클라우드 업무 처리 증거가 아니다.

소스가 바뀌어 실패하면 먼저 endpoint·인증·별칭과 cloud 검증 상태를 검토하고 JSON을 수정한다. 그 다음에만 근거를 갱신한다.

```sh
node supabase/tests/route-inventory.mjs --refresh-evidence
node supabase/tests/route-inventory.mjs
```

운영 전환에는 인벤토리의 모든 지원 기능, 실제 두 사용자·다기기 동기화, 권한 강등/로그아웃 중 진행 요청, CRDT/Undo/동기화 receipt, 첨부와 백업, 공개 게시와 자동화, 실제 설치 앱 검증이 필요하다. 원본 DB·파일·ACL·세션·문서 fingerprint를 비교하고 복구 가능한 이전 경로를 보존한다. 초기 owner 연결이 끝나지 않은 health/Auth 후보 배포를 가족용 완성 앱으로 안내하지 않는다.

참고: [Supabase Edge 제한](https://supabase.com/docs/guides/functions/limits), [Auth 세션](https://supabase.com/docs/guides/auth/sessions), [API 권한](https://supabase.com/docs/guides/api/securing-your-api), [Realtime 권한](https://supabase.com/docs/guides/realtime/authorization).
