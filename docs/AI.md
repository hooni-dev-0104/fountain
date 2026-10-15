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

## Google AI Pro 구독

구독 계정으로 [Gemini CLI의 Google 로그인](https://geminicli.com/docs/get-started/authentication/)을 사용하면 해당 구독의 CLI 한도가 적용된다. [현재 공식 한도](https://geminicli.com/docs/resources/quota-and-pricing/)는 AI Pro 기준 하루 최대 모델 요청 1,500회이며, CLI와 IDE 에이전트 사용량이 공유될 수 있다. 한 UI 작업에 여러 모델 요청이 발생할 수 있으므로 1,500번의 앱 작업을 보장하는 수치는 아니다.

Gemini CLI는 [headless JSON 출력](https://geminicli.com/docs/cli/headless/)을 제공하며 이미 로그인한 자격 증명을 사용할 수 있다. 따라서 이 PC에서 사용자가 직접 Google 로그인하고 앱이 제한된 CLI 어댑터를 호출하는 설계는 기술적으로 가능하다. 다만 이 PC에 `gemini` 실행 파일은 없으며 로그인·구독 인식·실제 문서 작업을 검증하지 않았다. 현재 앱에는 CLI 호출 어댑터가 없다.

구현 전 검증 항목은 로그인, JSON 응답, 사용량 표시, 타임아웃, 파일·셸·MCP 도구 차단, 문서만 전달하는 격리, 가족의 공동 사용에 적용되는 이용 조건이다. Google 로그인 토큰을 읽어서 비공개 API를 재현하는 방식은 사용하지 않는다. CLI를 공식 앱용 서버 API나 가족 전체의 무제한 이용권으로 간주하지 않는다.

[Gemini API 과금](https://ai.google.dev/gemini-api/docs/billing/)은 별도 프로젝트·무료 한도·과금 계정 체계다. AI Pro 구독이 API 무제한 이용권을 의미하지 않는다. 직접 API 연동을 원하면 무료 티어가 가능한 모델과 실제 계정의 한도를 별도로 확인해야 한다.
