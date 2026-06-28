# Sinkhole Dungeon Proto — 오케스트레이션 핸드오프

## 현재 기준

- Repo: `/opt/data/repos/sinkhole-dungeon-proto`
- Remote: `git@github.com:perust/sinkhole-dungeon-proto.git`
- 기준 문서:
  - `NEXT_STEPS.md`
  - `/opt/data/Obsidian Vault/Ideas/City Sinkhole Dungeon Scenario.md`의 `# 14. 미작업 / 후속 작업 백로그`

## 이번에 확인한 우선순위

두 백로그를 합치면 다음 순서가 가장 맞다.

1. 저장/이어하기
2. 방 선택 3지선다 / 방 타입 3개
3. 아이템 Heat/태그 개별화
4. 진실 조각 6개 엔딩
5. 귀환 중 선택 이벤트
6. 출구 선택
7. 위험 단계별 액션 연출 강화

## 완료된 패스

### Pass 1 — 저장/이어하기

구현됨:

- `localStorage` 저장 키: `sinkhole-dungeon-save`
- 저장 버전: `version: 1`
- 저장 대상:
  - RP
  - 가방/조명/무기 강화 레벨
  - 최고 깊이
  - 총 획득 RP
  - 의심도
  - 진실 조각
  - 오늘의 의뢰 진행 인덱스
- 깨진 JSON/버전 불일치/범위 밖 값 안전 처리
- 시작 화면 `기록 초기화` 버튼
- 자동 저장 지점:
  - 최고 깊이 갱신
  - 판매처 선택 후
  - 의뢰 완료 후
  - 실패 보상 후
  - 강화 구매 후

검증됨:

- `node --check src/game.js`
- `git diff --check`
- 브라우저 로컬 검증:
  - 저장값 생성
  - 새로고침 후 복원
  - 기록 초기화 후 localStorage 제거 및 시작 화면 초기화

## 다음 패스

### Pass 2 — 방 선택 3지선다 / 방 타입 3개

권장 범위:

- 새 런/층 진입마다 2~3개 선택지를 보여준다.
- MVP 방 타입 3개만 먼저 구현한다.
  1. 안전 캠프: 조명 일부 회복, 낮은 보상
  2. 폐쇄 연구실: 진실 조각/희귀 회수물 확률 상승, 추적도 리스크
  3. 회수자 둥지: 추적도 빠르게 상승, 고가 회수물 등장
- 기존 루프(`챙기기 → 추적도 상승 → 탈출 → 판매처 선택 → 강화`)는 유지한다.
- 그래픽 고도화 금지. 시스템 판단만 추가한다.

## 주의

- `NEXT_STEPS.md`와 `GAME_SYSTEM_V2.md`는 저장/이어하기 완료 상태로 갱신되어 있다.
- Obsidian `# 14` 백로그는 아직 최종 완료 체크 반영 전이다. 여러 pass가 끝난 뒤 한 번에 업데이트하는 것이 안전하다.
- GitHub Pages 배포는 각 큰 pass가 검증된 뒤 수행한다.
