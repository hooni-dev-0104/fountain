# 기존 inline 첨부의 Supabase 다운로드

원본 작업공간에는 이미 PostgreSQL에 저장된 80바이트 inline 첨부 1개가 있고 외부 chunk 행은 0개다. 클라우드 파일 경로가 Storage manifest만 받아 기존 형식을 내려받지 못하던 문제를 수정했다. 원본을 이동하거나 다시 업로드하지 않고 API version 10에서 이 형식을 읽는다. 원본 소유자 Auth 연결은 아직 없으므로, 아래 실제 인증 검증은 별도의 격리 작업공간에서 수행했다.

일반 Store snapshot의 `attachment.data` 숨김 처리는 유지한다. `20261016194516_fountain_cloud_inline_attachment_range.sql`은 실제 현재 세션·매핑·멤버를 확인하고 workspace 잠금을 얻은 뒤 정확한 첨부 메타데이터와 전체 원본 JSON의 digest를 비교한다. 전체 base64의 유효성·최대 5,000,000바이트·선언 크기·내용 SHA를 검증한 후 최대 64KiB만 반환한다. 첫 preflight는 바이트를 반환하지 않는다. private definer와 public invoker 함수만 service_role 실행을 허용하고 기존 테이블 권한은 바꾸지 않는다.

서버 전용 공급자는 고정 RPC·워크스페이스·컨텍스트·메타데이터·응답 범위·digest·base64·응답 크기·시간 제한·취소를 검사한다. HTTP 경로는 각 조각 RPC 전후에 문서 접근 권한을 다시 확인하며 HEAD·Range·If-Range·416을 지원한다. 응답은 `application/octet-stream`과 attachment 다운로드다. 원본 base64와 source digest는 공개 메타데이터에 포함하지 않는다. cloud overlay가 있으면 원래 inline 바이트로 되돌아가지 않는다.

## 실제 실행

- 전체 Supabase Node 검사 **370 PASS, 실패·skip 0**, 약 47초. 파일 도메인 32개·공급자 9개·SQL 계약 8개를 포함한다. 실제 정적 TypeScript 타입 검사와 구분한다.
- Supabase에 적용된 migration은 **26개**다. 실제 catalog에서 두 함수의 소유자·definer/invoker·고정 search path와 anon/authenticated 실행 거절·service_role 실행 허용을 확인했다.
- 실제 GoTrue bootstrap으로 QA owner를 생성하고 실제 계정 API로 두 번째 멤버를 생성·로그인했다. HttpOnly·Secure·SameSite=Strict 쿠키를 사용해 owner와 공유받은 멤버가 80바이트를 똑같이 내려받았다. 공개 DTO·HEAD·Range·suffix·If-Range 불일치·416·잘못된 전체 원본·빈 파일·Python 3.12의 pad bits 호환·공유받지 않은 파일 거절을 확인했다.
- 공유받은 멤버가 **5,000,000바이트**를 끝까지 내려받아 독립 Node SHA-256과 ETag를 비교했다. 결과는 `2c3e57d05f00a0835d1ad6eabc5410dd56595afe42417ddc69cb8bf60804c3b2`다. 64KiB 위치를 가로지르는 비정렬 Range도 확인했다. 이는 legacy inline의 5MB 한도이며 5GB 전송 검증이 아니다.
- 실제 PostgreSQL 검사 **19개 그룹 PASS**: 실제 세션에서 컨텍스트 도출, 권한·범위·stale metadata 거절, 같은 크기의 바이트 교체 후 digest 거절, vault 로그아웃·폐기·세션 만료·사용자 정지·매핑 삭제·멤버 비활성 거절, 전체 base64/크기/SHA 오류, pad bits, 원본·메타데이터·receipt 보존, REPEATABLE READ 거절이다. 이 검사의 모든 임시 변경은 rollback했다.
- 다운로드 검사 전후 QA 첨부·메타데이터 digest, revision **3**, receipt **0**, Storage 객체 **0**이 동일했다. 원본 첨부는 이전 portable SQLite 백업과 필드·바이트까지 동일하며 원본 여섯 비즈니스·세션 컬렉션 지문도 동일했다.

실제 QA는 고정 프로젝트·일회용 namespace·nonce로 제한한 wire에서 실제 애플리케이션 코드를 실행했다. SQL·Auth·HTTP·바이트 처리는 실제 Supabase이며 모델 공급자는 아니다. 실행한 제품 소스는 QA bundle과 운영 API 배포 사이에 같음을 비교했다. HTTP driver는 테스트 후 저장 파일의 부분 쓰기 처리와 retirement 검사만 보강했으며, 일반 다운로드 요청·검증 분기는 유지했다. 기록된 driver 해시는 보고 시점의 소스다.

진행 중인 스트림의 ACL 철회·취소·같은 크기 교체를 정확한 시점에 주입하는 검사는 모델 도메인 테스트다. 실제 SQL의 철회·교체 검사와 구분하며, 실제 기기에서 진행 중인 전송에 권한 철회를 동시에 주입했다고 주장하지 않는다. 이번 변경에서는 새 iOS/Android/Windows 앱 실행을 하지 않았다.

## 정리와 운영 상태

QA 계정 두 개를 정상 로그아웃한 뒤 정확한 UUID·보호된 marker를 검사해 Admin API로 삭제했다. 해당 공간의 29개 테이블 잔여 행·Auth 사용자·세션·Storage 객체·Cron은 0개다. 검증 함수는 version 52의 404 응답으로 교체했고 기존 nonce의 wire·cleanup-check·cleanup 요청 3개가 모두 거절됐다. 평문 nonce·비밀번호·쿠키 입력 파일도 삭제했다.

운영 `fountain-api`는 version **10**, SHA `8e6422197588a306bf15dc9d8e69577b5af90c234a06fefa3522dba17f8da9f9`이며 익명/거절 경계 8개를 다시 확인했다. `ready:false`, `setupEnabled:false`, `webOrigins:[]`, `publicWebOrigin:null`은 유지한다. 원본 entities 153개·meta 6개·Auth mapping 0개이며 기존 8787 미리보기는 재시작하지 않았다. Security advisor에는 기존 `extension_in_public` WARN 한 개가 남아 있다.

전체 목표는 진행 중이다. 실제 소유자 계정 연결·공개 웹 호스트·다섯 플랫폼 전체 동시 전파·Windows 실행·나머지 기능과 외부 공급자 검증은 남아 있다. [기계 판독 결과](inline-attachment-verification.json)에 버전·해시·검사·제한을 기록했다.

## 재현 도구

일반 source 검사는 다음 명령으로 실행한다. 이번 검증은 Node 24와 Python 3.12를 사용했다. legacy base64 oracle는 Python 3.12를 요구하며 아래 명령은 이미 승인된 해당 런타임을 지정한다.

```sh
FOUNTAIN_PYTHON=.data/supabase-venv/bin/python node --test supabase/tests/*.mjs
```

실제 QA는 Root가 새 namespace·seed·bootstrap hash와 밀봉된 테스트 함수를 준비한 경우에만 [HTTP driver](../../supabase/tests/drivers/inline-http.mjs)를 `prepare`, `small`, `large`, `logout`, `retired` 순서로 실행한다. 비밀 입력 파일은 소유자 전용 `0600`이어야 한다. 이전 입력이나 운영 owner를 재사용하지 않는다. [실제 SQL 검사](../../supabase/tests/live-inline-attachment-proofs.sql)는 실제 QA owner 세션이 살아 있을 때 workspace placeholder 두 곳을 같은 새 namespace로 바꾸고 실행한다. 실제 SQL 검사를 마친 뒤 로그아웃·보호된 Auth 정리·namespace 정리·함수 retirement·입력 삭제를 수행한다.
