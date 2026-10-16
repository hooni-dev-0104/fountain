# Fountain

Notion의 공개 동작과 요금제 명세를 참고한 독립 워크스페이스 앱입니다. Python 표준 라이브러리와 SQLite를 사용하며 별도 런타임 패키지 설치가 필요하지 않습니다.

```sh
python3 -m fountain.server --port 8787 --data .data/fountain.db
```

브라우저에서 http://127.0.0.1:8787 을 엽니다. 기본 실행은 로컬 개발 모드입니다. 다중 사용자 운영 환경으로 배포하기 전에 인증 및 외부 서비스 설정을 확인해야 합니다.

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
```

분석 근거, 기능별 구현 상태, 외부 서비스 의존성은 `docs/`에서 관리합니다. Notion의 서버 소스나 유료 서비스 접근 권한을 포함하지 않습니다.

개인·가족용으로 앱 안의 모든 기능을 무료로 사용합니다. 결제나 플랜 제한이 없습니다. 실제 구현 범위와 Notion과의 차이는 [기능 현황](docs/FEATURES.md), 역공학 근거는 [REA 조사](docs/research/notion-rea.md)에 있습니다.

가족 공용 비밀번호를 설정하려면 `FOUNTAIN_ACCESS_TOKEN`에 16자 이상 값을 지정하고 실행합니다. 세션은 HttpOnly 쿠키로 관리하며, 가족은 같은 신뢰 영역을 공유합니다. 기본 접속은 이 PC로 제한됩니다.

```sh
# 실제 비밀번호는 터미널에서 직접 입력합니다.
read -s FOUNTAIN_ACCESS_TOKEN
export FOUNTAIN_ACCESS_TOKEN
python3 -m fountain.server --host 0.0.0.0 --allowed-host 192.168.0.10
```

`--allowed-host`에는 서버 PC의 실제 LAN 주소를 사용합니다. 다른 기기는 `http://서버주소:8787`에 접속합니다. LAN 모드는 비밀번호와 허용 호스트가 모두 있어야 실행됩니다. 외부 인터넷 공유는 배포하지 않았습니다. 신뢰하는 사설망에서 사용하고 원격 공유에는 HTTPS/VPN 구성이 필요합니다. PC가 켜져 있어야 가족이 접속할 수 있습니다.

AI는 기본 비활성 상태이며 무료 로컬 모델 또는 호환 API를 명시적으로 설정할 수 있습니다. Gemini Pro 구독 연동 검토와 API 과금 구분은 [AI 안내](docs/AI.md)에 있습니다. `.env.example`은 설정 설명이며 서버가 자동으로 읽지는 않습니다.

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
