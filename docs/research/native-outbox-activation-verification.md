# 모바일 기본 저장 활성화 검증

2026-10-17, iOS·Android의 SQLite 저장을 기본 활성화했다. 실제 번들 bridge의 `outboxEnabled:true`, version 1을 확인했으며 테스트용 활성화 override는 사용하지 않았다. 실행 제품·소스·공개 자산 해시와 단계별 결과는 [증거 목록](native-outbox-activation-verification.json)에 기록했다.

| 실제 실행 | 결과 |
| --- | --- |
| iOS 27 Simulator | 서로 다른 프로세스의 5단계 통과, 저장 표시와 별도 native GET 200·서버 내용 일치, 최종 로그아웃과 대기 마커 제거 |
| Android API 36 Emulator | 서로 다른 프로세스의 5단계 통과, 저장 표시·서버 재조회·대기 편집 전송 후 로그아웃과 자격 증명 정리 |
| 양쪽 오프라인 재시작·IndexedDB 제거 | HTTPS 전송 0회로 네이티브가 확인한 대기 편집 복원. iOS는 여섯 논리 테이블 지문, Android는 검사한 native 상태 요약 유지 |
| 별도 강제 종료 | 내구성 staging 뒤 대기 active COMMIT 호출 전에 실제 SIGKILL. 새 프로세스에서 원본·staging·미수락 상태 확인. 합성 인증의 native 컴포넌트 검사 |

iOS의 기본 bridge·비공개 파일 canary 검사도 활성화 override와 기본 모드 선택 설정 없이 통과했다. Android의 오프라인 SDK 빌드·lint, iOS Simulator 빌드가 통과했고, 독립 검토에서 정확한 제품과 실행 결과를 확인했다. 기존 비활성 전용 fixture는 명시적인 과거 바이너리 검사용 선택 뒤에 남겼으며 새 활성화의 통과 수에 포함하지 않았다.

검증 중 발견한 저장 표시 갱신과 이전 로그아웃의 새 세션 침범을 수정했다. iOS의 동시 QA SQLite 조회가 저장과 충돌하는 현상은 재현 뒤 기존 native 소유 잠금 안에서 검사하도록 고쳤다. 이는 특정 파일 descriptor 닫힘이나 SQLite 자체 결함을 확정한 결과가 아니다. Android의 저장 실패·재시작·불확실한 백업 파일 경계는 실제 SDK와 별도의 AOSP 24 동작 모델로 구분해 검증했다.

검증 계정 2개는 세션·refresh token을 먼저 폐기한 뒤 보호된 메타데이터를 대조해 삭제했다. 해당 공간의 29개 테이블 잔여 자료·Storage 객체·Cron은 0이며 임시 함수 version 58의 이전 nonce 경로 세 곳은 모두 404다. 원본 153개 entity·6개 meta·매핑 0개와 여섯 업무·세션 데이터 지문은 유지했다. 당시 API version 12의 39개 파일도 다시 받아 일치함을 확인했다. 원본 SQLite와 8787 호환 미리보기도 보존했다.

이 결과는 네이티브 COMMIT으로 확인된 현재 로그인 범위의 편집에 해당한다. 미확인 키 입력이나 다른 로그인 원문을 보존한 내부 IndexedDB 저널은 같은 내구성 보장이 없다. 앱 삭제·전원 차단·트랜잭션 도중 종료·물리 기기·Android API 24 실행·릴리스 배포를 검증한 결과가 아니다. 원본 소유자 연결, 공개 웹 호스팅, Windows 실행, 다섯 플랫폼 전체 전파와 실제 AI·외부 인증 연결은 별도 작업으로 남아 있다.
