# 무료 AI와 Gemini Pro 연동 검토

2026-10-16 기준 공식 문서를 확인했다. 앱 자체에는 AI 이용료·구독·추가 결제가 없다. 외부 서비스의 제한과 비용은 별개다. 공급자를 설정하지 않으면 AI 작업은 명확한 미설정 오류를 반환한다.

## 현재 구현: 로컬 모델 또는 호환 API

`fountain/advanced.py`의 AI 경로는 Chat Completions 호환 HTTP 공급자를 호출한다. 요약·작성·번역·질의·입력 대화록 정리와 속성 제안을 지원한다. 프롬프트와 선택한 문서만 전송하며 브라우저에 키를 전달하지 않는다. 모델 응답을 문서에 자동 반영하지 않고 먼저 확인한다.

별도 API 요금 없이 실행하려면 PC에 설치한 로컬 모델을 연결할 수 있다. Ollama의 [공식 호환 API](https://docs.ollama.com/api/openai-compatibility)는 로컬 서버의 키가 필요 없다고 명시한다. 이 저장소는 Ollama나 모델을 자동 설치·다운로드하지 않는다. 설치한 모델의 라이선스와 PC의 메모리·처리 성능을 확인해야 한다.

```sh
export FOUNTAIN_AI_URL=http://127.0.0.1:11434/v1/chat/completions
export FOUNTAIN_AI_MODEL='실제로-설치한-모델-이름'
python3 -m fountain.server
```

원격 공급자는 HTTPS와 `FOUNTAIN_AI_KEY`가 필요하다. API 형식은 [OpenAI 공식 API 명세](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)를 참고했다. 유료 API로 자동 전환하거나 실패 시 다른 공급자를 호출하지 않는다.

## Google AI Pro 구독 검증 결과

**현재 Pro 구독을 Fountain의 AI 공급자로 연결하지 않는다. 실제 모델 호출은 성공하지 않았다.**

사용자 승인으로 공식 Gemini CLI 0.64.0을 프로젝트 전용 경로에 설치하고 tarball SHA-512를 검증했다. 전용 프로필에서 Google 인증을 진행했지만 서비스 설정 단계에서 `UNSUPPORTED_CLIENT`를 반환했다. 서버 응답은 개인용 기존 클라이언트를 더 이상 지원하지 않으며 Antigravity로 이전하라고 안내했다. 이 응답으로 Pro 구독 인식이나 사용 한도까지 확인한 것은 아니다.

별도 승인받은 Antigravity CLI 1.3.6도 공식 배포 SHA-512와 실제 버전·도움말을 확인했다. [공식 요금제](https://antigravity.google/pricing)에는 Google AI Pro 지원이 있고 [headless 문서](https://antigravity.google/docs/cli/headless/)에는 프로그램 호출 방법이 있다. 그러나 [공식 추가 약관 6항](https://antigravity.google/terms)은 타사 소프트웨어·도구·서비스를 통한 접근과 계정 정지 가능성을 명시한다. 이 조사를 근거로 Pro 계정을 Fountain의 서버 공급자로 연결하는 방식은 채택하지 않았다. Antigravity 로그인·모델 호출은 진행하지 않았고, 설치한 도구는 앱에서 실행하지 않는다.

구독 OAuth 토큰을 추출하거나 다른 클라이언트로 가장하지 않는다. 기존 사용자 설정·로그인 캐시를 가져오거나 유료 API로 자동 전환하지 않았다. Gemini 실험 어댑터는 배포 코드에서 제외했다. `FOUNTAIN_AI_PROVIDER`는 생략하거나 `compatible-http`로 설정하며, `gemini-cli`·`antigravity-cli` 등 지원하지 않는 값은 로컬/원격 HTTP 연결로 넘어가지 않고 503을 반환한다.

Google AI Pro 구독과 [Gemini Developer API 과금](https://ai.google.dev/gemini-api/docs/billing/)은 별도다. 현재 무료 사용 경로는 이미 설치한 로컬 모델을 호환 HTTP API로 연결하는 방식이다. API 키 생성·결제 연결·런타임 또는 모델 다운로드는 자동 수행하지 않았다. [패키지와 실제 서비스 조사 기록](research/gemini-cli.md).

## 권한과 지연 응답

요청 시작 시 현재 로그인과 문서 권한을 검사하고 허용한 본문만 캡처한다. 모델을 기다리는 동안 DB 쓰기 잠금을 점유하지 않는다. 결과를 공개하거나 감사 기록을 남기기 전에 원래 로그인·멤버·작업공간·문서 권한을 다시 검사한다. 다른 서버에서 로그아웃하거나 권한을 철회해도 늦은 응답이 공개되지 않는다.

브라우저도 요청한 모달·문서·로그인·편집 epoch를 유지한 경우에만 응답을 표시한다. 저장을 기다리던 중 화면이나 계정이 바뀌면 요청을 보내지 않는다. AI 결과를 문서에 자동 반영하지 않는다.

`python3 -m unittest tests.test_ai tests.test_ai_authorization`은 로컬 HTTP fixture와 독립 서버로 권한 경쟁을 검증한다. `node tests/browser-ai.mjs`는 실제 Chrome에서 모달·문서·계정 전환과 응답 escaping을 검사한다. 이 검증은 실제 모델 품질·Google 구독 연결 성공의 증거가 아니다.
