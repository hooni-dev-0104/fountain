# 대용량 첨부

문서의 **파일 추가**에서 파일당 최대 **5,000,000,000바이트(5GB)**를 업로드한다. 기존 첨부와 문서·버전·DB의 파일 참조는 유지한다. 기본 SQLite는 Python 표준 라이브러리만 사용하며, 현재 미리보기는 선택 PostgreSQL 드라이버와 서버 파일 디스크를 사용한다.

## 업로드와 재개

브라우저는 원본 파일의 4MiB 조각을 `application/octet-stream`으로 전송하며 파일 전체를 base64나 ArrayBuffer로 읽지 않는다. 진행 중 잠시 멈추거나 연결이 끊기면 서버가 확정한 offset부터 이어 올린다. 새로고침 후에는 같은 원본 파일을 다시 선택해야 한다. 기기에는 로그인·문서별 업로드 식별자와 파일 이름·크기·수정 시각·첫/끝 표본 지문만 보관하며 파일 바이트와 인증 토큰은 저장하지 않는다. 표본 지문은 다른 파일을 잘못 고르는 일을 줄이기 위한 검사이고 원본 전체 해시의 보장은 아니다.

완료된 청크만 offset에 반영한다. 중복 요청은 이미 저장한 바이트와 같을 때만 인정하고, 누락 구간·다른 내용·잘못된 길이는 거절한다. 마지막 청크까지 받은 뒤 서버가 실제 전체 파일의 SHA-256을 계산하고 첨부 메타데이터와 완료 표시를 같은 원본 DB 트랜잭션에서 기록한다. 완료 전에는 문서에 파일 블록을 만들지 않는다. 완료 요청의 재전송은 같은 파일을 반환한다.

진행 중 업로드는 24시간 뒤 만료된다. 서버 시작·새 업로드 시작·소유자 정리 API 호출 시 만료 자료를 정리한다. 완성된 파일은 업로드 기록이 만료되거나 취소되어도 지우지 않는다. 취소 시점에 완료 처리가 이미 끝난 파일도 보존하며, 필요하면 참조가 없는 첨부 삭제 API를 이용한다. 첨부 삭제는 문서·버전·DB 행의 참조가 남아 있으면 거절한다.

## 접근 검사와 다운로드

업로드는 작성자만 재개할 수 있다. 원래 문서를 편집할 수 있는지, 잠기거나 휴지통에 들어갔는지 매 요청에서 다시 검사한다. 게스트는 편집할 수 있는 문서를 지정해야 한다. 작업공간 소유자는 다른 사용자의 미완료 업로드를 정리할 수 있다. 요청 본문을 읽기 전에 인증하고, 네트워크 읽기 동안 워크스페이스 잠금을 놓으며, 저장 직전 원본 DB 쓰기 잠금 안에서 원래 쿠키로 인증한다.

다운로드는 64KiB씩 읽고 전송하며, 각 조각 전송 전 현재 세션·문서 참조 권한을 확인한다. 접근이 철회되면 연결을 닫는다. 이미 네트워크에 보낸 바이트를 되돌릴 수는 없다. 파일은 `application/octet-stream`과 첨부 다운로드 헤더로 제공하여 업로드한 HTML·SVG를 앱 출처에서 실행하지 않는다.

하나의 `Range: bytes=start-end`, `start-`, `-suffix` 요청과 SHA-256 ETag 기반 `If-Range`를 지원한다. 구간 응답은 206, 불가능한 바이트 구간은 416과 `Content-Range: bytes */size`를 반환한다. HEAD는 본문 없이 전체 길이를 반환하며 Range를 무시한다. 여러 구간을 합친 multipart 응답은 제공하지 않는다. [HTTP Range 표준](https://www.rfc-editor.org/rfc/rfc9110.html#name-range)

## 저장·백업

SQLite 모드는 `attachment_chunks` BLOB 테이블에 바이트를 보관한다. 현재 PostgreSQL 파일 모드는 청크의 해시·길이만 DB에 두고 실제 바이트는 보호된 공유 디스크에 저장한다. 파일 게시·fsync 뒤에 DB 참조를 삽입하며 rollback은 비공개 고아만 남긴다. 잘못된 루트·symlink·손상 파일은 거절한다. 기존 BYTEA와 작은 inline 첨부는 읽기 호환한다.

한 청크는 최대 4MiB이며 다운로드와 완료 해시의 파일 읽기는 64KiB 단위를 유지한다. 파일 모드의 완료 해시는 청크당 manifest를 한 번 조회한 뒤 로컬 파일을 읽어 원격 DB 왕복을 줄인다. 재전송 비교와 PostgreSQL 백업의 단일 읽기는 최대 4MiB다. 손상된 큰 BLOB 전체나 5GB 파일 전체를 메모리에 올리지 않는다.

전체 SQLite 백업은 완료된 파일의 청크와 SHA-256을 보존한다. 진행 중 업로드·임시 청크·로그인 세션·임시 클립보드·이전 캐시 식별자는 제외한다. 기존 두 테이블 백업도 읽을 수 있으며 새 백업의 크기·연속 offset·청크 길이·SHA-256을 검증한다. 같은 파일명을 덮어쓰지 않는 기존 복원 정책을 유지한다. JSON 내보내기는 문서·DB 이동용이며 대용량 첨부 바이트를 포함하지 않는다.

저장 공간은 파일 원본과 SQLite/WAL·백업·복원용 임시 공간이 필요하다. 완료 해시와 백업의 일관된 복사 동안 같은 작업공간의 다른 요청이 대기할 수 있다. 여러 API 서버는 동일한 파일 디스크를 공유해야 하며, 객체 서비스 연동·백그라운드 백업은 남아 있다. 취소·삭제 뒤 24시간 지난 미참조 파일의 정리 명령과 Supabase Free 용량 경계는 [연결 안내](SUPABASE.md)에 있다.

## 검증

```sh
python3 -m unittest discover -s tests -p 'test_*attachment*.py' -v
python3 -m unittest discover -s tests -p 'test_uploads_http.py' -v
node tests/browser-uploads.mjs
python3 scripts/verify-large-files.py --size 5000000000 --backup --report /tmp/fountain-large-files-report.json
node scripts/verify-browser-large-file.mjs 5000000000 /tmp/fountain-browser-large-file-report.json
```

2026-10-16 macOS에서 실제 5,000,000,000바이트 HTTP 업로드·전체 다운로드·SQLite 백업·복원을 실행했다. 원본 패턴과 다운로드·복원 파일의 SHA-256은 `71417e4e9e31f649a810892a7d99c48bee962483fec9c074a692017cd58a4200`으로 일치했다. 백업은 5,005,598,720바이트였고 전체 검증은 164.11초, 검증 프로세스의 최대 RSS는 51,331,072바이트(시작 대비 22,970,368바이트 증가)였다. 이 수치는 해당 로컬 환경의 실측이며 모든 기기의 속도 보장은 아니다. 원본 5GB 시험 파일은 저장소에 넣지 않으며 임시 시험 DB를 종료 후 삭제한다.

별도 Chrome 검증에서도 5,000,000,000바이트 파일 선택→진행률→문서 파일 블록의 서버 저장→전체 다운로드를 실행했다. 시험 원본은 0 패턴의 희소 파일이며, HTTP 전송·SQLite 저장·다운로드 크기는 각각 실제 5GB다. 다운로드 SHA-256 `750f9080de24a9e562c6b1fecc288c732a758003ab16e5cad014eba45c17466b`가 원본과 일치했다. 완료·취소 경합 수정을 포함한 최종 실행은 사전 원본 해시 계산을 제외해 60.856초였고, 업로드 중 표본 측정한 JS 힙 최댓값은 18,407,330바이트였다. JS 힙 수치는 Chrome 전체 프로세스 메모리를 뜻하지 않는다. 재현 스크립트는 검증한 앱·업로드 스크립트의 해시도 보고한다.

위 두 전체 HTTP 검사는 SQLite 모드의 결과다. 추가로 실제 PostgreSQL+공유 디스크에서 5GB 저장·전체 저장소 읽기·청크 경계 HTTP Range·백업/SQLite 복원을 검증했다. 1,193개 manifest, BYTEA 0건, 동일 SHA-256, 최대 RSS 약 73MiB였으며 [증거와 코드 해시](research/postgres-five-gb-evidence.json)를 보관했다. 이 추가 검사는 저장소 API로 업로드·전체 읽기를 했고 PostgreSQL의 5GB 전체 HTTP 전송은 별도 측정 대상이다. 두 독립 서버의 실제 Chrome 파일 업로드·다운로드 바이트 일치는 작은 파일로 검증했다.

호환용 `POST /api/attachments` JSON/base64 업로드는 기존 5MB 한도를 유지한다. 새 UI와 대용량 클라이언트는 아래 청크 API를 사용한다.

| 경로 | 동작 |
| --- | --- |
| `POST /api/uploads` | `{name,size,page_id?}`로 시작 |
| `GET /api/uploads/:id` | offset·청크 크기·만료·완료 상태 |
| `PUT /api/uploads/:id/chunks?offset=N` | 고정 크기 바이너리 청크 |
| `POST /api/uploads/:id/complete` | 전체 해시 검증 후 첨부 확정 |
| `DELETE /api/uploads/:id` | 미완료 업로드 취소 |
| `POST /api/uploads/cleanup` | 소유자의 만료 업로드 정리 |
| `GET/HEAD /api/attachments/:id/download` | 권한 검사·구간 다운로드 |

파일당 5GB는 [Notion 공개 파일 명세](https://www.notion.com/help/images-files-and-media)를 참고한 자체 구현이다. Notion의 업로드 서버나 비공개 전송 프로토콜을 복원했다는 의미는 아니다.
