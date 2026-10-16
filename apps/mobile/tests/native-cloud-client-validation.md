# 실제 모바일 UI의 클라우드 계정·문서 검증

2026-10-17 KST. [실행 증거와 해시](native-cloud-client-verification.json).
전체 Notion 유료 기능이나 다섯 플랫폼 운영 전환의 완료 보고는 아니다.

## 실제 결과

전용 Android API 36 에뮬레이터와 iOS 27 arm64 Simulator에서 공개 번들 UI,
실제 Capacitor 브리지, 기본 HTTPS, Keychain/Keystore, 실제 Supabase Auth와
PostgreSQL을 사용했다. 인증·DB 응답을 모의로 만들지 않았다.

1. Android UI가 일회용 소유자 연결 코드로 최초 공급자 계정을 만들었다.
   페이지 생성, 공통 문단 편집, 서버 재조회, 새 WebView 문서의 재로딩,
   보안 탭 UI 로그아웃을 확인했다. 실제 검사 1개가 23.185초에 통과했다.
2. iOS UI가 같은 계정으로 로그인해 Android 문단을 읽고 수정했다.
   서버 저장과 새 네이티브 owner의 Keychain 로그인 유지, UI 로그아웃을
   확인했다. 실제 검사 1개가 13.327초에 통과했다.
3. Android가 정상 UI로 다시 로그인해 사이드바의 같은 문서를 열었다.
   iOS가 수정한 첫 문단과 실제 서버 응답이 일치했고 UI 로그아웃도 통과했다.
   실제 검사 1개가 13.231초에 통과했다.

이 흐름은 순차 로그인으로 확인한 교차 기기 데이터 공유다. 두 앱을 동시에
전경에 둔 자동 반영·동시 편집·모바일 SSE의 증거로 해석하지 않는다.
모바일 어댑터의 실시간 갱신 구현은 주기적인 스냅샷 조회다.
Android 서버 설정은 기존 설정이 있어 실제 `FountainTransport.configure()`를
호출한 fallback을 사용했다. 설정 폼의 UI 성공은 주장하지 않는다.

Android 경로 정책 검사 1개와 iOS 기본 경로·브리지·비공개 자산 검사 3개도
통과했다. 마지막 iOS 익명 직접 요청은 변경하지 않은 운영 API 9에 도달했다.
모바일 mock bridge/실제 Chrome·HTTP 회귀 2개 suite, 봉인 진입점 Node 검사
12개, iOS portable 검사 22개가 통과했다. 실제 Swift/Java SDK 빌드와
별도의 TypeScript 타입 검사는 구분하며 후자는 수행하지 않았다.

## 발견한 Keychain 실행 조건

처음 iOS UI 검사는 HTTPS에 도달하기 전 `NATIVE_STORAGE`로 중단됐다.
자산·JS·서버 설정은 정상이고 Keychain 조회의 OSStatus는 실제 `-34018`이었다.
`CODE_SIGNING_ALLOWED=NO` 빌드는 linker 서명만 있고 Simulator용 application
identifier가 없었다. 동일 제품 소스를 다음 조건으로 빌드했다.

```sh
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme FountainQA \
  -configuration Debug -sdk iphonesimulator \
  -destination id=AA8931A4-B783-47B8-AA7D-243B8DB5A448 \
  -derivedDataPath .data/ios-cloud-client-build \
  -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile \
  -skipPackageUpdates CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build-for-testing
```

Xcode가 로컬 서명과 Simulator application identifier를 생성했다.
Keychain 사전 검사는 `-25300`(아직 항목 없음)으로 통과했고 실제 로그인·편집도
통과했다. Keychain 값·속성·참조를 진단 결과로 반환하지 않았다.
수동 entitlement 파일, Apple 계정 연결, 인증서 발급, 저장소 권한 검사 완화는
하지 않았다. 이 명령은 개인 키나 배포 서명을 만드는 명령이 아니다.
[Apple entitlement 진단 문서](https://developer.apple.com/library/archive/technotes/tn2415/_index.html).

## 테스트 격리와 한계

원래 운영 API 9의 작업공간을 바꾸지 않았다. 테스트 코드만 고정된 프로젝트의
`fountain-api` 요청을 nonce로 봉인한 일회용 검증 경로로 전달했다.
Android는 원래 플랫폼 HTTPS handler를 먼저 캡처한 테스트 APK의 URL factory를
사용했다. nonce 차단만으로 factory가 제거되는 것은 아니므로 Root가 각 실행 뒤
전용 앱 프로세스를 force-stop했다.

iOS는 DEBUG·정확한 QA 환경·전용 Simulator에서만 네이티브 URLProtocol class를
세션 생성 시 주입했다. setter는 Capacitor 메서드가 아니며 renderer에 nonce나
대체 서버 URL을 제공하지 않는다. 테스트 protocol의 응답·데이터·종료 callback은
원래 client thread에서 순서대로 전달하고 취소 때 중단했다. Apple 문서상 글로벌
`registerClass()`만으로 별도 ephemeral 세션을 가로챌 수 없어 명시적인 설정을
사용했다. [Apple URLProtocol 설명](https://developer.apple.com/library/archive/samplecode/CustomHTTPProtocol/Listings/Read_Me_About_CustomHTTPProtocol_txt.html).

별도 Release 앱 빌드도 통과했으며 QA setter·클래스·환경변수·익명 probe 심볼과
문자열이 Release 실행 파일에 없음을 확인했다. Android 일반 앱 APK에도 검증
factory 클래스·nonce 헤더가 없었다. 공개 자산 19개는 두 플랫폼 복사본과 실제
앱 파일까지 95번의 바이트/해시 검사로 일치했다. 새 의존성은 추가하지 않았다.

iOS의 새 view controller/plugin 생성은 앱 프로세스 강제 종료·재시작 검증이 아니다.
이번 실제 클라우드 UI 검사에는 첨부·백업 전송·OS 저장창·5GB·물리 기기·Windows
실행·iOS 신규 공급자 계정 생성이 포함되지 않는다. 고정 운영 API 경로의 실제
인증은 별도이며, 이번 인증 검사는 명시적인 테스트 네이티브 계측을 거쳤다.

## 재현과 정리

SDK·승인된 기존 패키지·별도 QA 장치가 필요하다. 새 QA 작업공간·신뢰된 소유자
연결 코드·보호된 검증 함수와 비공개 설정을 먼저 준비해야 한다. 현재 검증 함수는
빈 404로 종료했으므로 과거 nonce나 기존 작업공간으로 테스트를 재개하지 않는다.

```sh
python3 apps/mobile/tests/prepare-cloud-client-input.py android --device emulator-5554
python3 apps/mobile/tests/prepare-cloud-client-input.py ios \
  --device AA8931A4-B783-47B8-AA7D-243B8DB5A448
```

도구는 0600 일반 파일의 제한된 QA 설정을 검증한다. Android에는 stdin으로
전달하고 iOS에는 Simulator의 비공개 파일에 직접 기록한다. 비밀번호·nonce를
인자나 출력으로 내보내지 않으며 덮어쓰지 않는다.
UI 검사는 입력을 즉시 소비하고 boolean·숫자·해시만 별도 결과 파일에 기록한다.

Android selector는 `dev.fountain.workspace.CloudClientDeviceTest#actualMainUIBootstrapPageCreateEditReloadAndLogout`,
이후 iOS의 `FountainNativeTests/FountainNativeTests/testActualCloudBundledUILoginEditReloadAndLogout`,
마지막 Android의 `dev.fountain.workspace.CloudClientDeviceTest#actualMainUIReadsIOSChangesAndLogsOut` 순서다.
Keychain 사전 검사 selector는 `FountainNativeTests/FountainNativeTests/testCloudKeychainEligibility`다.
Xcode 실행에는 `-collect-test-diagnostics never`를 사용해 실패 후 장시간 전체
Simulator 진단 수집을 피했다. 모든 실패는 원인과 실행 상태를 확인한 뒤 재실행했다.

보호된 QA 계정 1개를 API로 삭제하고 QA 29개 테이블의 행·매핑·Auth 세션·Storage
객체·Cron 작업이 0임을 확인했다. 검증 함수 49는 빈 404이며 이전 nonce의 wire와
cleanup 경로도 모두 404였다. 장치 입력·결과와 비공개 비밀번호/nonce 입력을
삭제하고 Root가 시작한 Android만 종료했다. 기존 iOS Simulator는 켜 둔 채로
유지했다. 원본 153개 엔티티·meta 6개·6개 업무/세션 지문과 8787 미리보기는 유지됐다.
