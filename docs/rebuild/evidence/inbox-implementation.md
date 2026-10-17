# 검증 알림함 구현 증거

2026-10-17. 소스 커밋 ea40c1e, ec7954b, 915d5eb, 2b8dc1e, 72923af, 585a40f. 상세 증거는 ../../research/inbox-evidence.json, 사용법은 ../../INBOX.md다.

실행: Python 단위/권한/HTTP 70개 PASS; Node 생산 경계 45개와 Python SQLite/TS 결과 52개 PASS; 실제 CloudStore/default transactions 모델의 1000명 담당자 GET/PATCH 각14 snapshot calls PASS. 실제 임시 SQLite→HTTP→Chrome에서 같은 계정의 두 브라우저, 다른 수신자 격리, 읽음/보관·만료 회차·ACL 철회·페이지 나눔과 늦은 응답 경계를 확인했다. native pause는 JS 수명 주기 모델이며 SDK 실행 증거가 아니다.

별도 실제 Supabase Auth 2계정·3세션·Postgres/HTTP 12개 검사 PASS. 1000명은 담당자 멤버 기록이며 Auth 계정1000개가 아니다. API15의 40파일 소스를 대조하고 6개 익명/Origin/초기 연결 경계 PASS. QA29테이블 행0·해당Auth/세션0·비공개 Storage객체0·Cron0, 검증기64의 이전 경로404와 원본6컬렉션 불변을 확인했다.

앱 패키지 생성과 인증된 알림함 SDK 실행을 구분한다. 실제 Windows·물리 모바일·이메일/푸시·역사적/배경 알림 전달·Notion 전체 기능 동등성은 이 검사로 입증하지 않았다. TypeScript 정적 타입 검사는 미수행이다.
