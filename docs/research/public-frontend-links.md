# 공유 웹 주소와 로그인 복귀 검증

공유 링크용 프런트엔드 주소를 API 서버 주소와 구분했습니다. `deployment.publicWebOrigin`은 기본 `null`이며, 명시적으로 설정한 정확한 HTTPS origin이 `webOrigins`에도 있어야 합니다. 잘못된 설정은 Auth·외부 공급자 호출 전에 실패합니다. 설정한 경우에만 성공한 GET/POST 세션 응답에 `public_web_origin`을 추가합니다. 기존 로그인·쿠키·워크스페이스·캐시 식별 규칙은 유지합니다.

브라우저는 기존 주소를 기본으로 사용합니다. 데스크톱의 복사용 주소는 설정된 웹 주소를 사용하고 로컬 미리보기는 번들 안에 남습니다. 모바일은 설정된 웹 주소 또는 일반 HTTPS 서버 주소를 사용합니다. 공유 웹 주소가 없는 기본 Supabase API 주소를 공개 문서·폼·사이트 주소로 표시하지 않습니다.

가족용 폼·사이트는 현재 로그인과 기존 접근 검사를 요구합니다. 웹 presentation relay는 HTML 문서를 여는 GET 요청의 401에만 자신이 만든 상대 경로로 로그인 화면을 안내합니다. 앱은 정확한 ASCII 공개 경로만 한 번 읽어 탭 메모리에 보관하며, 온라인 로그인·워크스페이스 확인 후 같은 웹 origin으로 돌아갑니다. 외부 URL·중첩 인코딩·쿼리·fragment는 복귀 대상으로 사용할 수 없습니다. HEAD·fetch·403 응답은 로그인 이동으로 바꾸지 않습니다. 익명 게시 권한은 추가하지 않았습니다.

Android는 네이티브가 실제 세션 응답에서 관찰한 프런트엔드 주소를 서버·설정 세대·인증 세대·네이티브 경계에 묶습니다. 취소·실패·로그아웃·설정 전환 후에는 이전 주소를 사용할 수 없습니다. 실제 번들 메인 프레임에서 정확한 HTTPS `/forms|sites/<ASCII slug>`를 여는 경우에만 ACTION_VIEW를 만들고 WebView는 외부로 이동하지 않습니다. 렌더러에 임의 주소 허용 API를 추가하지 않았습니다.

## 실행한 검사

- Node 경계·세션·조합·프런트엔드 주소·relay·데스크톱 URL 검사 **38개 PASS**. 설정이 없는 세션 JSON, 성공 POST, HEAD, 오류·비밀 값 제거, 잘못된 origin, relay 취소·크기 제한을 포함합니다.
- 실제 Chrome·임시 Python Auth/문서 서버·로컬 presentation relay: 보호된 사이트 → 로그인 실패 후 재시도 → 원래 페이지 복귀, 이미 로그인한 상태의 복귀, 악성 경로 차단, 실제 공유 권한 화면의 링크, 오프라인 메타데이터 검증과 캐시 식별 보존 PASS. Python의 loopback Origin과 HTML marker를 이 테스트에서만 변환하므로 Vercel/Supabase 운영 배포 증거는 아닙니다.
- 기존 실제 Chrome 전송 회귀 PASS: 로그인·독립 컨텍스트 협업·4MiB 청크·파일·백업·폼·사이트·공유 링크. 모바일 전송 단위 검사와 Chrome mock native bridge/실제 임시 HTTP 통합 검사도 PASS입니다.
- Android 순수 JVM 정책 **195개 PASS**, outbox 정책 **103개 PASS**. Android API 모양만 제공하는 Java stub 컴파일과 실제 오프라인 Android SDK 앱·테스트 APK 빌드 PASS입니다.
- 전용 `FountainRecoveryQA` API 36 에뮬레이터의 `PublicWebNavigationDeviceTest#bundledPublicLinksUseOnlyObservedNativeSessionMetadata`: **1 test PASS, 8.106초**. 실제 MainActivity·WebView·네이티브 어댑터에서 허용된 `window.open`, 다른 origin·쿼리·인코딩·fragment·API 경로 거부, 누락·오류 메타데이터와 설정 전환 후 차단을 확인했습니다.

마지막 기기 검사는 테스트 APK의 URL factory가 익명 세션 JSON만 제공합니다. ActivityMonitor가 ACTION_VIEW를 가로채므로 외부 브라우저 표시·실제 TLS·Supabase Auth 증거가 아닙니다. 서브프레임은 CSP가 실제 iframe을 차단하므로, 설치된 실제 네이티브 클라이언트에 `isForMainFrame=false` 요청 DTO를 넣어 경계를 따로 검사했습니다. 종료 후 테스트 프로세스를 강제 종료하고 이 작업에서 시작한 에뮬레이터만 정지했습니다. iOS의 기존 시뮬레이터는 유지했습니다.

## 남은 연결

이번 변경은 클라우드에 배포하지 않았습니다. 공개 웹 호스팅의 무료 요금제·정확한 호스트와 실제 소유자 이메일이 아직 정해지지 않았습니다. 운영 계정 연결, 실제 호스트의 쿠키·Range·SSE·공유 링크, iOS 외부 브라우저, Windows 실행과 다섯 플랫폼 전체 동시 전파는 별도 검증이 필요합니다. 실제 TypeScript/Deno 타입 검사는 수행하지 않았으며 Node 구문·런타임 검사와 Android SDK 컴파일을 구분합니다.

원본의 여섯 비즈니스·세션 컬렉션 지문은 다시 비교해 동일함을 확인했습니다. 기존 8787 미리보기는 재시작하지 않았습니다. 전체 목표 완료나 운영 전환을 선언하지 않습니다. 소스·APK 해시와 검사 경계는 [기계 판독 결과](public-frontend-links.json)에 기록했습니다.
