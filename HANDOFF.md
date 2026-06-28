# Sinkhole Dungeon Proto — 오케스트레이션 핸드오프

## 현재 기준

- Repo: `/opt/data/repos/sinkhole-dungeon-proto`
- Remote: `git@github.com:perust/sinkhole-dungeon-proto.git`
- 기준 문서:
  - `NEXT_STEPS.md`
  - `/opt/data/Obsidian Vault/Ideas/City Sinkhole Dungeon Scenario.md`의 `# 14. 미작업 / 후속 작업 백로그`

## 백로그 병합 우선순위

1. 저장/이어하기 — 완료
2. 방 선택 3지선다 / 방 타입 3개 — 완료
3. 아이템 Heat/태그 개별화 — 다음 추천
4. 진실 조각 6개 엔딩
5. 귀환 중 선택 이벤트
6. 출구 선택
7. 위험 단계별 액션 연출 강화

## 완료된 패스

### Pass 1 — 저장/이어하기

구현됨:

- `localStorage` 저장 키: `sinkhole-dungeon-save`
- 저장 버전: `version: 1`
- 저장 대상: RP, 강화 레벨, 최고 깊이, 총 획득 RP, 의심도, 진실 조각, 오늘의 의뢰 진행
- 깨진 JSON/버전 불일치/범위 밖 값 안전 처리
- 시작 화면 `기록 초기화` 버튼
- 자동 저장 지점: 최고 깊이 갱신, 판매처 선택, 의뢰 완료, 실패 보상, 강화 구매

검증됨:

- 저장값 생성
- 새로고침 후 복원
- 기록 초기화 후 localStorage 제거 및 시작 화면 초기화

### Pass 2 — 방 선택 3지선다 / 방 타입 3개

구현됨:

- 층 진입 시 바로 회수물이 뜨지 않고 방 선택을 먼저 보여줌
- 방 타입 3종:
  - 안전 캠프: 조명 회복, 낮은 위험
  - 폐쇄 연구실: 희귀/진실 단서 확률 상승, 약간의 비용
  - 회수자 둥지: 고가 회수물 확률 상승, 추적도 압박 증가
- 방 선택 전에는 기존 액션 버튼을 숨겨 모바일 화면에서 선택지가 잘리지 않게 함
- 방 선택 후 기존 루프(`챙기기 → 탈출 → 판매처 선택`) 유지

검증됨:

- `node --check src/game.js`
- `git diff --check`
- 브라우저 로컬 검증:
  - 내려가기 후 방 선택 3개 표시
  - 방 선택 후 회수물 표시
  - 챙기기 후 판매처 선택 화면 진입
  - 방 선택 중 모바일 화면에서 버튼 잘림 없음

## 다음 패스 추천

### Pass 3 — 아이템 Heat/태그 개별화

권장 범위:

- 현재 등급 기반 Heat를 아이템 개별 속성으로 분리한다.
- 우선 MVP 속성은 `heat`, `noise`, `fragile` 세 개만 넣는다.
- `heat`: 암시장 판매 시 의심도 상승량
- `noise`: 챙기는 순간 추적도 상승량
- `fragile`: 버리고 도망 시 보상 일부만 남는 물건
- 판매처/의심도/챙기기 위험/버리기 계산에 새 속성을 연결한다.

제외:

- 진실 조각 6개 엔딩
- 새 회수자
- 출구 선택
- 그래픽 고도화

## 주의

- `NEXT_STEPS.md`, `README.md`, `GAME_SYSTEM_V2.md`는 Pass 1~2 완료 상태로 갱신되어 있다.
- Obsidian `# 14` 백로그는 아직 최종 완료 체크 반영 전이다. repo pass가 안정화된 뒤 한 번에 업데이트하는 것이 안전하다.
- GitHub Pages 배포는 커밋/푸시 후 clean `gh-pages` snapshot으로 진행한다.
