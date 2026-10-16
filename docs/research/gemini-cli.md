# Gemini CLI 0.64.0 연동 근거

2026-10-16. 공식 npm 패키지와 고정 소스를 조사하고 사용자 승인 후 프로젝트 전용 위치에 설치했다. 실제 로그인·모델 성공 증거와 구성요소 검증을 구분한다.

- 패키지: `@google/gemini-cli@0.64.0`, Node `>=20`, Apache-2.0.
- [고정 소스](https://github.com/google-gemini/gemini-cli/tree/4a0749aceac5643e6f85a36d7420314d85e13b52).
- [공식 npm metadata](https://registry.npmjs.org/@google%2fgemini-cli/0.64.0).
- Tarball SHA-512 직접 재계산: `FHrZ1NPf9QszyVMaa/BP3SsPy40ogBLnbZNWkv/PMi1Uz2zoDNMLGiBzBGmx4Bl7iLRq01K9PY/5kmloXFTpsA==`.
- 실제 게시 패키지의 bin은 `bundle/gemini.js`다. 저장소 빌드 경로인 `dist/index.js`로 추정하지 않는다.
- 설치 lifecycle script를 끄고 전역 PATH·설치를 변경하지 않았다. 별도 lockfile은 공식 tarball integrity와 일치한다. npm lock audit은 알려진 취약점 0건이며 번들 내부 전체 의존성의 무결점 보증은 아니다.

## 소스와 실제 실행에서 확인한 차이

`GEMINI_CLI_HOME`은 공식 전용 프로필 경로다. 사용자 소유 파일을 system-settings override로 지정하면 권한 검사를 통과하지 못한다. 사용자 프로필의 admin MCP/extensions/skills false도 실제 merged settings에서는 true로 남으므로 그 값에 의존하지 않는다. strict mcpServers 빈 설정, extensions none, MCP 이름 allowlist, coreTools 빈 목록, 사용자 deny 정책을 조합했다. 실제 headless는 신뢰하지 않는 작업 폴더에서 거절되어, 원래 저장소와 분리한 엄격히 검사한 빈 전용 작업 폴더만 신뢰하는 실험으로 수정했다.

CLI Config의 SandboxPolicyManager는 원래 OS 홈의 `.gemini/policies/sandbox.toml`을 직접 확인한다. 전용 프로필만으로 이 경로를 바꿨다고 표시하지 않는다. 그 파일이나 표준 관리 설정·정책이 존재하면 어댑터가 실행을 거부한다. 부재를 확인한 뒤 허용한 해당 메타데이터 검사와 실제 파일 본문 읽기는 구분한다.

headless의 `@file` 입력 처리는 tool registry 밖에서 ReadManyFilesTool을 직접 만들 수 있었다. 실제 시험 파일의 원문 읽기를 구성요소 probe에서 재현했다. 따라서 일반 도구 차단만으로 자동 파일 포함을 막았다고 판단하지 않는다. JSON 직렬화와 모든 literal `@`의 Unicode escape를 적용한 입력은 원문 의미를 유지하면서 이 처리에 진입하지 않았다.

## 무인증 실제 구성요소 검사

수정하지 않은 설치 패키지와 임시 전용 프로필에서 다음을 확인했다. probe의 네트워크·원래 홈 파일 본문 읽기는 차단하고 접근 시도를 기록했다. 사전 부재를 확인한 sandbox 정책 경로의 존재 확인만 허용했다.

- `--version`/`--help`: 종료 0, 실제 `0.64.0`.
- 실제 loadSettings·Config tool registry: 일반 도구 0, MCP 정의 0, 확장 0, 훅 비활성.
- MemoryContextManager: 메모리 경로·본문 0.
- 실제 MCP 목록: 최초 untrusted probe와 이후 trusted 빈 cwd probe 모두 도구·메모리·추가 환경 유입이 없었고 명령 실행 marker가 생성되지 않았다.
- 실제 확장 목록: 설치된 확장 없음.
- `@` 입력의 파일 포함 경로와 escape 입력의 안전한 의미 왕복을 각각 검사.
- 네트워크 및 원래 홈 파일 본문 읽기 0.

이는 공개 API와 CLI 구성요소 검사다. core Config.initialize·전체 main/auth/model을 모두 실행해 성공했다는 뜻이 아니며 실제 OS sandbox 검사도 아니다. 최초 로그인 실행에서 CLI가 설정 파일을 0644로 다시 저장하는 동작을 확인해 private 0700 디렉터리와 정확한 내용·비쓰기 권한 검사를 보존하며 호환했다.

## 실제 서비스 응답과 채택 결과

Google 브라우저 인증 후 Code Assist setup 단계에서 `IneligibleTierError`와 `reasonCode: UNSUPPORTED_CLIENT`를 받았다. 서버는 개인용 기존 클라이언트 지원 종료와 `https://antigravity.google` 이전을 안내했다. 모델 호출은 성공하지 않았으며 반복 로그인·클라이언트 가장으로 우회하지 않았다. 구성요소 및 fixture 성공은 서비스 연결 성공을 의미하지 않는다.

별도 승인으로 Antigravity CLI 1.3.6을 `.data/tools/antigravity-cli-1.3.6`에 설치했다. [공식 installer](https://antigravity.google/cli/install.sh)가 지정하는 [darwin_arm64 manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json)의 55,467,795바이트 tarball을 직접 해시했다.

```text
SHA-512: 473a34b685d0a09d48790e8b86bc3e545dfab889fe0d8fc81cb7e1fdfc336fe78ce57022e3b438c754c93c9cffeb13fdbd177e50fdedc087d52732fa5475183f
```

별도 빈 HOME/cwd에서 네트워크·mach lookup·원래 계정/키체인 경로 읽기·쓰기를 차단한 macOS sandbox로 `--version`과 `--help`만 실행했다. 둘 다 종료 0이며 실제 버전은 1.3.6이다. 인증·모델·구독 권한 확인을 실행했다는 뜻이 아니다. 글로벌 설치나 shell PATH는 변경하지 않았다.

[공식 headless 문서](https://antigravity.google/docs/cli/headless/)는 프로그램 호출을 지원하고 [요금제](https://antigravity.google/pricing)는 Google AI Pro를 포함한다. 다만 [추가 약관 6항](https://antigravity.google/terms)은 타사 도구를 통한 접근을 금지하고 계정 정지 가능성을 명시한다. 또 문서상 별도 프로필과 기존 OS keyring 자동 로그인 분리를 확인하지 못했다. 따라서 Fountain 서버의 개인 구독 공급자로 채택하지 않았다. Gemini 실험 어댑터와 로그인 보조 스크립트는 배포 코드에서 제외했으며, 설치한 두 도구는 앱에서 비활성이다.

현재 제공하는 AI 연결과 실제 검증 범위는 [AI 안내](../AI.md)에 있다.
