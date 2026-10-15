# Fountain

Notion의 공개 동작과 요금제 명세를 참고한 독립 워크스페이스 앱입니다. Python 표준 라이브러리와 SQLite를 사용하며 별도 런타임 패키지 설치가 필요하지 않습니다.

```sh
python3 -m fountain.server --port 8787 --data .data/fountain.db
```

브라우저에서 http://127.0.0.1:8787 을 엽니다. 기본 실행은 로컬 개발 모드입니다. 다중 사용자 운영 환경으로 배포하기 전에 인증 및 외부 서비스 설정을 확인해야 합니다.

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
```

분석 근거, 기능별 구현 상태, 외부 서비스 의존성은 `docs/`에서 관리합니다. Notion의 서버 소스나 유료 서비스 접근 권한을 포함하지 않습니다.
