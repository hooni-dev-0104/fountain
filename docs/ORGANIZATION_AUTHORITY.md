# 조직 권한과 작업공간 연결의 DB 기반

조직 소유권과 여러 작업공간 연결을 위한 독립된 Supabase 권한 계층을 추가했다. 조직 생성·이름 변경·소유자 부여와 철회·작업공간 연결 요청·동의·해제의 DB 계약을 구현했다. 공개 조직 화면이나 조직 로그인 경로는 아직 연결하지 않았다. [Notion 조직 통제](https://www.notion.com/help/organization-level-controls)와 [법적 보류](https://www.notion.com/help/legal-holds)는 공개 제품 요구사항의 참고 자료이며, 이 설계가 Notion 비공개 서버 구조를 복원했다는 뜻은 아니다.

## 권한 경계

조직 소유자는 확인된 Supabase Auth 사용자에 명시적으로 부여한다. 편집 가능한 작업공간의 `owner`·`admin`, 이메일, 사용자 메타데이터로 조직 소유권을 추론하지 않는다. 작업공간에 아직 등록되지 않은 계정도 조직 소유자일 수 있으며 조직 권한과 일반 콘텐츠 ACL은 별개다.

비공개 테이블 7개에 강제 RLS와 거부 정책을 적용하고 `anon`, `authenticated`, `service_role`, `fountain_backend`의 직접 읽기·쓰기를 차단했다. 함수 13개의 소유자는 `postgres`다. 공개 RPC 3개만 `service_role`이 실행할 수 있고, 내부 보조 함수는 실행 권한을 주지 않았다.

RPC의 `userId`·`authSessionId`는 신뢰된 Edge 코드가 공급할 입력이다. DB는 해당 사용자와 세션의 연결, 이메일 확인, 익명 여부, 삭제·차단·만료를 다시 확인한다. **UUID 두 개를 아는 것만으로 인증하는 브라우저 API는 아니다.** 이를 받는 공개 로그인 엔드포인트는 구현하지 않았다.

최초 소유자 등록은 운영자가 지정한 대상 사용자에게만 발급하는 일회용 claim으로 시작한다. 원문 nonce 대신 SHA-256만 저장하고 유효기간을 최대 24시간으로 제한한다. 발급만으로 소유자가 되지 않는다. 철회 뒤 재부여하면 새 권한 세대를 만들며, 예전 명령 영수증과 claim으로 철회된 권한을 되살릴 수 없다.

모든 사용자 명령은 현재 Auth와 권한을 확인한 뒤 영수증을 조회한다. 동일 명령의 정확한 재전송은 기존 응답을 반환하고, 다른 행위자나 요청으로 ID를 재사용하면 거절한다. 조직 revision 충돌을 검사하고, 마지막으로 사용할 수 있는 소유자를 관리 명령으로 제거하지 못하게 한다. 외부 Auth 차단·삭제는 방해하지 않으며, 사용 가능한 소유자가 사라지면 접근을 거절한다.

## 작업공간의 명시적 동의

조직 소유자가 최대 15분짜리 연결 요청을 발급한 뒤 해당 작업공간의 현재 소유자가 새 인증 검사와 작업공간 권한 검사를 통과하여 동의해야 한다. 한 작업공간은 동시에 한 조직에만 연결된다. 연결·해제 이력은 남기고, 해제된 연결의 예전 동의 응답을 재전송해 복원할 수 없다. 다시 연결하려면 소비된 기존 요청이 아닌 유효한 연결 요청에 명시적으로 동의해야 한다.

동의한 작업공간 소유자와 요청을 시작한 조직 소유자가 다른 경우를 구분한다. 동의 사건의 `actor_kind`는 `workspace_consent`, `actor_grant_id`는 비어 있으며 실제 동의 사용자를 기록한다. 요청자의 권한은 `initiatorGrantId`에 따로 남긴다. 조직 소유자 사건은 조직·권한·사용자의 복합 외래 키로 묶어서 다른 사람의 권한으로 잘못 표시하지 못하게 한다.

| 비공개 테이블 | 보존하는 사실 |
| --- | --- |
| `organization_registry` | 조직 상태·이름·revision |
| `organization_owner_grants` | 소유자 부여·철회 구간 |
| `organization_bootstrap_claims` | 대상 지정 초기 claim의 해시·만료·소비 |
| `organization_link_requests` | 요청자 권한·대상 작업공간·해시·만료 |
| `organization_workspace_links` | 동의 사용자·연결·해제 구간 |
| `organization_events` | 변경할 수 없는 명령별 행위 사실 |
| `organization_receipts` | 행위자·요청에 묶인 재전송 응답 |

현재의 전역 조직 권한은 기존 v1~v4 작업공간 백업·내보내기에 포함하지 않는다. 작업공간 복원으로 조직 소유권을 취득하지 못하며, 이번 변경은 새 백업 형식이나 일반 콘텐츠 접근권을 만들지 않는다.

## 배포와 검증

마이그레이션 [조직 권한](../supabase/migrations/20261017160540_fountain_organization_authority.sql)을 적용했다. 서버 migration 버전은 `20261018005550`, 누적 45개다. SHA-256은 `f3c4e389c93620f632de19bdf71a9ea4401dc30042b9e8f6e003f4799214f648`이며, 함수 13개의 본문·소유자·실행 권한을 원격에서 다시 읽어 비교했다. 운영 API는 27을 유지했다.

- [조직 권한 SQL 검사](../supabase/tests/organization-authority.sql)와 [작업공간 동의 SQL 검사](../supabase/tests/organization-workspace-consent.sql)를 실제 PostgreSQL의 `BEGIN`/`ROLLBACK` 범위에서 실행했다. 여기의 Auth 행은 합성 자료이며 GoTrue 로그인 검증과 구분한다. 동의자를 요청자의 조직 권한으로 잘못 표시하던 실패를 먼저 재현하고 수정 뒤 통과했다.
- 고정 범위 검증 Edge 함수 106으로 실제 GoTrue 사용자·세션 2개를 만들고 확인했다. 클라이언트가 정상적인 12자 opaque refresh token을 처음 거절한 검증기 문제를 고쳤으며, 서버 인증 성공 뒤 추가 로그인을 반복하지 않았다.
- 실제 세션으로 두 SQL 연결의 서로 다른 backend PID와 `pg_blocking_pids`를 확인하며 경합을 검사했다. 두 소유자의 동시 철회에서 후속 명령은 revision 충돌로 409를 받았고, 새 revision 재시도는 마지막 사용 가능한 소유자 보호로 409를 받았다. 두 조직의 같은 작업공간 동의 경합에서는 활성 연결이 하나만 남았다. 해제된 동의의 재전송은 403이었고 다른 유효 요청의 명시적 재연결은 통과했다. 작업공간 세션 보관 자료는 SQL fixture로 준비했으므로 실제 Fountain 브라우저 로그인 증거는 아니다.
- MCP 요청이 직렬화된 시도와 pooler 프록시 PID를 backend PID로 오인한 시도는 경합 성공 증거로 사용하지 않았다. 최종 경합 증거는 별도의 두 연결과 DB 관측으로 확인했다.
- 두 시험 조직·작업공간 1개·Auth 사용자와 세션·refresh token·Storage 자료를 정리한 뒤 0건을 확인했다. 임시 DB driver는 정확한 시험 범위·ticket 해시·만료를 제한했고, 실행 권한은 함수 삭제와 함께 제거했다. 삭제 예외는 한 트랜잭션의 정확한 시험 범위에만 적용하고 방어 함수 본문을 커밋 전에 복구했다. 전역 트리거 비활성화나 영구 역할 변경은 없었다.
- 검증 Edge 함수는 소스까지 대조한 107의 단일 무조건 404 응답으로 교체했다. 원본 콘텐츠 153개·메타데이터 6개·매핑 0개의 개수와 fingerprint가 이전 값과 일치했다. 작업 파일과 Git 이력의 비밀값 검사에서 일치 항목은 없었다.

공개 HTTP 검사 18개에서 운영 API의 인증 없는 접근은 401, 폐기한 검증 경로는 404로 확인했다. 공개 웹과 로컬 8787의 앱 자산 해시도 기존 값과 일치했다. 8787은 종료된 이전 프로세스를 확인한 뒤 동일한 고정 소스·PostgreSQL 설정으로 다시 시작했으며 소스 파일 37개를 대조했다. 새 브라우저·설치 앱 여정을 실행한 증거는 아니다.

기존 RLS 기본 거부 안내 24개와 `pg_net` public 스키마 경고는 남아 있다. 시험 Auth 사용자가 존재할 때 비밀번호 유출 방지 설정 경고도 관찰했으나 Auth 설정을 바꾸지 않았고, 최종 Auth 0건 상태의 진단에서는 해당 경고가 없었다. 새 의존성은 설치하지 않았다. [RLS 진단](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [확장 스키마 진단](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), [비밀번호 보호](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)를 참고할 수 있다.

## 남은 범위

공개 조직 로그인·관리 화면, 작업공간 전환과 탐색, 조직 정책의 적용·우선순위, 멤버·게스트 중복 제거, 조직 범위의 검색·감사와 법적 보류는 남아 있다. 지속 AI 대화, 보류 원문 스냅샷·첨부 핀, 보존 정책 운영, 가족 계정과 다섯 플랫폼의 실제 사용자 여정도 이번 증거에 포함하지 않는다. 기능 목록의 조직 거버넌스는 계속 `discovered`이며, 41개 기능의 전체 검증 완료 수는 0개다. 전체 목표는 진행 중이다.

공개 검증 요약은 [조직 권한 증거](research/organization-authority-evidence.json)에 있다.
