# 관리자 거버넌스의 원본 근거와 남은 범위

2026-10-17에 공식 도움말 **본문** 14개를 조회했다. 기계 판독 근거와 절별 관찰은 [조사 기록](../../research/admin-governance-original.json)에 있다. 공개 문서 관찰이며 유료 계정 화면·비공개 서버·원본 전체 기능 실행 검증은 아니다. 기존 REA 배포 자산 증거를 대체하거나 확대하지 않는다.

## 관리자 검색과 역할의 계약

[콘텐츠 검색](https://www.notion.com/help/admin-content-search)은 전체 콘텐츠의 ID·제목·본문, 생성자·날짜·공유 범위와 접근자 필터/메타데이터, CSV, 권한 변경·철회·게시 해제를 설명한다. 현재 권한으로 볼 수 있는 검증 페이지의 제목 목록만으로 이 계약을 충족했다고 판단하지 않는다.

[관리 역할](https://www.notion.com/help/enterprise-admins)은 기본 역할에 더하는 개별 권한이며 일반 페이지·DB 접근은 바꾸지 않는다. 구체적인 전체 acceptance는 `features.json`의 `FEATURE-admin-content-search`와 `FEATURE-admin-roles`에 유지한다. 위임된 검색 권한을 가짜 소유자 신원으로 바꾸는 설계는 독립 구현 요구에 맞지 않는다. 권한 철회 시점·원자적 변경·감사 기록은 독립 구현의 검증 요구이며 원본 서버 내부 관찰로 표시하지 않는다.

[보존 정책](https://www.notion.com/help/custom-data-retention-settings)은 휴지통 뒤의 별도 보존 상태와 검색·복원을 설명한다. 기존 휴지통 정리를 이 두 단계 보존 전체의 증거로 확대하지 않는다.

## 추가한 발견 영역

기존 32개 행을 유지하고 9개 행을 추가했다. 추가한 9개는 모두 `discovered`, `verification: []`이며 `inventory_complete`는 계속 `false`다.

| 추가 ID | 직접 읽은 공식 본문 |
| --- | --- |
| `FEATURE-organization-governance` | [조직·여러 작업공간 통제](https://www.notion.com/help/organization-level-controls) |
| `FEATURE-admin-roles` | [준비된/사용자 지정 관리 역할](https://www.notion.com/help/enterprise-admins) |
| `FEATURE-legal-holds` | [법적 보류](https://www.notion.com/help/legal-holds) |
| `FEATURE-managed-users` | [관리 계정](https://www.notion.com/help/managed-users-dashboard) |
| `FEATURE-ip-restrictions` | [IP 제한](https://www.notion.com/help/ip-address-restrictions) |
| `FEATURE-network-control` | [프록시의 작업공간 제한](https://www.notion.com/help/network-control) |
| `FEATURE-guest-mfa-enforcement` | [게스트 MFA 강제](https://www.notion.com/help/mfa-enforcement) |
| `FEATURE-admin-apis` | [관리 API 설정](https://www.notion.com/help/admin-apis-for-enterprise-organizations), [개발자 소개](https://developers.notion.com/reference/admin/intro) |
| `FEATURE-managed-deployment` | [macOS 배포](https://www.notion.com/help/deploy-notion-for-macos), [Windows 배포](https://www.notion.com/help/deploy-notion-for-windows), [모바일 Intune 보호](https://www.notion.com/help/set-up-microsoft-intune-with-notion-ios-and-android) |

데스크톱 배포 문서는 요금제 제한을 명시하지 않는다. 이 영역의 Enterprise 전용 근거는 Intune 앱 보호이며, 추가 라이선스가 필요한 외부 서비스다. 개인·가족 무료 운영과 타사 유료 라이선스 제공을 같은 것으로 처리하지 않는다.

## 현재 구현 근거와 미확인

조사 기준은 커밋 `bb06ce028c2c67ec44700844adfd6e93c3157a74`의 일반 ACL 검색, 검증 페이지 목록과 보존 정리다. 좁은 소스 관찰 위치는 조사 JSON의 `implementation_snapshot`에 기록한다. 이번 목록 확장은 구현 완료를 뜻하지 않으며, 병렬로 수정 중인 코드는 이후 실행 증거로 따로 확인해야 한다.

원본 검색의 전체 추가 필터·일치/정렬 규칙·DB 행 처리·위임 CSV/관리 액션 조합은 미관찰이다. 법적 보류 문서의 소유자 설명과 준비된 Compliance 역할 범위가 만나는 실제 화면도 미확인이다. 외부 조직·IdP·프록시·관리 기기와 계약/라이선스를 포함한 운영 검증 역시 남아 있다.
