# 네이티브 편집 응답 관찰 — 2026-10-17

모바일 SQLite 영구 저장소 활성화의 선행 오류를 수정했다. 기존 native observer는 정규 GET만 증거로 받아, 실제 CRDT 편집 POST가 새 seq/revision과 ACK를 반환해도 이전 증거를 유지했다. 이 상태에서는 새 canonical snapshot과 확인된 작업 삭제를 native에 저장할 때 거절될 수 있었다.

이제 정확한 `POST /api/pages/{id}/operations`의 **200 응답**도 기존 private native HTTP observer에서 검사한다. JavaScript 응답 전달 전에 관찰하도록 기존 plugin 경로에 연결했다. renderer가 제출한 profile이나 ACK로 로그인·문서 권한을 만들지 않는다.

- ACK는 실제 서버 계약과 같은 최대 1000개 canonical client:clock ID이며, 서버가 허용하는 중복 ID도 받는다. ACK 자체를 권한이나 삭제 근거로 사용하지 않는다.
- 현재 private cookie·작업공간·멤버·binding·canonical page·access/data floor를 검사한다. 같은 epoch의 낮은 seq는 새 global revision이어도 거절하며, 새로운 epoch의 seq 초기화는 허용한다.
- 실패한 POST는 읽기 거절이 아니다. 403/404를 포함한 비200 POST가 기존 읽기 증거·입력·tombstone·전달 기한을 바꾸지 않는다.
- 잘못된 200 ACK/응답은 기존 입력을 지우지 않고 다시 정규 GET으로 확인할 수 있는 invalid evidence로 전환한다. 영구 읽기 거절로 처리하거나 부분적인 새 증거를 남기지 않는다.
- POST 경로는 선행 슬래시·정규 인코딩·정확한 suffix를 검사한다. 기존 GET의 동작 범위는 유지한다.

## 실행 증거

구조화된 결과와 소스 SHA는 [JSON 기록](native-operations-observer-verification.json)에 있다.

1. 프로덕션 Swift 소스를 실제 OS SQLite와 함께 실행한 **75개 검사 PASS**. 사용자 HOME·Keychain을 바꾸지 않고 DEBUG 전용 임시 DB 주입을 사용했다. release 초기화 경로는 기존 경로다.
2. 실제 Android API36 전용 `FountainRecoveryQA`에서 **SQLite 계측 테스트 4 PASS, 실패 0**. 현재 proof 갱신·역행 거절·입력 보존·invalid 후 GET 복구·쿠키/범위 거절을 확인했다.
3. 실제 iOS27 `Fountain QA` Simulator에서 **XCTest 4 PASS, 실패/skip 0**. xcresult 결과 건수와 개별 실행 로그를 대조했다. 기존 booted simulator만 사용했고 종료/초기화하지 않았다.
4. 순수 JDK outbox 검사 **149 PASS**, 기존 Android 경계 검사 **195 PASS**, portable iOS SQLite 검사 **22 PASS**. 이 수치는 SDK 실행과 별개다.
5. Android 앱·계측 APK 빌드와 iOS build-for-testing 성공, Android lint 통과, 독립적인 이번 변경 범위 검토 APPROVE, diff 검사 통과. lint의 현재 경고 수는 JSON 기록에 남겼다. offline lint는 기존 Capacitor 테스트 아티팩트 캐시가 없어 처음 중단됐으며, 기존에 선언된 테스트 아티팩트를 받은 뒤 정상 실행했다. 프로젝트 의존성 목록·버전은 바꾸지 않았다.

두 SDK의 테스트는 **합성된 native session과 canonical 응답을 내부 observer에 전달하는 컴포넌트 검사**다. 실제 HTTPS·GoTrue 로그인·활성화된 JavaScript bridge의 편집/ACK/COMMIT 흐름을 검증했다는 뜻은 아니다. Android 테스트를 마친 뒤 Root가 시작한 전용 에뮬레이터만 종료했다. 전역 Keychain·사용자 앱 데이터·원본 작업공간은 초기화하지 않았다.

검증 도구 수정도 분리한다. Android 최초 실행의 1개 실패는 fixture의 SQLite key JSON 인코딩 오류였으며, `JSONObject.quote`로 실제 키 계약을 맞춘 뒤 4개가 통과했다. 기존 QA 서명을 재사용해 앱 데이터를 지우지 않고 테스트 APK를 설치했다. 전체 모듈의 불필요한 AndroidTest 빌드 대신 앱 대상만 빌드했으며 새 의존성은 추가하지 않았다.

## 남은 활성화 작업

`OUTBOX_ENABLED`는 두 플랫폼 모두 **false**다. 이번 수정으로 전체 영구 저장이 활성화됐다고 표시하지 않는다. 다음에는 native가 실제 요청 접수 이후의 정규 응답만 수집하는 제한된 collector, 최신 baseline과 미전송 입력의 원자적 재조정, 충돌 의존 묶음의 보존, 명시적 격리 자료 승격·로컬 생성 DAG, 부팅/로그인/ACK 장벽을 연결해야 한다. 실제 편집→native COMMIT→프로세스 재시작→IDB만 제거→복원까지 양쪽 SDK로 검증한 뒤 기본 활성화를 판단한다. [전체 저장소 상태](../NATIVE_OUTBOX.md).
