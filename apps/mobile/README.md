# Fountain Mobile

Capacitor 8.5.3의 iOS·Android 프로젝트와 공통 웹 편집기를 연결합니다.
앱의 최소 설치 버전은 iOS·iPadOS 15.5입니다. 편집 화면에서 사용하는 [dialog·structuredClone](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)과 [inert](https://developer.apple.com/documentation/safari-release-notes/safari-15_5-release-notes)의 지원 범위에 맞췄습니다. 실제 실행 검증한 OS 버전은 아래 SDK 검증 기록과 구분합니다.
**iOS·Android의 SQLite outbox는 기본 활성화(`outboxVersion:1`, `outboxEnabled:true`)입니다. 실제 Simulator·Emulator에서 활성화 override 없이 로그인·온라인 저장, 오프라인 보관, 프로세스 재시작, IndexedDB 제거 뒤 복원, 재접속·전송·로그아웃의 5단계를 통과했습니다.** 원본 소유자 연결·물리 기기·전체 다섯 플랫폼 검증·릴리스 배포는 별도입니다. [기본 활성화 실행 결과](../../docs/research/native-outbox-activation-verification.md) · [증거 목록](../../docs/research/native-outbox-activation-verification.json)

앱은 묶어 둔 화면을 열고, 설정한 공통 HTTPS 백엔드에 Fountain 계정으로 로그인합니다. Supabase 기본 프로젝트 주소도 지원하며 앱의 네이티브 전송부가 고정 API 경로를 붙입니다. 주소 칸에는 프로젝트 origin만 입력하고 함수 경로는 넣지 않습니다. Supabase 키나 서버 DB를 앱에 넣지 않습니다. 현재 PC의 `localhost:8787`은 다른 휴대폰에서 접속할 주소가 아닙니다. 운영 owner 연결과 공개 웹 호스트 활성화는 아직 남아 있습니다.

## 준비와 빌드

Node.js 22 이상, iOS에는 Xcode, Android에는 SDK와 JDK가 필요합니다. 정확한 버전·설치 조건은 [Capacitor 공식 환경 안내](https://capacitorjs.com/docs/getting-started/environment-setup)를 확인합니다. 승인한 core/cli/ios/android는 모두 8.5.3으로 고정했습니다.

저장소 루트에서:

```sh
npm ci --prefix apps/mobile --ignore-scripts --no-audit --no-fund
npm run --prefix apps/mobile sync
npm run --prefix apps/mobile ios
npm run --prefix apps/mobile android
```

`sync`는 공개 웹 자산만 `www`로 복사하고 두 프로젝트에 반영합니다. `www`, 복사한 플랫폼 자산, node_modules는 커밋하지 않습니다. 비밀·원본 DB·로그인 캐시를 묶지 않습니다.

사용자가 Xcode와 Android Studio 설치·설정을 마쳤습니다. `xcodebuild -showsdks`가 정상 동작하며 Android SDK는 `/opt/homebrew/share/android-commandlinetools`에 있습니다. 기존 API 36·Build Tools 36.0.0·JDK 21로 빌드하고 SDK 자동 다운로드를 끕니다. 최초 Gradle 확인에서 기본 Build Tools 35.0.0이 기존 라이선스로 자동 설치된 사실은 검증 기록에 남겼으며, 이후 빌드는 36.0.0을 명시합니다.

환경이 준비된 뒤 iOS 시뮬레이터 빌드 예시:

```sh
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme FountainQA \
  -configuration Debug -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=Fountain QA" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  -derivedDataPath .data/ios-build build-for-testing
```

시뮬레이터에서 로그인까지 실행할 때는 위의 로컬 서명을 사용합니다. `CODE_SIGNING_ALLOWED=NO`는 컴파일 확인에는 사용할 수 있지만 실제 Keychain 호출에서 `-34018`이 발생했습니다. 같은 소스를 로컬 서명한 빌드는 Keychain 사전 검사와 로그인·편집을 통과했습니다. 이 과정은 개인 Apple 계정이나 인증서 발급을 사용하지 않습니다.

Android 디버그 APK는 `apps/mobile/android`에서 `./gradlew :app:assembleDebug`로 만듭니다. 이 환경에서는 `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`와 `JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home`을 지정합니다. 앱 테스트 APK는 `:app:assembleDebugAndroidTest`로 범위를 제한합니다. 실제 iPhone 배포에는 Apple 계정·서명 설정이 필요하며 스토어 배포나 서명 자격증명을 만들지 않았습니다.

## 연결 경계

화면은 로컬 번들에서 실행합니다. `server.url`, 광범위한 `allowNavigation`, CORS 완화, 인증서 예외 또는 전역 fetch/XHR 패치로 원격 사이트를 감싸지 않습니다. 기본 Http/Cookies/WebView 경로 대신 제한한 자체 `FountainNative` 브리지를 사용합니다.

기존 `/api/session`과 HttpOnly 세션을 재사용합니다. 세션은 iOS 앱 전용 Keychain 또는 Android Keystore로 암호화한 앱 저장소에 보관하고, Cookie·Set-Cookie를 JS에 반환하지 않습니다. Native HTTPS는 고정 서버의 상대 API 경로만 허용합니다. 자세한 요청·권한·철회 계약은 [NATIVE_CONTRACT.md](NATIVE_CONTRACT.md)에 있습니다.

문서·접속 상태는 전경에서 권한 있는 스냅샷을 반복 조회합니다. 업로드는 기존 4MiB 조각과 offset 확인을 유지하며 진행률은 조각 응답 후 갱신합니다. 첨부·백업은 native 임시 파일로 스트리밍한 뒤 OS 저장 화면을 열도록 구현했습니다. 작은 JSON·CSV·복구 파일의 내보내기는 8MiB까지입니다. 공통 화면의 [복구 JSON 가져오기](../../docs/RECOVERY_IMPORT.md)는 별도의 16MiB 입력 한도를 적용하며, 가져오기는 자동 동기화 대신 확인 후 대기열 보관으로 진행합니다. 최신 번들은 19개 공개 자산을 포함합니다. Native 요청과 파일 전송의 시간 제한은 45초이므로 모바일 대용량·이어 다운로드는 추가 검증과 보완이 필요합니다.

서버 주소·작업공간·멤버·로그인 binding별로 저장소를 구분하고 native에서는 서비스 워커를 등록하지 않습니다. IndexedDB의 화면 캐시와 intent를 네이티브 SQLite 저장 경로에 연결하며, SQLite COMMIT 성공을 확인한 뒤에만 기기 저장 성공을 반환합니다. 확인된 현재 로그인 범위의 대기 편집은 프로세스 재시작·IndexedDB 제거 뒤 현재 권한으로 다시 읽습니다. 로그인 설명을 JS에서 저장하는 것으로 네이티브 권한을 만들 수 없습니다.

COMMIT 전 미확인 입력이나 다른 로그인 원문을 보존한 내부 IndexedDB 저널은 같은 내구성 보장이 없습니다. 이를 확인된 네이티브 보관이나 서버 저장으로 표시하지 않으며, 캐시 제거 전 동기화·복구 내보내기가 필요합니다. 앱 삭제·OS 저장소 초기화 뒤 로컬 자료도 보장하지 않습니다. 재조정·명시적 복구와 한도는 [모바일 SQLite 저장소](../../docs/NATIVE_OUTBOX.md)를 따릅니다. 외부 양식·게시 링크는 검증된 공개 HTTPS 주소가 필요하며 외부 브라우저는 별도 로그인 상태를 가집니다.

## 검증 범위

```sh
npm test --prefix apps/mobile
sh apps/mobile/tests/android-policy/run.sh
# 아래 기반 검사는 Node.js 24의 내장 node:sqlite와 Chrome을 사용합니다.
npm run --prefix apps/mobile test:outbox
npm run --prefix apps/mobile test:recovery
python3 apps/mobile/tests/ios-outbox-sql.py
python3 apps/mobile/tests/android-outbox/test_sql.py
```

첫 명령은 mock native bridge를 사용합니다. 실제 임시 Python HTTP 서버와 Chrome으로 초기 설정·로그인·문서 편집·접속 상태·4MiB+113바이트 업로드·파일/백업·내보내기·로그아웃·서버별 캐시를 확인합니다. 유효한 4MiB·16MiB 응답의 바이트도 비교합니다. 실제 Capacitor 형태의 네트워크 오류에서 오프라인 재시작·편집·재전송을 확인하고, 보안 저장소 오류에서는 캐시를 대신 열지 않는지 검사합니다.

기존 JVM 검증 기록의 195개 검사는 생산 코드의 경로·헤더·쿠키·공유 주소 경계와 저장 실패 정책을 다룹니다. `JAVA_HOME` 또는 `FOUNTAIN_JAVA_HOME`으로 JDK를 지정할 수 있습니다. 이 과거 수치를 새 기본 활성화의 통과 수로 합산하지 않으며 JVM 실행은 Android SDK 빌드가 아닙니다.

실제 SDK 빌드와 격리 시뮬레이터·에뮬레이터 검증은 Chrome 모의 검사와 구분합니다. 기본 활성화와 별도 저장 실패·재시작 검증의 범위는 아래 실행 기록을 따릅니다. 물리 기기·전원 차단·모든 저장 공간 부족 상황·5GB 전송·다섯 플랫폼 전체 동기화·릴리스 배포는 남아 있으며 코드 검토나 mock 성공으로 완료를 주장하지 않습니다.

기기의 이전 기록은 [명시적 복구 흐름](../../docs/NATIVE_RECOVERY.md)으로 확인·내보낼 수 있습니다. 복구 화면을 여는 것만으로 격리 자료나 다른 로그인의 입력을 자동 승격·재전송하지 않습니다. 현재 권한을 확인하고 가져오기 또는 원본을 보관한 채 최신 상태로 계속하기를 선택합니다.


`test:outbox`는 의도적으로 비활성인 모델의 무접근 경계와 활성 fixture의 실제 IndexedDB·SQLite 모의를 함께 검사합니다. 비활성 fixture는 현재 제품의 기본 설정을 뜻하지 않습니다. 실제 임시 Python HTTP 응답의 신원·revision과 담당자 변경을 Chrome/IndexedDB 및 Node SQLite 접근 검증 모델에 연결하며, 읽기 0바이트·원문 보존·로그인 응답 유지·응답 유실 재시도를 검사합니다. 이 명령 자체가 iOS/Android 네이티브 SQLite나 SDK를 실행하는 것은 아닙니다.


초기 SDK 기록은 iOS Simulator 실제 Swift/SQLite·WebView 접근 차단 6개 통과,
Android API 36 전용 AVD의 실제 네이티브 HTTPS·SQLite·시스템 저장창 취소/저장·
복구 중 로그아웃 검사 통과입니다. Android에서 저장한 JSON은 공통 웹 parser로
다시 읽어 원문 Unicode를 비교했습니다. 격리된 실제 Supabase 로그인·비공개 페이지 관찰은
두 플랫폼에서 로컬 TLS relay를 통해 확인한 당시 범위입니다. 이를 이후의 기본 활성화
검증으로 소급하지 않습니다. [iOS 상세 기록](tests/ios-outbox-validation.md)과
[Android 상세 기록](tests/android-outbox/README.md)에 재현 명령과 경계를 남깁니다.

2026-10-17에는 두 플랫폼의 실제 네이티브 HTTPS 클라이언트로 Supabase에 직접 익명 GET을 수행했습니다.
Android 기기 검사 1개, iOS 선택 검사 2개와 추가 core 검사 11개가 통과했습니다.
이 검사는 계정 로그인·UI 편집 검증을 대신하지 않습니다.
[직접 연결 절차·범위](tests/native-direct-validation.md)와 [실행 증거](tests/native-direct-verification.json)를 참고합니다.

## 기본 활성화 실제 SDK 검증

021 실행은 iOS 27 Simulator와 Android API 36 Emulator에서 각 5단계를 서로 다른
프로세스로 수행했습니다. 활성화 override 없이 실제 bridge의 기본 설정을 확인했고,
오프라인 재시작·IndexedDB 제거 단계의 HTTPS 전송은 모두 0회였습니다. iOS는 저장 표시와
별도 native GET 200의 서버 내용 일치·로그아웃 대기 마커 정리를, Android는 저장 표시·서버
재조회·대기 전송 후 로그아웃과 자격 증명 정리를 확인했습니다.
[실행 결과](../../docs/research/native-outbox-activation-verification.md) ·
[제품·소스·단계별 증거](../../docs/research/native-outbox-activation-verification.json)

별도 강제 종료 검사는 내구성 staging 뒤 활성 COMMIT 호출 전에 SIGKILL하고 새 프로세스에서
원본·staging·미수락 상태를 확인했습니다. 합성 인증의 네이티브 컴포넌트 검사이며 트랜잭션
중 종료·전원 차단·실제 Auth와 결합한 강제 종료·Android API 24 실행의 증거가 아닙니다.
물리 기기와 OS 저장 화면의 전체 흐름, 장시간 대용량 사용, 배포 서명은 추가 검증이 필요합니다.

과거 비활성 전용 SDK fixture는 Android의 `legacyDisabledFoundationQA=1` 또는 iOS의
`FOUNTAIN_LEGACY_DISABLED_QA=1`과 이전 비활성 바이너리를 요구합니다. 기본 실행에서 이
fixture를 건너뛴 결과를 새 활성화의 통과로 계산하지 않습니다.

## 실제 모바일 UI 클라우드 검사

[검증 절차](tests/native-cloud-client-validation.md)와 [실행 증거](tests/native-cloud-client-verification.json)에 격리 방법·소스 해시·SDK 실행·정리 결과를 기록했습니다. Android에서 최초 계정 생성과 페이지 생성·편집·재로딩·UI 로그아웃, iOS에서 같은 계정으로 Android 문서를 읽고 편집한 뒤 새 네이티브 화면의 Keychain 로그인 유지·UI 로그아웃, Android의 정상 재로그인 후 iOS 변경 읽기를 확인했습니다. 새 화면 생성은 앱 프로세스 강제 종료·재시작 검증과 구분합니다.

이는 실제 번들 UI·브리지·기본 TLS·Keychain/Keystore·Supabase Auth/PostgreSQL을 사용한 검사입니다. 테스트 네이티브 계측만 고정된 검증 경로로 요청을 전달했으며, 원래 운영 API의 인증 실행이나 전체 기능 완료를 증명하지 않습니다. 모바일 동기화는 주기적 스냅샷 조회이며 SSE 증거가 아닙니다. Android 서버 주소 설정은 기존 설정 때문에 실제 어댑터 호출로 진행한 부분을 결과에 남겼습니다.

공개 웹 주소가 없는 Supabase 기본 주소에서는 문서 링크 복사를 비활성화하고 폼·사이트 열기에서도 주소 연결 안내를 표시합니다. 서버의 `public_web_origin`이 설정되면 그 주소를 사용합니다. Android는 실제 네이티브 세션 응답에서 확인한 주소의 정확한 폼·사이트 경로만 외부 열기를 허용합니다. 전용 에뮬레이터에서 실제 WebView의 `window.open`과 ACTION_VIEW 발생·차단을 확인했으며, 테스트가 Intent를 가로채므로 실제 브라우저 화면·클라우드 인증 검증은 아닙니다. iOS의 실제 외부 브라우저 열기와 공개 웹 호스팅은 남아 있습니다. [공유 링크 상세 검증](../../docs/research/public-frontend-links.md)
