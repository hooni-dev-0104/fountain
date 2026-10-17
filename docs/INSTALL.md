# 설치 앱 사용하기

2026-10-17 검증된 페이지 관리 개선을 반영해 현재 작업폴더에 만든 파일이다. 앱 바이너리는 Git에 넣지 않으며, 실행 코드·공개 자산·압축파일 해시는 [검증 기록](research/verified-pages-evidence.json)에 남겼다.

생성 위치: `.data/installables-verified-pages-20261017/`

| 파일 | 사용 방법과 범위 |
| --- | --- |
| `Fountain-macOS-arm64.zip` | Apple Silicon Mac용이다. 압축을 풀고 `Fountain.app`을 실행한다. 새 패키지의 편집·재시작 14개와 Supabase 익명 연결·재시작을 확인했다. 이전 보안 5개 검증의 실행 코드는 그대로이며 이번 검증은 검증 목록의 네이티브 로그인 여정을 포함하지 않는다. 공인 서명·공증·자동 업데이트 배포본은 아니다. |
| `Fountain-Windows-x64.zip` | 압축을 푼 폴더 전체를 유지하고 `Fountain.exe`를 실행한다. x64 PE·실행 소스·공개 자산·ZIP CRC를 확인했다. 실제 Windows 실행은 아직 검증하지 않았다. |
| `Fountain-Android-debug.apk` | Android 기기의 디버그 설치용 APK다. 기본 저장 활성화 021과 같은 네이티브 실행 코드에 새 화면을 넣었다. 새 APK의 서명·오프라인 빌드·lint를 확인했다. 이번 APK를 에뮬레이터에서 새로 실행하지는 않았으며 이전 실행 결과와 구분한다. 앱 스토어용 릴리스 서명은 아니다. |
| `Fountain-iOS-Simulator-Release.zip` | Xcode 시뮬레이터용 Release 앱이다. 테스트 번들을 제외했으며 실제 전용 시뮬레이터에서 인증 진입 화면까지 실행했다. 실제 iPhone에 설치하는 IPA는 아니다. |

각 파일의 SHA-256은 같은 폴더의 `SHA256SUMS`와 비교할 수 있다. 현재 DB 연결정보와 소유자 연결 코드가 네 압축파일의 항목에 포함되지 않았는지도 검사했다. 이는 모든 종류의 비밀정보를 탐지하는 보증은 아니다.

## 같은 계정으로 연결하기

앱의 서버 주소에는 `https://ehnovtfadpkwtubmwltl.supabase.co`를 입력한다. 함수 경로나 API 키는 입력하지 않는다. 기기마다 같은 서버 주소와 본인의 같은 Fountain 계정으로 로그인하면 서버 작업공간을 공유한다. 네이티브 앱의 직접 연결은 항상 켜진 Python 서버나 개발자 Mac을 요구하지 않는다.

최초 소유자는 앱에서 명시적으로 계정을 연결해야 한다. 이 작업폴더의 비공개 연결 코드와 본인이 선택한 이메일·비밀번호를 사용한다. 연결 코드는 한시적이며 다른 사람에게 보내거나 Git에 넣지 않는다. 가입 후 다른 기기의 일반 로그인에는 연결 코드가 필요 없다. 가족 구성원은 소유자가 발급한 초대로 각자의 계정을 연결하고 공유 권한을 적용한다.

공개 웹 호스팅과 원본 소유자 연결의 완료는 별도로 확인해야 한다. 지금까지의 앱 동기화 검사는 격리된 QA 계정의 증거이며 실사용 가족 계정이나 전체 다섯 플랫폼 동시 실행의 증거가 아니다.

## 직접 만들기

이미 승인·설치한 Electron 의존성이 있는 환경에서 데스크톱 명령은 순서대로 실행한다.

```sh
node apps/desktop/pack.cjs darwin arm64
node apps/desktop/pack.cjs win32 x64
```

출력은 `.data/desktop-build`이며, 같은 이름의 이전 출력은 덮어쓰므로 필요한 파일을 먼저 보존한다. [데스크톱 상세 안내](../apps/desktop/README.md)를 따른다.

iOS의 실제 scheme 이름은 `FountainQA`다. Release 시뮬레이터 앱만 만들 때는 `build`를 사용한다.

```sh
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme FountainQA \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .data/ios-release-distribution \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
```

실제 iPhone 실행에는 Xcode의 Apple 계정·개발 팀·기기 서명 설정이 필요하다. 이 과정의 성공이나 스토어 배포를 위 시뮬레이터 결과로 대신하지 않는다. Android 빌드 조건과 모바일 저장·복구 한계는 [모바일 안내](../apps/mobile/README.md)를 따른다.
