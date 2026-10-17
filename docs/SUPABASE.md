# Supabase 연결

2026-10-16에 승인받은 무료 조직 `hooni-dev-0104's Org`에 서울 리전의 **Fountain** 프로젝트를 생성했다. 프로젝트 참조는 `ehnovtfadpkwtubmwltl`이며 기존 다른 프로젝트는 변경하지 않았다. **현재 `localhost:8787` 미리보기는 Supabase PostgreSQL을 원본으로 사용하는 Python 호환 실행 상태다.** 기존 페이지·DB·첨부·계정·작업공간 ID·로그인 binding을 검증해 이관했으며 `.data/fountain.db` 원본과 전환 전후 백업도 보존했다.

이 문서의 실행 명령·디스크 파일 설명은 보존된 Python 호환 모드에 해당한다. 최종 운영용 Supabase Edge Functions·Auth·Storage 백엔드는 별도로 구현·검증하고 있으며 현재 API version 14, migration 26개다. 원본 소유자용 일회용 연결 코드를 해시로 등록하고 앱의 명시적 가입·연결 화면을 열 수 있게 준비했다. 실제 소유자는 앱에서 직접 이메일·비밀번호·코드를 입력해야 하며 아직 연결 완료를 검증하지 않았다. 공개 웹 호스팅과 함께 운영 전환의 남은 단계다. [현재 백엔드 구조·검증 상태](supabase-backend.md), [기존 inline 첨부 읽기](research/inline-attachment-verification.md), [통합 검색](research/advanced-search-verification.md).

## 저장소와 권한

`fountain_private` 스키마에 문서·설정·첨부 조각·향후 계정 매핑 테이블을 만들었다. 네 테이블 모두 RLS를 활성화하고 강제한다. 앱 서버 전용 `fountain_app` 역할은 해당 스키마의 읽기·쓰기만 허용하며 superuser·BYPASSRLS·역할 생성·스키마 생성 권한은 없다. `anon`·`authenticated`·`service_role`은 이 스키마에 접근하지 못한다.

서버는 트랜잭션마다 작업공간 ID를 설정하고 작업공간 단위 advisory lock을 얻은 뒤 세션·문서 권한을 검사한다. 작업공간 설정이 없으면 행을 읽거나 쓸 수 없다. 이 RLS는 신뢰하는 서버의 작업공간 경계다. 최종 가족 사용자별 권한은 기존 Fountain API가 검사하므로 DB 계정을 브라우저·데스크톱 renderer·모바일 앱에 넣으면 안 된다.

이 Python 호환 모드의 계정·비밀번호·로그아웃은 기존 Fountain 개별 계정 방식을 사용하며 문서와 접속자 갱신은 Fountain API의 SSE를 사용한다. 별도 Supabase 백엔드의 Auth·Realtime·Storage 구현과 구분한다. 아래 명령으로 실행한 Python 서버에는 직접 상시 운영이 필요하지만, 최종 Supabase 백엔드는 Python 프로세스나 상시 켜진 Mac을 요구하지 않는 구성이다.

## 선택 설치와 실행

SQLite 실행에는 새 패키지가 필요 없다. PostgreSQL 모드도 앱의 Python 3.11 이상 조건을 유지하며 승인받은 선택 드라이버를 사용한다. 버전과 배포 파일 해시는 lock 파일에 고정했다.

```sh
python3 -m venv .data/supabase-venv
.data/supabase-venv/bin/python -m pip install --require-hashes -r requirements-supabase.lock
```

연결 파일은 Git에서 제외되는 `.data/` 아래에 소유자만 읽을 수 있는 `0600` 권한으로 둔다. JSON의 `database_dsn` 값에는 서버 전용 계정·암호·호스트와 `sslmode=verify-full`, `sslrootcert` 경로를 지정한다. 파일 대신 `FOUNTAIN_DATABASE_URL` 환경 변수로 전달할 수도 있다. `.env`는 자동으로 읽지 않는다. DSN을 명령 인자에 직접 넣는 옵션은 제공하지 않는다.

```sh
.data/supabase-venv/bin/python -m fountain.server --database postgres \
  --database-config .data/supabase-connection.json --attachment-root .data/fountain-files
```

현재 비공개 연결 파일에는 검증한 `workspace_id`도 보관하므로 위 명령으로 이관된 작업공간을 다시 연다. `--workspace-id`를 명시하면 그 값이 우선하며 새 이름은 별도의 빈 작업공간을 만든다. SQLite 자료를 자동으로 가져오는 명령은 아니다. 모든 서버 인스턴스에 같은 작업공간 ID와 파일 루트를 사용해야 한다. 기존 `--host`·`--allowed-host`·TLS·가족 계정 조건도 그대로 적용된다. 기본 SQLite 명령은 별도의 원본을 열므로 현재 클라우드 자료를 보려면 위 실행 옵션을 사용한다.

현재 환경에서는 IPv6 전용 직접 DB 주소에 연결할 수 없어, 실제 인증과 스키마 확인을 마친 서울 공유 session pooler의 IPv4 주소·5432 포트를 사용한다. 인증서는 Supabase Studio의 [공식 인증서 URL 설정](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json)에 있는 다운로드 주소에서 받았다. Root 2021 CA의 DER SHA-256 지문은 `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`이며, 실제 TLS 1.3 연결에서 인증서와 호스트 이름 검증을 통과했다. 인증서 설치와 `verify-full` 설정은 [공식 SSL 안내](https://supabase.com/docs/guides/platform/ssl-enforcement)를 따른다.

## 백업과 용량

PostgreSQL 모드의 전체 백업 다운로드는 작업공간 잠금 안에서 문서·설정·완료된 첨부 바이트를 함께 복사하고 기존 검증기를 거친 SQLite 파일을 만든다. 계정 암호 해시는 복원할 수 있게 보존하며 로그인 세션·presence·미완료 업로드·로컬 cache binding·파일 루트와 GC 참조는 제외한다. 기존 `python3 -m fountain.backup restore`로 새 SQLite 파일에 복원할 수 있다. 복원본에는 실제 파일 바이트가 있으므로 원래 파일 디렉터리가 필요 없다. 외부 Supabase Auth 매핑은 포함되지 않는다. 복사 중 같은 작업공간의 쓰기는 대기한다.

`--attachment-root`를 사용하는 현재 서버는 새 청크 업로드의 바이트를 POSIX 공유 디스크에 저장하고 PostgreSQL에는 작은 해시 manifest를 둔다. 파일·디렉터리 권한은 각각 `0600`·`0700`이며 덮어쓰기 없는 파일 게시를 마친 뒤 DB 참조를 커밋한다. 파일 루트의 UUID가 DB와 다르거나 기존 파일 작업공간을 루트 없이 시작하면 거절한다. 여러 API 서버는 같은 내구성 있는 디스크를 공유해야 한다. 기존 작은 inline 첨부와 BYTEA 읽기는 호환하지만 BYTEA만 사용하는 모드는 Free DB 용량 안의 작은 검증용이다.

[Free DB는 500MB, Storage는 1GB](https://supabase.com/pricing)이고 [Free Storage의 파일 한도는 50MB](https://supabase.com/docs/guides/storage/uploads/file-limits)다. 현재 큰 파일은 Supabase Storage에 올리지 않는다. 서버 디스크 용량과 공통 API 서버의 상시 운영은 별도로 필요하다.

취소·삭제·실패 뒤 미참조 파일은 즉시 지우지 않는다. 아래 명령은 현재 참조를 재검사해 24시간 지난 고아 파일을 최대 500개 살펴보며, 진행 위치를 DB에 보관하므로 다음 실행이 이어서 정리한다.

```sh
.data/supabase-venv/bin/python -m fountain.server --database postgres \
  --database-config .data/supabase-connection.json --attachment-root .data/fountain-files \
  --collect-files --gc-limit 500
```

운영 이관용 `migrate_sqlite(source_path, targetStore)`는 기존 SQLite를 잠그고 같은 ID의 빈 PostgreSQL 작업공간에 원자적으로 복사한다. 계정·세션·cache binding·CRDT·재전송 receipt·revision을 보존하고 데이터·첨부 해시를 비교한다. 기존 대상은 지우지 않으며 실패하면 대상만 rollback한다. 현재 자료도 이 경로로 이관한 뒤 검증용 API에서 문서·DB·첨부 바이트·세션을 비교하고 본래 주소로 전환했다. 이관된 서버의 백업을 다시 SQLite로 복원하는 검증도 통과했다.

마이그레이션은 `supabase/migrations/20261016021029_fountain_private_store.sql`에 기록했다. 원격 적용 후 보안 advisor 지적은 없었다. 새 프로젝트의 사용 전 인덱스 안내는 실제 호출과 향후 Auth FK를 위한 인덱스이므로 유지한다. [unused index 안내](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)

실제 PostgreSQL 검증은 테스트마다 임의 작업공간을 만들고 그 작업공간만 정리한다. `FOUNTAIN_TEST_POSTGRES_DSN`을 별도로 설정한 선택 드라이버 환경에서 `test_postgres.py`, `test_postgres_backup.py`, `test_postgres_http.py`를 실행한다. 비밀정보와 실제 가족 작업공간은 테스트 로그·Git에 넣지 않는다.

전체 Python 테스트 367개가 선택 드라이버와 실제 Supabase 연결을 사용해 skip 없이 통과했다. 파일 저장소 17개·혼합 저장과 해시 12개·백업 12개·이관 12개를 포함한다. 기존 저장소 16개와 HTTP 4개는 RLS·권한·SAVEPOINT·동시 변경·서로 다른 서버의 같은 계정·문서/행·CRDT/SSE·첨부·로그아웃을 확인한다. 이후 연결 설정 6개와 기능 API 16개도 통과했다. 권한 철회와 조회의 경쟁은 이전 구현에서 실패하는 회귀 테스트로 검증했다.

`tests/browser-postgres.mjs`는 실제 Chrome의 독립 서버 두 개와 같은 계정으로 편집·커서·오프라인 재시작·동시 병합·행 UI·파일 다운로드를 검증했다. 파일 디스크 모드에서 바이트 일치, BYTEA 0건과 테스트 자료 삭제까지 통과했다. 원격 단계마다 30초, 문서 연결 후 UI 완료에는 10초를 적용한다. 세션 조회를 묶고 중복 사전 인증을 제거한 뒤 같은 두 SSE 조건의 업로드 처리 4단계 합계는 32.098초에서 8.205초로 감소했다.

`scripts/verify-postgres-large-files.py`로 실제 5,000,000,000바이트를 저장하고 전체 읽기·청크 경계 HTTP Range·백업·SQLite 복원 해시 일치를 검증했다. manifest 1,193개, BYTEA 0건, 최대 RSS 약 73MiB, 368.92초였으며 테스트 데이터는 정리했다. [원본 코드 해시와 측정 결과](research/postgres-five-gb-evidence.json)에 범위를 기록했다. 이 5GB 검사의 업로드와 전체 읽기는 저장소 API를 직접 사용했으며 **PostgreSQL 모드의 5GB 전체 HTTP 전송을 검증한 결과는 아니다.** HTTP 전체 전송은 작은 파일로 확인했고 큰 파일은 `--http-full`로 별도 측정할 수 있다.
