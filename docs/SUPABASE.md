# Supabase 연결

2026-10-16에 승인받은 무료 조직 `hooni-dev-0104's Org`에 서울 리전의 **Fountain** 프로젝트를 생성했다. 프로젝트 참조는 `ehnovtfadpkwtubmwltl`이며 기존 다른 프로젝트는 변경하지 않았다. 현재 로컬 미리보기의 원본은 `.data/fountain.db`다. 기존 가족 데이터 이관과 운영 서버 전환은 아직 하지 않았다.

## 저장소와 권한

`fountain_private` 스키마에 문서·설정·첨부 조각·향후 계정 매핑 테이블을 만들었다. 네 테이블 모두 RLS를 활성화하고 강제한다. 앱 서버 전용 `fountain_app` 역할은 해당 스키마의 읽기·쓰기만 허용하며 superuser·BYPASSRLS·역할 생성·스키마 생성 권한은 없다. `anon`·`authenticated`·`service_role`은 이 스키마에 접근하지 못한다.

서버는 트랜잭션마다 작업공간 ID를 설정하고 작업공간 단위 advisory lock을 얻은 뒤 세션·문서 권한을 검사한다. 작업공간 설정이 없으면 행을 읽거나 쓸 수 없다. 이 RLS는 신뢰하는 서버의 작업공간 경계다. 최종 가족 사용자별 권한은 기존 Fountain API가 검사하므로 DB 계정을 브라우저·데스크톱 renderer·모바일 앱에 넣으면 안 된다.

현재 계정·비밀번호·로그아웃은 기존 Fountain 개별 계정 방식을 사용한다. Supabase Auth·OAuth·Realtime·Storage 연동은 구현하지 않았다. 문서와 접속자 갱신은 Fountain API의 SSE를 사용한다. Supabase DB 생성으로 Python 서버까지 호스팅되는 것은 아니며 공통 HTTPS 서버 운영은 별도로 필요하다.

## 선택 설치와 실행

SQLite 실행에는 새 패키지가 필요 없다. PostgreSQL 모드는 Python 3.10 이상과 승인받은 선택 드라이버를 사용한다. 버전과 배포 파일 해시는 lock 파일에 고정했다.

```sh
python3 -m venv .data/supabase-venv
.data/supabase-venv/bin/python -m pip install --require-hashes -r requirements-supabase.lock
```

연결 파일은 Git에서 제외되는 `.data/` 아래에 소유자만 읽을 수 있는 `0600` 권한으로 둔다. JSON의 `database_dsn` 값에는 서버 전용 계정·암호·호스트와 `sslmode=verify-full`, `sslrootcert` 경로를 지정한다. 파일 대신 `FOUNTAIN_DATABASE_URL` 환경 변수로 전달할 수도 있다. `.env`는 자동으로 읽지 않는다. DSN을 명령 인자에 직접 넣는 옵션은 제공하지 않는다.

```sh
.data/supabase-venv/bin/python -m fountain.server --database postgres \
  --database-config .data/supabase-connection.json --workspace-id family --port 8788
```

이 명령은 지정한 이름의 작업공간을 연다. 새 이름이면 초기 작업공간이 생성되며 SQLite 자료를 자동으로 가져오지 않는다. 모든 서버 인스턴스에 같은 작업공간 ID를 사용해야 한다. 기존 `--host`·`--allowed-host`·TLS·가족 계정 조건도 그대로 적용된다.

현재 환경에서는 IPv6 전용 직접 DB 주소에 연결할 수 없어, 실제 인증과 스키마 확인을 마친 서울 공유 session pooler의 IPv4 주소·5432 포트를 사용한다. 인증서는 Supabase Studio의 [공식 인증서 URL 설정](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json)에 있는 다운로드 주소에서 받았다. Root 2021 CA의 DER SHA-256 지문은 `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`이며, 실제 TLS 1.3 연결에서 인증서와 호스트 이름 검증을 통과했다. 인증서 설치와 `verify-full` 설정은 [공식 SSL 안내](https://supabase.com/docs/guides/platform/ssl-enforcement)를 따른다.

## 백업과 용량

PostgreSQL 모드의 전체 백업 다운로드는 작업공간 잠금 안에서 문서·설정·완료된 첨부를 함께 복사하고 기존 검증기를 거친 SQLite 파일을 만든다. 계정 암호 해시는 복원할 수 있게 보존하며 로그인 세션·presence·미완료 업로드·로컬 cache binding은 제외한다. 기존 `python3 -m fountain.backup restore`로 새 SQLite 파일에 복원할 수 있다. 외부 Supabase Auth 매핑은 이 백업에 포함되지 않는다. 복사 중 같은 작업공간의 쓰기는 대기한다.

현재 PostgreSQL 첨부 조각은 BYTEA로 저장한다. 이는 **Free DB 용량 안의 작은 첨부 검증용**이며 기존 파일당 5GB를 Free DB에 넣는 운영 구성이 아니다. [Free DB는 500MB, Storage는 1GB](https://supabase.com/pricing)이고 [Free Storage의 파일 한도는 50MB](https://supabase.com/docs/guides/storage/uploads/file-limits)다. 대용량 첨부 저장소를 분리하기 전에는 기존 SQLite 운영 데이터를 클라우드 모드로 전환하지 않는다.

마이그레이션은 `supabase/migrations/20261016021029_fountain_private_store.sql`에 기록했다. 원격 적용 후 보안 advisor 지적은 없었다. 새 프로젝트의 사용 전 인덱스 안내는 실제 호출과 향후 Auth FK를 위한 인덱스이므로 유지한다. [unused index 안내](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)

실제 PostgreSQL 검증은 테스트마다 임의 작업공간을 만들고 그 작업공간만 정리한다. `FOUNTAIN_TEST_POSTGRES_DSN`을 별도로 설정한 선택 드라이버 환경에서 `test_postgres.py`, `test_postgres_backup.py`, `test_postgres_http.py`를 실행한다. 비밀정보와 실제 가족 작업공간은 테스트 로그·Git에 넣지 않는다.

현재 전체 Python 테스트 318개가 선택 드라이버와 실제 Supabase 연결을 사용해 skip 없이 통과했다. 이 중 저장소 16개는 실제 RLS·권한·SAVEPOINT·동시 변경·세션 철회, 백업 7개는 바이트 복원·잠금·실패 정리를 확인한다. HTTP 4개는 서로 다른 서버의 같은 계정, 문서·행·CRDT·별도 presence SSE·첨부 Range·백업·로그아웃·권한 철회를 확인한다. 권한 철회와 조회의 경쟁은 이전 구현에서 실패하는 회귀 테스트로도 검증했다.
