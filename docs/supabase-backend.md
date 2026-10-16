# Supabase 백엔드 전환

최종 운영 목표는 웹·macOS·Windows·iOS·Android에서 같은 계정과 데이터를 사용하고, 업무 처리를 Supabase에서 수행하는 것이다. 운영 환경이 Python 프로세스, 항상 켜진 개발자 Mac, SQLite 파일이나 POSIX 첨부 디렉터리에 의존해서는 안 된다. 현재 Python 구현은 동작 비교와 이전을 위한 기준이며, 전체 기능 검증과 데이터 보존 확인 전에는 기존 운영 경로를 교체하지 않는다.

## 현재 범위와 완료 기준

2026-10-16 확인 시점의 Supabase 프로젝트는 `ehnovtfadpkwtubmwltl`이다. Edge 함수 `fountain-api` version 2가 배포됐고, private session vault와 Store snapshot RPC가 존재한다. 기존 데이터는 entities 153개·meta 6개이며 실사용 Auth 사용자·identity mapping은 각각 0개다. `fountain-files` 비공개 bucket 1개가 있고 검증 파일 정리 후 객체는 0개다. 이 수치는 관측 시점의 상태이며 계정 연결이나 운영 전환 완료를 의미하지 않는다.

현재 Edge entry는 `application.ts`로 문서·데이터베이스·공동 편집·동기화·첨부·presence/SSE·AI·계정·백업 handler를 조합한다. 서비스는 actor를 공유하지 않으며 각 요청이 자신의 쿠키를 캡처해 재인가한다. 일부 SQL과 실제 사용자 연결 검증은 남아 있다. 라우트와 실제 클라우드 동작의 검증이 끝나기 전에는 HTTP 기능 완료로 세지 않는다. `/health`의 `ready:false`는 전환 상태 표시다. 기존 `/api/health`와도 다른 경로다.

Auth/Vault·Store migration `20261016094842`·`20261016100057`은 적용됐고, 격리한 실제 Supabase Auth/Vault/Store QA 14개 검사가 통과한 뒤 fixture를 정리했다. 여기에는 실제 비밀번호 로그인, 신뢰된 기존 role 연결, 동시 CAS 단일 승자, receipt 정확 재시도, refresh lease 만료 후 재사용 금지, 폐기된 세션의 snapshot/ACK 거절이 포함된다. 이 근거는 기초 계층의 검증이며 실사용자 owner 연결이나 기존 전체 HTTP 기능의 배포 증거를 대신하지 않는다.

후속 실제 클라우드 검증에서 문서·버전·typed row/수식·ACL·공동 편집/Undo·sync receipt·마지막 로그인 가능한 소유자 보호 10개 그룹, presence 6개 그룹, SSE 2개 그룹이 통과했다. 9MiB+123바이트 파일을 세 청크로 비공개 Storage에 저장하고 전체 SHA-256·청크 경계의 Range·HEAD·416·다른 멤버의 접근 거절 및 실제 객체 삭제를 검증했다. 현대 서버 키로 실제 Realtime WebSocket을 구독하고 QA revision 변경의 알림 수신도 확인했다. Realtime은 본문 없이 재조회만 깨우며, 서버 전용 소켓의 URL·키를 renderer나 로그에 보내지 않는다.

이 검증은 별도 nonce로 닫힌 일회용 함수 안에서 실제 모듈·GoTrue·PostgreSQL·Storage를 호출했다. 최종 웹 relay·설치 앱·실사용 계정의 종단 검증을 대신하지 않는다. QA 계정 2개·DB 행·Storage 객체를 모두 지웠고 검증 함수는 version 12의 404 응답으로 교체했다. 원본 6개 데이터 묶음의 fingerprint는 유지됐다. `fountain-api` version 2에서는 실제 익명/거절 경계 8개를 별도로 확인했다.

소스 회귀 실행은 Node runner 144개가 모두 통과했고, 내부 Python/SQLite oracle에는 별도 수백~수천 개의 비교가 있다. 기존 Python의 실제 PostgreSQL 전체 검사 481개도 통과했다. 로컬에 실제 TypeScript 컴파일러는 없으며 Node 구문 검사나 LSP 결과를 타입 검사 성공으로 취급하지 않는다. 실제 Deno bundle 배포와 HTTP 검증의 범위를 별도로 기록한다.

계정 관리·초기 계정 생성·백업 SQL은 `supabase/schema/cloud-accounts.sql`, `cloud-bootstrap-create.sql`, `cloud-backup.sql`의 **미적용 초안**이다. 계정 변경의 미확정 외부 요청 중에는 연결 해제를 거절하고 전역 Auth UUID의 연결 차단을 보존한다. 백업 취소는 읽기를 종료하고 임시 파일을 한 번 정리한다. 단, 현 백업의 64MiB 상한만으로 Edge 실행 한도를 충족하지는 않는다. 48MiB 입력의 로컬 CPU 4.55초·권한 검사 3,109회가 확인되어 실제 한도 검증과 분할 처리 또는 보수적 거절이 남아 있다. 이 제한이 해결되기 전 대용량 백업 지원 완료를 주장하지 않는다.

`deployment.setupEnabled`는 아직 false이며, 일반 가입·실사용자 계정 생성·초기 연결 코드 발급을 켜지 않았다. 계정 연결 화면은 기존 `/api/session` 안에서 명시적으로 동작하며 코드와 비밀번호를 영구 저장하지 않는다. 정적 웹 배포물 15개와 공개 HTML relay는 생성·로컬 검증했지만 호스팅 배포와 정확한 HTTPS origin 연결은 남아 있다. localhost:8787은 기존 동작 보존용 불변 Python 릴리스를 계속 제공하며 새 클라우드의 운영 전환으로 안내하지 않는다.

[라우트 인벤토리](../supabase/tests/route-inventory.json)는 현재 Python 라우트의 **method/path 201개 행**을 기록한다. HEAD와 기존 suffix alias도 별도 행이다. 각 행에는 인증 경계, 익명 접근 여부, handler/domain/module, 실제 Python AST 분기의 근거와 cloud 상태가 있다. `public`은 익명 인증 경계를 뜻하며 단순히 게시된 콘텐츠라는 뜻이 아니다.

- `pending`: 운영 가능한 클라우드 handler와 검증이 아직 연결되지 않음.
- `staged-auth`: 세션 경계 구현 단계. 실제 사용자 연결과 다기기 흐름 검증이 남음.
- `static-relay-required`: 정적 호스트 및 같은 출처의 전달 경로가 필요함.
- `not-applicable`: 로컬 전용 세션 갱신. 계정 인증이 필수인 클라우드에서는 명시적으로 거절해야 함.

현재 모든 행의 `productionParityVerified`는 `false`다. fixture, 모델 테스트, 함수 배포, 타입 또는 health 검사만으로 이 값을 바꾸지 않는다. 실제 Supabase Auth/DB/Storage와 연결한 해당 HTTP 계약 및 권한·오류·재시도·데이터 보존 증거가 필요하다.

## 구성

1. **Supabase Auth**가 클라우드 사용자 인증을 담당한다. 기존 member ID·role·ACL의 의미는 `identity_mapping(workspace_id, auth_user_id, member_id)`으로 유지한다. 이메일이나 user metadata로 owner를 자동 지정하거나 첫 가입자를 owner로 만들지 않는다. 기존 scrypt 해시를 Supabase의 비밀번호 해시로 간주하지 않는다.
2. **Edge Functions**가 기존 `/api/*`, SCIM, 공개 게시, SSE, Range 계약을 구현한다. 업무 요청을 Python으로 되돌려 보내는 경로는 최종 구성에 포함하지 않는다. `verify_jwt=false`인 entry는 자체 인증을 수행하며 이 설정을 익명 허용으로 해석하지 않는다.
3. **세션 Vault**는 43자 `fountain_session`을 서버 토큰 보관함의 식별자로 유지한다. DB에는 식별자의 해시와 암호문만 둔다. Supabase JWT·refresh token·service key는 웹 및 앱 renderer로 보내지 않는다. 웹의 HttpOnly 쿠키와 모바일의 Keychain/Keystore 계약을 유지한다. refresh는 lease/CAS로 직렬화하며 binding과 7일 opaque 만료 시각을 갱신 때마다 연장하지 않는다. Supabase 앞단의 Cloudflare가 붙이는 `__cf_bm`은 Fountain의 계정 쿠키가 아니며 실제 인증 쿠키 검증과 구분한다.
4. **Store RPC**는 실제 session hash·binding·Auth session·user·member mapping을 재검증하고 잠근다. 기존 Python writer와 같은 workspace advisory lock 및 revision CAS를 사용한다. 같은 세션의 txid/digest receipt는 정확한 재시도만 허용하고, 응답이 불확실하면 새 변경을 실행하지 않는다. 이 경로는 trusted service의 서버 권한 검사다. `SECURITY DEFINER`가 기존 workspace RLS를 우회하므로 사용자별 RLS로 보호된다고 설명하지 않는다. 클라이언트의 직접 RPC 실행과 기존 private schema에 대한 새 일반 grant는 허용하지 않는다.
5. **Storage** 비공개 bucket이 기존 첨부 파일의 영구 보관을 맡는다. 첨부 권한·offset·SHA·중단 후 재개·Range·백업 의미를 보존해야 한다. 무료 quota를 넘는 입력을 잘라 저장하거나 무제한 무료라고 표시하지 않는다.
6. **Realtime와 Cron**이 변경 알림·presence 및 예약 작업을 담당한다. renderer에 JWT를 노출하지 않는 SSE 중계는 현재 세션과 리소스 권한을 계속 검사해야 한다. 무료 Edge worker 수명에 맞춰 재연결하며 공유 알림에 비공개 본문을 넣지 않는다.

## 웹 및 설치 앱의 연결

무료 Supabase 기본 도메인은 HTML GET 응답을 `text/plain`으로 바꾼다. 따라서 정적 웹 호스트가 HTML/CSS/JS를 제공하고, `/api/*` 등을 Supabase Edge로 전달하는 얇은 같은 출처 relay가 필요하다. 업무 로직이나 사용자 데이터는 relay에 두지 않는다. 쿠키·EventSource·XHR를 같은 출처로 유지하면 제3자 쿠키 차단에 의존하지 않는다. API·쿠키·개인 응답의 CDN 캐시는 끄고, 실제 Set-Cookie·SSE·Range 전달을 검사한다. 공개 sites/forms HTML 역시 브라우저에서 렌더링되는 최종 content type을 확인해야 한다.

설치 앱은 같은 웹 HTTPS origin을 사용할 수 있다. Supabase origin에 직접 연결하려면 네이티브 내부에서 고정 `/functions/v1/fountain-api` 접두사를 붙이는 명시적 adapter가 필요하다. 현재 주소 입력은 순수 origin만 허용하고 요청은 `origin + /api/...`로 작성하므로 함수 URL 전체를 기존 주소 칸에 붙이는 방식은 동작하지 않는다. TLS·경로·헤더·쿠키 격리를 완화해서는 안 된다.

기존 `/sites/{slug}`·`/forms/{id}`는 게시 정책을 검사하지만, 현행 Python HTTP wrapper에서는 family/accounts 모드의 세션 인증도 거친다. 현재 동작과 최종 익명 공개 요구를 구분하고 의도한 변경은 별도 권한 테스트로 검증한다. SCIM은 별도 bearer 인증이다. 일반 legacy OPTIONS endpoint는 없지만 SCIM ServiceProviderConfig는 메서드 확인 전에 응답하는 기존 예외가 있다. Advanced collection은 임의의 추가 suffix를 받는 GET/PATCH/DELETE alias도 있으므로 조용히 누락하지 않는다.

## 라우트 감사 실행

```sh
node supabase/tests/route-inventory.mjs
```

검사는 Python 표준 AST만 읽으며 서버 모듈을 import하거나 DB에 접속하지 않는다. Python 라우팅·인가 함수 8개의 fingerprint, 실제 분기가 도달하는 return/HTTP handler, 모든 비예외 terminal의 포함 여부와 각 대표 경로의 7개 HTTP method를 대조한다. Edge entry fingerprint도 검사하므로 handler 설치가 바뀌면 coverage를 다시 감사해야 한다. 격리된 Edge boundary 호출은 미구현 domain 요청이 성공으로 위장하지 않고 503을 반환하는지 확인하는 검사이며 실제 클라우드 업무 처리 증거가 아니다.

소스가 바뀌어 실패하면 먼저 endpoint·인증·별칭과 cloud 검증 상태를 검토하고 JSON을 수정한다. 그 다음에만 근거를 갱신한다.

```sh
node supabase/tests/route-inventory.mjs --refresh-evidence
node supabase/tests/route-inventory.mjs
```

운영 전환에는 인벤토리의 모든 지원 기능, 실제 두 사용자·다기기 동기화, 권한 강등/로그아웃 중 진행 요청, CRDT/Undo/동기화 receipt, 첨부와 백업, 공개 게시와 자동화, 실제 설치 앱 검증이 필요하다. 원본 DB·파일·ACL·세션·문서 fingerprint를 비교하고 복구 가능한 이전 경로를 보존한다. 초기 owner 연결이 끝나지 않은 health/Auth 후보 배포를 가족용 완성 앱으로 안내하지 않는다.

참고: [Supabase Edge 제한](https://supabase.com/docs/guides/functions/limits), [Auth 세션](https://supabase.com/docs/guides/auth/sessions), [API 권한](https://supabase.com/docs/guides/api/securing-your-api), [Realtime 권한](https://supabase.com/docs/guides/realtime/authorization).
