# Fountain Mobile

Capacitor 8.5.3의 iOS·Android 프로젝트와 공통 웹 편집기를 연결합니다.
**iOS 시뮬레이터 앱과 Android 디버그 APK를 실제 SDK로 빌드했습니다. 운영 API의 익명 직접 연결과 별도 QA 공간의 실제 UI 로그인·문서 편집·Android→iOS→Android 변경 확인을 통과했습니다. 운영 계정 전환·물리 기기·전체 기능·배포 서명 검증은 남아 있습니다.**

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

서버 주소·작업공간·멤버·로그인 binding별로 캐시를 구분하고 native에서는 서비스 워커를 등록하지 않습니다. 번들과 IndexedDB로 여는 오프라인 흐름을 모의 검증했지만, SQLite 영구 outbox는 [비활성 개발 기반](../../docs/NATIVE_OUTBOX.md)으로 추가했습니다. 기본 `outboxEnabled:false` 경로에서는 새 저장소를 열거나 기존 캐시를 이관하지 않으며, 화면도 앱 캐시 보관으로 표시합니다. OS의 WebView 저장소 퇴거 뒤 미전송 편집 복구는 아직 보장하지 않습니다. 외부 양식·게시 링크는 공통 HTTPS 주소를 사용하며 외부 브라우저는 별도 로그인 상태를 가집니다.

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

JVM 검사는 실제 생산 코드의 경로·헤더·쿠키 경계와 저장 실패 정책 148개를 검사합니다. `JAVA_HOME` 또는 `FOUNTAIN_JAVA_HOME`으로 JDK를 지정할 수 있습니다. 이것은 Android SDK 빌드가 아닙니다.

실제 SDK 빌드와 격리 시뮬레이터·에뮬레이터 검증은 Chrome 모의 검사와 구분해 기록합니다. 물리 기기, Keychain/Keystore의 강제 종료·저장 실패, 앱 중단과 재개, 5GB 전송, 영구 outbox 활성화와 다섯 플랫폼 전체 동기화는 남아 있습니다. 코드 검토나 Chrome의 mock 성공을 이 항목의 완료 증거로 사용하지 않습니다.

기기의 이전 네이티브 저장 기록은 [명시적 복구 흐름](../../docs/NATIVE_RECOVERY.md)으로 확인·내보낼 수 있습니다. 이 기능은 일반 outbox를 활성화하거나 기존 캐시를 자동 이관하지 않습니다.


`test:outbox`는 기본 비활성 부팅의 무접근 경계와 명시적 활성 fixture의 실제 IndexedDB·SQLite 모의를 검사합니다. 실제 임시 Python HTTP 응답의 신원·revision과 담당자 변경도 Chrome/IndexedDB 및 Node SQLite 접근 검증 모델에 연결합니다. 자료 확인이 필요할 때 읽기 0바이트·원문 보존·로그인 응답 유지·응답 유실 재시도를 검사합니다. iOS/Android의 네이티브 SQLite나 SDK를 실행하는 시험은 아닙니다.


현재 SDK 증거는 iOS Simulator 실제 Swift/SQLite·WebView 접근 차단 6개 통과,
Android API 36 전용 AVD의 실제 네이티브 HTTPS·SQLite·시스템 저장창 취소/저장·
복구 중 로그아웃 검사 통과입니다. Android에서 저장한 JSON은 공통 웹 parser로
다시 읽어 원문 Unicode를 비교했습니다. 격리된 실제 Supabase 로그인·비공개 페이지 관찰은
두 플랫폼에서 로컬 TLS relay를 통해 확인했습니다. iOS OS 저장창 완료와 전체 편집 전파는
별도 검증이 필요합니다. [iOS 상세 기록](tests/ios-outbox-validation.md)과
[Android 상세 기록](tests/android-outbox/README.md)에 재현 명령과 경계를 남깁니다.

2026-10-17에는 두 플랫폼의 실제 네이티브 HTTPS 클라이언트로 Supabase에 직접 익명 GET을 수행했습니다.
Android 기기 검사 1개, iOS 선택 검사 2개와 추가 core 검사 11개가 통과했습니다.
이 검사는 계정 로그인·UI 편집 검증을 대신하지 않습니다.
[직접 연결 절차·범위](tests/native-direct-validation.md)와 [실행 증거](tests/native-direct-verification.json)를 참고합니다.

## 실제 모바일 UI 클라우드 검사

[검증 절차](tests/native-cloud-client-validation.md)와 [실행 증거](tests/native-cloud-client-verification.json)에 격리 방법·소스 해시·SDK 실행·정리 결과를 기록했습니다. Android에서 최초 계정 생성과 페이지 생성·편집·재로딩·UI 로그아웃, iOS에서 같은 계정으로 Android 문서를 읽고 편집한 뒤 새 네이티브 화면의 Keychain 로그인 유지·UI 로그아웃, Android의 정상 재로그인 후 iOS 변경 읽기를 확인했습니다. 새 화면 생성은 앱 프로세스 강제 종료·재시작 검증과 구분합니다.

이는 실제 번들 UI·브리지·기본 TLS·Keychain/Keystore·Supabase Auth/PostgreSQL을 사용한 검사입니다. 테스트 네이티브 계측만 고정된 검증 경로로 요청을 전달했으며, 원래 운영 API의 인증 실행이나 전체 기능 완료를 증명하지 않습니다. 모바일 동기화는 주기적 스냅샷 조회이며 SSE 증거가 아닙니다. Android 서버 주소 설정은 기존 설정 때문에 실제 어댑터 호출로 진행한 부분을 결과에 남겼습니다.

공개 웹 주소가 없는 Supabase 기본 주소에서는 열리지 않는 문서 링크 복사를 비활성화합니다. 멤버 권한 설정은 유지합니다. 공개 웹 호스팅·폼/사이트 외부 링크 연결은 별도 작업입니다.
