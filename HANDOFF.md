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

### UI Pass — 모바일 앱 게임 형식

완료됨:

- `manifest.webmanifest` 추가
- mobile web app / apple mobile web app 메타 추가
- 시작 화면에 앱 프로토타입 칩 추가
- 던전 화면에 `DIVE MODE` 상단 상태 라인 추가
- 방 선택 3개와 액션 버튼을 하단 앱 독 형태로 고정
- 방 선택 중에는 방 버튼이 주 조작, 방 선택 후에는 액션 버튼이 주 조작
- 짧은 모바일 viewport에서 시작 화면/던전 방 선택/던전 액션 버튼이 한 화면 안에 들어오는 것 확인

검증됨:

- `node --check src/game.js`
- `python3 -m json.tool manifest.webmanifest`
- `git diff --check`
- 브라우저 로컬 검증:
  - 시작 화면 `scrollHeight == innerHeight`
  - 방 선택 3개 모두 보임
  - 방 선택 후 액션 4개 모두 보임
  - 브라우저 비전 평가: 모바일 앱 게임 HUD처럼 보이며 하단 액션 독이 한 손 조작 영역에 있음

### TRPG Pass — 방 선택 판정

완료됨:

- 방 선택마다 `d20 + 보정치 ≥ 난이도` 판정 추가
- 보정치 요소:
  - 조명이 충분하면 유리
  - 조명이 낮으면 불리
  - 빈 가방은 유리, 거의 찬 가방은 불리
  - 안전 캠프는 유리, 회수자 둥지는 불리
- 결과 4종:
  - 대성공: 조명/위험 소폭 이득
  - 성공: 조용히 진입
  - 대가 있는 성공: 회수물은 얻지만 위험 상승
  - 실패: 조명 손실, 위험 상승, 추격 시작 가능
- 모바일 첫 viewport 안에 d20 판정 카드 표시
- 기존 핵심 루프는 유지: 방 선택 → 회수물 확인 → 챙기기 → 탈출 → 판매처 선택

검증됨:

- `node --check src/game.js`
- `python3 -m json.tool manifest.webmanifest`
- `git diff --check`
- 브라우저 로컬 검증:
  - 방 선택 전 판정 카드 숨김
  - 방 선택 후 `d20`, 결과, 보정치, 난이도 표시
  - 강제 낮은 주사위로 실패 결과 확인
  - 챙기기 → 귀환 → 위원회 판매 → 저장 생성 확인

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
- Obsidian `# 14` 백로그도 저장/이어하기와 방 선택 3지선다 완료 상태로 갱신되어 있다.
- 다음 구현은 `아이템 Heat/태그 개별화`를 우선한다. 엔딩은 그 다음 패스로 둔다.
- GitHub Pages 배포는 커밋/푸시 후 clean `gh-pages` snapshot으로 진행한다.
