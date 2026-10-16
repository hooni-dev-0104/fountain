# Fountain

Notion의 공개 동작과 요금제 명세를 참고한 독립 워크스페이스 앱입니다. 기본 실행은 Python 3.11 이상 표준 라이브러리와 SQLite를 사용하며 별도 런타임 패키지 설치가 필요하지 않습니다.

```sh
python3 -m fountain.server --port 8787 --data .data/fountain.db
```

위 명령은 기본 SQLite 모드입니다. 이 프로젝트에서 이관한 현재 자료는 아래 명령으로 엽니다. 비공개 연결 파일에 작업공간 ID를 보관합니다.

```sh
.data/supabase-venv/bin/python -m fountain.server --database postgres \
  --database-config .data/supabase-connection.json --attachment-root .data/fountain-files
```

브라우저에서 http://127.0.0.1:8787 을 엽니다. 기본 실행은 로컬 개발 모드입니다. 다중 사용자 운영 환경으로 배포하기 전에 인증 및 외부 서비스 설정을 확인해야 합니다.

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
```

분석 근거, 기능별 구현 상태, 외부 서비스 의존성은 `docs/`에서 관리합니다. Notion의 서버 소스나 유료 서비스 접근 권한을 포함하지 않습니다.

개인·가족용으로 앱 안의 모든 기능을 무료로 사용합니다. 결제나 플랜 제한이 없습니다. 실제 구현 범위와 Notion과의 차이는 [기능 현황](docs/FEATURES.md), 역공학 근거는 [REA 조사](docs/research/notion-rea.md)에 있습니다.

목표 플랫폼은 웹·macOS·Windows·iOS·Android이며 같은 계정의 기기들은 하나의 원본 서버와 동기화합니다. **현재 실행 가능한 형태는 웹 앱이고 네이티브 설치 앱은 아직 없습니다.** Electron 데스크톱·Capacitor 모바일과 Supabase 공통 계정/DB 검토, 무료 저장소의 제약은 [플랫폼 설계](docs/PLATFORMS.md)에 기록했습니다.

설치된 Notion Desktop 7.39.0의 번들에서도 SQLite·저장소 마이그레이션·클립보드 연결을 정적으로 조사하고 REA로 분석했습니다. 범위·해시·재현 명령은 [Desktop 조사 기록](docs/research/notion-desktop.md)에 있으며, 계정 데이터와 개인 문서는 읽지 않았습니다.

가족 공용 비밀번호를 설정하려면 `FOUNTAIN_ACCESS_TOKEN`에 16자 이상 값을 지정하고 실행합니다. 세션은 HttpOnly 쿠키로 관리하며, 가족은 같은 신뢰 영역을 공유합니다. 기본 접속은 이 PC로 제한됩니다.

```sh
# 실제 비밀번호는 터미널에서 직접 입력합니다.
read -s FOUNTAIN_ACCESS_TOKEN
export FOUNTAIN_ACCESS_TOKEN
python3 -m fountain.server --host 0.0.0.0 --allowed-host 192.168.0.10
```

`--allowed-host`에는 서버 PC의 실제 LAN 주소를 사용합니다. 다른 기기는 `http://서버주소:8787`에 접속합니다. LAN 모드는 비밀번호와 허용 호스트가 모두 있어야 실행됩니다. 외부 인터넷 공유는 배포하지 않았습니다. 신뢰하는 사설망에서 사용하고 원격 공유에는 HTTPS/VPN 구성이 필요합니다. PC가 켜져 있어야 가족이 접속할 수 있습니다.

직접 HTTPS로 제공하려면 기기에서 신뢰하는 서버 이름의 인증서 체인과 일치하는 PEM 개인 키를 지정합니다. 두 옵션은 함께 사용하며, HTTPS 로그인 쿠키에는 `Secure`가 붙습니다. 서버는 TLS 1.2 이상을 사용하고 실제 접속 방식에 맞는 Origin만 허용합니다.

```sh
python3 -m fountain.server --host 0.0.0.0 --port 8787 \
  --allowed-host family.example.com \
  --tls-cert /secure/path/fullchain.pem --tls-key /secure/path/privkey.pem
```

위 예시는 DNS·인증서·가족 로그인을 먼저 구성한 뒤 `https://family.example.com:8787`로 접속하는 명령입니다. 인증서 발급·갱신과 상시 서버 배포는 별도 작업입니다. `X-Forwarded-Proto`로 HTTPS를 가장할 수 없으며, HTTP로 TLS를 종료하는 프록시 연결도 별도 지원 없이 동작한다고 가정하지 않습니다. 인증서 검증을 앱에서 끄지 않습니다. HTTPS에서는 서비스 워커를 이용한 오프라인 새로고침을 사용할 수 있습니다.

AI는 기본 비활성 상태이며 무료 로컬 모델 또는 호환 API를 명시적으로 설정할 수 있습니다. Gemini Pro 구독 연동 검토와 API 과금 구분은 [AI 안내](docs/AI.md)에 있습니다. `.env.example`은 설정 설명이며 서버가 자동으로 읽지는 않습니다.

현재 미리보기는 서울 Supabase PostgreSQL을 공통 원본으로 사용합니다. 기존 자료·계정·작업공간·로그인 상태를 보존해 이관했고 SQLite 원본과 전환 전후 백업도 남겼습니다. 새 첨부 청크는 서버 디스크에 저장하며 실제 5GB 저장소 읽기·범위 다운로드·백업 복원을 검증했습니다. 연결 옵션·무료 용량·검증 범위는 [Supabase 안내](docs/SUPABASE.md)에 있습니다. 기본 SQLite 실행과 현재 클라우드 자료를 여는 명령을 구분해 사용하세요.

전체 백업은 설정 → 가져오기 / 내보내기 → 전체 백업 다운로드에서 받을 수 있습니다. 댓글·문서 이력·첨부·설정이 포함되고 로그인 세션·임시 클립보드는 제외됩니다. JSON은 문서와 데이터베이스의 이동용 내보내기입니다.

```sh
# 실행 중인 DB도 일관된 시점으로 백업합니다. 대상 파일은 새 이름이어야 합니다.
python3 -m fountain.backup create .data/fountain.db .data/fountain-backup.db
# 복원도 기존 파일을 덮어쓰지 않습니다. 복원한 경로로 서버를 시작합니다.
python3 -m fountain.backup restore .data/fountain-backup.db .data/restored.db
python3 -m fountain.server --data .data/restored.db
```

브라우저 통합 검증은 별도의 테스트 DB로 실행한 서버를 대상으로 `node tests/browser.mjs`를 실행합니다. Chrome과 Playwright가 이미 설치된 환경을 사용하며, 필요한 경우 `FOUNTAIN_PLAYWRIGHT`와 `FOUNTAIN_CHROME`으로 경로를 지정합니다. `tests/browser-advanced.mjs`는 `FOUNTAIN_URL`과 테스트용 `FOUNTAIN_ACCESS_TOKEN`이 설정된 가족 인증 서버를 대상으로 실행합니다. 테스트는 데이터를 추가·수정하므로 실제 가족 DB 대신 임시 DB를 사용하세요.

가족 구성원마다 계정과 다른 권한이 필요하면 설정 → 가족 계정에서 소유자와 가족의 비밀번호를 만든 뒤 **개별 계정 로그인 활성화**를 선택합니다. 기존 공용 세션은 종료되며 각자 이메일로 다시 로그인합니다. 활성화 후에는 서버 재시작 시 공용 암호 환경 변수가 없어도 계정 로그인이 필요합니다. LAN 실행은 여전히 `--allowed-host`를 지정해야 합니다.

페이지의 공유 버튼에서 기본 공유 범위와 멤버별 보기·댓글·편집·공유 관리 권한을 설정합니다. DB 공유에서는 담당자 속성에 해당 멤버 ID나 이메일이 있는 행만 허용할 수 있습니다. 작업공간 소유자는 비공개 자료도 관리할 수 있습니다. 비밀번호를 잊었을 때는 서버 PC에서 아래 명령을 실행하고 숨겨진 입력으로 새 암호를 설정합니다.

```sh
python3 -m fountain.auth reset local --data .data/fountain.db
```

`node tests/browser-accounts.mjs`는 임시 DB와 별도 서버를 자동으로 만들어 계정 활성화·개별 로그인·공유 권한·담당 행·세션 종료를 검증합니다. 실제 가족 계정을 변경하지 않습니다.

JSON·Markdown·CSV 가져오기는 새 문서와 DB를 가져온 사람의 비공개 자료로 만듭니다. 다른 사람에게 보이려면 공유 범위를 지정하세요. 계정·권한까지 그대로 복원하려면 전체 SQLite 백업을 사용합니다.

DB 화면의 **일정** 설정에서 하위 항목·선행 작업과 자동 날짜 조정을 켤 수 있습니다. 목록과 타임라인에서 하위 항목을 접고 펼치며, 항목 상세에서 시작·종료일과 선행 작업을 편집합니다. 부모를 복제하거나 삭제하면 하위 항목도 함께 처리합니다. 타임라인은 날짜 속성 선택·일/주 보기·오늘 이동과 모바일 가로 스크롤을 지원합니다.

설정 → 자동화에서 **일정에 따라 반복**을 선택하면 서버가 켜져 있는 동안 실제로 작업을 실행합니다. 시간대·반복 간격·시작·선택 종료 시각을 지정하고 예약 실행 기록에서 결과를 확인하세요. 꺼져 있던 동안 놓친 실행은 한 번으로 합치며, 작성자의 현재 권한을 다시 검사합니다. 자동화로 만든 변경은 다른 자동화를 연쇄 실행하지 않습니다.

```sh
node tests/browser-projects.mjs
```

이 검증도 임시 서버와 DB를 사용합니다. 타임라인 표시뿐 아니라 하위 항목 복제·삭제·일정 연쇄 이동과 예약 시각의 실제 행 생성까지 확인합니다.

문서는 문자·서식 단위로 공동 편집합니다. 편집기 도구로 서식을 지정하고 Tab·Shift+Tab으로 블록을 중첩합니다. 열린 문서는 기기에 저장하며 페이지 메뉴에서 오프라인 보관을 확인할 수 있습니다. localhost에서는 서버가 끊겨도 보관한 문서를 다시 열어 편집하고 재접속 시 병합합니다. 버전 복원과 미전송 편집이 겹치면 복구 초안에서 내용을 내려받거나 새 블록으로 추가하세요.

같은 페이지에 접속한 가족의 이름·커서·선택 영역을 표시합니다. 보기 권한 사용자도 참여하며, 접속 상태는 5초마다 갱신하고 마지막 갱신 뒤 15초가 지나면 만료됩니다. 접속 정보는 오프라인 캐시와 백업에 남기지 않습니다.

즐겨찾기와 최근 문서는 부팅 뒤 최대 20개를 자동 보관합니다. 필요한 다른 문서는 연결되어 있을 때 직접 열어 보관하세요.

열어 본 DB도 기기에 보관합니다. 연결이 끊겨도 행 추가·수정·하위 항목 삭제, 새 페이지·자식 페이지 생성과 제목·아이콘·표지·즐겨찾기·본문 편집을 계속할 수 있습니다. 다시 연결하면 같은 계정의 서버 자료와 비교해 적용합니다. 수식·롤업과 일정 연쇄 조정의 최종 계산은 서버에 연결한 뒤 반영됩니다.

상단 또는 사이드바의 **동기화 대기 / 확인 필요**에서 미전송 변경을 확인합니다. 같은 필드나 속성 정의가 바뀌면 자동으로 덮어쓰지 않고 복구 기록을 남깁니다. 내용을 내려받거나 최신 서버 값을 확인한 뒤 다시 적용할 수 있으며, 폐기는 의존하는 변경도 함께 확인합니다. 새 페이지를 폐기하면 기기에만 있던 본문도 삭제됩니다.

로그아웃은 기기의 해당 사용자 자료를 지웁니다. 미전송 내용이 있다면 먼저 동기화하거나 복구 파일로 보관하세요. DB 구조·권한·설정 변경과 파일 업로드는 서버 연결이 필요합니다. 일반 LAN HTTP의 서버 없는 새로고침은 지원하지 않습니다. 자세한 범위는 [공동 편집·오프라인 안내](docs/COLLABORATION.md)에 있습니다.

```sh
node tests/crdt.mjs
node tests/browser-collaboration.mjs
node tests/browser-offline.mjs
node tests/browser-offline-data.mjs
node tests/browser-mutations.mjs
```

브라우저 검증은 임시 서버와 DB를 만들며 실제 계정·문서를 바꾸지 않습니다. 순수 병합 벡터, 동시 편집·서식·중첩, 서비스 워커 재로딩·여러 오프라인 탭·원격 변경의 재접속을 검증합니다.

첨부는 파일당 5GB까지 4MiB 조각으로 전송합니다. 진행률에서 일시 정지·이어 올리기·취소를 선택하고, 새로고침 뒤에는 같은 원본 파일을 다시 선택해 재개합니다. 원본 파일을 브라우저 저장소에 보관하지 않으며 전체 SQLite 백업에는 완료된 파일 바이트가 포함됩니다. [대용량 첨부와 실제 5GB 검증](docs/FILES.md)
