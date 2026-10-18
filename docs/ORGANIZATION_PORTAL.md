# 독립 조직 로그인과 관리 화면

조직 소유자가 작업공간 로그인과 별도로 인증하고 조직·소유자·작업공간 연결을 관리하는 경로를 구현했다. 기존 [조직 권한 DB 기반](ORGANIZATION_AUTHORITY.md)에 세션 보관소, HTTP API, 독립 관리 화면과 모바일 전송을 연결한다. 실제 GoTrue·HTTP·Chrome 검증 뒤 운영 API 28과 웹에 배포했다. 최종 전역 fingerprint·보안 진단·비밀값 검사와 설치 앱의 전체 사용자 여정은 아직 별도 확인 대상이다. 전체 목표와 41개 기능 목록은 진행 중이며, 전체 기능 검증 완료 수는 0개다.

## 세션과 권한

작업공간의 `fountain_session`과 조직의 `fountain_organization_session`은 서로 다른 opaque cookie다. 조직 로그인은 별도의 GoTrue 로그인으로 독립된 provider 세션을 만든다. 같은 계정을 사용해도 작업공간 세션을 복사하지 않으므로 한쪽 로그아웃이나 작업공간 멤버 제거가 다른 쪽의 인증을 함께 폐기하지 않도록 설계했다. 실제 GoTrue와 HTTP에서 두 provider 세션의 ID가 다름을 확인했고, 양방향 로그아웃 보존과 작업공간 멤버십 없이 조직 소유자로 접근하는 동작을 검사했다.

[공통 세션 엔진](../supabase/functions/_shared/session-auth.ts)은 기존 암호화·opaque cookie·일회용 refresh lease·응답 불확실성 처리·먼저 로컬 폐기하는 알고리즘을 재사용한다. 기존 [작업공간 인증 facade](../supabase/functions/_shared/auth.ts)는 공개 계약을 유지하고, [조직 인증 facade](../supabase/functions/_shared/organization-auth.ts)는 실제 Auth identity만 다룬다. 가짜 작업공간·멤버·역할을 만들지 않으며, 소유 조직이 없는 확인된 계정도 조직 로그인 자체는 가능하다. 두 realm의 HKDF와 AES-GCM AAD purpose를 분리해 암호문을 서로 사용할 수 없게 한다.

새 `fountain_private.organization_session_vault`는 강제 RLS와 기본 거부 정책을 사용한다. Auth 외래 키나 트리거를 추가하지 않고 기존 작업공간 백업에서 제외한다. 공개 RPC 두 개는 `service_role`에만 실행을 허용하며, 비공개 보조 함수와 테이블의 직접 접근은 클라이언트·서비스·백엔드 역할에서 거부한다. Edge 코드가 보관소에서 얻은 identity·세션·binding을 DB에 전달하고 DB가 현재 Auth와 세션 상태를 다시 확인한다. 브라우저 입력의 UUID나 이메일을 인증 근거로 사용하지 않는다.

조직 소유자 부여는 현재 소유자의 명시적 명령이다. 이메일은 확인된 Auth 사용자를 선택하는 입력이며, 편집 가능한 메타데이터나 작업공간 역할에서 소유권을 추론하지 않는다. 대상 Auth UUID와 명령 digest를 고정해 이메일 재지정 뒤 예전 응답을 재사용하지 못하게 한다. 마지막 사용 가능한 소유자 보호, revision 충돌과 철회 뒤 권한 세대는 기존 DB 계약을 유지한다.

## 두 세션이 필요한 작업공간 동의

현재 작업공간으로 조직을 만드는 명령은 독립된 조직 세션과 현재 작업공간 소유자 세션이 같은 Auth 계정인지 확인한다. 화면에서 본인을 조직 소유자로 지정하고 현재 작업공간을 연결하는 두 항목에 명시적으로 동의해야 한다. 조직·첫 소유자·연결·사건·영수증을 한 트랜잭션에서 만든다. 운영자가 발급하는 대상 지정 초기 claim도 별도로 지원한다.

다른 작업공간 연결은 조직 소유자의 최대 15분짜리 요청과 대상 작업공간 소유자의 새 동의를 요구한다. 클라이언트가 복사하는 연결 코드는 서버 서명이 아니며, 미리보기에서 실제 조직·대상 작업공간·revision·만료를 확인한 뒤 수락한다. nonce 원문 대신 해시를 DB에 저장한다. 재전송은 같은 명령과 payload를 사용하되 현재 권한·활성 연결·세션을 다시 확인한다. 해제한 연결은 과거 ACK로 복구할 수 없다.

조직 context는 Auth 사용자 → Auth 세션 → 조직 vault → 조직 writer 순서로 잠근다. 교차 명령은 기존 작업공간 context와 writer를 먼저 잡는다. 작업공간 인증 실패는 403, 조직 인증 실패는 401로 구분해 작업공간 문제 때문에 정상 조직 세션을 지우지 않도록 한다. 세션 변경이나 RPC 대기 중 만료도 ACK를 공개하기 전에 다시 검사한다.

## HTTP와 화면

[조직 HTTP dispatcher](../supabase/functions/_shared/organization-portal.ts)는 공통 Origin·요청 헤더·경로·크기·오류 경계 뒤, 작업공간 인증 앞에서 실행한다. 공개 응답은 snake_case이고 Auth 사용자 UUID, provider 세션 UUID, cookie·토큰·암호문은 포함하지 않는다. 세션 이외 조회에는 현재 `session_binding` query, 변경에는 body binding과 명령 ID를 요구한다. 기존 조직 변경은 revision도 검사한다.

| `/api/organization` 하위 경로 | 동작 |
| --- | --- |
| `/session` | 상태 확인·조직 로그인·조직 로그아웃 |
| `/setup-eligibility` | 현재 두 세션의 조직 생성 자격 확인 |
| `/organizations` | 소유 조직 목록·명시적 조직 생성 |
| `/organizations/:id` | 상세 조회·이름 변경 |
| `/organizations/:id/owners`와 `/:grantId` | 확인된 이메일로 소유자 부여·철회 |
| `/organizations/:id/workspace-requests` | 작업공간 연결 요청 발급 |
| `/organizations/:id/workspaces/:linkId` | 연결 해제 |
| `/bootstrap` | 대상 지정 초기 claim 수락 |
| `/workspace-preview`와 `/workspace-accept` | 실제 연결 대상 확인·명시적 수락 |

[독립 조직 화면](../static/organization.html)은 작업공간 `app.js`, 오프라인 부트스트랩과 outbox를 실행하지 않는다. 로그인·조직 선택·소유자 관리·연결 요청·미리보기·동의·해제·로그아웃을 제공하며, 기존 로그인과 설정의 같은 창 링크에서 연다. 조직 전용 epoch와 binding으로 늦은 응답을 버리고, 응답이 불확실한 변경은 같은 명령을 재시도한다. 계정 변경 뒤 예전 입력·코드·명령을 새 계정에 적용하지 않는다. 비공개 조직 응답과 인증 입력을 localStorage·IndexedDB·서비스 워커 캐시에 저장하지 않는다.

## 웹·설치 앱 전송

웹과 Electron은 기존 같은 origin의 HttpOnly cookie 처리 경로에서 두 cookie를 분리한다. Electron의 원격 호스트·팝업 권한은 늘리지 않고 같은 창에서 조직 문서로 이동한다. 웹·데스크톱·모바일의 고정 자산 목록에 조직 HTML·JS·CSS를 포함했다.

모바일 문서는 Capacitor와 작은 [조직 전용 bootstrap](../apps/mobile/web/organization-native.js)을 사용한다. Android와 iOS의 `organizationRequest`·`organizationCancel`은 별도 OS vault namespace·키·인증 epoch·폐기 대기 상태를 사용한다. 기존 작업공간 요청은 인코딩 별칭을 포함한 조직 namespace를 거부한다. 조직 요청·401·로그아웃에서 작업공간 outbox나 세션 admission을 변경하지 않는다.

조직 세션만 보내는 것이 기본이며, `/setup-eligibility`, 조직 생성, `/workspace-preview`, `/workspace-accept` 네 경로에만 현재 작업공간 cookie를 읽어서 함께 보낸다. cookie와 `Set-Cookie`는 renderer에 반환하지 않는다. backend origin 변경, 취소 generation, 응답 크기·시간 제한과 폐기 대기 상태를 각 네이티브 경계에서 검사한다.

## 적용과 검증 범위

세션 마이그레이션 [46](../supabase/migrations/20261018012202_fountain_organization_sessions.sql)과 정리 마이그레이션 [47](../supabase/migrations/20261018013921_fountain_organization_session_cleanup.sql)을 Supabase에 적용했다. 서버 버전은 각각 `20261018013625`, `20261018013940`이다. 함수 9개의 본문·소유자·실행 권한을 원격에서 다시 읽어 비교했다. 운영 API 28의 52개 파일과 공유 소스 50개를 원격에서 대조했다. 웹은 기존 Vercel Hobby 프로젝트에 배포했으며 [공개 주소](https://fountain-hoonis-projects-1ccfd37e.vercel.app)에서 자산 17개와 HTTP 경계 8개를 확인했다. 배포 자산은 허용 목록 19개로 제한했다. 공개 운영 주소에서 실제 가족 계정으로 로그인한 증거는 아니다.

시간 만료는 요청 시 먼저 로컬 폐기한다. 조직 vault만 처리하는 PostgreSQL Cron 작업은 매시 17분에 최대 128행, 15초 제한으로 실행한다. 동일 명령의 임시 scheduler 작업이 실제 성공한 뒤 그 시험 작업과 기록을 제거했다. Auth가 사라진 고아 암호문은 정리하지만, 살아 있는 provider 세션의 로그아웃 실패에 필요한 retry-only 암호문은 보존한다. 별도 서버 유지보수 경로는 제한된 수의 provider 폐기를 재시도하며 실패를 성공으로 표시하지 않는다.

| 검증 | 확인한 범위와 제한 |
| --- | --- |
| PostgreSQL SQL 검사 | 실제 DB의 트랜잭션 안에서 세션·두 계정 경계·마지막 소유자·동의·replay·만료·고아 정리를 검사했다. Auth fixture는 실제 GoTrue 로그인과 구분한다. |
| 인증·HTTP·UI | 조직 인증 26개, HTTP 29개, UI 모델 10개를 통과했다. 운영 UI 함수를 제어된 비동기 응답으로 실행한 경합·동의 행위자 검사 2개도 통과했다. 실제 Chrome 화면 검증은 아래 별도 실제 인증 증거로 구분한다. |
| Node 회귀 | 76개 스크립트의 초기 실행과 변경 영향이 있는 9개 재검사를 합쳐 통과했다. 초기 접근 검사 관측 timeout과 경로 인벤토리 fingerprint 실패를 보존했다. 76개 전부가 하나의 소스 revision에서 실행된 결과는 아니다. |
| Python 회귀 | 실제 PostgreSQL 설정으로 802개 통과, skip 0개다. |
| iOS SDK | 설치된 Simulator SDK 27.0으로 앱 빌드·서명 검사와 실제 simulator 테스트 2개를 통과했다. 전송 fixture 54개, 실제 Keychain·SQLite를 포함한다. 시험 fixture의 QoS 런타임 경고 1개는 남았다. 소유한 시험 simulator는 제거했다. |
| Android SDK | 설치된 android-36/build-tools 36.0.0과 offline Gradle로 앱·시험 APK를 빌드하고 실제 emulator에서 26개를 통과했다. 조직 정책 81개와 기존 작업공간 정책 195개 검사도 통과했다. 원격 조직 인증·전체 UI 여정은 포함하지 않는다. |

새 의존성이나 SDK를 내려받지 않았다. TypeScript 진단 도구가 0개를 반환했지만 실제 compiler 실행을 입증하지 못했으므로 TypeScript 정적 컴파일 통과로 기록하지 않는다.

실제 인증 검증에는 고정 범위 QA 함수 109와 원본과 다른 작업공간 두 개를 사용했다. 최초 초기 설정은 HTTP 200 뒤 로컬 검증기가 Cloudflare cookie를 거부했다. 서버에서 성공한 초기 설정을 반복하지 않고 정확한 provider 세션을 복구해 로컬 폐기한 뒤, SQL에서 해당 세션 0건을 확인하고 암호문을 제거했다. 이후 이미 매핑된 계정의 일반 로그인과 남은 계정의 초기 설정을 각각 정상 경로로 진행했다.

실제 GoTrue identity 검사 2개와 HTTP 여정 8그룹을 통과했다. 조직 두 개의 생성과 정확한 명령 ACK, 대상 작업공간 멤버가 아닌 조직 소유자 접근, 이메일 소유자 부여, 서버 미리보기 후 연결 동의, 소유권 철회 뒤 identity 보존, 마지막 소유자 보호, 양방향 로그아웃 보존을 확인했다. 브라우저 검증 전 SQL에서는 별도 provider SID, 사건 11개·영수증 13개·활성 연결 두 개와 동의 행위자 구분을 확인했다.

실제 Chrome은 임시 loopback 표시 경로에서 실제 GoTrue·Edge·PostgreSQL에 연결했다. 전체 화면 여정 7개와 최종 읽기·시각 재검사 6개를 기록했으며, 중복 검사를 합쳐 13개의 고유 여정으로 세지 않는다. 실제 로그인·이름 변경·소유자 부여, 서버 표시값의 비활성 텍스트 처리, 390px 가로 넘침 없음, 비공개 브라우저 저장 자료 0건과 조직 로그아웃 뒤 작업공간 세션 보존을 확인했다. 시각 판정은 94점이며 기존 Fountain 스타일과 반응형 품질의 검증이다. Notion 원본의 픽셀 동등성 증거는 아니다. 전체 페이지 스크린샷의 중복처럼 보이는 캡처 현상은 실제 viewport와 DOM 개수를 확인해 구분했다.

QA 함수 110의 서버 내부 공식 password 로그인으로 대상 표시를 다시 확인하고 provider 전체 로그아웃 후 Auth 사용자 두 명을 삭제했다. SQL에서 Auth 사용자·세션·refresh token과 양쪽 realm 폐기 대기 0건을 확인한 뒤, 정확한 시험 작업공간 두 개·조직 두 개를 제거했다. 보호 함수는 트랜잭션 커밋 전에 복구했고 운영 Cron 작업과 원본 153개·메타데이터 6개의 snapshot을 보존했다. 검증 함수는 소스가 정확한 111의 단일 무조건 404 응답으로 교체했으며 예전 nonce 경로 6개도 404였다. 최종 DB 검사에서 Auth·세션·refresh token·Storage·모든 조직 테이블과 다른 작업공간 자료가 0건이며 원본 153개·메타데이터 6개의 fingerprint가 일치했다. 알려진 비밀값 136개와 인코딩 변형 198개를 소스·Git·공개 번들·설치 파일 4개에서 검사해 일치 0건을 확인했다. 이번 QA의 원문 비밀번호·nonce·쿠키와 ownership 증명은 검증 후 로컬 시험 자료에서 redaction했다. 운영 연결 설정은 보존했다.

최종 Android APK와 iOS Release simulator 앱에는 최종 공개 자산 23개가 각각 동일하게 포함됐다. Android 시험 emulator는 정리했다. iOS 결과물은 simulator용이며 물리 iPhone에 설치할 IPA가 아니다. macOS arm64와 Windows x64 ZIP에도 최종 공개 자산 17개와 클라이언트 ASAR 소스가 일치한다. macOS ad-hoc 서명, Windows PE 아키텍처와 ZIP CRC·SHA를 확인했다. 이번 단계의 새 macOS 앱 실행·Windows OS 실행·모바일의 원격 backend 전체 화면 여정은 아직 검증하지 않았다. 네 결과물과 SHA256SUMS는 `.data/installables-organization-portal-20261018`에 있다.

기존 RLS 기본 거부 안내 24개와 `pg_net` public 스키마 경고는 유지된다. 이번 단계가 기존 진단을 해결했다는 뜻은 아니다. [RLS 진단](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)과 [확장 스키마 진단](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public)을 참고할 수 있다.

## 남은 검증과 제품 범위

원본 작업공간의 실제 사용자 소유자 등록은 아직 연결하지 않았다. 공개 운영 주소에서 실제 가족 계정의 로그인 여정, macOS·Windows 실행, iOS·Android의 원격 backend 전체 화면 여정도 완료하지 않았다. 모바일 SDK fixture와 자산이 같은 설치 결과물은 해당 사용자 여정의 증거와 구분한다.

여러 작업공간 전환·탐색, 조직 정책 적용과 우선순위, 멤버·게스트 중복 제거, 조직 범위 검색·감사·법적 보류, 지속 AI 대화와 보존 정책, 가족 계정의 다섯 플랫폼 여정 및 Notion 유료 기능 전체 비교는 별도 잔여 범위다. 공개 검증 요약은 [조직 portal 증거](research/organization-portal-evidence.json)에 있다.
