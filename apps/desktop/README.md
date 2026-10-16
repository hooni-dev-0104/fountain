# Fountain Desktop

macOS arm64와 Windows x64용 클라이언트입니다. Supabase 프로젝트 주소를 선택하면 앱에 포함된 공개 화면을 열고 Supabase Edge Function에 직접 연결합니다. 기존 Fountain HTTP(S) 서버 주소를 선택하면 그 서버의 웹 화면을 사용합니다. 앱 안에 Python 서버나 SQLite 서버 데이터베이스를 만들지 않습니다.

Supabase 모드의 화면과 네트워크는 서로 다른 Chromium 세션을 사용합니다. 로그인 쿠키는 창이 없는 네트워크 세션에 보관하고, 화면에는 전달하지 않습니다. 문서 캐시·서비스 워커·IndexedDB는 별도 화면 세션에 보관하며 두 세션 모두 서버 주소별로 분리합니다.

Node.js 24에서 확인했습니다. 프로젝트 루트에서 실행합니다.

```sh
npm ci --prefix apps/desktop --ignore-scripts --no-audit --no-fund
node apps/desktop/node_modules/electron/install.js
npm start --prefix apps/desktop
```

첫 화면에 HTTPS 서버의 기본 주소를 입력합니다. Supabase에는 `https://<20자리 프로젝트 참조>.supabase.co`만 입력합니다. `/functions/v1/fountain-api`는 앱이 요청할 때 붙입니다. 공개 화면 파일은 빌드 과정에서 허용된 14개만 복사하고 실행 시 manifest의 크기·해시와 실제 일반 파일 여부를 검증합니다.

 경로·계정 정보·query·fragment는 허용하지 않습니다. 로컬 개발에는 정확한 `http://localhost`, `http://127.0.0.1`, `http://[::1]` 주소와 선택 포트를 허용합니다. 자체 서명 인증서를 자동 승인하지 않으며, 인증서 신뢰는 OS/Chromium의 정상 검증을 사용합니다.

서버를 바꾸려면 **파일 → 서버 변경…**을 선택합니다. 설정은 Electron `userData/server.json`에 저장하며 POSIX에서는 0600을 적용합니다. Windows는 현재 사용자의 AppData ACL을 따릅니다. 인증 쿠키와 문서 캐시는 서버별 persistent partition에 보관합니다. Supabase 모드에서는 공개 웹 주소가 아직 설정되지 않아 문서의 링크 복사가 비활성화되지만 멤버별 공유 권한 설정은 사용할 수 있습니다. 저장되지 않은 변경으로 웹 화면이 이동을 막으면 나가기 확인창을 표시합니다.

## 패키징

```sh
npm run --prefix apps/desktop package:mac
npm run --prefix apps/desktop package:windows
```

출력:

- `.data/desktop-build/Fountain-darwin-arm64/Fountain.app`
- `.data/desktop-build/Fountain-win32-x64/Fountain.exe` 및 같은 폴더의 런타임 파일

공개 화면 파일은 `resources/bundle`에 별도 포함하고 실행 코드는 `app.asar`에 보관합니다. 앱과 해당 리소스를 함께 배포해야 합니다. 패키징 명령은 같은 번들 출력 디렉터리를 사용하므로 순서대로 실행합니다.

이 결과는 standalone 앱/폴더입니다. 서명된 설치 프로그램, DMG/MSI, 자동 업데이트 또는 공개 배포본은 포함하지 않습니다. Windows 배포에는 **폴더 전체**가 필요하며 exe 하나만 옮기면 실행할 수 없습니다. Windows x64 폴더는 macOS에서도 만들 수 있지만 실제 Windows 실행 검증은 Windows에서 별도로 해야 합니다. 서명 키·OS 설치·배포는 수행하지 않습니다.

## 보안 경계

원격 창에는 Node·preload·webview 권한이 없고 sandbox/contextIsolation/webSecurity를 적용합니다. 서버 변경 IPC는 패키지 내부 설정 파일의 정확한 main frame에서만 허용합니다. 권한 요청과 카메라·마이크·화면·USB/HID/serial/Bluetooth 접근은 거절합니다. 외부 origin 리소스·탐색·프로토콜과 임의 팝업은 차단합니다.

기존 폼/사이트 열기는 같은 origin의 정확한 `/forms/<id>` 또는 `/sites/<slug>` GET에 한해 별도 sandbox 창을 허용합니다. POST, API, 외부 팝업은 거절하며 해당 창도 같은 세션과 탐색·권한 제한을 사용합니다. 다른 외부 문서 링크는 현재 앱에서 열지 않습니다. 같은 서버의 첨부/내보내기 다운로드는 사용자 저장 대화상자를 사용합니다.

[Electron 보안 권고](https://www.electronjs.org/docs/latest/tutorial/security), [webContents API](https://www.electronjs.org/docs/latest/api/web-contents), [Session API](https://www.electronjs.org/docs/latest/api/session)를 기준으로 구현했습니다.

## 검증

```sh
npm test --prefix apps/desktop
node tests/desktop/electron-smoke.mjs
node tests/desktop/electron-security.mjs
```

실제 실행 테스트는 기존 Playwright 설치를 사용합니다. `FOUNTAIN_PLAYWRIGHT`로 그 패키지 경로를 지정할 수 있습니다. 없으면 Codex 번들 런타임 경로를 사용하며 새 Playwright 의존성을 설치하지 않습니다. `FOUNTAIN_PYTHON`, `FOUNTAIN_CHROME`, `FOUNTAIN_ELECTRON`으로 테스트 실행 파일을 지정할 수 있습니다.

패키지 실행 확인:

```sh
FOUNTAIN_ELECTRON="$PWD/.data/desktop-build/Fountain-darwin-arm64/Fountain.app/Contents/MacOS/Fountain" FOUNTAIN_DESKTOP_PACKAGED=1 node tests/desktop/electron-smoke.mjs
```

모든 서버와 SQLite/로그인 fixture는 임시 디렉터리에 생성하고 종료 후 삭제합니다. 운영 데이터베이스나 로그인 세션은 사용하지 않습니다. 결과·화면은 `.data/desktop-proof`에 저장합니다. `FOUNTAIN_DESKTOP_USER_DATA`는 자동화·별도 프로필용 절대 경로를 지정할 때만 사용합니다.

## Supabase 직접 연결 검증

```sh
FOUNTAIN_DESKTOP_CLOUD_LIVE=1 node tests/desktop/electron-cloud-smoke.mjs
```

이 명령은 지정된 Fountain Supabase 프로젝트에 익명으로 연결합니다. 실제 로그인이나 데이터를 생성하지 않고, 앱의 공개 화면·샌드박스·서비스 워커·비공개 쿠키 경계·재시작을 검사합니다. macOS 설치 앱은 위의 `FOUNTAIN_ELECTRON`, `FOUNTAIN_DESKTOP_PACKAGED=1`을 함께 지정합니다. 소스 실행과 실제 macOS 패키지에서 각각 두 번의 시작을 확인했습니다. Windows 패키지는 파일·아키텍처·해시만 검사했으며 Windows 실행 증거는 없습니다.

인증 검증용 `electron-cloud-auth.mjs`는 별도로 준비한 일회용 QA 공간과 비공개 설정이 필요합니다. 운영 API를 테스트 공간으로 바꾸는 기능은 제품에 없습니다. 검증 도구만 자체 Electron 메인 프로세스에서 고정된 일회용 검증 경로를 사용하며, 운영 데이터나 실제 사용자 계정을 사용하지 않습니다. 실행 후 QA 계정·파일·행과 검증 함수를 정리해야 합니다.

파일 업로드는 기존 4 MiB 조각 단위로 전송하며 Electron 내부에서 각 요청 본문을 버퍼링합니다. 다운로드는 스트림으로 전달합니다. 5 GB 전체 전송과 Windows 실제 실행, 공개 호스팅 및 최초 운영 계정 연결은 별도 검증이 필요합니다.
