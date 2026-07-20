/* ============================================================
   도심 싱크홀 — 회수 잠수 (플레이어블 프로토타입)

   핵심 훅: "던전이 내가 훔친 물건을 다시 가져가려 한다."
   루프:    챙기고 → 도망치고 → 팔고 → 강화 → 더 깊이.

   - 메타 상태(meta): 런을 넘어 유지되는 영구 자산(RP, 강화 레벨, 최고 깊이).
   - 런 상태(run):    한 번의 잠수 동안만 존재하는 상태(층, 조명, 가방, 위험, 작은 맵).
   각 층은 8~11개 노드짜리 맵으로 생성된다. 노드에는 출구(exits),
   방 유형(kind), 선택적 아이템(item), 선택적 몬스터 이벤트(monster)가 있다.
   모든 수치는 조정 가능한 초기값이다.
   ============================================================ */
(() => {
  'use strict';

  /* ---------------- 설정값 (튜닝 포인트) ---------------- */

  // 3개 층: 깊을수록 조명 소모·위험 상승 속도가 빨라진다.
  const FLOORS = [
    // dangerBase는 150ms 틱마다 오르는 값이다. 1층은 첫 성공을 보장할 만큼 느리게 둔다.
    { n: 1, name: '무너진 도시 시설',   drain: 0.18, dangerBase: 0.18 },
    { n: 2, name: '변질된 연구 구역',   drain: 0.35, dangerBase: 0.35 },
    { n: 3, name: '뒤틀린 지하 구역', drain: 0.55, dangerBase: 0.60 },
  ];

  // 회수물 6종 — 층이 깊을수록 무겁고(칸) 비싸다(RP).
  // 아이템 태그 v1:
  //   heat   — 암시장 판매 시 물건 하나가 더하는 의심도(등급이 아니라 물건별로 다르다).
  //   noise  — 집는 순간의 소음 압박('low'|'medium'|'high'). 조심/재빨리와 함께 추격 압박을 정한다.
  //   fragile— 버리고 도망 시 깨져 값이 거의 남지 않는 물건(true).
  const ITEM_TABLE = {
    1: [
      { name: '실험용 배터리', slots: 1, value: 6,  tier: 'common', icon: 0, heat: 3,  noise: 'medium', fragile: false, truth: '배터리에는 위원회 마크가 지워진 흔적이 있다.' },
      { name: '배관 부품',     slots: 1, value: 5,  tier: 'common', icon: 1, heat: 2,  noise: 'low',    fragile: false, truth: '도시 배관은 사고 전부터 아래로 이어져 있었다.' },
    ],
    2: [
      { name: '봉인 데이터칩', slots: 2, value: 10, tier: 'rare', icon: 2, heat: 9,  noise: 'low',    fragile: true,  truth: '데이터칩의 날짜는 싱크홀 발생 전날로 찍혀 있다.' },
      { name: '연구 노트',     slots: 1, value: 7,  tier: 'rare', icon: 3, heat: 7,  noise: 'medium', fragile: true,  truth: '연구 노트에는 ‘어둠붙이’가 빛과 소리에 다르게 반응한다고 적혀 있다.' },
    ],
    3: [
      { name: '안정화 코어',   slots: 2, value: 18, tier: 'epic', icon: 4, heat: 15, noise: 'high',   fragile: false, truth: '코어는 싱크홀을 막는 장치가 아니라 더 깊게 여는 열쇠다.' },
      { name: '봉인 유물',     slots: 3, value: 30, tier: 'epic', icon: 5, heat: 20, noise: 'high',   fragile: true,  truth: '봉인 유물의 문양은 지상 허가증의 직인과 같다.' },
    ],
  };

  const TIER_COLOR = { common: '#7fb0ff', rare: '#b98bff', epic: '#ffd166' };
  const TIER_HEAT = { common: 4, rare: 8, epic: 14 };
  // 태그 누락 시(오래된 저장/외부 생성 물건) 등급 기준으로 안전하게 보정한다.
  const TIER_NOISE = { common: 'low', rare: 'medium', epic: 'high' };
  function itemHeat(it)  { return it && Number.isFinite(it.heat) ? it.heat : (TIER_HEAT[it && it.tier] || 4); }
  function itemNoise(it) { return it && it.noise ? it.noise : (TIER_NOISE[it && it.tier] || 'medium'); }
  function itemFragile(it) { return !!(it && it.fragile); }
  function itemFamily(it) { return !!(it && it.family); }
  const TRUTH_TOTAL = Object.values(ITEM_TABLE).flat().length;

  // 실종자 흔적방에서만 나오는 개인 유품. 진실 조각 수에는 포함하지 않고,
  // 지상에서는 낮은 값의 개인 물건으로 처리한다(가족 반환 루트는 다음 패스 후보).
  const FAMILY_KEEPSAKES = [
    { name: '가족 사진', slots: 1, value: 4, tier: 'common', icon: 3, heat: 1, noise: 'low', fragile: true, family: true, familyNote: '사진 뒤에 “아빠 꼭 돌아와”라고 적혀 있다.' },
    { name: '이름표 목걸이', slots: 1, value: 5, tier: 'common', icon: 0, heat: 1, noise: 'medium', fragile: false, family: true, familyNote: '목걸이에 아이 이름과 집 주소가 새겨져 있다.' },
    { name: '아이 배낭', slots: 1, value: 3, tier: 'common', icon: 1, heat: 1, noise: 'low', fragile: false, family: true, familyNote: '배낭 안에 반쯤 쓴 색연필과 위원회 출입증이 들어 있다.' },
  ];
  function pickFamilyKeepsake() { return { ...FAMILY_KEEPSAKES[Math.floor(Math.random() * FAMILY_KEEPSAKES.length)] }; }

  // 짧은 의뢰는 "한 번 더 내려가기"의 명분과 판매처 선택의 압박을 만든다.
  const CONTRACTS = [
    { title: '합법 샘플 반납', desc: '위원회에 회수물 2개 이상 넘기기', reward: 6, suspDelta: -3, test: (ctx) => ctx.buyer === 'committee' && ctx.items.length >= 2 },
    { title: '뜨거운 증거', desc: '희귀 이상을 암시장에 팔기', reward: 9, suspDelta: 2, test: (ctx) => ctx.buyer === 'black' && ctx.items.some((it) => it.tier !== 'common') },
    { title: '하층 동선 확인', desc: '2층 이상까지 내려갔다가 생환', reward: 7, suspDelta: 0, test: (ctx) => ctx.maxFloor >= 2 },
  ];

  /* ---------------- 작은 맵 노드 유형 ---------------- */
  // label: 갈림길 버튼에 뜨는 장소 이름. desc: 짧은 감각 단서.
  // style: 버튼 색조('' | 'good' | 'danger'). light/danger: 도착 시 1회 적용.
  const NODE_KINDS = [
    { key: 'corridor', label: '정면 복도',   desc: '곧게 뻗은 어둠',     style: '',       light: -4, danger: 3 },
    { key: 'door',     label: '왼쪽 문',     desc: '금 간 문틈',         style: 'good',   light: 10, danger: -4 },
    { key: 'storage',  label: '낮은 창고',   desc: '먼지 쌓인 선반',     style: 'good',   light: 6,  danger: -2 },
    { key: 'office',   label: '관리실',      desc: '잠긴 캐비닛',        style: '',       light: 0,  danger: 1 },
    { key: 'vent',     label: '환풍구',      desc: '좁고 찬 바람',       style: '',       light: -2, danger: -1 },
    { key: 'hall',     label: '무너진 통로', desc: '내려앉은 콘크리트', style: '',       light: -6, danger: 5 },
    { key: 'crack',    label: '오른쪽 균열', desc: '젖은 발자국',        style: 'danger', light: -8, danger: 9 },
    // 위원회 감시소: 드물게 등장(uncommon). 의심도가 높으면 단말/기록 조작이 위험해진다.
    { key: 'watchpost',label: '위원회 감시소', desc: '꺼진 감시등',        style: '',       light: -2, danger: 2, uncommon: true },
    // 실종자 흔적방: 드물게 등장. 유품 회수와 가족 반환 후보로 이어지는 방이다.
    { key: 'missing-trace', label: '실종자 흔적', desc: '벽에 붙은 사진', style: '', light: -1, danger: 1, uncommon: true },
  ];
  const ENTRY_KIND  = { key: 'entry',  label: '입구',       desc: '',            style: '', light: 0, danger: 0 };
  const STAIRS_KIND = { key: 'stairs', label: '계단 아래로', desc: '더 깊은 냉기', style: '', light: 0, danger: 0 };

  // 위원회 감시소 튜닝값과 단말 로그. 로그는 진실 조각을 공짜로 풀지 않고 단서 한 줄만 흘린다.
  const WATCHPOST_SPAWN_CHANCE = 0.28;     // 층마다 감시소가 나타날 확률(드물게)
  const WATCHPOST_TENSE_SUSPICION = 40;    // 이 이상이면 단말을 뒤지는 게 위험해진다
  const WATCHPOST_LOGS = [
    '단말 로그: “회수물은 폐기가 아니라 재봉인 창고로 이송.” 날짜 칸은 지워져 있다.',
    '깨진 화면에 한 줄이 남아 있다 — “감시등 소등은 상부 지시.” 서명란은 비어 있다.',
    '명단이 스친다. 회수자 몇 사람 이름 옆에 붉은 표시가 찍혀 있다.',
  ];
  const MISSING_TRACE_SPAWN_CHANCE = 0.24;
  const MISSING_TRACE_LOGS = [
    '사진 뒤에 날짜가 적혀 있다 — 싱크홀이 열리기 사흘 전. 이 사람은 그날 이후로 올라오지 않았다.',
    '이름표에 “3구역 회수반”이 찍혀 있다. 위원회 실종 명단에서 지워진 번호다.',
    '편지 한 줄만 읽힌다 — “여보, 이번이 마지막이야.” 다음 줄은 물에 번져 지워졌다.',
  ];

  // 출구 선택 v1: 지상으로 나가는 세 갈래 길. 보정값은 결정적(무작위 없음)이라 판매 견적에 그대로 반영된다.
  const EXIT_CHECKPOINT_HEAT = 12;      // 이 이상 뜨거운 짐이면 공식 출구 검문대가 걸고 넘어진다
  const EXIT_CHECKPOINT_SUSP = 45;      // 지상 의심도가 이 이상이어도 검문이 깐깐해진다
  const EXIT_CHECKPOINT_SUSP_ADD = 3;   // 공식 출구 검문에 걸렸을 때 오르는 의심도
  const EXIT_CRACK_SUSP_RELIEF = 2;     // 균열 출구로 검문을 피해 덜어내는 의심도
  const EXIT_SCRATCH_RATE = 0.15;       // 균열 출구에서 파손되기 쉬운 물건이 긁혀 깎이는 값 비율
  const EXIT_PASSAGE_FEE = 8;           // 암시장 통로 통행료(RP)
  const EXIT_PASSAGE_BLACK_RELIEF = 4;  // 암시장 통로로 뒷골목에 바로 붙어 줄어드는 암시장 의심도
  const FAMILY_RETURN_RATE = 0.4;       // 가족 유품 값 중 사례로 돌아오는 비율
  const FAMILY_RETURN_SUSP_RELIEF = 2;  // 유품 하나를 가족에게 돌려줄 때마다 줄어드는 의심도

  const FLOOR_OPEN_CUE = [
    '아래에서 찬바람이 올라온다.',
    '벽이 미세하게 떨린다.',
    '복도 폭이 조금씩 어긋나 있다.',
  ];

  const EXTRACTION_TUTORIAL_CUE = '쓸 만한 게 있으면 챙겨놓자. 왔던 길은 표시해둬야겠지.';

  const LIGHT_ALERTS = [
    { key: 'dim70', pct: 70, text: '손전등의 동그란 빛이 끝부터 흐려진다.' },
    { key: 'dim45', pct: 45, text: '빛 가장자리가 흐려진다. 복도 끝이 제대로 보이지 않는다.' },
    { key: 'dim25', pct: 25, text: '빛이 두 번 끊긴다. 어둠 속에서 젖은 숨소리가 샌다.' },
    { key: 'dim10', pct: 10, text: '빛이 바닥에 붙어 떨린다. 어둠 속 발소리가 가까워진다.' },
  ];

  const MENTAL_ALERTS = [
    { key: 'uneasy60', value: 60, text: '숨이 차서 호흡이 짧아진다. 바닥이 기울어진 것처럼 느껴진다.' },
    { key: 'shaken35', value: 35, text: '판단이 느려지고 있다. 생각이 흐려지는 것을 붙잡기 힘들다.' },
    { key: 'fraying15', value: 15, text: '손전등을 쥔 손이 차갑게 굳는다.' },
  ];

  const BAG_ALERTS = {
    heavy: '가방 끈이 어깨를 세게 누른다. 뛰면 금방 균형을 잃을 것 같다.',
    full: '더 넣을 곳이 없다. 돌아가서 짐을 정리하자.',
    blocked: '더 넣을 곳이 없다. 돌아가서 짐을 정리하자.',
  };
  const NO_BAG_LEVEL = 0;
  const BAG_PRODUCTS = [
    { level: 0, name: '맨손', cap: 1, cost: 0 },
    { level: 1, name: '작은 가방', cap: 3, cost: 8 },
    { level: 2, name: '큰 가방', cap: 5, cost: 18 },
    { level: 3, name: '대형 가방', cap: 7, cost: 34 },
    { level: 4, name: '특대 가방', cap: 9, cost: 56 },
  ];
  const MAX_BAG_LEVEL = BAG_PRODUCTS[BAG_PRODUCTS.length - 1].level;
  const CABINET_BAG_FIND_RATES = { 1: 0.18, 2: 0.075, 3: 0.032, 4: 0.014 }; // 캐비닛에서 더 큰 가방을 발견할 확률. 큰 제품일수록 낮다.
  const NO_BAG_ALERTS = {
    full: '손이 가득 찼다. 맨손이라 더는 못 든다.',
    blocked: '맨손이라 더 쥘 자리가 없다. 손에 쥔 것만으로 벅차다.',
  };
  function bagProduct(level = meta.bagLevel) {
    const safe = Math.max(NO_BAG_LEVEL, Math.min(MAX_BAG_LEVEL, Math.floor(Number(level)) || 0));
    return BAG_PRODUCTS.find((bag) => bag.level === safe) || BAG_PRODUCTS[0];
  }
  function bagAlert(key) {
    if (meta.bagLevel === NO_BAG_LEVEL && NO_BAG_ALERTS[key]) return NO_BAG_ALERTS[key];
    return BAG_ALERTS[key];
  }
  function largerBagProducts(currentLevel = meta.bagLevel) {
    return BAG_PRODUCTS.filter((bag) => bag.level > NO_BAG_LEVEL && bag.level > currentLevel);
  }
  function cabinetBagFindCandidate(currentLevel, roll) {
    const level = Math.max(NO_BAG_LEVEL, Math.min(MAX_BAG_LEVEL, Math.floor(Number(currentLevel)) || 0));
    const chanceRoll = Math.max(0, Math.min(1, Number(roll)));
    const candidates = largerBagProducts(level);
    if (!candidates.length) return null;
    let acc = 0;
    for (const bag of candidates) {
      acc += CABINET_BAG_FIND_RATES[bag.level] || 0;
      if (chanceRoll < acc) return bag;
    }
    return null;
  }
  function bagFindCandidate() {
    return cabinetBagFindCandidate(meta.bagLevel, Math.random());
  }

  function itemIcon(index) {
    return `<span class="loot-icon" style="--icon-index:${index}" aria-hidden="true"></span>`;
  }

  function hasFinalConsonant(text) {
    const ch = [...String(text)].pop();
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  }
  const subjectParticle = (text) => hasFinalConsonant(text) ? '이' : '가';
  const objectParticle = (text) => hasFinalConsonant(text) ? '을' : '를';

  // 행동 비용
  const GRAB_LIGHT_COST    = 6;   // 회수물 집기: 공명으로 조명 소모
  const GRAB_DANGER_BUMP   = 4;   // 집는 순간 위험 점프
  const DESCEND_LIGHT_COST = 14;  // 더 깊이: 강하 비용
  const DESCEND_DANGER_BUMP= 8;   // 추격 중 강하 시 위험 점프
  const DROP_DANGER_FACTOR = 0.45;// 버리고 도망: 위험 ×0.45
  const DROP_DANGER_MINUS  = 6;
  const LOOT_RETRIEVE_TICKS = 6;  // 끌개: 버린 물건을 놈이 거둬 가기까지의 유예(틱). 이후 가까우면 사라진다.
  const WAIT_LIGHT_COST     = 4;  // 기다리기: 시간이 흘러 조명 소모
  const START_MENTAL        = 80; // 침착함/판단력. 조명 상태에 따라 서서히 변한다.
  const MENTAL_BREAK_RECOVERY = 28; // 붕괴 후 간신히 다시 움직일 수 있는 기준선
  const MENTAL_BREAK_GRACE_TICKS = 40; // 해결 직후 약 6초간 연쇄 붕괴 방지
  const MENTAL_BREAK_MIN_LIGHT_PCT = 8; // 암전이면 손전등을 아주 약하게 되살림
  // 몬스터 이벤트 위험 수치
  const SIGHT_DANGER        = 8;  // 직선 끝에서 이상한 기척
  const SIGHT_MOVE_DANGER   = 6;  // 그쪽으로 전진할 때 추가 위험
  const CROSS_DANGER        = 4;  // 갈림길을 어둠붙이가 지나감(도착)
  const CROSS_MOVE_DANGER   = 14; // 지나가는 중에 움직이면 들킴
  const AMBUSH_MOVE_DANGER  = 20; // '움직이면 들킴' 상태에서 이동
  const MONSTER_GRACE_DANGER = 86; // 위기 선택 성공 후 즉시 재기절하지 않게 낮출 기준
  const TICK_MS            = 150;
  const MOVE_MS            = 420; // 전진 연출은 짧게, 상황 문구는 상단 패널에 지속
  const DESCEND_MS         = 560; // 층 이동 연출도 조작감을 해치지 않게 짧게 유지

  /* ---------------- 숨은 이동 추격자(스토커) ---------------- */
  // 각 층에는 보이지 않는 추격자 하나가 돌아다닌다. 플레이어의 소음을 좇아
  // BFS로 한 칸씩 다가오고, 조용하면 다시 잠든다. 위험도는 추격자와의 거리로만 오르내린다.
  const DORMANT_AFTER = 3;             // quietSteps가 이 값 이상이면 잠듦(비추격)
  const STALKER_STEP_TICKS = { 1: 16, 2: 11, 3: 8 }; // 층별 이동 주기(1층이 가장 느림)
  const DORMANT_WANDER_CHANCE = 0.12;  // 잠든 추격자가 아주 가끔 한 칸 배회
  const DORMANT_DANGER_CAP = 15;       // 잠들어 가까이 있어도 위험은 낮게 묶는다
  const DANGER_RISE = 0.30;            // 거리 기반 목표치로 오를 때(빠르게)
  const DANGER_DECAY = 0.10;           // 목표치로 내릴 때(느리게)
  const stalkerStepTicks = (floor) => STALKER_STEP_TICKS[floor] || 8;

  const MONSTER_ARCHETYPES = {
    longFace: {
      name: '길게 구부러진 형체',
      tag: '빛에 굳는 것',
      title: '조명 끝에 걸린 얼굴',
      reasons: {
        sight: {
          known: (dir) => `${dir} 어둠에서 젖은 쇳소리가 멎는다. 조명 끝에 길게 구부러진 윤곽이 보인다.`,
          unknown: '젖은 쇳소리가 멎는다. 조명 끝에 길게 구부러진 윤곽이 보인다.',
        },
        cross: '갈림길을 지나던 검은 윤곽이 허리를 숙인다. 고개가 이쪽으로 천천히 돌아온다.',
        ambush: '문 옆 빈틈에서 구부러진 몸이 펴진다. 손끝이 조명 가장자리를 더듬는다.',
        critical: '젖은 쇳소리가 등 뒤에서 끊긴다. 빛이 닿지 않는 곳에서 놈이 몸을 숙인다.',
      },
      choices: (ctx) => [
        ctx.canLight && eventChoice('shine', '조명을 정면으로 비추며 물러난다', '', ctx.lightStrong ? 'good' : 'danger'),
        eventChoice('sidestep', '옆으로 피하며 달려나간다', ''),
        eventChoice('hold', '숨 죽이고 구석으로 숨는다', '', ctx.mentalOk ? '' : 'danger'),
      ].filter(Boolean),
    },
    wetFeet: {
      name: '젖은 발소리',
      tag: '소리와 발자국을 좇는 것',
      title: '젖은 발자국',
      reasons: {
        sight: {
          known: (dir) => `${dir} 바닥에 젖은 발자국이 따라 찍힌다. 내 발소리보다 반 박자 늦게 들린다.`,
          unknown: '바닥에 젖은 발자국이 따라 찍힌다. 내 발소리보다 반 박자 늦게 들린다.',
        },
        cross: '갈림길 바닥에 젖은 자국이 번진다. 보이지 않는 발소리가 이쪽으로 방향을 튼다.',
        ambush: '바로 옆 물웅덩이에 새 발자국이 찍힌다. 놈은 숨소리보다 발소리에 먼저 반응한다.',
        critical: '등 뒤에서 물 밟는 소리가 들린다. 내 걸음에 맞춰 따라온다.',
      },
      choices: (ctx) => [
        eventChoice('hold', '발을 멈추고 숨을 죽인다', '', ctx.mentalOk ? 'good' : 'danger'),
        ctx.hasBag && eventChoice('bait', '미끼를 던지고 반대로 뛴다', '', 'good'),
        eventChoice('run', '젖은 바닥을 박차고 뛴다', '', 'danger'),
      ].filter(Boolean),
    },
    doorHand: {
      name: '문틈의 손가락',
      tag: '가까이서 붙잡는 것',
      title: '문틈 안쪽의 손가락',
      reasons: {
        sight: {
          known: (dir) => `${dir} 문틈이 서서히 벌어진다. 길고 얇은 손가락들이 문을 열고 있었다.`,
          unknown: '문틈이 서서히 벌어진다. 길고 얇은 손가락들이 문을 열고 있었다.',
        },
        cross: '갈림길 옆 문틈에서 손가락 마디들이 먼저 나온다. 지나갈 틈이 손바닥만큼 좁아진다.',
        ambush: '문 사이 빈틈에서 구부러진 몸이 천천히 펴지며 나온다. 손목 같은 것이 가방 끈을 움켜쥔다.',
        critical: '등 뒤 문틀이 비틀린다. 길고 차가운 마디들이 바로 등에 닿는다.',
      },
      choices: (ctx) => [
        eventChoice('strike', '손목을 후려치고 빠져나간다', '', 'good'),
        eventChoice('kick', '문틀을 걷어차고 몸을 뺀다', ''),
        ctx.canLight && eventChoice('shine', '조명을 비추며 손을 떼어낸다', '', ''),
        eventChoice('run', '몸을 비틀어 달아난다', '', 'danger'),
      ].filter(Boolean),
    },
  };
  const MONSTER_KIND_KEYS = Object.keys(MONSTER_ARCHETYPES);

  const RECOVERY_OUTCOMES = [
    {
      elapsed: '1시간 후',
      title: '다른 조사자에게 발견됐다.',
      body: '낯선 조사자가 비상등 하나를 흔들며 나를 끌어냈다.',
      rpRate: 0.35,
      suspDelta: 4,
      loss: '가방은 찢겼지만 작은 조각 몇 개는 건졌다.',
    },
    {
      elapsed: '3시간 후',
      title: '위원회 드론에 발견되어 구조됐다.',
      body: '구조 기록이 남았다. 대신 현장 물품은 대부분 압수됐다.',
      rpRate: 0.15,
      suspDelta: -6,
      loss: '위원회가 회수품을 압수하고 구조비 명목으로 정리했다.',
    },
    {
      elapsed: '얼마나 지났는지 모르겠다',
      title: '깨어났다.',
      body: '혼자였다. 벽에 기대어 있다가 비틀거리며 지상으로 돌아왔다.',
      rpRate: 0,
      suspDelta: -2,
      loss: '가방은 비어 있었다. 조명도 한동안 켜지지 않았다.',
    },
    {
      elapsed: '2시간 후',
      title: '암시장 수거꾼에게 끌려 나왔다.',
      body: '치료비는 말없이 계산됐다. 누가 나를 맡겼는지는 모른다.',
      rpRate: 0.25,
      suspDelta: 7,
      loss: '쓸 만한 회수품 일부가 치료비로 사라졌다.',
    },
  ];

  const MENTAL_BREAK_EVENTS = [
    {
      key: 'panic',
      title: '공황',
      cue: '숨이 목에 걸린다. 손전등 원이 바닥으로 떨어진다.',
      choice: '숨을 고른다',
      sub: '조명 -8 · 기척 +6',
      apply() {
        run.light = clamp(run.light - 8, 0, maxLight());
        run.danger = clamp(run.danger + 6, 0, 100);
      },
      after: '목 안쪽에서 숨을 겨우 풀었다. 빛은 흔들리지만 다시 앞을 가른다.',
    },
    {
      key: 'voices',
      title: '환청',
      cue: '뒤에서 누군가 이름을 부른다. 돌아본 순간 길 감각이 흐려진다.',
      choice: '벽을 짚고 확인한다',
      sub: '기척 +10 · 멘탈 회복',
      apply() {
        run.danger = clamp(run.danger + 10, 0, 100);
      },
      after: '돌아보면 아무도 없다. 젖은 벽만 손바닥에 남는다.',
    },
    {
      key: 'tremor',
      title: '손이 떨림',
      cue: '손끝이 말을 듣지 않는다. 가방 끈이 어둠 속으로 미끄러진다.',
      choice: '가방부터 붙잡는다',
      sub: '가벼운 짐 1개 손실 가능',
      apply() {
        if (run.bag.length && Math.random() < 0.55) {
          const lost = takeCheapestBagItem();
          if (lost) {
            run.droppedCount += 1;
            run.lastMentalLoss = lost.name;
          }
        }
      },
      after: '손끝의 떨림이 천천히 멈춘다.',
    },
  ];

  // 강화: 레벨에 비례해 비용 상승
  const UPGRADES = {
    bag:    { label: '가방',  cost: lv => 8  * lv },
    light:  { label: '조명',  cost: lv => 5  * lv },
    weapon: { label: '장비',  cost: lv => 10 * lv },
  };

  /* ---------------- 생존자 v1 ---------------- */
  // 던전에서 구출해 지상으로 데려온 사람들. 런을 넘어 유지되며(meta.survivors),
  // 각자 하나의 영구 효과를 준다.
  const SURVIVORS = {
    mechanic: {
      id: 'mechanic',
      name: '정비공',
      // 방에서 뜨는 이벤트 문구 — 시적이지 않고 구체적으로.
      eventTitle: '갇힌 사람',
      eventCue: '휘어진 사물함 뒤에서 둔한 두드림이 반복된다. 좁은 틈으로 흙 묻은 손이 뻗어 나와 허공을 더듬는다.',
      rescueSub: '사물함을 비틀어 연다',
      rescueLog: '휘어진 사물함을 비틀어 열었다. 정비공이라던 사람이 기어 나와 숨을 몰아쉰다. 이제부터 장비를 싸게 손봐 준다.',
    },
    medic: {
      id: 'medic',
      name: '의무병',
      eventTitle: '깔린 사람',
      eventCue: '무너진 선반 밑에서 누군가 다리가 눌린 채 낮게 신음한다. 비상등 불빛에 창백한 얼굴이 스친다.',
      rescueSub: '선반을 들어 다리를 뺀다',
      rescueLog: '선반을 들어 올려 다리를 빼냈다. 의무병이라던 사람이 절뚝이며 따라붙는다. 다음에 쓰러져도 뒤처리를 도와줄 것이다.',
    },
    mapper: {
      id: 'mapper',
      name: '지도공',
      eventTitle: '벽 뒤의 사람',
      eventCue: '휘어진 벽판 뒤에서 접힌 지도를 쥔 손이 흔들린다. 젖은 종이에는 아래층 통로가 손으로 그려져 있다.',
      rescueSub: '벽판을 뜯어 끌어낸다',
      rescueLog: '휘어진 벽판을 뜯어 그 사람을 끌어냈다. 지도공이라던 이가 젖은 지도를 접어 넣으며 따라붙는다. 이제부터 갈림길마다 앞쪽 방이 뭔지 짚어 준다.',
    },
    insider: {
      id: 'insider',
      name: '전 위원회 직원',
      eventTitle: '게이트에 낀 사람',
      eventCue: '부서진 ID 게이트 사이에 팔이 낀 사람이 몸을 비튼다. 찢어진 끈에 위원회 출입증이 매달려 흔들린다.',
      rescueSub: '게이트 틈을 벌려 빼낸다',
      rescueLog: '뒤틀린 ID 게이트를 벌려 그 사람을 빼냈다. 전 위원회 직원이라던 이가 출입증을 움켜쥔 채 따라붙는다. 감시소 단말과 지상 검문에서 낡은 직원 코드가 쓸모가 있다.',
    },
  };
  const SURVIVOR_IDS = Object.keys(SURVIVORS);
  const KNOWN_SURVIVORS = new Set(SURVIVOR_IDS);

  const MECHANIC_DISCOUNT = 0.25;        // 정비공: 장비(weapon) 강화 비용을 이 비율만큼 깎는다
  const MEDIC_SUSPICION_RELIEF = 2;      // 의무병: 기절 시 오르는 의심도를 이만큼 덜어낸다(양수 델타에만)
  const MEDIC_CONSOLATION_RATE = 0.15;   // 의무병: 잃은 짐 값의 이 비율만큼 위로 보상을 더 챙겨준다
  const INSIDER_WATCHPOST_LIGHT = 3;     // 전 직원: 봉쇄 코드를 넣느라 드는 조명(소음·위험 없음)
  const INSIDER_CHECKPOINT_RELIEF = 2;   // 전 직원: 공식 출구 검문에서 의심도 상승을 덜어낸다
  const INSIDER_SEAL_LOG = '낡은 직원 코드가 먹혔다. 단말이 순순히 열리고 한 줄이 떠오른다 — “봉쇄문 재봉인은 3단계, 마지막 인증은 현장 직원 코드.”';
  const MAPPER_FEATURE = {
    corridor: '곧은 복도', crack: '젖은 균열', storage: '낮은 창고', office: '관리실',
    watchpost: '감시소', hall: '무너진 통로', door: '비상등 문', vent: '낮은 틈', 'missing-trace': '사진 흔적', stairs: '아래 계단',
  };

  const SURVIVOR_EVENT_CHANCE = 0.16;    // 방 도착 시 생존자 조우가 열릴 확률(드물게)
  const SURVIVOR_RESCUE_LIGHT = 8;       // 구출: 끌어내느라 드는 조명
  const SURVIVOR_RESCUE_MENTAL = 5;      // 구출: 끌어내느라 드는 멘탈
  const SURVIVOR_RESCUE_DANGER = 6;      // 구출: 소음으로 오르는 위험

  const MUTATIONS = {
    'fissure-sight': { id: 'fissure-sight', name: '균열 시야', gainLog: '벽 틈이 더 선명하게 보인다. 물건과 계단이 있는 쪽이 어렴풋이 짚인다.' },
    'black-hand': { id: 'black-hand', name: '검은 손', gainLog: '손등에 검은 얼룩이 번졌다. 손가락이 전보다 쉽게 틈을 비집는다.' },
    'muffled-skin': { id: 'muffled-skin', name: '젖은 살갗', gainLog: '살갗이 짙은 물기에 덮였다. 손끝에 닿는 것들이 소리를 덜 낸다.' },
  };
  const MUTATION_ORDER = ['fissure-sight', 'black-hand', 'muffled-skin'];
  const KNOWN_MUTATIONS = new Set(MUTATION_ORDER);
  const MUTATION_TRIGGER_HEAT = 15;
  const MUTATION_TRIGGER_ROOMS = 3;
  const MUTATION_TRIGGER_FLOOR = 2;
  const FISSURE_SCRATCH_RATE = 0.20;
  const FISSURE_EXIT_NOTE = '벽 틈이 너무 많이 보여 빠져나오는 길을 한번 잘못 짚었다.';
  const BLACKHAND_CABINET_LIGHT = 1;
  const BLACKHAND_CHECKPOINT_SUSP = 1;
  const BLACKHAND_CABINET_NOTE = '검게 물든 손가락이 휘어진 손잡이를 너무 쉽게 비집었다.';
  const BLACKHAND_CHECKPOINT_NOTE = '검문관의 시선이 검게 물든 손에 오래 머물렀다.';
  const MUFFLED_COMMITTEE_SUSP = 1;
  const MUFFLED_COMMITTEE_NOTE = '접수관이 젖은 살갗을 보고 서류를 한 번 더 넘겼다.';

  /* ---------------- 상태 ---------------- */

  const meta = {
    rp: 0,
    bagLevel: NO_BAG_LEVEL,
    lightLevel: 1,
    weaponLevel: 1,
    maxDepth: 1,
    totalEarned: 0,
    suspicion: 0,
    truths: [],
    contractIndex: 0,
    extractionCueSeen: false,
    endingSeen: false,
    survivors: [],   // 구출해 지상으로 데려온 생존자 id 목록(런을 넘어 유지)
    mutations: [],   // 몸에 남은 왜곡 변이 id 목록(런을 넘어 유지)
    minimapMode: 'rotate', // rotate: 바라보는 방향 12시 / fixed: 지도 고정
  };

  const hasSurvivor = (id) => meta.survivors.includes(id);
  const hasMutation = (id) => meta.mutations.includes(id);
  function nextMutationId(current = meta.mutations) {
    const known = new Set((Array.isArray(current) ? current : []).filter((id) => KNOWN_MUTATIONS.has(id)));
    return MUTATION_ORDER.find((id) => !known.has(id)) || null;
  }
  function mutationCandidateForReturn(ctx) {
    const bag = Array.isArray(ctx && ctx.bag) ? ctx.bag : [];
    const current = Array.isArray(ctx && ctx.mutations) ? ctx.mutations : [];
    if (!bag.length) return null;
    if (!bag.some((it) => itemHeat(it) >= MUTATION_TRIGGER_HEAT)) return null;
    const deepEnough = (ctx && ctx.maxFloor >= MUTATION_TRIGGER_FLOOR) || (ctx && ctx.roomsEntered >= MUTATION_TRIGGER_ROOMS);
    if (!deepEnough) return null;
    const id = nextMutationId(current);
    return id ? MUTATIONS[id] : null;
  }
  function grantMutationOnReturn() {
    if (!run || run.mutationChecked) return null;
    run.mutationChecked = true;
    const mutation = mutationCandidateForReturn({ bag: run.bag, maxFloor: run.maxFloor, roomsEntered: run.roomsEntered, mutations: meta.mutations });
    if (!mutation) return null;
    if (!hasMutation(mutation.id)) meta.mutations.push(mutation.id);
    saveMeta();
    return mutation;
  }
  // 아직 구출하지 않은 생존자 중 하나를 고른다(중복 방지). 없으면 null.
  function nextUnrescuedSurvivor() {
    const pool = SURVIVOR_IDS.filter((id) => !hasSurvivor(id));
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  // 강화 비용: 정비공을 구출했으면 장비(weapon) 강화가 싸진다(결정적).
  function upgradeCost(type) {
    const base = UPGRADES[type].cost(meta[type + 'Level']);
    if (type === 'weapon' && hasSurvivor('mechanic')) {
      return Math.max(1, Math.round(base * (1 - MECHANIC_DISCOUNT)));
    }
    return base;
  }

  /* ---------------- 저장 / 이어하기 ---------------- */
  // localStorage에 메타(런을 넘는 영구 자산)만 저장한다. 런 상태는 저장하지 않는다.
  // SAVE_VERSION을 올리면 이전 구조의 저장값은 무시되고 기본값으로 새로 시작한다.

  const SAVE_KEY = 'sinkhole-dungeon-save';
  const INTRO_KEY = 'unlit-halls-intro-seen';
  const SAVE_VERSION = 1;

  // 알려진 진실 조각 이름 집합 — 깨진/오래된 truths 값을 거를 때 쓴다.
  const KNOWN_TRUTHS = new Set(Object.values(ITEM_TABLE).flat().map((it) => it.name));

  function hasStorage() {
    try {
      const k = '__sinkhole_test__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false; // 사생활 모드 등 localStorage 차단 환경
    }
  }

  const storageOk = typeof window !== 'undefined' && hasStorage();

  // 0 이상의 정수만 통과시키고, 그 외에는 기본값으로 되돌린다.
  function safeInt(value, fallback, min, max) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < min) return fallback;
    return max != null ? Math.min(n, max) : n;
  }

  function saveMeta() {
    if (!storageOk) return;
    try {
      const payload = {
        version: SAVE_VERSION,
        rp: meta.rp,
        bagLevel: meta.bagLevel,
        lightLevel: meta.lightLevel,
        weaponLevel: meta.weaponLevel,
        maxDepth: meta.maxDepth,
        totalEarned: meta.totalEarned,
        suspicion: meta.suspicion,
        truths: meta.truths,
        contractIndex: meta.contractIndex,
        extractionCueSeen: !!meta.extractionCueSeen,
        endingSeen: !!meta.endingSeen,
        survivors: meta.survivors,
        mutations: meta.mutations,
        minimapMode: meta.minimapMode === 'fixed' ? 'fixed' : 'rotate',
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    } catch (e) {
      /* 저장 실패는 조용히 무시한다 — 게임 진행은 막지 않는다. */
    }
  }

  // 저장값을 읽어 meta에 병합한다. 버전이 다르거나 깨졌으면 무시하고 기본값을 유지한다.
  function loadMeta() {
    if (!storageOk) return;
    let data;
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      data = JSON.parse(raw);
    } catch (e) {
      return; // JSON 파손 → 기본값으로 시작
    }
    if (!data || typeof data !== 'object') return;
    // 버전 불일치(이전/미래 구조) → 마이그레이션 대신 안전하게 폐기.
    if (data.version !== SAVE_VERSION) { clearSave(); return; }

    meta.bagLevel    = safeInt(data.bagLevel,    NO_BAG_LEVEL, NO_BAG_LEVEL, MAX_BAG_LEVEL);
    meta.lightLevel  = safeInt(data.lightLevel,  1, 1);
    meta.weaponLevel = safeInt(data.weaponLevel, 1, 1);
    meta.rp          = safeInt(data.rp,          0, 0);
    meta.totalEarned = safeInt(data.totalEarned, meta.rp, 0);
    meta.maxDepth    = safeInt(data.maxDepth,    1, 1, FLOORS.length);
    meta.suspicion   = safeInt(data.suspicion,   0, 0, 99);
    meta.contractIndex = safeInt(data.contractIndex, 0, 0);
    meta.extractionCueSeen = !!data.extractionCueSeen;
    // endingSeen: 구버전 저장값에는 없다 → 기본 false. 하위호환이라 SAVE_VERSION은 올리지 않는다.
    meta.endingSeen = !!data.endingSeen;
    // truths: 배열이면서 현재 회수물에 실제로 존재하는 이름만 남기고 중복 제거.
    if (Array.isArray(data.truths)) {
      meta.truths = [...new Set(data.truths.filter((t) => KNOWN_TRUTHS.has(t)))];
    }
    // survivors: 구버전 저장값에는 없다 → 기본 []. 알려진 id만 남기고 중복 제거(하위호환).
    if (Array.isArray(data.survivors)) {
      meta.survivors = [...new Set(data.survivors.filter((id) => KNOWN_SURVIVORS.has(id)))];
    }
    if (Array.isArray(data.mutations)) {
      const known = new Set(data.mutations.filter((id) => KNOWN_MUTATIONS.has(id)));
      meta.mutations = MUTATION_ORDER.filter((id) => known.has(id));
    }
    meta.minimapMode = data.minimapMode === 'fixed' ? 'fixed' : 'rotate';
  }

  function clearSave() {
    if (!storageOk) return;
    try { window.localStorage.removeItem(SAVE_KEY); } catch (e) { /* 무시 */ }
  }

  // '기록 초기화' — 저장값을 지우고 meta를 출고 상태로 되돌린다.
  function resetProgress() {
    if (!window.confirm('모든 기록(RP·강화·깊이·의심도·진실 조각·생존자·변이)을 지울까요?')) return;
    clearSave();
    Object.assign(meta, {
      rp: 0, bagLevel: NO_BAG_LEVEL, lightLevel: 1, weaponLevel: 1,
      maxDepth: 1, totalEarned: 0, suspicion: 0, truths: [], contractIndex: 0, extractionCueSeen: false,
      endingSeen: false, survivors: [], mutations: [], minimapMode: 'rotate',
    });
    renderStartScreen();
  }

  const activeContract = () => CONTRACTS[meta.contractIndex % CONTRACTS.length];

  function nextGoal() {
    if (meta.maxDepth < FLOORS.length) return `${meta.maxDepth + 1}층 도달`;
    if (meta.truths.length < TRUTH_TOTAL) return '진실 조각 더 찾기';
    if (!meta.endingSeen) return '진실 확인하기';
    return '심층 루프 계속';
  }

  let run = null;
  let timer = null;
  let introMode = 'normal';
  let introLine = 0;

  // 파생값
  let bagShopOpen = false;
  const maxLight   = () => 100 + (meta.lightLevel  - 1) * 35;
  const bagCap     = () => bagProduct().cap;
  const weaponFactor = () => 1 + (meta.weaponLevel - 1) * 0.25; // 위험 상승 둔화
  const usedSlots  = () => run.bag.reduce((s, i) => s + i.slots, 0);
  const bagValue   = () => run.bag.reduce((s, i) => s + i.value, 0);
  function familyReturnQuote(items, effect = { gainDelta: 0, suspDelta: 0, note: '', route: 'official' }) {
    const familyItems = (Array.isArray(items) ? items : []).filter(itemFamily);
    const raw = familyItems.reduce((sum, it) => sum + (Number(it.value) || 0), 0);
    return {
      gained: Math.max(0, Math.ceil(raw * FAMILY_RETURN_RATE) + (effect.gainDelta || 0)),
      suspDelta: -(familyItems.length * FAMILY_RETURN_SUSP_RELIEF) + (effect.suspDelta || 0),
      familyCount: familyItems.length,
      note: effect.note || '',
      route: effect.route || 'official',
    };
  }
  const roomFor    = (item) => bagCap() - usedSlots() >= item.slots;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function lightPercent() {
    return run ? Math.round((run.light / maxLight()) * 100) : 0;
  }

  function effectiveLightPercent() {
    if (!run || run.lightOn === false) return 0;
    return lightPercent();
  }

  function lightState() {
    const pct = lightPercent();
    if (run && run.lightOn === false && pct > 0) return { key: 'off', label: '꺼둠' };
    if (pct <= 0) return { key: 'blackout', label: '암전' };
    if (pct < 20) return { key: 'dying', label: '꺼져감' };
    if (pct < 45) return { key: 'flicker', label: '깜빡임' };
    if (pct < 75) return { key: 'dim', label: '흐림' };
    return { key: 'clear', label: '또렷함' };
  }

  function newRun() {
    return {
      floor: 1,
      light: maxLight(),
      lightOn: true,
      mental: START_MENTAL,
      bag: [],
      danger: 0,
      chasing: false,
      currentItem: null,   // 현재 노드에 놓인, 아직 안 집은 물건
      floorMap: null,      // 이번 층의 작은 맵
      currentNodeId: 0,    // 현재 위치한 노드 id
      facing: 'n',          // 손전등/시선 방향. 좌우 버튼은 이동이 아니라 이 값을 돌린다.
      holdEvent: null,     // 활성 몬스터 대기 이벤트({type:'cross'|'ambush', node})
      pendingEvent: null,  // 방 도착 후 플레이어가 고르는 짧은 환경 이벤트
      encounterTime: 0,     // 어두운 형체 조우 중 남은 초. 선택지 표시 중에도 줄어든다.
      returnWalk: false,   // 귀환 걷기 연출 진행 중(마지막 탭에서 지상으로 나간다)
      exitRoute: 'official', // 지상으로 나가는 길: official|crack|blackpass (판매처 선택 전에 고른다)
      exitNote: '',        // 선택한 출구의 결과 문구(강화 화면 요약에 노출)
      monsterCrisisCount: 0,
      previousNodeId: null,
      failContext: '',
      mentalEventCount: 0,
      mentalGraceTicks: 0,
      lastMentalLoss: null,
      moving: false,       // 전진/강하 연출 중
      lastAction: '',      // 다음 의미 있는 행동/상태 갱신 전까지 상단 상황판에 남길 최근 맥락
      dialogue: null,      // 선택/이동 결과를 가방 아래에서 탭해 넘기는 읽기 게이트
      dialogueQueue: [],   // 한 행동 안에서 도착→이벤트처럼 이어지는 중요한 문장 순서 보존
      seenLightAlerts: new Set(),
      seenMentalAlerts: new Set(),
      seenBagAlerts: new Set(),
      maxFloor: 1,
      roomsEntered: 0,
      mutationChecked: false,
      mutationNote: '',
      grabbedCount: 0,
      droppedCount: 0,
      bought: false,     // 이번 귀환에서 강화를 샀는가
      lastSale: [],      // 판매 화면용 스냅샷
      lastBuyer: null,
      lastTruth: null,
      contractResult: null,
      streetNews: '허가소 앞 전광판이 조용하다.',
    };
  }

  function pickFloorItem(floor, node) {
    const table = ITEM_TABLE[floor];
    // 위험한 방일수록 비싼 물건이 놓일 확률을 높인다.
    if (node && node.style === 'danger' && table.length > 1 && Math.random() < 0.7) {
      return { ...table[table.length - 1] };
    }
    return { ...table[Math.floor(Math.random() * table.length)] };
  }

  /* ---------------- 작은 맵 생성 ---------------- */

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  const MAP_DIRECTIONS = [
    { key: 'n', dx: 0,  dy: -1 },
    { key: 'e', dx: 1,  dy: 0 },
    { key: 's', dx: 0,  dy: 1 },
    { key: 'w', dx: -1, dy: 0 },
  ];
  const MAP_DIRECTION_BY_KEY = Object.fromEntries(MAP_DIRECTIONS.map((d) => [d.key, d]));
  const MAP_DIRECTION_ORDER = ['n', 'e', 'w', 's'];
  const CARDINAL_DIRECTIONS = ['n', 'e', 's', 'w'];
  const FACING_LABELS = { n: '북쪽', e: '동쪽', s: '남쪽', w: '서쪽' };
  const ENCOUNTER_SECONDS = 6.0;

  const posKey = (pos) => `${pos.x},${pos.y}`;
  const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
  const edgeKey = (a, b) => [a, b].sort((x, y) => x - y).join('-');

  function addEdge(nodes, a, b) {
    if (a === b) return;
    if (!nodes[a].exits.includes(b)) nodes[a].exits.push(b);
    if (!nodes[b].exits.includes(a)) nodes[b].exits.push(a);
  }

  function usedDirectionKeys(nodes, fromId) {
    const from = nodes[fromId];
    const used = new Set();
    if (!from || !from.pos) return used;
    from.exits.forEach((toId) => {
      const to = nodes[toId];
      const key = directionKeyBetween(from, to);
      if (key) used.add(key);
    });
    return used;
  }

  function directionKeyBetween(from, to) {
    if (!from || !to || !from.pos || !to.pos) return null;
    const dx = sign(to.pos.x - from.pos.x);
    const dy = sign(to.pos.y - from.pos.y);
    const dir = MAP_DIRECTIONS.find((d) => d.dx === dx && d.dy === dy);
    return dir ? dir.key : null;
  }

  function cardinalVector(key) {
    return MAP_DIRECTION_BY_KEY[key] || MAP_DIRECTION_BY_KEY.n;
  }

  function turnFacing(delta) {
    if (!run || run.moving || run.dialogue || run.returnWalk || run.pendingEvent) return;
    const i = CARDINAL_DIRECTIONS.indexOf(run.facing || 'n');
    run.facing = CARDINAL_DIRECTIONS[(i + delta + CARDINAL_DIRECTIONS.length) % CARDINAL_DIRECTIONS.length];
    run.lastAction = `${FACING_LABELS[run.facing]}으로 조명을 돌렸다.`;
    log(run.lastAction);
    render();
  }

  function directionScore(from, to, facingKey) {
    if (!from || !to || !from.pos || !to.pos) return -Infinity;
    const f = cardinalVector(facingKey || (run && run.facing) || 'n');
    const dx = sign(to.pos.x - from.pos.x);
    const dy = sign(to.pos.y - from.pos.y);
    return dx * f.dx + dy * f.dy;
  }

  function relativeExit(rel) {
    if (!run || !run.floorMap) return null;
    const node = currentNode();
    if (!node || !node.pos) return null;
    const f = cardinalVector(run.facing || 'n');
    const desired = {
      front: { dx: f.dx, dy: f.dy },
      back: { dx: -f.dx, dy: -f.dy },
      left: { dx: f.dy, dy: -f.dx },
      right: { dx: -f.dy, dy: f.dx },
    }[rel];
    if (!desired) return null;
    return node.exits.find((id) => {
      const to = nodeById(id);
      if (!to || !to.pos) return false;
      return (to.pos.x - node.pos.x) === desired.dx && (to.pos.y - node.pos.y) === desired.dy;
    }) ?? null;
  }

  function visibleStalkerInLight() {
    if (!run || !run.floorMap || effectiveLightPercent() <= 0) return false;
    const s = stalker();
    if (!s || !stalkerAwake()) return false;
    const node = currentNode();
    const target = nodeById(s.nodeId);
    if (!node || !target || !node.pos || !target.pos) return false;
    const dist = bfs(run.floorMap.nodes, run.currentNodeId)[s.nodeId];
    if (!Number.isFinite(dist) || dist > 3) return false;
    return directionScore(node, target, run.facing) > 0.35;
  }

  function currentRoomHasCover() {
    const node = currentNode();
    return !!node && ['storage', 'office', 'watchpost', 'door'].includes(node.kind);
  }

  function roomPropLabel(node) {
    if (!node) return '';
    return {
      office: '찌그러진 캐비닛',
      watchpost: '꺼진 감시 단말',
      storage: '낮은 사물함',
      door: '비상등 문틀',
      hall: '무너진 잔해',
      vent: '낮은 환풍구',
      crack: '젖은 균열',
      'missing-trace': '벽에 붙은 사진',
      corridor: '긴 복도',
      stairs: '아래 계단',
      entry: '입구 표식',
    }[node.kind] || '';
  }

  function toggleMinimapMode() {
    meta.minimapMode = meta.minimapMode === 'fixed' ? 'rotate' : 'fixed';
    saveMeta();
    render();
  }

  function placeNeighbor(nodes, fromId, toId, preferred = []) {
    const from = nodes[fromId];
    const to = nodes[toId];
    if (!from || !to || !from.pos || to.pos) return;
    const occupied = new Set(nodes.filter((n) => n.pos).map((n) => posKey(n.pos)));
    const used = usedDirectionKeys(nodes, fromId);
    const choices = preferred.concat(MAP_DIRECTION_ORDER).filter((key, index, arr) => arr.indexOf(key) === index);
    let fallback = null;
    for (const key of choices) {
      const dir = MAP_DIRECTION_BY_KEY[key];
      if (!dir || used.has(key)) continue;
      for (let radius = 1; radius <= 3; radius++) {
        const pos = { x: from.pos.x + dir.dx * radius, y: from.pos.y + dir.dy * radius };
        if (!fallback) fallback = pos;
        if (!occupied.has(posKey(pos))) { to.pos = pos; return; }
      }
    }
    if (fallback) { to.pos = fallback; return; }
    // Extremely small maps should not exhaust eight directions, but keep a safe fallback.
    to.pos = { x: from.pos.x + 1, y: from.pos.y };
  }

  function addPositionedEdge(nodes, a, b, preferred = []) {
    if (a === b) return;
    if (nodes[a].pos && !nodes[b].pos) placeNeighbor(nodes, a, b, preferred);
    else if (nodes[b].pos && !nodes[a].pos) {
      const reverse = preferred.map((key) => {
        const dir = MAP_DIRECTION_BY_KEY[key];
        const rev = dir && MAP_DIRECTIONS.find((d) => d.dx === -dir.dx && d.dy === -dir.dy);
        return rev ? rev.key : key;
      });
      placeNeighbor(nodes, b, a, reverse);
    }
    addEdge(nodes, a, b);
  }

  function canAddVisibleDirectionEdge(nodes, a, b) {
    if (a === b || nodes[a].exits.includes(b) || !nodes[a].pos || !nodes[b].pos) return false;
    const ak = directionKeyBetween(nodes[a], nodes[b]);
    const bk = directionKeyBetween(nodes[b], nodes[a]);
    return !!ak && !!bk && !usedDirectionKeys(nodes, a).has(ak) && !usedDirectionKeys(nodes, b).has(bk);
  }

  function applyKind(node, kind) {
    node.kind = kind.key;
    node.label = kind.label;
    node.desc = kind.desc;
    node.style = kind.style;
    node.light = kind.light;
    node.danger = kind.danger;
  }

  // 무방향 그래프에서 start로부터의 거리(없는 노드는 Infinity).
  function bfs(nodes, start) {
    const dist = nodes.map(() => Infinity);
    dist[start] = 0;
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      nodes[cur].exits.forEach((nb) => {
        if (dist[nb] === Infinity) { dist[nb] = dist[cur] + 1; queue.push(nb); }
      });
    }
    return dist;
  }

  // 추격자 초기 배치: 입구에서 BFS 거리가 '가장 먼' 비입구/비계단 노드에 둔다(거리 우선).
  // 최대 거리가 여럿이면 막다른 곳(차수 <= 2)을 선호하되, 거리가 항상 1순위다.
  // 시작은 잠든 상태(lastHeardId 없음, quietSteps = DORMANT_AFTER, stepCounter 0).
  function seedStalker(nodes, entryId, stairsId, floor) {
    const dist = bfs(nodes, entryId);
    let best = -1, bestD = -1, bestSlim = false;
    for (let i = 0; i < nodes.length; i++) {
      if (i === entryId || i === stairsId) continue;
      if (dist[i] === Infinity) continue; // 도달 불가한 노드는 제외
      const d = dist[i];
      const slim = nodes[i].exits.length <= 2;
      // 거리가 더 멀면 무조건 교체, 동률이면 막다른 곳을 우선.
      if (d > bestD || (d === bestD && slim && !bestSlim)) { bestD = d; best = i; bestSlim = slim; }
    }
    if (best < 0) {
      // 도달 가능한 대안이 없을 때만 임의의 비입구/비계단 노드로, 그마저 없으면 입구.
      const cand = [];
      for (let i = 0; i < nodes.length; i++) if (i !== entryId && i !== stairsId) cand.push(i);
      best = cand.length ? cand[Math.floor(Math.random() * cand.length)] : entryId;
    }
    const kind = monsterKindForEvent('stalk', floor, nodes[best]);
    return { nodeId: best, kind, lastHeardId: null, quietSteps: DORMANT_AFTER, stepCounter: 0, nearCued: false };
  }

  /* --- 추격자 조작 헬퍼(그래프 헬퍼 위에 얹는 얇은 층) --- */

  // 현재 층의 추격자 상태(없으면 null).
  function stalker() {
    return run && run.floorMap ? run.floorMap.stalker : null;
  }

  // 추격자가 깨어(추격 중) 있는가. 조용한 걸음이 DORMANT_AFTER 이상 쌓이면 잠든다.
  function stalkerAwake() {
    const s = stalker();
    return !!s && s.quietSteps < DORMANT_AFTER;
  }

  // 플레이어 현재 노드와 추격자 사이의 그래프 거리(엣지 수). 도달 불가면 Infinity.
  function stalkerDistance() {
    const s = stalker();
    if (!s || !run || !run.floorMap) return Infinity;
    const dist = bfs(run.floorMap.nodes, run.currentNodeId);
    const d = dist[s.nodeId];
    return d == null ? Infinity : d;
  }

  // from에서 to로 가는 최단경로의 다음 한 칸. 같은 곳이거나 도달 불가면 null.
  function pathNextStep(from, to) {
    if (from === to || !run || !run.floorMap) return null;
    const nodes = run.floorMap.nodes;
    const dist = bfs(nodes, to); // 목적지에서 역으로 재서 from의 이웃 중 가장 가까운 칸을 고른다.
    if (dist[from] === Infinity) return null;
    let best = null, bestD = Infinity;
    nodes[from].exits.forEach((nb) => {
      if (dist[nb] < bestD) { bestD = dist[nb]; best = nb; }
    });
    return best;
  }

  // 추격자를 한 칸 이동시킨다. 깨어 있으면 마지막으로 들린 소음(없으면 플레이어) 쪽으로,
  // 잠들어 있으면 아주 가끔 인접 칸으로 배회한다. silent면 접근 큐를 남기지 않는다.
  function moveStalkerOneStep(opts) {
    const s = stalker();
    if (!s || !run || !run.floorMap) return;
    const nodes = run.floorMap.nodes;
    const awake = stalkerAwake();
    let next = null;
    if (awake) {
      const target = s.lastHeardId != null ? s.lastHeardId : run.currentNodeId;
      next = pathNextStep(s.nodeId, target);
    } else if (Math.random() < DORMANT_WANDER_CHANCE) {
      // 잠든 채로 플레이어 칸에 슬며시 올라앉지 않도록, 대안이 있으면 현재 플레이어 노드는 피한다.
      const exits = nodes[s.nodeId].exits;
      const avail = exits.filter((nb) => nb !== run.currentNodeId);
      const pool = avail.length ? avail : exits;
      if (pool.length) next = pool[Math.floor(Math.random() * pool.length)];
    }
    if (next == null) return;
    s.nodeId = next;
    // 바로 옆까지 붙으면 한 번만 짧은 큐를 남긴다(소리 없는 이동은 제외).
    const silent = !!(opts && opts.silent);
    if (!silent && awake) {
      const d = stalkerDistance();
      if (d > 0 && d <= 1) {
        if (!s.nearCued) { const cue = stalkerCue(); if (cue) log(cue, 'hot'); s.nearCued = true; }
      } else {
        s.nearCued = false;
      }
    }
  }

  // 플레이어가 소음을 냈다: 추격자를 깨우고 마지막 소음 위치를 기록한다.
  // loud면 큰 소리이므로 즉시 한 칸 끌어당긴다. 두 번째 인자는 {loud} 또는 boolean.
  function emitNoise(nodeId, opts) {
    const s = stalker();
    if (!s) return;
    const loud = opts === true || (opts && opts.loud);
    s.lastHeardId = nodeId != null ? nodeId : run.currentNodeId;
    s.quietSteps = 0;
    run.chasing = true;
    if (loud) moveStalkerOneStep({ silent: true });
    // 새로 들린 소음은 이동 주기를 처음부터 다시 센다. 잠든 동안 쌓인 stepCounter를
    // 그대로 두면 다음 틱에 곧바로 한 칸 움직여 조심히 주운 뒤에도 즉시 조우가 열린다.
    // 큰 소리의 즉시 한 걸음 뒤에도 리셋해 그다음 예약 이동이 바로 오지 않게 한다.
    s.stepCounter = 0;
  }

  function pickupNoiseLevel(item, muffled) {
    const noise = itemNoise(item);
    if (!muffled) return noise;
    if (noise === 'high') return 'medium';
    if (noise === 'medium') return 'low';
    return noise;
  }

  // 집기 소음 처리: 젖은 살갗은 실제 추격 압박에서만 소음을 한 단계 낮춘다.
  function applyPickupNoise(nodeId, item, cautious) {
    const noise = pickupNoiseLevel(item, hasMutation('muffled-skin'));
    const loud = !cautious && noise !== 'low';
    emitNoise(nodeId, { loud });
    if (cautious && noise === 'high') {
      // emitNoise가 방금 추격자를 깨웠으므로(quietSteps=0) 여기서 stalkerAwake는 항상 참 —
      // 다시 확인하지 않는다. 두 칸 이상 떨어져 있을 때만 소리 없이 한 칸 좁힌다.
      // 붙어 있을 때(dist<=1)는 좁히지 않으므로 조심히 주웠는데 즉살당하는 일은 없다.
      if (stalkerDistance() > 1) moveStalkerOneStep({ silent: true });
      return '금속이 부딪치는 둔탁한 소리가 어둠에 퍼졌다.';
    }
    return '';
  }

  // 위기 탈출 성공 뒤: 추격자를 플레이어에게서 minDist 엣지 이상 떨어뜨린다.
  function teleportStalkerAway(minDist) {
    const s = stalker();
    if (!s || !run || !run.floorMap) return;
    const min = minDist == null ? 2 : minDist;
    const nodes = run.floorMap.nodes;
    const dist = bfs(nodes, run.currentNodeId);
    const far = [];
    let bestId = s.nodeId, bestD = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (i === run.currentNodeId) continue;
      const d = dist[i] === Infinity ? -1 : dist[i];
      if (d >= min) far.push(i);
      if (d > bestD) { bestD = d; bestId = i; }
    }
    s.nodeId = far.length ? far[Math.floor(Math.random() * far.length)] : bestId;
    s.nearCued = false;
  }

  // 플레이어 → 추격자 방향의 한글 방향 라벨(앞/뒤/왼쪽 앞 …). 없으면 ''.
  function stalkerDirectionLabel() {
    const s = stalker();
    if (!s || !run || !run.floorMap) return '';
    const step = pathNextStep(run.currentNodeId, s.nodeId);
    if (step == null) return '';
    return dirLabelForKey(directionKeyBetween(currentNode(), nodeById(step)));
  }

  // 추격자가 깨어 가까이(거리 ≤2) 있을 때만 의미 있는, 숫자 없는 방향 큐.
  function stalkerCue() {
    const s = stalker();
    if (!s || !stalkerAwake()) return '';
    const d = stalkerDistance();
    if (d > 2) return '';
    const label = stalkerDirectionLabel();
    const from = label ? directionSourceLabel(label) : '가까운 어둠';
    return d <= 1
      ? `${from}에서 젖은 숨소리가 가까이 붙었다.`
      : `${from}에서 물 밟는 소리가 가까워진다.`;
  }

  // 깨어 가까이(거리 ≤2) 붙은 추격자 쪽으로 향하는 현재 노드의 출구 이웃 id.
  // 이동 패드에서 그 출구만 조용히 표시하기 위한 값이며, 정확한 위치는 드러내지 않는다.
  // 조건이 안 맞거나 다음 걸음이 실제 출구가 아니면 null.
  function stalkerTowardExit() {
    const s = stalker();
    if (!s || !run || !run.floorMap || !stalkerAwake()) return null;
    if (stalkerDistance() > 2) return null;
    const step = pathNextStep(run.currentNodeId, s.nodeId);
    if (step == null) return null;
    return currentNode().exits.includes(step) ? step : null;
  }

  // 미끼/버린 물건을 둘 인접 칸 하나를 고른다: 추격자 쪽이 아닌 출구를 우선하고,
  // 계단은 피한다(그쪽에 두면 되찾으러 갈 수 없다). 출구가 없으면 현재 칸.
  function baitAdjacentNodeId() {
    if (!run || !run.floorMap) return run ? run.currentNodeId : 0;
    const exits = currentNode().exits;
    if (!exits.length) return run.currentNodeId;
    const s = stalker();
    const toward = s ? pathNextStep(run.currentNodeId, s.nodeId) : null;
    const stairsId = run.floorMap.stairsId;
    let pool = exits.filter((id) => id !== toward && id !== stairsId);
    if (!pool.length) pool = exits.filter((id) => id !== stairsId);
    if (!pool.length) pool = exits;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // 미끼를 던져 추격자의 관심을 인접한 칸으로 돌린다(가능할 때).
  function divertStalkerToAdjacent() {
    const s = stalker();
    if (!s || !run || !run.floorMap) return;
    if (!currentNode().exits.length) return;
    s.lastHeardId = baitAdjacentNodeId();
    s.nearCued = false;
  }

  function droppedLoots() {
    if (!run || !run.floorMap) return [];
    if (!Array.isArray(run.floorMap.droppedLoot)) {
      run.floorMap.droppedLoot = run.floorMap.droppedLoot ? [run.floorMap.droppedLoot] : [];
    }
    return run.floorMap.droppedLoot;
  }

  function smokeCloneItem(item) {
    return item && typeof item === 'object' ? { ...item } : item;
  }

  function smokeCloneLoot(loot) {
    return loot && typeof loot === 'object'
      ? { ...loot, item: smokeCloneItem(loot.item) }
      : loot;
  }

  // 헤드리스 QA용 순수 가방/바닥 자국 시뮬레이터. 실제 브라우저 런 상태나 무작위 id에는 손대지 않는다.
  function createBagDropReclaimSmokeState(options = {}) {
    const bag = Array.isArray(options.bag) ? options.bag.map(smokeCloneItem) : [];
    const droppedLoot = Array.isArray(options.droppedLoot) ? options.droppedLoot.map(smokeCloneLoot) : [];
    return {
      cap: Math.max(0, Math.floor(Number(options.cap)) || 0),
      currentNodeId: Math.max(0, Math.floor(Number(options.currentNodeId)) || 0),
      bag,
      droppedLoot,
      nextLootSerial: Math.max(0, Math.floor(Number(options.nextLootSerial)) || 0),
    };
  }

  function smokeUsedSlots(state) {
    if (!state || !Array.isArray(state.bag)) return 0;
    return state.bag.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item && item.slots)) || 0), 0);
  }

  function smokeRoomFor(state, item) {
    const slots = Math.max(0, Math.floor(Number(item && item.slots)) || 0);
    return Math.max(0, Math.floor(Number(state && state.cap)) || 0) - smokeUsedSlots(state) >= slots;
  }

  function smokeDropBagItem(state, index, nodeId = state && state.currentNodeId) {
    const next = createBagDropReclaimSmokeState(state);
    const itemIndex = safeInt(index, -1, 0, next.bag.length - 1);
    if (itemIndex < 0) return { ok: false, reason: 'missing-item', state: next };
    const item = next.bag.splice(itemIndex, 1)[0];
    const serial = next.nextLootSerial;
    next.nextLootSerial += 1;
    const safeNodeId = Math.max(0, Math.floor(Number(nodeId)) || 0);
    const loot = {
      id: `smoke-loot-${safeNodeId}-${serial}`,
      nodeId: safeNodeId,
      item,
      ticks: 0,
      broken: itemFragile(item),
      source: 'manual',
    };
    next.droppedLoot.push(loot);
    return { ok: true, state: next, loot, usedSlots: smokeUsedSlots(next), freeSlots: Math.max(0, next.cap - smokeUsedSlots(next)) };
  }

  function smokeReclaimDroppedLoot(state, lootId) {
    const next = createBagDropReclaimSmokeState(state);
    const lootIndex = next.droppedLoot.findIndex((loot) => loot && loot.id === lootId);
    if (lootIndex < 0) return { ok: false, reason: 'missing-loot', state: next };
    const loot = next.droppedLoot[lootIndex];
    if (!smokeRoomFor(next, loot.item)) {
      return { ok: false, reason: 'no-capacity', state: next, loot };
    }
    next.droppedLoot.splice(lootIndex, 1);
    next.bag.push(loot.item);
    return { ok: true, state: next, loot, usedSlots: smokeUsedSlots(next), freeSlots: Math.max(0, next.cap - smokeUsedSlots(next)) };
  }

  function smokeDroppedLootChoices(state, nodeId = state && state.currentNodeId) {
    const safeNodeId = Math.max(0, Math.floor(Number(nodeId)) || 0);
    const loots = (state && Array.isArray(state.droppedLoot) ? state.droppedLoot : [])
      .filter((loot) => loot && loot.nodeId === safeNodeId);
    const choices = loots.slice(0, 4).map((loot) => ({
      id: `take-back:${loot.id}`,
      label: `${loot.item.name} 챙기기`,
      sub: `${loot.item.slots}칸${loot.broken ? ' · 깨짐' : ''}`,
      tone: 'good',
    }));
    if (loots.length > 4) choices.push({ id: 'list-more', label: '나머지는 둔다', sub: `남은 짐 ${loots.length - 4}개는 다음에 정리한다` });
    choices.push({ id: 'leave', label: '그냥 둔다', sub: '두고 물러난다' });
    return choices;
  }

  function addDroppedLoot(item, nodeId, options = {}) {
    if (!run || !run.floorMap || !item || nodeId == null) return null;
    const loot = {
      id: `loot-${Date.now().toString(36)}-${Math.floor(Math.random() * 100000).toString(36)}`,
      nodeId,
      item,
      ticks: 0,
      broken: itemFragile(item) || !!options.broken,
      source: options.source || 'drop',
    };
    droppedLoots().push(loot);
    return loot;
  }

  function removeDroppedLoot(loot) {
    if (!run || !run.floorMap || !loot) return;
    run.floorMap.droppedLoot = droppedLoots().filter((entry) => entry !== loot && entry.id !== loot.id);
  }

  // 끌개 v2: 버린 물건 여러 개를 각 칸 바닥 자국으로 둔다. 추격자는 가까운 물건도 되찾으러 간다.
  function dropLootTrace(item) {
    if (!run || !run.floorMap || !item) return null;
    const nodeId = baitAdjacentNodeId();
    const loot = addDroppedLoot(item, nodeId, { source: 'bait' });
    const s = stalker();
    if (s) {
      s.lastHeardId = nodeId;
      s.quietSteps = 0;   // 깨워서 회수하러 오게 한다
      s.stepCounter = 0;  // 새 목표이므로 이동 주기를 처음부터
      s.nearCued = false;
    }
    return loot;
  }

  // 가방에서 직접 꺼내 놓은 물건은 현재 칸 바닥에 둔다. 물건을 바꿔 담기 위한 정리 동작이다.
  function dropLootHere(item) {
    if (!run || !run.floorMap || !item) return null;
    const nodeId = run.currentNodeId;
    const loot = addDroppedLoot(item, nodeId, { source: 'manual' });
    const s = stalker();
    if (s && stalkerAwake()) {
      s.lastHeardId = nodeId;
      s.nearCued = false;
    }
    return loot;
  }

  // 끌개 회수 판정(틱마다): 추격자가 버린 물건 칸에 닿거나, 깨어 가까이서 유예가 다하면 거둬 간다.
  function maybeRetrieveDroppedLoot() {
    const loots = droppedLoots();
    if (!loots.length) return;
    const s = stalker();
    if (!s) return;
    for (const loot of [...loots]) {
      loot.ticks += 1;
      const reached = s.nodeId === loot.nodeId;
      let grace = false;
      if (!reached && loot.ticks >= LOOT_RETRIEVE_TICKS && stalkerAwake()) {
        const d = bfs(run.floorMap.nodes, loot.nodeId)[s.nodeId];
        grace = d != null && d <= 1;
      }
      if (!reached && !grace) continue;
      removeDroppedLoot(loot);
      const item = loot.item;
      const obj = `${item.name}${objectParticle(item.name)}`;
      const line = loot.broken
        ? `깨진 채 버린 ${obj}, 어둠이 조각째 훑어 가는 소리가 났다.`
        : `버리고 온 ${obj}, 어둠 저편에서 다시 끌어가는 소리가 났다.`;
      const nearDist = bfs(run.floorMap.nodes, run.currentNodeId)[loot.nodeId];
      const near = nearDist != null && nearDist <= 1;
      log(line, near ? 'hot' : undefined);
      if (near) run.lastAction = line;
    }
  }

  function adjacentGridPairs(nodes, blockedId = -1) {
    const pairs = [];
    const byPos = new Map(nodes.filter((n) => n.pos).map((n) => [posKey(n.pos), n.id]));
    nodes.forEach((node) => {
      if (!node.pos || node.id === blockedId) return;
      MAP_DIRECTIONS.forEach((dir) => {
        const other = byPos.get(posKey({ x: node.pos.x + dir.dx, y: node.pos.y + dir.dy }));
        if (other == null || other <= node.id || other === blockedId || node.exits.includes(other)) return;
        pairs.push([node.id, other]);
      });
    });
    return pairs;
  }

  function freeGridDirections(nodes, nodeId) {
    const node = nodes[nodeId];
    if (!node || !node.pos) return [];
    const occupied = new Set(nodes.filter((n) => n.pos).map((n) => posKey(n.pos)));
    return MAP_DIRECTIONS.filter((dir) => !occupied.has(posKey({ x: node.pos.x + dir.dx, y: node.pos.y + dir.dy })));
  }

  // 각 층 진입 시 9~12개 방을 블럭형 격자로 만든다.
  // - 모든 방은 동서남북으로만 붙는다. 대각선/비스듬한 길은 만들지 않는다.
  // - 0번은 입구. 가장 먼 잎 노드는 계단(다음 층 입구)으로 둔다(마지막 층 제외).
  function generateFloorMap(floor) {
    const isLast = floor >= FLOORS.length;
    const count = 9 + Math.floor(Math.random() * 4); // 9..12
    const nodes = [];
    for (let i = 0; i < count; i++) {
      nodes.push({
        id: i, exits: [], pos: null, kind: null, label: '', desc: '', style: '',
        light: 0, danger: 0, item: null, itemTaken: false,
        monster: null, monsterResolved: false, dangerExit: null, entered: false, roomEventResolved: false,
      });
    }
    nodes[0].pos = { x: 0, y: 0 };

    const placeFrom = (parentId, childId, preferredKeys = []) => {
      const parent = nodes[parentId];
      const free = freeGridDirections(nodes, parentId);
      if (!parent || !parent.pos || !free.length) return false;
      const ordered = preferredKeys
        .map((key) => free.find((dir) => dir.key === key))
        .filter(Boolean)
        .concat(shuffle(free.filter((dir) => !preferredKeys.includes(dir.key))));
      const dir = ordered[0];
      nodes[childId].pos = { x: parent.pos.x + dir.dx, y: parent.pos.y + dir.dy };
      addEdge(nodes, parentId, childId);
      return true;
    };

    // 입구 주변부터 직교 갈림길을 만든다. 화면/미니맵에서 초반 선택지가 블럭처럼 읽히게 한다.
    if (count > 1) placeFrom(0, 1, ['n']);
    if (count > 2) placeFrom(0, 2, ['e', 'w']);

    for (let i = 3; i < count; i++) {
      const placed = nodes.filter((n) => n.pos && freeGridDirections(nodes, n.id).length);
      placed.sort((a, b) => {
        const da = Math.abs(a.pos.x) + Math.abs(a.pos.y);
        const db = Math.abs(b.pos.x) + Math.abs(b.pos.y);
        return (db - da) || (Math.random() < 0.5 ? -1 : 1);
      });
      const parent = placed[Math.floor(Math.random() * Math.min(4, placed.length))] || placed[0];
      if (!parent || !placeFrom(parent.id, i, ['n', 'e', 'w', 's'])) {
        const fallback = nodes.find((n) => n.pos && freeGridDirections(nodes, n.id).length);
        if (fallback) placeFrom(fallback.id, i, MAP_DIRECTION_ORDER);
      }
    }

    // 계단(또는 마지막 층의 가장 깊은 방)은 그래프상 가장 먼 잎을 우선한다.
    const treeDist = bfs(nodes, 0);
    let deepestId = 1;
    for (let i = 1; i < count; i++) {
      const leafBonus = nodes[i].exits.length <= 1 ? 0.25 : 0;
      const cur = (treeDist[i] || 0) + leafBonus;
      const best = (treeDist[deepestId] || 0) + (nodes[deepestId].exits.length <= 1 ? 0.25 : 0);
      if (cur > best) deepestId = i;
    }
    const stairsId = isLast ? -1 : deepestId;

    // 격자에서 붙어 있는 방끼리만 여분 연결을 1~2개 추가한다(계단은 잎으로 보존).
    const extra = 1 + Math.floor(Math.random() * 2);
    const extraCandidates = shuffle(adjacentGridPairs(nodes, stairsId));
    for (let e = 0; e < extra && e < extraCandidates.length; e++) {
      addEdge(nodes, extraCandidates[e][0], extraCandidates[e][1]);
    }

    // 방 유형 배정. 흔한 유형만 기본 풀에 넣고, 감시소 같은 드문 유형은 따로 주입한다.
    applyKind(nodes[0], ENTRY_KIND);
    if (stairsId >= 0) applyKind(nodes[stairsId], STAIRS_KIND);
    const others = [];
    for (let i = 0; i < count; i++) if (i !== 0 && i !== stairsId) others.push(i);
    const pool = shuffle(NODE_KINDS.filter((k) => !k.uncommon));
    others.forEach((id, idx) => applyKind(nodes[id], pool[idx % pool.length]));

    let watchpostId = -1;
    const watchpostKind = NODE_KINDS.find((k) => k.key === 'watchpost');
    if (watchpostKind && others.length && Math.random() < WATCHPOST_SPAWN_CHANCE) {
      watchpostId = others[Math.floor(Math.random() * others.length)];
      applyKind(nodes[watchpostId], watchpostKind);
    }

    let traceId = -1;
    const traceKind = NODE_KINDS.find((k) => k.key === 'missing-trace');
    if (traceKind && others.length && Math.random() < MISSING_TRACE_SPAWN_CHANCE) {
      const traceCandidates = others.filter((id) => id !== watchpostId);
      if (traceCandidates.length) {
        traceId = traceCandidates[Math.floor(Math.random() * traceCandidates.length)];
        applyKind(nodes[traceId], traceKind);
      }
    }

    const itemSlots = shuffle(others.filter((id) => id !== watchpostId && id !== traceId));
    const itemCount = Math.min(itemSlots.length, 2 + (Math.random() < 0.5 ? 1 : 0));
    for (let i = 0; i < itemCount; i++) nodes[itemSlots[i]].item = pickFloorItem(floor, nodes[itemSlots[i]]);

    placeMonsters(nodes, others, stairsId, floor);
    const stalker = seedStalker(nodes, 0, stairsId, floor);

    return { nodes, entryId: 0, stairsId, count, travelledEdges: new Set(), stalker, droppedLoot: [] };
  }

  function monsterKindForEvent(type, floor, node) {
    if (type === 'ambush') return 'doorHand';
    if (type === 'cross') return Math.random() < 0.65 ? 'wetFeet' : 'doorHand';
    if (node && (node.kind === 'door' || node.kind === 'office')) return Math.random() < 0.7 ? 'doorHand' : 'longFace';
    if (node && (node.kind === 'crack' || node.kind === 'hall')) return Math.random() < 0.65 ? 'wetFeet' : 'longFace';
    if (floor <= 1) return Math.random() < 0.7 ? 'longFace' : 'wetFeet';
    return MONSTER_KIND_KEYS[Math.floor(Math.random() * MONSTER_KIND_KEYS.length)];
  }

  // 몬스터 이벤트 3종:
  //  - sight : 직선 끝에서 이상한 기척(위험 상승, 선택은 가능, 그쪽으로 가면 위험 추가)
  //  - cross : 앞 갈림길을 어둠붙이가 지나감(기다리거나 다른 길; 지나가는 중 움직이면 들킴)
  //  - ambush: '움직이면 들킴' 상태(다음 이동 시 위험 급증/추격; 기다리면 완화)
  function placeMonsters(nodes, others, stairsId, floor) {
    if (!others.length) return;
    // 계단 직전 노드(잎인 계단의 유일한 이웃)는 반드시 지나가므로 첫 이벤트를 여기 둔다.
    let gateway = -1;
    if (stairsId >= 0 && nodes[stairsId].exits.length) {
      gateway = nodes[stairsId].exits.find((id) => id !== 0);
      if (gateway === undefined) gateway = nodes[stairsId].exits[0];
    }
    const pool = shuffle(others.slice());
    // 층별 이벤트 구성. 1층은 부드럽게 'sight'만.
    let plan;
    if (floor <= 1) plan = ['sight'];
    else if (floor === 2) plan = Math.random() < 0.7 ? ['sight', 'cross'] : ['sight'];
    else plan = ['cross', 'ambush'];

    const targets = [];
    if (gateway >= 0 && gateway !== 0) targets.push(gateway);
    pool.forEach((id) => { if (!targets.includes(id)) targets.push(id); });

    plan.forEach((type, i) => {
      const id = targets[i % targets.length];
      if (id == null || nodes[id].monster) return;
      nodes[id].monster = { type, kind: monsterKindForEvent(type, floor, nodes[id]) };
      if (type === 'sight') {
        const nb = nodes[id].exits;
        nodes[id].dangerExit = nb.length ? nb[Math.floor(Math.random() * nb.length)] : null;
      }
    });
  }

  /* ---------------- DOM 캐시 ---------------- */

  const el = {};
  const IDS = [
    'screen-start', 'screen-dungeon', 'screen-return', 'screen-upgrade', 'screen-fail', 'screen-ending',
    'btn-enter', 'btn-reset', 'start-art', 'intro-panel', 'intro-line', 'intro-hint', 'enter-fade', 'start-rp', 'start-depth', 'start-susp', 'start-truth-count', 'start-codex', 'start-codex-tail', 'start-contract', 'start-goal',
    'btn-meta', 'meta-panel', 'hud-rp', 'hud-depth', 'hud-bag',
    'floor-num', 'floor-name',
    'light-val', 'light-fill', 'mental-val', 'mental-fill', 'danger-val', 'danger-fill', 'risk-panel', 'risk-chip', 'risk-copy',
    'room-choices', 'dock', 'dock-actions',
    'bag-slots', 'choice-cue', 'mini-map', 'mini-mode', 'recovery-point', 'stage-objects', 'chaser', 'stage', 'stage-situation', 'dialogue-card', 'dialogue-copy', 'depth-rail', 'log',
    'btn-grab', 'btn-drop', 'btn-return',
    'return-list', 'return-susp', 'committee-rp', 'committee-susp', 'black-rp', 'black-susp', 'return-contract',
    'route-choice', 'route-official', 'route-crack', 'route-blackpass', 'route-note',
    'buy-committee', 'buy-black', 'buy-family', 'family-rp', 'family-susp', 'sale-buyer', 'run-summary', 'sale-list', 'sale-gain', 'sale-balance', 'sale-susp', 'truth-news', 'sale-contract', 'street-news', 'return-goal',
    'start-survivors', 'start-mutations',
    'up-bag', 'bag-shop', 'up-light', 'up-weapon', 'btn-again',
    'fail-recovery', 'fail-detail', 'fail-susp', 'btn-retry',
    'ending-truth-count', 'ending-continue', 'ending-reset',
  ];
  function cacheDom() { IDS.forEach((id) => { el[id] = document.getElementById(id); }); }

  const currentNode = () => run && run.floorMap ? run.floorMap.nodes[run.currentNodeId] : null;
  const nodeById = (id) => run && run.floorMap ? run.floorMap.nodes[id] : null;

  function renderGoals() {
    const goal = nextGoal();
    if (el['start-goal']) el['start-goal'].textContent = goal;
    if (el['return-goal']) el['return-goal'].textContent = goal;
  }

  function renderDepthRail() {
    if (!run || !el['depth-rail']) return;
    el['depth-rail'].innerHTML = FLOORS.map((f) => {
      const cls = f.n === run.floor ? 'current' : f.n < run.floor ? 'passed' : 'locked';
      return `<span class="rail-dot ${cls}">${f.n}</span>`;
    }).join('');
  }

  function signed(n) { return n > 0 ? `+${n}` : `${n}`; }

  function contractHtml(contract, result) {
    if (result && result.done) return `<b>의뢰 완료</b> · ${result.title}<span>+${result.reward} RP · 의심도 ${result.suspDelta}</span>`;
    return `<b>오늘의 의뢰</b> · ${contract.title}<span>${contract.desc} · 보수 +${contract.reward} RP</span>`;
  }

  function renderContractCards() {
    const contract = activeContract();
    const pending = contractHtml(contract, null);
    if (el['start-contract']) el['start-contract'].innerHTML = pending;
    if (el['return-contract']) el['return-contract'].innerHTML = pending;
    if (el['sale-contract']) {
      el['sale-contract'].innerHTML = run && run.contractResult ? contractHtml(contract, run.contractResult) : pending;
      el['sale-contract'].classList.toggle('done', !!(run && run.contractResult));
    }
  }

  function makeStreetNews(buyer, quote) {
    if (buyer === 'family') return '거리 소문: 가족에게 돌아간 유품 때문에, 지상 소문이 조금 누그러졌다.';
    const hot = quote.suspDelta > 10 || meta.suspicion >= 55;
    if (buyer === 'black' && hot) return '뉴스: “싱크홀 밀반출 급증”… 검문 드론이 한 블록 가까워졌다.';
    if (buyer === 'black') return '소문: 암시장 매입가가 올랐다. 대신 허가소가 이름을 묻기 시작했다.';
    if (meta.suspicion <= 15) return '공보: 위원회가 “성실 반납자” 명단을 정리 중이다. 아직 조용하다.';
    return '뉴스: 위원회가 일부 반납품을 은폐했다는 제보가 돈다.';
  }

  function resolveContract(buyer) {
    const contract = activeContract();
    const ctx = { buyer, items: run.lastSale, maxFloor: run.maxFloor };
    if (!contract.test(ctx)) { run.contractResult = null; return; }
    meta.rp += contract.reward;
    meta.totalEarned += contract.reward;
    meta.suspicion = Math.max(0, Math.min(99, meta.suspicion + contract.suspDelta));
    run.contractResult = { done: true, title: contract.title, reward: contract.reward, suspDelta: signed(contract.suspDelta) };
    meta.contractIndex += 1;
    saveMeta(); // 의뢰 완료 후 자동 저장
    log(`의뢰 완료: ${contract.title}`, 'win');
  }

  function playDescendFx() {
    if (!el['stage']) return;
    el['stage'].classList.remove('descending');
    void el['stage'].offsetWidth;
    el['stage'].classList.add('descending');
  }

  // 줍기 후 연출: 회수물이 플레이어 쪽으로 빨려 들어가는 짧은 애니메이션.
  function playGrabFx() {
    if (!el['stage']) return;
    el['stage'].classList.remove('grabbing');
    void el['stage'].offsetWidth;
    el['stage'].classList.add('grabbing');
    window.setTimeout(() => { if (el['stage']) el['stage'].classList.remove('grabbing'); }, 460);
  }

  function show(screenId) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    el[screenId].classList.add('active');
  }

  /* ---------------- 로그 ---------------- */

  function log(text, kind) {
    const lines = el['log'].querySelectorAll('.log-line');
    if (lines.length >= 2) lines[0].remove();
    const div = document.createElement('div');
    div.className = 'log-line' + (kind ? ' ' + kind : '');
    div.textContent = text;
    el['log'].appendChild(div);
  }

  function showDialogue(text, tone = '') {
    if (!run || !text) return;
    const copy = cleanSituationText(String(text));
    if (!copy) return;
    const next = { text: copy, tone };
    if (run.dialogue) {
      run.dialogueQueue = run.dialogueQueue || [];
      run.dialogueQueue.push(next);
    } else {
      run.dialogue = next;
    }
  }

  function clearDialogue() {
    if (run) {
      run.dialogue = null;
      run.dialogueQueue = [];
    }
  }

  let suppressDungeonClickUntil = 0;

  function dismissDialogue() {
    if (!run || !run.dialogue) return;
    const queue = run.dialogueQueue || [];
    run.dialogue = queue.shift() || null;
    run.dialogueQueue = queue;
    // 귀환 걷기의 마지막 줄을 넘기면 그제서야 지상으로 나간다(순간이동 대신).
    if (!run.dialogue && run.returnWalk) {
      run.returnWalk = false;
      returnToSurface();
      return;
    }
    render();
  }

  function handleDialogueCardClick(event) {
    if (event) event.stopPropagation();
    dismissDialogue();
  }

  function dungeonDialogueActive() {
    const card = el['dialogue-card'];
    return !!(run && run.dialogue && card && !card.classList.contains('hidden') && el['screen-dungeon'] && el['screen-dungeon'].classList.contains('active'));
  }

  function swallowDungeonEvent(event) {
    if (!event) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  function handleDungeonDialoguePointer(event) {
    if (!dungeonDialogueActive()) return;
    suppressDungeonClickUntil = Date.now() + 450;
    swallowDungeonEvent(event);
    dismissDialogue();
  }

  function handleDungeonDialogueTap(event) {
    if (Date.now() < suppressDungeonClickUntil) {
      swallowDungeonEvent(event);
      return;
    }
    if (!dungeonDialogueActive()) return;
    swallowDungeonEvent(event);
    dismissDialogue();
  }

  function showBagBlockedDialogue() {
    run.seenBagAlerts.add('blocked');
    run.lastAction = `${bagAlert('blocked')} 가방 슬롯을 눌러 짐을 내려놓거나, 이 물건은 그냥 지나가자.`;
    log(run.lastAction, 'hot');
    showDialogue(run.lastAction, 'hot');
  }

  function queueSensoryAlert(text, tone = 'hot') {
    if (!run || !text) return false;
    if (run.pendingEvent || run.moving) return false;
    run.lastAction = text;
    log(text, tone);
    showDialogue(text, tone);
    return true;
  }

  function maybeQueueLightAlert() {
    if (!run || run.pendingEvent || run.moving) return false;
    const pct = lightPercent();
    for (const alert of LIGHT_ALERTS) {
      if (pct <= alert.pct && !run.seenLightAlerts.has(alert.key)) {
        run.seenLightAlerts.add(alert.key);
        return queueSensoryAlert(alert.text, 'hot');
      }
    }
    return false;
  }

  function maybeQueueMentalAlert() {
    if (!run || run.pendingEvent || run.moving || run.mental <= 0) return false;
    for (const alert of MENTAL_ALERTS) {
      if (run.mental <= alert.value && !run.seenMentalAlerts.has(alert.key)) {
        run.seenMentalAlerts.add(alert.key);
        return queueSensoryAlert(alert.text, alert.value <= 15 ? 'hot' : '');
      }
    }
    return false;
  }

  function maybeQueueBagAlert() {
    if (!run || run.pendingEvent || run.moving) return false;
    const slots = usedSlots();
    const cap = bagCap();
    if (slots >= cap && !run.seenBagAlerts.has('full')) {
      run.seenBagAlerts.add('full');
      return queueSensoryAlert(bagAlert('full'), 'hot');
    }
    if (slots >= Math.max(1, cap - 1) && !run.seenBagAlerts.has('heavy')) {
      run.seenBagAlerts.add('heavy');
      return queueSensoryAlert(BAG_ALERTS.heavy, 'hot');
    }
    return false;
  }

  function maybeQueueRunAlerts() {
    if (!run || run.dialogue || run.pendingEvent || run.moving) return false;
    return maybeQueueLightAlert() || maybeQueueMentalAlert() || maybeQueueBagAlert();
  }

  function maybeQueueExtractionTutorial() {
    if (!run || meta.extractionCueSeen) return false;
    meta.extractionCueSeen = true;
    saveMeta();
    return queueSensoryAlert(EXTRACTION_TUTORIAL_CUE, '');
  }

  /* ---------------- 틱 루프 ---------------- */

  function startTick() { stopTick(); timer = setInterval(tick, TICK_MS); }
  function stopTick()  { if (timer) { clearInterval(timer); timer = null; } }

  function tick() {
    if (!run) return;
    const liveEncounter = run.pendingEvent && run.pendingEvent.type === 'monster-encounter';
    if (liveEncounter) {
      run.encounterTime = Math.max(0, (run.encounterTime || 0) - TICK_MS / 1000);
      if (run.encounterTime <= 0) {
        run.failContext = '어두운 형체가 조명 안으로 끝까지 걸어 들어왔다.';
        log('어두운 형체가 바로 앞까지 왔다.', 'hot');
        failRun();
        return;
      }
    } else if (run.dialogue) {
      render();
      return;
    }

    // 조명은 켜 둔 동안 천천히 닳는다. 꺼두면 배터리는 아끼지만 시야/멘탈 압박이 커진다.
    if (run.lightOn !== false) run.light = Math.max(0, run.light - FLOORS[run.floor - 1].drain);

    updateMentalByLight();
    if (run.mentalGraceTicks > 0) run.mentalGraceTicks -= 1;
    if (maybeTriggerMentalBreak()) return;
    if (maybeQueueRunAlerts()) { render(); return; }

    // 어둠붙이를 정면으로 마주친 위기 선택 중에는 먼저 한 번 대응하게 두고,
    // 선택 없이 틱으로 바로 실패시키지 않는다.
    const pausingEventOpen = run.pendingEvent && (run.pendingEvent.type === 'monster-encounter' || run.pendingEvent.type === 'return-attempt');

    // 숨은 추격자를 주기적으로 한 칸 움직인다. 대사/이벤트/이동 연출 중에는 멈춘다.
    const s = stalker();
    if (s && !run.pendingEvent && !run.dialogue && !run.moving) {
      s.stepCounter += 1;
      if (s.stepCounter >= stalkerStepTicks(run.floor)) {
        s.stepCounter = 0;
        const wasAwake = stalkerAwake(); // 이동 직전의 상태: 추격(노이즈 추적) 걸음인지 잠든 배회인지 가른다.
        moveStalkerOneStep();
        // 추격 중이던 걸음이 플레이어 칸에 올라앉으면 quietSteps로 잠들기 전에 즉시 조우시킨다.
        // (잠든 배회는 대안이 있으면 플레이어 칸을 피하므로 여기서 불공정한 무음 접촉을 만들지 않는다.)
        if (wasAwake && s.nodeId === run.currentNodeId && !run.pendingEvent) {
          if (startMonsterEncounter('critical', currentNode(), s.kind)) return;
          failRun();
          return;
        }
        s.quietSteps += 1; // 새 소음이 없으면 조용한 걸음이 쌓여 결국 다시 잠든다.
      }
      // 끌개: 버린 물건 자국이 있으면 매 틱 유예를 세고, 놈이 닿으면 거둬 간다.
      maybeRetrieveDroppedLoot();
    }

    // 추격 여부는 추격자가 깨어 있는지로만 결정한다.
    run.chasing = stalkerAwake();

    // 조명 정면에 깨어 있는 어두운 형체가 잡히면, 접촉 전에도 짧은 실시간 조우를 연다.
    if (!pausingEventOpen && run.chasing && visibleStalkerInLight() && stalkerDistance() <= 2) {
      if (startMonsterEncounter('sight', currentNode(), s && s.kind)) return;
    }

    // 위험은 추격자와의 거리로만 오르내린다: 멀면 0, 붙으면(거리 0) 조우.
    if (!pausingEventOpen) {
      const dist = stalkerDistance();
      if (run.chasing && dist <= 0) {
        if (startMonsterEncounter('critical', currentNode(), s && s.kind)) return;
        failRun();
        return;
      }
      let target = dist >= 4 ? 0 : dist === 3 ? 30 : dist === 2 ? 55 : dist === 1 ? 80 : 100;
      if (!run.chasing) target = Math.min(target, DORMANT_DANGER_CAP); // 잠들었으면 가까워도 낮게 묶는다.
      // 목표치로 이징: 오를 땐 빠르게, 내릴 땐 느리게.
      if (run.danger < target) run.danger = Math.min(100, run.danger + (target - run.danger) * DANGER_RISE);
      else run.danger = Math.max(0, run.danger - (run.danger - target) * DANGER_DECAY);

      if (run.danger >= 100) {
        if (startMonsterEncounter('critical', currentNode(), s && s.kind)) return;
        failRun();
        return;
      }
    }
    if (maybeQueueRunAlerts()) { render(); return; }
    render();
  }

  function updateMentalByLight(extra = 1) {
    if (!run) return;
    if (run.mentalGraceTicks > 0) return;
    const pct = effectiveLightPercent();
    let delta;
    if (pct >= 75) delta = 0.025;
    else if (pct >= 45) delta = -0.015;
    else if (pct >= 20) delta = -0.075;
    else if (pct > 0) delta = -0.16;
    else delta = -0.33;
    run.mental = clamp(run.mental + delta * extra, 0, 100);
  }

  function maybeTriggerMentalBreak() {
    if (!run || run.mental > 0 || run.mentalGraceTicks > 0 || run.pendingEvent || run.moving) return false;
    const outcome = MENTAL_BREAK_EVENTS[Math.floor(Math.random() * MENTAL_BREAK_EVENTS.length)];
    run.mentalEventCount += 1;
    run.lastMentalLoss = null;
    run.pendingEvent = {
      type: 'mental-break',
      title: outcome.title,
      cue: outcome.cue,
      outcome,
      choices: [eventChoice('recover', outcome.choice, outcome.sub, 'danger')],
    };
    run.lastAction = outcome.cue;
    log(`${outcome.title}: ${outcome.cue}`, 'hot');
    render();
    return true;
  }

  /* ---------------- 런 진행 액션 ---------------- */

  // 최고 깊이를 갱신하고, 실제로 늘었을 때만 저장한다.
  function bumpMaxDepth(floor) {
    if (floor > meta.maxDepth) { meta.maxDepth = floor; saveMeta(); }
  }

  // 새 층의 맵을 만들고 입구에 선다.
  function enterFloor(floor) {
    run.floorMap = generateFloorMap(floor);
    run.currentNodeId = run.floorMap.entryId;
    run.facing = directionKeyBetween(run.floorMap.nodes[run.floorMap.entryId], nodeById(run.floorMap.nodes[run.floorMap.entryId].exits[0])) || 'n';
    run.holdEvent = null;
    const entry = currentNode();
    entry.entered = true; // 입구 환경 효과는 없음
    run.currentItem = entry.item && !entry.itemTaken ? entry.item : null;
    const f = FLOORS[floor - 1];
    run.lastAction = `${f.n}층 진입. ${FLOOR_OPEN_CUE[floor - 1] || ''}`.trim();
    log(`${f.n}층. ${FLOOR_OPEN_CUE[floor - 1] || ''}`);
    showDialogue(run.lastAction);
    if (floor === 1) maybeQueueExtractionTutorial();
  }

  function startNewRun() {
    bagShopOpen = false;
    if (el['log']) el['log'].innerHTML = '<div class="log-line">아래가 열린다.</div>';
    run = newRun();
    bumpMaxDepth(run.floor);
    enterFloor(1);
    setMetaPanel(false);
    show('screen-dungeon');
    render();
    startTick();
  }

  function introSeen() {
    if (!storageOk) return true;
    try {
      return window.localStorage.getItem(INTRO_KEY) === '1' || !!window.localStorage.getItem(SAVE_KEY);
    } catch (e) { return true; }
  }

  function markIntroSeen() {
    if (!storageOk) return;
    try { window.localStorage.setItem(INTRO_KEY, '1'); }
    catch (e) { /* 인트로 저장 실패는 진행을 막지 않는다. */ }
  }

  // 첫 시작 인트로 대사 3줄. 마지막 줄에서는 별도 버튼 없이 화면 탭으로 던전에 들어간다.
  const INTRO_LINES = [
    '살아남기 위해서는 저 곳으로 들어가보는 수밖에 없어',
    '꼭 산다고는 할 수 없지만 어쩔 수 없지 …',
    '들어가보자 ..',
  ];

  function setEnterButton(text, label) {
    if (!el['btn-enter']) return;
    el['btn-enter'].hidden = false;
    el['btn-enter'].disabled = false;
    el['btn-enter'].textContent = text;
    el['btn-enter'].setAttribute('aria-label', label);
  }

  // 현재 introLine 대사를 패널에 그린다. 마지막 줄이면 힌트를 '탭해서 들어가기'로 바꾸고 진입 대기(ready) 상태로 둔다.
  function renderIntroLine() {
    if (el['intro-panel']) el['intro-panel'].hidden = false;
    if (el['intro-line']) el['intro-line'].textContent = INTRO_LINES[introLine] || '';
    const last = introLine >= INTRO_LINES.length - 1;
    if (el['intro-panel']) {
      el['intro-panel'].classList.toggle('done', last);
      el['intro-panel'].setAttribute('aria-label', last ? '탭해서 던전에 들어가기' : '탭해서 다음 이야기 보기');
    }
    if (el['intro-hint']) el['intro-hint'].textContent = last ? '탭해서 들어가기' : '탭해서 계속';
    if (last) introMode = 'ready';
  }

  // 인트로 진행: 대사가 남았으면 다음 줄로, 마지막 줄(ready)에서는 던전 진입 연출을 시작한다.
  function advanceIntro() {
    if (introMode === 'dialogue') {
      if (introLine >= INTRO_LINES.length - 1) return;
      introLine += 1;
      renderIntroLine();
      return;
    }
    if (introMode === 'ready') beginEntering();
  }

  function setupFirstStartIntro() {
    introMode = introSeen() ? 'normal' : 'start';
    introLine = 0;
    if (el['intro-panel']) {
      el['intro-panel'].hidden = true;
      el['intro-panel'].classList.remove('done');
    }
    if (el['intro-line']) el['intro-line'].textContent = '';
    if (el['enter-fade']) {
      el['enter-fade'].hidden = true;
      el['enter-fade'].classList.remove('active');
    }
    if (el['start-art']) el['start-art'].classList.remove('entering');
    setEnterButton(
      introMode === 'start' ? '시작하기' : '들어가기',
      introMode === 'start' ? '첫 시작 인트로 보기' : '던전 들어가기',
    );
  }

  // 던전 진입 연출: 배경이 커지며 화면이 어두워진 뒤 새 런을 시작한다.
  function beginEntering() {
    introMode = 'entering';
    markIntroSeen();
    if (el['btn-enter']) el['btn-enter'].disabled = true;
    if (el['start-art']) el['start-art'].classList.add('entering');
    if (el['enter-fade']) {
      el['enter-fade'].hidden = false;
      void el['enter-fade'].offsetWidth;
      el['enter-fade'].classList.add('active');
    }
    window.setTimeout(() => {
      if (el['start-art']) el['start-art'].classList.remove('entering');
      if (el['enter-fade']) {
        el['enter-fade'].hidden = true;
        el['enter-fade'].classList.remove('active');
      }
      startNewRun();
    }, 1200);
  }

  function handleStartButton(event) {
    if (introMode === 'start') {
      // 첫 시작: 버튼을 숨기고 인트로 대사 첫 줄을 연다. 이후 진행은 화면 어디든 탭.
      // 이 클릭이 화면 탭 핸들러로 버블링돼 곧바로 다음 줄로 넘어가는 이중 진행을 막는다.
      if (event) event.stopPropagation();
      introMode = 'dialogue';
      introLine = 0;
      if (el['btn-enter']) el['btn-enter'].hidden = true;
      renderIntroLine();
      return;
    }
    // 재시작·기존 세이브: '들어가기' 버튼을 그대로 눌러 새 런을 시작한다.
    if (introMode === 'ready') {
      beginEntering();
      return;
    }
    // 진실을 다 모았지만 엔딩을 아직 확인하지 않았다면, 새 런 대신 엔딩을 먼저 보여준다.
    if (meta.truths.length >= TRUTH_TOTAL && !meta.endingSeen) {
      renderEndingScreen();
      show('screen-ending');
      return;
    }
    startNewRun();
  }

  // 시작 화면 어디든 탭하면 인트로를 진행한다(첫 시작 대사·진입 대기 상태에서만).
  function handleStartScreenTap(event) {
    if (introMode !== 'dialogue' && introMode !== 'ready') return;
    if (!el['screen-start'] || !el['screen-start'].classList.contains('active')) return;
    // 자체 동작이 있는 버튼(기록 초기화·진입 버튼) 탭은 인트로를 진행시키지 않는다.
    if (event && event.target && event.target.closest &&
        (event.target.closest('#btn-reset') || event.target.closest('#btn-enter'))) return;
    if (event) event.preventDefault();
    advanceIntro();
  }

  function applyNodeEntryEffects(node) {
    if (!node) return false;
    const firstVisit = !node.entered;
    if (firstVisit) {
      node.entered = true;
      run.roomsEntered += 1;
      if (node.light) run.light = Math.max(0, Math.min(maxLight(), run.light + node.light));
      if (node.danger > 0) run.danger = Math.min(100, run.danger + node.danger);
      else if (node.danger < 0) run.danger = Math.max(0, run.danger + node.danger);
    }
    run.currentItem = node.item && !node.itemTaken ? node.item : null;
    return firstVisit;
  }

  // 노드 도착: 환경 효과 1회 적용 → 아이템 노출 → 몬스터 이벤트 발동.
  function arriveAtNode() {
    const node = currentNode();
    const firstVisit = applyNodeEntryEffects(node);
    maybeStartRoomEvent(node);
    if (run.pendingEvent) {
      // 방 이벤트가 상황(cue)을 이어받는다 — 별도 도착 대사로 끊지 않고 선택지와 함께 보여준다.
      return;
    }
    if (firstVisit) {
      run.lastAction = run.currentItem ? `${run.currentItem.name}${subjectParticle(run.currentItem.name)} 눈에 들어온다.` : '새 구역에 도착했다.';
      if (run.currentItem) log(`${run.currentItem.name}.`, node.style === 'danger' ? 'hot' : undefined);
      showDialogue(run.lastAction, node.style === 'danger' ? 'hot' : '');
    } else {
      // 이미 지나온 구역으로 되돌아옴 — '새 구역 도착' 대사 없이 현재 상황(situationCopy)만 조용히 반영한다.
      run.lastAction = '';
    }
    triggerMonster(node);
  }

  function eventChoice(id, label, sub, tone = '') {
    return { id, label, sub, tone };
  }

  // 헤드리스/브라우저 QA용: 플레이어가 직접 누르는 이벤트 선택지 id/라벨 fixture.
  // 새 정적 eventChoice를 추가하면 scripts/event-choice-smoke.js가 이 allowlist 갱신을 요구한다.
  const KNOWN_PLAYER_CHOICE_FIXTURES = Object.freeze([
    { type: 'monster-archetype', source: 'longFace', choices: Object.freeze([
      { id: 'shine', label: '조명을 정면으로 비추며 물러난다' },
      { id: 'sidestep', label: '옆으로 피하며 달려나간다' },
      { id: 'hold', label: '숨 죽이고 구석으로 숨는다' },
    ]) },
    { type: 'monster-archetype', source: 'wetFeet', choices: Object.freeze([
      { id: 'hold', label: '발을 멈추고 숨을 죽인다' },
      { id: 'bait', label: '미끼를 던지고 반대로 뛴다' },
      { id: 'run', label: '젖은 바닥을 박차고 뛴다' },
    ]) },
    { type: 'monster-archetype', source: 'doorHand', choices: Object.freeze([
      { id: 'strike', label: '손목을 후려치고 빠져나간다' },
      { id: 'kick', label: '문틀을 걷어차고 몸을 뺀다' },
      { id: 'shine', label: '조명을 비추며 손을 떼어낸다' },
      { id: 'run', label: '몸을 비틀어 달아난다' },
    ]) },
    { type: 'mental', source: 'mental-break', choices: Object.freeze([
      { id: 'recover', label: '*' },
      ...MENTAL_BREAK_EVENTS.map((entry) => ({ id: 'recover', label: entry.choice })),
    ]) },
    { type: 'room-event', source: 'survivor', choices: Object.freeze([
      { id: 'rescue', label: '꺼내준다' },
      { id: 'mark', label: '위치만 표시한다' },
      { id: 'pass', label: '그냥 지나간다' },
    ]) },
    { type: 'room-event', source: 'dropped-loot', choices: Object.freeze([
      { id: 'take-back:*', label: '* 챙기기' },
      { id: 'list-more', label: '나머지는 둔다' },
      { id: 'leave', label: '그냥 둔다' },
    ]) },
    { type: 'room-event', source: 'item-encounter', choices: Object.freeze([
      { id: 'careful', label: '조심히 집는다' },
      { id: 'grab', label: '재빨리 챙긴다' },
      { id: 'take-back:*', label: '* 되챙기기' },
      { id: 'skip', label: '그냥 지나간다' },
    ]) },
    { type: 'room-event', source: 'cabinet', choices: Object.freeze([
      { id: 'open', label: '조심히 연다' },
      { id: 'skip', label: '그냥 지나간다' },
      { id: 'noise', label: '소리를 내서 확인한다' },
    ]) },
    { type: 'room-event', source: 'collapsed-passage', choices: Object.freeze([
      { id: 'cross', label: '잔해를 넘어간다' },
      { id: 'low', label: '낮게 돌아간다' },
      { id: 'give-up', label: '포기한다' },
    ]) },
    { type: 'room-event', source: 'watchpost', choices: Object.freeze([
      { id: 'wipe-log', label: '기록을 지운다' },
      { id: 'search', label: '단말을 뒤진다' },
      { id: 'pass', label: '그냥 지나간다' },
      { id: 'seal-code', label: '봉쇄 코드를 넣는다' },
    ]) },
    { type: 'room-event', source: 'missing-trace', choices: Object.freeze([
      { id: 'recover', label: '유품을 챙긴다' },
      { id: 'inspect', label: '사진만 확인한다' },
      { id: 'pass', label: '그냥 지나간다' },
    ]) },
    { type: 'room-event', source: 'footprints', choices: Object.freeze([
      { id: 'hold', label: '숨을 죽인다' },
      { id: 'rush', label: '빠르게 지난다' },
      { id: 'bait', label: '미끼를 던진다' },
    ]) },
    { type: 'room-event', source: 'vent', choices: Object.freeze([
      { id: 'crawl', label: '기어서 통과한다' },
      { id: 'turn', label: '돌아선다' },
    ]) },
    { type: 'room-event', source: 'light-recovery', choices: Object.freeze([
      { id: 'charge', label: '조명에 연결한다' },
      { id: 'wipe', label: '렌즈만 닦는다' },
      { id: 'skip', label: '그냥 둔다' },
    ]) },
    { type: 'monster', source: 'monster-encounter', choices: Object.freeze([
      { id: 'backstep', label: '뒤로 물러난다' },
      { id: 'side-left', label: '왼쪽으로 뛰어든다' },
      { id: 'side-right', label: '오른쪽으로 뛰어든다' },
      { id: 'glare', label: '조명을 고정한다' },
      { id: 'throw-bag', label: '짐을 던진다' },
      { id: 'hide-dark', label: '조명을 끄고 숨는다' },
    ]) },
  ]);

  function collectKnownPlayerChoiceFixtures() {
    return KNOWN_PLAYER_CHOICE_FIXTURES;
  }

  // 인던 물건 힌트: RP·수치는 감추고 '소리가 클 것 같다 / 깨질 것 같다'만 짧게 흘린다.
  function itemTraitHint(item) {
    const bits = [];
    if (itemNoise(item) === 'high') bits.push('금속이 부딪치면 소리가 클 것 같다');
    if (itemFragile(item)) bits.push('모서리가 금 가 있다');
    return bits.join('. ');
  }

  // 물건이 놓인 구역의 조우 큐: 물건과 주변 위협을 한 문장에 함께 묘사한다.
  function itemEncounterCue(node, item) {
    const stat = `${item.slots}칸`;
    let threat;
    if (node.kind === 'crack' || node.style === 'danger') {
      threat = '바로 옆 어둠에서 물 밟는 소리가 얕게 인다. 집으려면 소리를 죽여야 한다.';
    } else if (node.kind === 'hall' || node.kind === 'corridor') {
      threat = '어둠이 낮게 깔렸다. 손을 뻗는 순간의 소리가 마음에 걸린다.';
    } else {
      threat = '주변은 조용하지만, 물건을 드는 순간의 소리가 신경 쓰인다.';
    }
    const hint = itemTraitHint(item);
    const hintPart = hint ? ` ${hint}.` : '';
    return `${item.name}${subjectParticle(item.name)} 발치에 떨어져 있다 — ${stat}.${hintPart} ${threat}`;
  }

  // 끌개: 되찾을 수 있는, 내가 버린 물건이 이 칸에 아직 남아 있는가.
  function droppedLootHere(node) {
    if (!node) return null;
    return droppedLoots().find((loot) => loot.nodeId === node.id) || null;
  }

  function droppedLootCountHere(node) {
    if (!node) return 0;
    return droppedLoots().filter((loot) => loot.nodeId === node.id).length;
  }

  // 생존자 조우: 아직 구출 안 한 사람이 남아 있을 때만, 드물게 이 방에서 열린다.
  // 물건이 없는 방에서만 호출되므로 회수물 이벤트를 밀어내지 않는다. 열면 true.
  function maybeStartSurvivorEvent(node) {
    if (!node || Math.random() >= SURVIVOR_EVENT_CHANCE) return false;
    const id = nextUnrescuedSurvivor();
    if (!id) return false; // 둘 다 구출했으면 이벤트 없음
    const s = SURVIVORS[id];
    node.roomEventResolved = true;
    run.pendingEvent = {
      type: 'survivor',
      survivorId: id,
      title: s.eventTitle,
      cue: s.eventCue,
      node: node.id,
      tone: 'hot',
      choices: [
        eventChoice('rescue', '꺼내준다', s.rescueSub, 'good'),
        eventChoice('mark', '위치만 표시한다', '두고 표시만 남긴다'),
        eventChoice('pass', '그냥 지나간다', '못 본 척 지나친다'),
      ],
    };
    run.lastAction = s.eventCue;
    log(s.eventCue, 'hot');
    return true;
  }

  function maybeStartRoomEvent(node) {
    if (!node) return;
    // 버린 물건은 이미 방 이벤트를 끝낸 칸이라도 다시 집을 수 있어야 하므로 roomEventResolved 앞에서 처리한다.
    const loot = droppedLootHere(node);
    if (loot && !run.currentItem) {
      const loots = droppedLoots().filter((entry) => entry.nodeId === node.id);
      const count = loots.length;
      const first = loots[0];
      const item = first.item;
      const moreHint = count > 1 ? ` 이 칸에 내려놓은 짐이 ${count}개 있다.` : '';
      const brokenHint = first.broken ? ' 모서리가 깨졌지만, 아직 바닥에 걸려 있다.' : '';
      const takeChoices = loots.slice(0, 4).map((entry) => eventChoice(`take-back:${entry.id}`, `${entry.item.name} 챙기기`, `${entry.item.slots}칸${entry.broken ? ' · 깨짐' : ''}`, 'good'));
      if (loots.length > 4) takeChoices.push(eventChoice('list-more', '나머지는 둔다', `남은 짐 ${loots.length - 4}개는 다음에 정리한다`));
      run.pendingEvent = {
        type: 'dropped-loot',
        title: '내려놓은 짐',
        cue: `바닥에 내려놓은 ${item.name}${subjectParticle(item.name)} 보인다.${moreHint}${brokenHint} 필요한 것만 다시 챙길 수 있다.`,
        node: node.id,
        tone: 'hot',
        choices: [
          ...takeChoices,
          eventChoice('leave', '그냥 둔다', '두고 물러난다'),
        ],
      };
      run.lastAction = run.pendingEvent.cue;
      log(run.pendingEvent.cue, 'hot');
      return;
    }
    if (node.roomEventResolved || node.kind === 'entry' || node.kind === 'stairs') return;
    // 생존자 조우 v1: 물건이 없는 방에서만 드물게 연다(물건 이벤트를 밀어내지 않는다).
    if (!run.currentItem && maybeStartSurvivorEvent(node)) return;
    let ev = null;
    if (run.currentItem) {
      // 물건이 보이면 선택지를 '집기/지나치기'로 물건에 묶는다 → 뒤따르는 별도 줍기 버튼이 없다.
      const item = run.currentItem;
      const loots = droppedLoots().filter((entry) => entry.nodeId === node.id).slice(0, 2);
      // 서브라벨을 물건 성질에 맞춘다: 깨질 물건은 조심히, 소리 큰 물건은 재빨리 챙길 때 크게 울린다.
      const carefulSub = itemFragile(item) ? '조용히, 깨지지 않게 다룬다' : '조용하지만 시간이 걸린다';
      const grabSub = itemNoise(item) === 'high' ? '빠르지만 크게 울린다' : '빠르지만 소리가 난다';
      const choices = [
        eventChoice('careful', '조심히 집는다', carefulSub, 'good'),
        eventChoice('grab', '재빨리 챙긴다', grabSub, 'danger'),
        ...loots.map((entry) => eventChoice(`take-back:${entry.id}`, `${entry.item.name} 되챙기기`, `내려놓은 짐 · ${entry.item.slots}칸${entry.broken ? ' · 깨짐' : ''}`, 'good')),
        eventChoice('skip', '그냥 지나간다', '건드리지 않는다'),
      ];
      ev = {
        type: 'item-encounter',
        title: '눈앞의 회수물',
        cue: itemEncounterCue(node, item),
        choices,
      };
    } else if (node.kind === 'office') {
      ev = {
        type: 'cabinet',
        title: '잠긴 캐비닛',
        cue: '찌그러진 캐비닛 문이 반쯤 벌어져 있다. 안쪽에 희끄무레한 먼지들이 보인다.',
        choices: [
          eventChoice('open', '조심히 연다', '경첩을 조심한다', 'good'),
          eventChoice('skip', '그냥 지나간다', '손대지 않는다'),
          eventChoice('noise', '소리를 내서 확인한다', '반응을 확인한다', 'danger'),
        ],
      };
    } else if (node.kind === 'hall') {
      // 무너진 통로 v1: 고위험/고보상. 잔해를 넘으면 빛·멘탈을 더 쓰고 소리가 나지만,
      // 방에 물건이 없을 때 더 나은 회수물이 드러날 수 있다(있으면 중복 생성하지 않는다).
      ev = {
        type: 'collapsed-passage',
        title: '무너진 통로',
        cue: '천장이 내려앉아 철근이 삐져나온 잔해가 통로를 반쯤 막았다. 위쪽 들보가 먼지를 떨구며 낮게 삐걱인다.',
        choices: [
          eventChoice('cross', '잔해를 넘어간다', '철근을 넘느라 소리가 난다', 'danger'),
          eventChoice('low', '낮게 돌아간다', '먼지 속을 기어 돌아간다', 'good'),
          eventChoice('give-up', '포기한다', '잔해를 등지고 물러난다'),
        ],
      };
    } else if (node.kind === 'watchpost') {
      // 위원회 감시소 v1: meta.suspicion과 상호작용. 의심도가 높으면 단말을 뒤지는 게 위험하다.
      const tense = meta.suspicion >= WATCHPOST_TENSE_SUSPICION;
      ev = {
        type: 'watchpost',
        title: '위원회 감시소',
        cue: tense
          ? '꺼진 감시등 아래 단말이 아직 희미하게 깜빡인다. 화면에 내 회수 이력 같은 항목이 스쳐 지나간다.'
          : '감시등은 꺼졌고 단말도 잠들어 있다. 먼지 앉은 자판 위에서 붉은 대기등만 느리게 뛴다.',
        choices: [
          eventChoice('wipe-log', '기록을 지운다', '내 흔적을 지운다', 'good'),
          eventChoice('search', '단말을 뒤진다', tense ? '위험하지만 뭔가 나올 수 있다' : '뭔가 나올 수 있다', tense ? 'danger' : ''),
          eventChoice('pass', '그냥 지나간다', '건드리지 않는다'),
        ],
      };
      if (hasSurvivor('insider')) {
        ev.choices.splice(1, 0, eventChoice('seal-code', '봉쇄 코드를 넣는다', '낡은 직원 코드를 쓴다', 'good'));
      }
    } else if (node.kind === 'missing-trace') {
      ev = {
        type: 'missing-trace',
        title: '실종자 흔적',
        cue: '벽에 젖은 사진과 이름표가 붙어 있다. 누군가 이 방에서 오래 기다린 흔적이 남았다.',
        choices: [
          eventChoice('recover', '유품을 챙긴다', '가족에게 돌아갈지도 모른다', 'good'),
          eventChoice('inspect', '사진만 확인한다', '단서만 읽고 둔다'),
          eventChoice('pass', '그냥 지나간다', '못 본 척 지나친다'),
        ],
      };
    } else if (node.kind === 'crack' || node.kind === 'corridor') {
      ev = {
        type: 'footprints',
        title: node.kind === 'crack' ? '젖은 발자국' : '다가오는 발소리',
        cue: node.kind === 'crack'
          ? '방금 찍힌 듯한 젖은 발자국이 앞쪽으로 이어진다. 그 끝 어둠에서 물 밟는 소리가 얕게 다가온다.'
          : '어둠이 낮게 깔렸다. 그 안에서 느릿한 발소리가 이쪽으로 다가온다. 아직 들키진 않았다.',
        choices: [
          eventChoice('hold', '숨을 죽인다', '발소리를 멈춘다', 'good'),
          eventChoice('rush', '빠르게 지난다', '빛을 아낀다', 'danger'),
        ],
      };
      if (run.bag.length > 0) ev.choices.push(eventChoice('bait', '미끼를 던진다', '짐을 하나 버린다', 'good'));
    } else if (node.kind === 'vent') {
      ev = {
        type: 'vent',
        title: '낮은 환풍구',
        cue: '사람 하나 겨우 지날 낮은 틈이 벌어져 있다. 찬 바람이 팔꿈치를 스친다.',
        choices: [
          eventChoice('crawl', '기어서 통과한다', '낮게 지나간다', 'good'),
          eventChoice('turn', '돌아선다', '틈을 등진다'),
        ],
      };
    } else if (node.kind === 'storage' || node.kind === 'door') {
      ev = {
        type: 'light-recovery',
        title: node.kind === 'storage' ? '비상 배터리' : '벽 비상등',
        cue: node.kind === 'storage'
          ? '선반 아래 배터리가 아직 아주 작게 깜빡인다.'
          : '깨진 비상등 안쪽에 약한 빛이 남아 있다.',
        choices: [
          eventChoice('charge', '조명에 연결한다', '배터리를 연결한다', 'good'),
          eventChoice('wipe', '렌즈만 닦는다', '시야를 확보한다', 'good'),
          eventChoice('skip', '그냥 둔다', '건드리지 않는다'),
        ],
      };
    }
    if (!ev) return;
    node.roomEventResolved = true;
    const tense = ev.type === 'footprints' || ev.type === 'item-encounter';
    run.pendingEvent = { ...ev, node: node.id, tone: tense ? 'hot' : '' };
    run.lastAction = ev.cue;
    log(ev.cue, tense ? 'hot' : undefined);
    // 큐는 tap-through 대사가 아니라 선택지와 함께 남는 sticky 카드로 보여준다(renderSituationLayer).
  }

  function takeCheapestBagItem() {
    if (!run.bag.length) return null;
    let idx = 0;
    run.bag.forEach((it, i) => { if (it.value < run.bag[idx].value) idx = i; });
    return run.bag.splice(idx, 1)[0];
  }

  function moveDuringEncounter(targetId, message) {
    const from = currentNode();
    const to = nodeById(targetId);
    if (!from || !to || !from.exits.includes(targetId)) return false;
    markTravelledEdge(from.id, targetId);
    run.previousNodeId = from.id;
    run.currentNodeId = targetId;
    const firstVisit = applyNodeEntryEffects(to);
    if (firstVisit) run.encounterArrivalNode = targetId;
    if (message) run.lastAction = message;
    return true;
  }

  function resolveMonsterEncounter(ev, choiceId) {
    const kind = MONSTER_ARCHETYPES[ev.monsterKind] || MONSTER_ARCHETYPES.longFace;
    let msg = '';
    let knockedOut = false;
    const s = stalker();

    if (choiceId === 'backstep') {
      const targetId = relativeExit('back');
      if (targetId == null || (s && s.nodeId === targetId)) {
        msg = '뒷걸음친 순간 등 뒤 어둠에서 차가운 손이 어깨를 눌렀다.';
        knockedOut = true;
      } else {
        moveDuringEncounter(targetId, '정면의 어두운 형체를 보며 한 걸음 물러났다.');
        if (s) { s.lastHeardId = run.currentNodeId; s.quietSteps = 0; }
        run.danger = Math.max(run.danger, 72);
        msg = '정면의 어두운 형체를 보며 뒤로 빠졌다. 발소리는 아직 빛 끝을 따라온다.';
      }
      if (knockedOut) run.failContext = msg;
      return { msg, knockedOut };
    }
    if (choiceId === 'side-left' || choiceId === 'side-right') {
      const targetId = relativeExit(choiceId === 'side-left' ? 'left' : 'right');
      const load = usedSlots() / Math.max(1, bagCap());
      const chance = 0.78 - load * 0.28 + (run.mental >= 35 ? 0.08 : -0.12) + (effectiveLightPercent() >= 35 ? 0.06 : -0.08);
      if (targetId == null) {
        msg = '몸을 틀었지만 빠질 틈이 없다. 어두운 형체가 바로 앞까지 왔다.';
        knockedOut = true;
      } else if (Math.random() < chance) {
        moveDuringEncounter(targetId, '옆으로 몸을 밀어 넣었다.');
        if (s) { s.lastHeardId = run.currentNodeId; s.quietSteps = 0; }
        run.light = Math.max(0, run.light - 7);
        run.mental = Math.max(0, run.mental - 5);
        run.danger = Math.max(run.danger, 66);
        msg = '문틀을 긁으며 옆방으로 뛰어들었다. 어두운 형체는 뒤쪽 복도에서 따라온다.';
      } else {
        const lost = takeCheapestBagItem();
        if (lost) {
          run.droppedCount += 1;
          dropLootTrace(lost);
          run.danger = Math.min(96, run.danger + 10);
          msg = `${lost.name}${subjectParticle(lost.name)} 가방에서 빠졌다. 몸은 옆방으로 넘어갔지만 발소리가 바로 뒤에 붙었다.`;
          moveDuringEncounter(targetId, msg);
        } else {
          msg = '몸을 틀었지만 늦었다. 어두운 형체의 팔이 조명 앞을 덮었다.';
          knockedOut = true;
        }
      }
      if (knockedOut) run.failContext = msg;
      return { msg, knockedOut };
    }
    if (choiceId === 'glare') {
      if (run.light >= 18) {
        run.light = Math.max(0, run.light - 16);
        run.encounterTime = Math.min(ENCOUNTER_SECONDS, (run.encounterTime || 0) + 2.2);
        run.danger = Math.max(55, run.danger - 12);
        msg = '빛을 정면에 고정했다. 어두운 형체가 잠깐 멈췄지만 고개는 계속 이쪽을 향한다.';
      } else {
        run.light = Math.max(0, run.light - 6);
        run.encounterTime = Math.max(0.8, (run.encounterTime || 0) - 1.4);
        run.danger = Math.min(98, run.danger + 12);
        msg = '빛이 두 번 깜빡였다. 어두운 형체는 멈추지 않고 더 가까워졌다.';
      }
      return { msg, knockedOut, keepEncounter: true };
    }
    if (choiceId === 'throw-bag') {
      const bait = takeCheapestBagItem();
      if (bait) {
        run.droppedCount += 1;
        dropLootTrace(bait);
        run.danger = Math.max(0, run.danger - 30);
        run.encounterTime = Math.min(ENCOUNTER_SECONDS, (run.encounterTime || 0) + 1.5);
        msg = `${bait.name}${objectParticle(bait.name)} 어둠 반대편으로 던졌다. 어두운 형체의 고개가 금속음 쪽으로 꺾인다.`;
      } else {
        msg = '던질 짐이 없다. 빈손이 조명 아래서 떨린다.';
        run.danger = Math.min(98, run.danger + 8);
      }
      return { msg, knockedOut };
    }
    if (choiceId === 'hide-dark') {
      if (!currentRoomHasCover()) {
        msg = '숨을 곳이 없다. 조명만 흔들렸다.';
        run.danger = Math.min(98, run.danger + 8);
      } else {
        const noisy = usedSlots() >= Math.max(2, Math.ceil(bagCap() * 0.7));
        run.lightOn = false;
        if (noisy && Math.random() < 0.45) {
          msg = '캐비닛 문을 닫는 순간 가방 안 금속이 부딪쳤다. 어두운 형체가 그 소리로 고개를 돌렸다.';
          knockedOut = true;
        } else {
          const st = stalker();
          if (st) { st.quietSteps = DORMANT_AFTER; st.lastHeardId = null; }
          run.chasing = false;
          run.danger = Math.max(0, run.danger - 45);
          msg = '캐비닛 뒤로 몸을 넣고 조명을 껐다. 발소리가 문 앞에서 멈췄다가 멀어진다.';
        }
      }
      if (knockedOut) run.failContext = msg;
      return { msg, knockedOut };
    }

    if (ev.monsterKind === 'longFace') {
      if (choiceId === 'shine') {
        const enoughLight = run.light >= 12;
        run.light = Math.max(0, run.light - 12);
        if (enoughLight) {
          run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 30);
          run.mental = clamp(run.mental + 2, 0, 100);
          msg = '빛을 정면에 고정했다. 구부러진 목이 멈춘다. 놈이 팔로 눈을 가리는 사이 벽 틈으로 빠져나왔다.';
        } else {
          run.danger = Math.min(100, run.danger + 14);
          msg = '빛이 힘없이 튄다. 검은 팔이 깜빡인 방향으로 먼저 뻗는다.';
          knockedOut = run.danger >= 100;
        }
      } else if (choiceId === 'sidestep') {
        run.light = Math.max(0, run.light - 4);
        if (run.danger < 90 || run.mental >= 18) {
          run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 14);
          msg = '놈이 몸을 접는 틈에 옆으로 빠져나왔다. 손끝이 벽만 길게 긁고 지나간다.';
        } else {
          run.danger = Math.min(100, run.danger + 10);
          msg = '비키려는 순간 발이 엉킨다. 길게 뻗은 팔이 퇴로를 가로막는다.';
          knockedOut = run.danger >= 100;
        }
      } else {
        const steady = run.mental >= 24;
        run.mental = Math.max(0, run.mental - 12);
        if (steady && run.light < 12) {
          run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 8);
          msg = '빛을 낮추고 숨을 눌렀다. 검은 윤곽은 다른 벽을 천천히 더듬는다.';
        } else {
          run.danger = Math.min(100, run.danger + 12);
          msg = '숨은 죽였지만 빛 끝이 흔들렸다. 높은 곳의 고개가 그 흔들림을 따라 내려온다.';
          knockedOut = run.danger >= 100 || run.mental <= 0;
        }
      }
    } else if (ev.monsterKind === 'wetFeet') {
      if (choiceId === 'bait') {
        const bait = takeCheapestBagItem();
        if (bait) {
          run.droppedCount += 1;
          run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 36);
          divertStalkerToAdjacent(); // 던진 소리가 옆 칸에서 나므로 그쪽을 좇게 한다.
          msg = `${bait.name}${objectParticle(bait.name)} 물웅덩이 건너로 던졌다. 물 밟는 소리가 던진 물건 쪽으로 멀어진다.`;
          if (run.bag.length === 0 && run.danger < 35) run.chasing = false;
        } else {
          run.danger = Math.min(100, run.danger + 10);
          msg = '던질 게 없다. 빈 가방 끈이 철벅이고, 뒤의 발소리가 그 소리에 맞춰 빨라진다.';
          knockedOut = run.danger >= 100;
        }
      } else if (choiceId === 'hold') {
        const steady = run.mental >= 16;
        run.mental = Math.max(0, run.mental - 10);
        if (steady) {
          run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 24);
          msg = '발을 바닥에서 떼고 숨까지 멈췄다. 내 발소리가 멈추자, 젖은 발자국이 제자리에서 맴돈다.';
        } else {
          run.danger = Math.min(100, run.danger + 12);
          msg = '다리가 떨려 물웅덩이가 한 번 울린다. 젖은 발소리가 정확히 따라붙는다.';
          knockedOut = run.danger >= 100 || run.mental <= 0;
        }
      } else {
        run.light = Math.max(0, run.light - 5);
        run.danger = Math.min(100, run.danger + 22);
        msg = '뛰자 내 발소리가 길게 울린다. 뒤에서 젖은 발소리가 더 빠르게 따라온다.';
        knockedOut = run.danger >= 100;
      }
    } else if (ev.monsterKind === 'doorHand') {
      if (choiceId === 'strike') {
        const steady = run.mental >= 12;
        run.mental = Math.max(0, run.mental - 8);
        const relief = 24 + Math.min(10, (meta.weaponLevel - 1) * 4);
        if (steady) {
          run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - relief);
          msg = '손가락 마디를 후려쳤다. 얇은 손가락들이 물러나고, 문짝과 벽 사이가 벌어진다.';
        } else {
          run.danger = Math.min(100, run.danger + 12);
          msg = '팔은 휘둘렀지만 힘이 빠졌다. 문틈의 마디들이 가방 끈을 더 세게 감는다.';
          knockedOut = run.danger >= 100 || run.mental <= 0;
        }
      } else if (choiceId === 'kick') {
        run.light = Math.max(0, run.light - 6);
        run.mental = Math.max(0, run.mental - 10);
        run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 18);
        msg = '문틀을 걷어차자 삭은 나무가 터진다. 긴 마디들이 잠깐 끼이고, 그 사이 어깨를 뺐다.';
      } else if (choiceId === 'shine') {
        run.light = Math.max(0, run.light - 10);
        run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 8);
        msg = '빛을 들이대자 얇은 마디들이 떤다. 움켜쥔 힘이 잠깐 느슨해진다.';
      } else {
        run.danger = Math.min(100, run.danger + 18);
        msg = '몸을 빼 달렸지만 너무 가까웠다. 문 안쪽의 손가락들이 팔꿈치와 가방 끈을 낚아챈다.';
        knockedOut = run.danger >= 100;
      }
    } else {
      run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 10);
      msg = '놈이 잠깐 물러난 틈에 빠져나왔다.';
    }

    if (knockedOut) run.failContext = msg;
    if (!knockedOut && run.danger >= 100) run.danger = MONSTER_GRACE_DANGER;
    if (!knockedOut) {
      // 위기를 넘기면 추격자를 멀리 보내고 한동안 잠재운다 — 즉시 재조우를 막는다.
      teleportStalkerAway(2);
      const s = stalker();
      if (s) { s.lastHeardId = null; s.quietSteps = DORMANT_AFTER; s.nearCued = false; }
      if (run.danger < MONSTER_GRACE_DANGER) run.chasing = false;
    }
    return { msg, knockedOut };
  }

  function resolveRoomEvent(choiceId) {
    if (!run || run.moving || run.dialogue || !run.pendingEvent) return;
    clearDialogue();
    const ev = run.pendingEvent;
    const node = nodeById(ev.node) || currentNode();
    let msg = '';
    if (ev.type === 'return-attempt') {
      resolveReturnAttempt(ev, choiceId);
      return;
    } else if (ev.type === 'mental-break') {
      const outcome = ev.outcome;
      if (outcome && typeof outcome.apply === 'function') outcome.apply();
      run.mental = MENTAL_BREAK_RECOVERY;
      run.mentalGraceTicks = MENTAL_BREAK_GRACE_TICKS;
      if (effectiveLightPercent() <= 0) { run.light = Math.max(run.light, maxLight() * (MENTAL_BREAK_MIN_LIGHT_PCT / 100)); run.lightOn = true; }
      if (run.lastMentalLoss) msg = `${outcome.after} ${run.lastMentalLoss}${subjectParticle(run.lastMentalLoss)} 손에서 빠져나갔다.`;
      else msg = outcome ? outcome.after : '간신히 정신을 붙잡았다.';
    } else if (ev.type === 'cabinet') {
      if (choiceId === 'open') {
        const blackHand = hasMutation('black-hand');
        run.light = Math.max(0, run.light - (blackHand ? BLACKHAND_CABINET_LIGHT : 3));
        const foundBag = !node.cabinetBagChecked ? bagFindCandidate() : null;
        node.cabinetBagChecked = true;
        if (foundBag) {
          meta.bagLevel = foundBag.level;
          saveMeta();
          msg = `찌그러진 캐비닛 안에 멀쩡한 ${foundBag.name}${subjectParticle(foundBag.name)} 걸려 있다. ${foundBag.name}${objectParticle(foundBag.name)} 멨다. 이제 ${foundBag.cap}칸까지 챙길 수 있다.`;
        } else if (!run.currentItem && !node.itemTaken) {
          node.item = node.item || pickFloorItem(run.floor, node);
          run.currentItem = node.item;
          msg = `${run.currentItem.name}${subjectParticle(run.currentItem.name)} 안쪽에서 굴러 떨어졌다.`;
        } else {
          run.danger = Math.max(0, run.danger - 2);
          msg = meta.bagLevel >= MAX_BAG_LEVEL
            ? '낡은 가방 하나가 걸려 있지만, 지금 멘 것보다 나을 게 없다.'
            : '문을 천천히 닫았다. 철판 속의 빈 소리가 가라앉는다.';
        }
        if (blackHand) msg = `${msg} ${BLACKHAND_CABINET_NOTE}`;
      } else if (choiceId === 'noise') {
        run.danger = Math.min(100, run.danger + 7);
        msg = '금속음이 울렸다. 먼 곳에서 비슷한 소리가 한 번 늦게 돌아온다.';
      } else {
        run.danger = Math.max(0, run.danger - 1);
        msg = '캐비닛은 그대로 둔다. 열린 틈이 등 뒤에서 오래 남는다.';
      }
    } else if (ev.type === 'footprints') {
      if (choiceId === 'hold') {
        run.light = Math.max(0, run.light - 2);
        run.danger = Math.max(0, run.danger - 5);
        msg = '숨을 죽이자 젖은 발자국 소리가 천천히 멀어진다.';
      } else if (choiceId === 'bait') {
        const bait = takeCheapestBagItem();
        if (bait) {
          run.droppedCount += 1;
          run.danger = Math.max(0, run.danger - 12);
          divertStalkerToAdjacent(); // 미끼 소리로 추격자의 관심을 옆 칸으로 돌린다.
          if (run.bag.length === 0) run.chasing = false;
          msg = `${bait.name}${objectParticle(bait.name)} 미끼로 던졌다. 물 밟는 소리가 그쪽으로 멀어진다.`;
        } else {
          run.danger = Math.min(100, run.danger + 4);
          msg = '던질 게 없다. 빈손만 어둠 속에서 떨린다.';
        }
      } else {
        run.light = Math.max(0, run.light - 1);
        run.danger = Math.min(100, run.danger + 5);
        msg = '빠르게 지나쳤다. 뒤에서 물 밟는 소리가 조금 늦게 따라온다.';
      }
    } else if (ev.type === 'collapsed-passage') {
      if (choiceId === 'cross') {
        // 고위험/고보상: 빛·멘탈을 더 쓰고 큰 소리를 내지만, 방에 물건이 없으면 더 나은 회수물이 드러난다.
        run.light = Math.max(0, run.light - 8);
        run.mental = Math.max(0, run.mental - 6);
        run.danger = Math.min(100, run.danger + 8);
        emitNoise(node.id, { loud: true });
        if (!run.currentItem && !node.itemTaken) {
          // 방에 물건이 없을 때만 새로 드러낸다 — 이미 있으면 중복 생성하지 않는다. style:'danger'로 등급을 위로 편향.
          const revealed = pickFloorItem(run.floor, { style: 'danger' });
          node.item = revealed;
          run.currentItem = revealed;
          msg = `철근을 밟고 잔해를 넘었다. 무너진 콘크리트 밑에서 ${revealed.name}${subjectParticle(revealed.name)} 걸려 나왔다.`;
        } else {
          msg = '철근을 붙잡고 잔해를 넘었다. 등 뒤로 콘크리트 조각이 우수수 굴러떨어진다.';
        }
      } else if (choiceId === 'low') {
        // 낮은 길: 시간과 빛은 들지만 소음·위험이 적다.
        run.light = Math.max(0, run.light - 5);
        run.danger = Math.max(0, run.danger - 3);
        msg = '먼지 속을 낮게 기어 잔해 옆을 돌았다. 들보가 머리 위에서 한 번 삐걱였을 뿐이다.';
      } else {
        run.danger = Math.max(0, run.danger - 1);
        msg = '잔해 더미를 등지고 물러났다. 무너진 통로는 그대로 남는다.';
      }
    } else if (ev.type === 'watchpost') {
      const tense = meta.suspicion >= WATCHPOST_TENSE_SUSPICION;
      if (choiceId === 'seal-code' && hasSurvivor('insider')) {
        run.light = Math.max(0, run.light - INSIDER_WATCHPOST_LIGHT);
        if (meta.suspicion > 0) {
          meta.suspicion = Math.max(0, meta.suspicion - 4);
          saveMeta();
        }
        msg = INSIDER_SEAL_LOG;
      } else if (choiceId === 'wipe-log') {
        // 기록 삭제: 의심도를 조금 낮추고 빛·멘탈을 쓰며 작은 소음을 낸다.
        run.light = Math.max(0, run.light - 4);
        run.mental = Math.max(0, run.mental - 3);
        run.danger = Math.min(100, run.danger + 4);
        emitNoise(node.id, { loud: false });
        if (meta.suspicion > 0) {
          meta.suspicion = Math.max(0, meta.suspicion - 3);
          saveMeta();
        }
        msg = '단말을 열어 내 회수 이력을 지웠다. 자판이 딸깍이고, 감시등이 한 번 꺼졌다 켜진다.';
      } else if (choiceId === 'search') {
        run.light = Math.max(0, run.light - 3);
        if (tense) {
          // 의심도가 높으면 뒤지는 게 위험하다 — 경보가 남고 의심도가 오른다.
          run.danger = Math.min(100, run.danger + 10);
          meta.suspicion = Math.min(99, meta.suspicion + 3);
          saveMeta();
          emitNoise(node.id, { loud: true });
          msg = '단말을 뒤지자 화면이 붉게 번쩍이며 경보음이 짧게 울렸다. 어둠 저편에서 무언가 방향을 튼다.';
        } else if (!run.currentItem && !node.itemTaken && Math.random() < 0.5) {
          const found = pickFloorItem(run.floor, node);
          node.item = found;
          run.currentItem = found;
          msg = `서랍을 뒤지자 ${found.name}${subjectParticle(found.name)} 딸려 나왔다.`;
        } else {
          // 진실 조각을 공짜로 풀지 않는다 — 단서 로그 한 줄만 남긴다.
          msg = WATCHPOST_LOGS[Math.floor(Math.random() * WATCHPOST_LOGS.length)];
        }
      } else {
        run.danger = Math.max(0, run.danger - 1);
        msg = '감시소는 건드리지 않고 지나쳤다. 꺼진 감시등이 등 뒤에 남는다.';
      }
    } else if (ev.type === 'missing-trace') {
      if (choiceId === 'recover') {
        run.light = Math.max(0, run.light - 2);
        run.mental = Math.max(0, run.mental - 2);
        if (!run.currentItem && !node.itemTaken) {
          const keepsake = pickFamilyKeepsake();
          node.item = keepsake;
          run.currentItem = keepsake;
          msg = `${keepsake.name}${subjectParticle(keepsake.name)} 사진 아래에 놓여 있다. ${keepsake.familyNote || '가족에게 돌아갈 물건이다.'}`;
        } else {
          msg = '사진 아래 빈자리만 남았다. 이미 챙긴 흔적이 있다.';
        }
      } else if (choiceId === 'inspect') {
        run.light = Math.max(0, run.light - 1);
        msg = MISSING_TRACE_LOGS[Math.floor(Math.random() * MISSING_TRACE_LOGS.length)];
      } else {
        run.danger = Math.max(0, run.danger - 1);
        msg = '사진과 이름표를 그대로 두고 지나쳤다. 테이프가 벽에서 천천히 떨어진다.';
      }
    } else if (ev.type === 'survivor') {
      const s = SURVIVORS[ev.survivorId] || {};
      if (choiceId === 'rescue') {
        // 구출: 빛·멘탈을 쓰고 소음이 나지만, 생존자를 지상으로 데려간다(영구 효과 해금).
        run.light = Math.max(0, run.light - SURVIVOR_RESCUE_LIGHT);
        run.mental = Math.max(0, run.mental - SURVIVOR_RESCUE_MENTAL);
        run.danger = Math.min(100, run.danger + SURVIVOR_RESCUE_DANGER);
        emitNoise(node.id, { loud: false }); // 끌어내는 소리 — 작지 않은 소음
        if (!hasSurvivor(ev.survivorId)) {
          meta.survivors.push(ev.survivorId);
          saveMeta(); // 구출 즉시 저장 — 이번 런이 실패로 끝나도 사람은 남는다
        }
        msg = s.rescueLog || '갇혀 있던 사람을 끌어냈다.';
      } else if (choiceId === 'mark') {
        // 위치만 표시: 구출하지 않는다. v1은 되돌아와도 이 방에 다시 열리지 않는다.
        run.mental = Math.max(0, run.mental - 2);
        run.danger = Math.min(100, run.danger + 2);
        msg = '지금은 손이 없다. 벽에 표식을 긁어 위치만 남기고 물러났다.';
      } else {
        run.danger = Math.max(0, run.danger - 1);
        msg = '못 본 척 지나쳤다. 두드림 소리가 등 뒤에서 한동안 이어진다.';
      }
    } else if (ev.type === 'item-encounter') {
      const item = run.currentItem;
      if (choiceId && choiceId.startsWith('take-back:')) {
        const requestedId = choiceId.slice('take-back:'.length);
        const loot = droppedLoots().find((entry) => node && entry.nodeId === node.id && entry.id === requestedId);
        if (!loot) {
          msg = '내려놓은 짐은 이미 어둠 속으로 사라졌다.';
        } else if (!roomFor(loot.item)) {
          showBagBlockedDialogue();
          render();
          return;
        } else {
          run.bag.push(loot.item);
          removeDroppedLoot(loot);
          run.grabbedCount += 1;
          run.droppedCount = Math.max(0, run.droppedCount - 1);
          run.light = Math.max(0, run.light - Math.max(2, GRAB_LIGHT_COST - 1));
          playGrabFx();
          run.chasing = true;
          applyPickupNoise(node.id, loot.item, true);
          run.danger = Math.min(100, run.danger + Math.max(2, GRAB_DANGER_BUMP - 2));
          const brokenTail = loot.broken ? ' 깨진 모서리가 손끝을 스친다.' : '';
          msg = `눈앞의 회수물은 그대로 두고, 내려놓았던 ${loot.item.name}${objectParticle(loot.item.name)} 먼저 가방에 넣었다.${brokenTail}`;
          maybeQueueBagAlert();
          maybeQueueLightAlert();
        }
      } else if (!item) {
        msg = '물건은 이미 챙겼다.';
      } else if (choiceId === 'skip') {
        // 지금은 지나친다. 자국은 남아, 다시 이 방을 지날 때 조용히 집을 수 있다.
        run.currentItem = null;
        run.danger = Math.max(0, run.danger - 2);
        msg = `${item.name}${objectParticle(item.name)} 그대로 두고 지나쳤다. 발소리를 죽인 채 물러난다.`;
      } else if (!roomFor(item)) {
        // 가방이 가득 차 집을 수 없다 → 이벤트를 유지해 지나치기/재선택하게 둔다.
        showBagBlockedDialogue();
        render();
        return;
      } else {
        const cautious = choiceId === 'careful';
        run.bag.push(item);
        node.itemTaken = true;
        run.grabbedCount += 1;
        run.currentItem = null;
        run.light = Math.max(0, run.light - (cautious ? GRAB_LIGHT_COST : Math.max(2, GRAB_LIGHT_COST - 3)));
        playGrabFx();
        const firstGrab = !run.chasing;
        run.chasing = true;
        // 소음은 아이템 noise + 조심/재빨리로 결정한다(applyPickupNoise 참고). run.chasing 판정 뒤에 호출.
        const noiseWarn = applyPickupNoise(node.id, item, cautious);
        if (cautious) {
          run.danger = firstGrab ? Math.max(run.danger, GRAB_DANGER_BUMP) : Math.min(100, run.danger + GRAB_DANGER_BUMP);
          msg = `숨을 죽이고 ${item.name}${objectParticle(item.name)} 천천히 가방에 넣었다.`;
          if (noiseWarn) msg += ` ${noiseWarn}`; // 소리 큰 물건은 조심해도 티가 난다.
        } else {
          run.danger = Math.min(100, run.danger + GRAB_DANGER_BUMP + 4);
          const dir = reversePathDirection(node);
          const cue = dir ? `${dir}에서 발소리가 붙는다.` : '뒤쪽에서 발소리가 붙는다.';
          msg = `${item.name}${objectParticle(item.name)} 재빨리 낚아챘다. ${cue}`;
        }
        if (usedSlots() >= bagCap() && !run.seenBagAlerts.has('full')) {
          run.seenBagAlerts.add('full');
          msg += ` ${bagAlert('full')}`;
        }
        maybeQueueBagAlert();
        maybeQueueLightAlert();
        maybeQueueMentalAlert();
      }
    } else if (ev.type === 'dropped-loot') {
      const lootsHere = droppedLoots().filter((entry) => node && entry.nodeId === node.id);
      const requestedId = choiceId && choiceId.startsWith('take-back:') ? choiceId.slice('take-back:'.length) : '';
      const loot = requestedId ? lootsHere.find((entry) => entry.id === requestedId) : lootsHere[0];
      if (!loot) {
        msg = '내려놓은 짐은 이미 어둠 속으로 사라졌다.'; // 그새 어두운 형체가 거둬 갔다.
      } else if (choiceId === 'leave' || choiceId === 'list-more') {
        // 두고 물러난다 — 자국은 유지된다. 어두운 형체가 나중에 되찾으러 올 몫이다.
        run.danger = Math.max(0, run.danger - 2);
        msg = choiceId === 'list-more'
          ? `남은 짐은 그대로 두었다. 바닥의 자국만 다시 확인했다.`
          : `${loot.item.name}${objectParticle(loot.item.name)} 그대로 두고 물러났다. 바닥의 자국만 다시 확인했다.`;
      } else if (!roomFor(loot.item)) {
        // 가방이 가득 차 되챙길 수 없다 → 이벤트를 유지해 지나치기/재선택하게 둔다.
        showBagBlockedDialogue();
        render();
        return;
      } else {
        // 되챙기기: 같은 물건이 가방으로 돌아온다(복제 아님). 되찾으면 버림 카운트도 되돌린다.
        run.bag.push(loot.item);
        removeDroppedLoot(loot);
        run.grabbedCount += 1;
        run.droppedCount = Math.max(0, run.droppedCount - 1);
        run.currentItem = null;
        run.light = Math.max(0, run.light - GRAB_LIGHT_COST);
        playGrabFx();
        run.chasing = true;
        applyPickupNoise(node.id, loot.item, true); // 되챙기는 소리가 난다(조심히 다뤄도 티가 날 수 있다).
        run.danger = Math.min(100, run.danger + GRAB_DANGER_BUMP);
        const brokenTail = loot.broken ? ' 깨진 모서리가 손끝을 스친다.' : '';
        msg = `버리고 왔던 ${loot.item.name}${objectParticle(loot.item.name)} 다시 가방에 넣었다.${brokenTail}`;
        if (usedSlots() >= bagCap() && !run.seenBagAlerts.has('full')) {
          run.seenBagAlerts.add('full');
          msg += ` ${bagAlert('full')}`;
        }
        maybeQueueBagAlert();
        maybeQueueLightAlert();
      }
    } else if (ev.type === 'vent') {
      if (choiceId === 'crawl') {
        run.light = Math.max(0, run.light - 4);
        run.danger = Math.max(0, run.danger - 3);
        msg = '낮게 기어 통과했다. 먼지가 입안으로 들어오고, 찬 바람이 손등을 스친다.';
      } else {
        run.danger = Math.max(0, run.danger - 1);
        msg = '좁은 틈은 등졌다. 안쪽 바람이 한동안 발목을 따라온다.';
      }
    } else if (ev.type === 'light-recovery') {
      if (choiceId === 'charge') {
        const gain = node && node.kind === 'storage' ? 22 : 15;
        run.light = clamp(run.light + gain, 0, maxLight());
        run.lightOn = true;
        run.mental = clamp(run.mental + 3, 0, 100);
        msg = node && node.kind === 'storage'
          ? '비상 배터리를 연결했다. 손전등 빛이 조금 밝아진다.'
          : '비상등의 남은 빛을 끌어왔다. 앞쪽 윤곽이 잠깐 선명해진다.';
      } else if (choiceId === 'wipe') {
        run.light = clamp(run.light + 7, 0, maxLight());
        run.lightOn = true;
        run.mental = clamp(run.mental + 5, 0, 100);
        msg = '렌즈의 흙탕물을 닦아냈다. 앞뒤의 깊이가 조금 돌아온다.';
      } else {
        msg = '불안정한 빛은 건드리지 않는다. 깜빡임만 뒤에 남는다.';
      }
    } else if (ev.type === 'monster-encounter') {
      const result = resolveMonsterEncounter(ev, choiceId);
      msg = result.msg;
      if (result.knockedOut) {
        run.pendingEvent = null;
        run.lastAction = msg;
        log(msg, 'hot');
        showDialogue(msg, 'hot');
        failRun();
        return;
      }
      if (result.keepEncounter) {
        run.lastAction = msg;
        log(msg, 'hot');
        clearDialogue();
        render();
        return;
      }
    }
    const arrivedFromEncounter = ev.type === 'monster-encounter' && run.encounterArrivalNode === run.currentNodeId;
    run.encounterArrivalNode = null;
    run.pendingEvent = null;
    run.lastAction = msg || '상황을 정리했다.';
    const actionTone = /울렸다|따라온다|없다|어두운 형체|젖은 발소리|손가락|얼굴|붙는다/.test(run.lastAction) ? 'hot' : undefined;
    log(run.lastAction, actionTone);
    showDialogue(run.lastAction, actionTone || (ev.type === 'mental-break' ? 'good' : ''));
    if (arrivedFromEncounter && !run.currentItem) {
      maybeStartRoomEvent(currentNode());
      if (run.pendingEvent) { render(); return; }
    }
    if (ev.type !== 'monster-encounter' && ev.type !== 'mental-break' && node && node.monster && !node.monsterResolved) {
      triggerMonster(node);
      if (run.pendingEvent) return;
    }
    if (maybeTriggerMentalBreak()) return;
    if (maybeQueueRunAlerts()) { render(); return; }
    render();
  }

  function markTravelledEdge(fromId, toId) {
    if (!run || !run.floorMap || fromId === toId) return;
    if (!run.floorMap.travelledEdges) run.floorMap.travelledEdges = new Set();
    run.floorMap.travelledEdges.add(edgeKey(fromId, toId));
  }

  function monsterEncounterCue(reason, node, monsterKind) {
    const kind = MONSTER_ARCHETYPES[monsterKind] || MONSTER_ARCHETYPES.longFace;
    const copy = kind.reasons[reason] || kind.reasons.critical;
    if (reason === 'sight' && copy && typeof copy === 'object') {
      return directionCueFromNode(node, node && node.dangerExit, copy);
    }
    return copy;
  }

  function monsterChoices(monsterKind) {
    const choices = [];
    if (relativeExit('back') != null) choices.push(eventChoice('backstep', '뒤로 물러난다', '정면을 본 채 뒷방으로 빠진다', 'good'));
    if (relativeExit('left') != null) choices.push(eventChoice('side-left', '왼쪽으로 뛰어든다', '문틀에 걸리면 잡힌다', 'danger'));
    if (relativeExit('right') != null) choices.push(eventChoice('side-right', '오른쪽으로 뛰어든다', '가방이 무거우면 늦다', 'danger'));
    choices.push(eventChoice('glare', '조명을 고정한다', '몇 초만 늦출 수 있다', run.light >= 18 ? 'good' : 'danger'));
    if (run.bag.length > 0) choices.push(eventChoice('throw-bag', '짐을 던진다', '소리를 반대쪽으로 보낸다', 'good'));
    if (currentRoomHasCover()) choices.push(eventChoice('hide-dark', '조명을 끄고 숨는다', '캐비닛 뒤로 몸을 넣는다', 'good'));
    return choices.length ? choices : [eventChoice('glare', '조명을 고정한다', '빛이 약하면 위험하다', 'danger')];
  }

  function startMonsterEncounter(reason, node, kindOverride) {
    if (!run || run.pendingEvent) return false;
    if (reason === 'critical' && run.monsterCrisisCount > 0 && run.light <= 0 && run.mental <= 0) return false;

    // 직접 접촉/치명 조우는 거리 기반 위험도 상승보다 먼저 발화할 수 있어,
    // 위험 라벨이 '먼곳에서'로 남는 UX 불일치가 생긴다. 조우를 여는 순간 위험도를 끌어올린다.
    if (reason === 'critical' || stalkerDistance() <= 0) {
      run.danger = Math.max(run.danger, 85);
    }

    const monsterKind = kindOverride
      || (node && node.monster && node.monster.kind)
      || monsterKindForEvent(reason, run.floor, node);
    const kind = MONSTER_ARCHETYPES[monsterKind] || MONSTER_ARCHETYPES.longFace;
    const choices = monsterChoices(monsterKind);

    run.holdEvent = null;
    run.chasing = true;
    run.encounterTime = Math.max(3.2, ENCOUNTER_SECONDS - Math.max(0, run.danger - 70) / 18);
    run.monsterCrisisCount += 1;
    run.pendingEvent = {
      type: 'monster-encounter',
      title: kind.title,
      cue: monsterEncounterCue(reason, node, monsterKind),
      reason,
      monsterKind,
      node: node ? node.id : run.currentNodeId,
      choices,
    };
    run.lastAction = run.pendingEvent.cue;
    log(run.pendingEvent.cue, 'hot');
    clearDialogue();
    render();
    return true;
  }

  function triggerMonster(node) {
    if (!node || !node.monster || node.monsterResolved) return;
    // 숨은 추격자가 모든 조우를 전담한다. 노드에 시딩된 몬스터는 분위기용이므로
    // 도착 시 별도 조우를 열지 않는다(이중 발화 방지).
    if (run && run.floorMap && run.floorMap.stalker) { node.monsterResolved = true; return; }
    const type = node.monster.type;
    node.monsterResolved = true;
    if (type === 'sight') {
      run.danger = Math.min(100, run.danger + SIGHT_DANGER);
      startMonsterEncounter('sight', node);
    } else if (type === 'cross') {
      run.danger = Math.min(100, run.danger + CROSS_DANGER);
      startMonsterEncounter('cross', node);
    } else if (type === 'ambush') {
      run.danger = Math.min(100, run.danger + 6);
      startMonsterEncounter('ambush', node);
    }
  }

  function dirLabelForKey(key) {
    const slot = DIR_SLOTS.find((d) => d.key === key);
    return slot ? slot.label : '';
  }

  function directionSourceLabel(label) {
    return {
      '앞': '정면',
      '뒤': '뒤쪽',
      '왼쪽 앞': '왼쪽 앞쪽',
      '오른쪽 앞': '오른쪽 앞쪽',
      '왼쪽 뒤': '왼쪽 뒤쪽',
      '오른쪽 뒤': '오른쪽 뒤쪽',
    }[label] || label;
  }

  function directionCueFromNode(from, toId, copy) {
    const to = nodeById(toId);
    const label = dirLabelForKey(directionKeyBetween(from, to));
    return label ? copy.known(directionSourceLabel(label)) : copy.unknown;
  }

  function reversePathDirection(node) {
    if (!node || !run || !run.floorMap) return '';
    const entered = node.exits
      .map((id) => nodeById(id))
      .filter((nb) => nb && nb.entered && nb.id !== node.id);
    if (!entered.length) return '';
    entered.sort((a, b) => {
      const aEdge = run.floorMap.travelledEdges && run.floorMap.travelledEdges.has(edgeKey(node.id, a.id)) ? 0 : 1;
      const bEdge = run.floorMap.travelledEdges && run.floorMap.travelledEdges.has(edgeKey(node.id, b.id)) ? 0 : 1;
      return aEdge - bEdge;
    });
    return dirLabelForKey(directionKeyBetween(node, entered[0]));
  }

  function pickupThreatCue(node) {
    const dir = reversePathDirection(node);
    return dir ? `${dir}에서 으스스한 한기가 느껴진다.` : '어둠 속에서 으스스한 한기가 번진다.';
  }

  // 전진 연출 후 콜백 실행. 연출 중에는 갈림길/액션을 가린다.
  function beginTransition(after, fx, duration) {
    if (run.moving) return;
    clearDialogue();
    run.moving = true;
    run.lastAction = fx === 'descend' ? '계단 아래로 내려가는 중이다.' : '어둠 속으로 이동하는 중이다.';
    render();
    if (fx === 'descend') playDescendFx();
    window.setTimeout(() => {
      if (!run) return;
      after();
      run.moving = false;
      render();
    }, duration);
  }

  // 갈림길 선택. 계단이면 강하, 아니면 인접 노드로 이동.
  function chooseExit(targetId) {
    if (!run || run.moving || run.dialogue || run.pendingEvent) return;
    clearDialogue();
    const node = currentNode();
    const target = nodeById(targetId);
    if (!target || !node.exits.includes(targetId)) return;

    // 대기 이벤트를 무시하고 움직이면 들킨다.
    if (run.holdEvent) {
      const ev = run.holdEvent;
      if (ev.type === 'cross') {
        run.danger = Math.min(100, run.danger + CROSS_MOVE_DANGER);
        run.chasing = true;
        run.lastAction = '발소리가 방향을 틀었다. 따라온다!';
        log('발소리가 방향을 틀었다. 따라온다!', 'hot');
      } else if (ev.type === 'ambush') {
        run.danger = Math.min(100, run.danger + AMBUSH_MOVE_DANGER);
        run.chasing = true;
        run.lastAction = '움직였다. 들켰다 — 추격이 시작됐다.';
        log('움직였다. 들켰다 — 추격 시작!', 'hot');
      }
      const evNode = nodeById(ev.node);
      if (evNode) evNode.monsterResolved = true;
      run.holdEvent = null;
    }

    // 어둠붙이가 보이는 방향으로 전진하면 위험이 더 오른다.
    // 숨은 추격자가 있으면 시딩된 몬스터는 분위기용(triggerMonster 비활성)이므로,
    // 보이지 않는 dangerExit 세금을 물리지 않는다. 추격자가 없을 때만 옛 동작을 유지한다.
    if (node.dangerExit === targetId && !(run.floorMap && run.floorMap.stalker)) {
      run.danger = Math.min(100, run.danger + SIGHT_MOVE_DANGER);
    }

    if (effectiveLightPercent() <= 0) {
      const load = usedSlots() / Math.max(1, bagCap());
      const stumbleChance = 0.14 + load * 0.22 + (target.kind === 'stairs' ? 0.14 : 0);
      run.mental = Math.max(0, run.mental - 3);
      run.danger = Math.min(100, run.danger + 6 + Math.round(load * 6));
      emitNoise(node.id, { loud: load > 0.65 });
      if (Math.random() < stumbleChance) {
        run.lastAction = target.kind === 'stairs'
          ? '꺼진 조명으로 계단을 찾다가 발끝이 허공을 긁었다. 내려가기 전에 숨을 다시 고른다.'
          : '꺼진 조명 속에서 벽에 어깨를 부딪쳤다. 금속음이 낮게 번지고 발걸음이 멈췄다.';
        log(run.lastAction, 'hot');
        showDialogue(run.lastAction, 'hot');
        render();
        return;
      }
      log('조명을 끈 채 더듬어 움직였다. 배터리는 아꼈지만 발소리가 길게 끌렸다.', 'hot');
    }

    if (target.kind === 'stairs') { descend(); return; }

    const fromId = node.id;
    // 이미 깨어 있거나 추격 중이거나 짐을 들었을 때만 발소리를 남긴다.
    // 짐을 집기 전 첫 탐색은 완전히 잠든 추격자를 깨우지 않는다(공정성).
    if (stalkerAwake() || run.chasing || run.bag.length > 0) {
      emitNoise(fromId, { loud: false }); // 발을 떼는 소리로 추격자에게 이 칸을 기억시킨다.
    }
    beginTransition(() => {
      markTravelledEdge(fromId, targetId);
      run.previousNodeId = fromId;
      run.currentNodeId = targetId;
      arriveAtNode();
    }, 'move', MOVE_MS);
  }

  function chooseBackstep(targetId) {
    if (!run || run.moving || run.dialogue || run.pendingEvent) return;
    const s = stalker();
    if (s && s.nodeId === targetId && stalkerAwake()) {
      run.failContext = '뒷걸음친 순간 등 뒤에서 어두운 형체가 어깨를 눌렀다.';
      failRun();
      return;
    } else if (s && s.nodeId === targetId) {
      run.danger = Math.min(100, run.danger + 12);
      run.lastAction = '등 뒤 어둠이 차갑게 닿았다. 발목 뒤로 찬 공기가 붙는다.';
      log(run.lastAction, 'hot');
    }
    chooseExit(targetId);
  }

  function chooseHideInCover() {
    if (!run || run.moving || run.dialogue || run.pendingEvent || !currentRoomHasCover()) return;
    clearDialogue();
    const noisyBag = usedSlots() >= Math.max(2, Math.ceil(bagCap() * 0.7));
    const pressure = stalkerAwake() && (stalkerDistance() <= 2 || run.danger >= 55);
    run.lightOn = false;
    if (pressure && noisyBag && Math.random() < 0.45) {
      run.danger = Math.min(100, run.danger + 20);
      run.lastAction = '캐비닛 문을 닫는 순간 가방 안 금속이 부딪쳤다. 어두운 형체가 그 소리로 고개를 돌렸다.';
      log(run.lastAction, 'hot');
      startMonsterEncounter('critical', currentNode(), stalker() && stalker().kind);
      return;
    }
    const s = stalker();
    if (s) { s.quietSteps = DORMANT_AFTER; s.lastHeardId = null; s.nearCued = false; }
    run.chasing = false;
    run.danger = Math.max(0, run.danger - (pressure ? 35 : 12));
    run.lastAction = '캐비닛 뒤로 몸을 넣고 조명을 껐다. 발소리가 문 앞에서 멈췄다가 멀어진다.';
    log(run.lastAction);
    showDialogue(run.lastAction);
    render();
  }

  function toggleHandLight() {
    if (!run || run.moving || run.dialogue || run.pendingEvent || run.returnWalk) return;
    if (run.light <= 0) {
      run.lastAction = '스위치를 눌렀지만 손전등은 켜지지 않는다.';
      log(run.lastAction, 'hot');
      showDialogue(run.lastAction, 'hot');
      render();
      return;
    }
    run.lightOn = run.lightOn === false;
    if (run.lightOn) {
      run.light = Math.max(0, run.light - 1);
      run.danger = Math.min(100, run.danger + (stalkerAwake() ? 4 : 1));
      run.lastAction = '조명을 다시 켰다. 앞쪽 윤곽이 돌아오지만, 빛이 복도를 긁는다.';
      log(run.lastAction);
    } else {
      run.danger = Math.max(0, run.danger - (stalkerAwake() ? 8 : 2));
      run.lastAction = '조명을 껐다. 길은 사라졌지만, 숨소리는 낮아졌다.';
      log(run.lastAction);
    }
    render();
  }

  // 대기. 발소리를 흘려보낸다. 시간이 흘러 조명이 조금 닳고, 조용한 걸음이 쌓여 추격자는 결국 잠든다.
  function chooseWait() {
    if (!run || run.dialogue || run.moving || run.pendingEvent || !stalkerAwake()) return;
    clearDialogue();
    run.light = Math.max(0, run.light - WAIT_LIGHT_COST);
    const s = stalker();
    if (s) {
      s.quietSteps += 1 + (Math.random() < 0.5 ? 1 : 0);
      // 소리 없이 기다리는 동안에도 놈은 마지막 발소리 쪽으로 느리게 걷는다.
      // 단, 이미 바로 옆(거리 1)이면 무음 걸음으로 플레이어 칸에 올라앉지 않도록 움직이지 않는다.
      if (stalkerAwake() && stalkerDistance() > 1) moveStalkerOneStep({ silent: true });
    }
    run.chasing = stalkerAwake();
    if (!run.chasing) {
      run.lastAction = '젖은 발소리가 멀어진다.';
    } else if (stalkerDistance() <= 1) {
      run.lastAction = '숨을 죽였지만 가까운 어둠은 물러나지 않는다.';
    } else {
      run.lastAction = '발소리가 잠시 멀어진 듯하다.';
    }
    log(run.lastAction);
    showDialogue(run.lastAction);
    maybeQueueLightAlert();
    maybeQueueMentalAlert();
    render();
  }

  function grab() {
    if (!run || run.dialogue || run.pendingEvent || !run.currentItem) return;
    if (!roomFor(run.currentItem)) {
      showBagBlockedDialogue();
      render();
      return;
    }
    clearDialogue();
    const node = currentNode();
    const item = run.currentItem;
    run.bag.push(item);
    node.itemTaken = true;
    run.grabbedCount += 1;
    run.currentItem = null;
    run.light = Math.max(0, run.light - GRAB_LIGHT_COST);
    playGrabFx();
    const firstGrab = !run.chasing;
    // 기본 줍기(대기 이벤트 없는 일반 물건)는 조심스러운 손놀림이다: 아이템 noise를 반영하되
    // 낚아채기처럼 즉시 한 칸 끌어당기지는 않는다. 소리 큰 물건이면 경고 한 줄이 붙는다.
    // run.chasing 판정(firstGrab) 뒤에 호출한다 — emitNoise가 run.chasing을 켜기 때문.
    const noiseWarn = applyPickupNoise(node.id, item, true);
    const tail = noiseWarn ? ` ${noiseWarn}` : '';
    if (firstGrab) {
      run.chasing = true;
      run.danger = Math.max(run.danger, GRAB_DANGER_BUMP);
      const cue = pickupThreatCue(node);
      run.lastAction = `${item.name}${objectParticle(item.name)} 집었다. ${cue}${tail}`;
      log(`집었다. ${cue}${tail}`, 'hot');
      showDialogue(run.lastAction, 'hot');
    } else {
      run.danger = Math.min(100, run.danger + GRAB_DANGER_BUMP);
      const dir = reversePathDirection(node);
      const cue = dir ? `${dir}에서 발소리가 가까워진다.` : '젖은 발소리가 가까워진다.';
      run.lastAction = `${item.name}까지 챙겼다. ${cue}${tail}`;
      log(`${item.name}까지 챙겼다. ${cue}${tail}`, 'hot');
      showDialogue(run.lastAction, 'hot');
    }
    maybeQueueBagAlert();
    maybeQueueLightAlert();
    maybeQueueMentalAlert();
    render();
  }

  // 계단 아래로: 다음 층의 새 맵을 생성한다.
  function descend() {
    if (run.floor >= FLOORS.length) return;
    beginTransition(() => {
      run.floor += 1;
      run.light = Math.max(0, run.light - DESCEND_LIGHT_COST);
      if (run.chasing) run.danger = Math.min(100, run.danger + DESCEND_DANGER_BUMP);
      bumpMaxDepth(run.floor);
      if (run.floor > run.maxFloor) run.maxFloor = run.floor;
      if (run.floorMap) emitNoise(run.currentNodeId, { loud: true }); // 계단을 밟는 소리 — 새 층으로 넘어가기 직전 현재 층 추격자에게.
      enterFloor(run.floor);
    }, 'descend', DESCEND_MS);
  }

  function dropAndFlee() {
    if (run.dialogue || !run.chasing || run.bag.length === 0) return;
    clearDialogue();
    // 가장 비싼 물건을 떨군다 → 위험 급감. 이제 물건은 사라지지 않고 바닥 자국으로 남는다(끌개):
    // 던전은 미끼가 아니라 '되찾을 물건'을 좇는다. 놈보다 먼저 닿으면 다시 집을 수 있다.
    let idx = 0;
    run.bag.forEach((it, i) => { if (it.value > run.bag[idx].value) idx = i; });
    const dropped = run.bag.splice(idx, 1)[0];
    run.droppedCount += 1;
    run.danger = Math.max(0, run.danger * DROP_DANGER_FACTOR - DROP_DANGER_MINUS);
    dropLootTrace(dropped); // 던진 물건 쪽으로 추격자를 돌리고, 되찾을 수 있는 자국을 남긴다.
    const droppedObject = `${dropped.name}${objectParticle(dropped.name)}`;
    const shatter = itemFragile(dropped) ? ' 깨지는 소리가 났다.' : '';
    run.lastAction = `${droppedObject} 던지고 반대쪽으로 뛰었다.${shatter} 발소리가 던진 물건 쪽으로 돌아선다.`;
    log(run.lastAction);
    showDialogue(run.lastAction);
    render();
  }

  function dropBagItem(index) {
    if (!run || run.moving || run.returnWalk || run.dialogue || run.pendingEvent || run.bag.length === 0) return;
    const itemIndex = safeInt(index, -1, 0, run.bag.length - 1);
    if (itemIndex < 0) return;
    clearDialogue();
    const dropped = run.bag.splice(itemIndex, 1)[0];
    if (!dropped) return;
    run.droppedCount += 1;
    dropLootHere(dropped);
    if (run.chasing) run.danger = Math.max(0, run.danger - 4);
    run.seenBagAlerts.delete('full');
    run.seenBagAlerts.delete('blocked');
    run.lastAction = `${dropped.name}${objectParticle(dropped.name)} 가방에서 꺼내 바닥에 놓았다. 빈칸이 생겼다.`;
    log(run.lastAction);
    showDialogue(run.lastAction);
    render();
  }

  function returnPathLength() {
    if (!run || !run.floorMap) return 0;
    const travelled = run.floorMap.travelledEdges ? run.floorMap.travelledEdges.size : 0;
    const seenNodes = run.floorMap.nodes.filter((node) => node.entered).length;
    return Math.max(travelled, Math.max(0, seenNodes - 1)) + Math.max(0, run.floor - 1) * 4;
  }

  function returnRisk() {
    const lightPct = lightPercent();
    const slots = usedSlots();
    const path = returnPathLength();
    const causes = [];
    let score = 0;

    score += Math.max(0, run.floor - 1) * 13;
    score += Math.min(22, path * 4);
    if (slots > 0) score += Math.min(18, slots * 5 + run.bag.length * 2);
    if (lightPct < 45) score += 8;
    if (lightPct < 25) score += 14;
    if (run.mental < 40) score += 10;
    if (run.mental < 20) score += 16;
    if (run.danger >= 35) score += 10;
    if (run.danger >= 65) score += 18;
    if (run.chasing) score += 16;

    if (lightPct < 35) causes.push('light');
    if (run.mental < 35) causes.push('mental');
    if (run.chasing || run.danger >= 55) causes.push('pursuit');
    if (slots >= Math.max(2, Math.ceil(bagCap() * 0.6)) || run.bag.length >= 2) causes.push('bag');
    if (run.floor >= 2 || path >= 4) causes.push('depth');

    return { score, causes, path, lightPct, slots };
  }

  // 귀환 걷기 연출용 대사 풀. 시적 표현 대신 방/표식/계단을 구체적으로 되짚는다.
  const RETURN_WALK_RETRACE = [
    '표시해 둔 벽의 흠집을 따라 왔던 방을 되짚는다.',
    '지나온 갈림길에서 계단 쪽으로 꺾어 붙는다.',
    '바닥에 남긴 표식을 하나씩 밟으며 걷는다.',
    '무너진 선반 옆을 지나 입구 방향으로 향한다.',
    '젖은 복도를 되돌아 나가며 짐을 고쳐 멘다.',
    '갈라진 계단참을 딛고 한 층을 더 올라선다.',
  ];
  const RETURN_WALK_CLIMB = [
    '표식이 끝나는 지점에서 위쪽 계단의 빛이 보인다.',
    '난간을 짚고 마지막 계단을 하나씩 오른다.',
  ];
  const RETURN_WALK_PURSUIT = [
    '뒤쪽 어둠에서 젖은 발소리가 한 박자 늦게 따라붙는다.',
    '따라오던 발소리가 계단참 아래에서 멈췄다가 다시 움직인다.',
  ];
  const RETURN_WALK_FINAL = '마지막 계단을 올라 지상의 소음 속으로 나왔다.';

  function returnWalkPursuit(risk, opts) {
    return !!((opts && opts.pursuit)
      || (risk && risk.causes && risk.causes.includes('pursuit'))
      || (run && (run.chasing || run.danger >= 55)));
  }

  // 방문한 방/표식 수(returnPathLength)에 비례해 걷는 줄 수를 정하되 2~6줄로 묶어 지치지 않게 한다.
  function buildReturnWalkLines(risk, opts) {
    opts = opts || {};
    const pursuit = returnWalkPursuit(risk, opts);
    const offset = Math.max(0, Math.floor((risk && risk.path) || 0));
    if (opts.resolved) {
      // 위험 대응(선택)을 이미 끝낸 뒤라 방 되짚기는 생략하고 마지막 계단만 짧게 오른다(2~3줄).
      const lines = [];
      if (pursuit) lines.push(RETURN_WALK_PURSUIT[offset % RETURN_WALK_PURSUIT.length]);
      lines.push(RETURN_WALK_CLIMB[offset % RETURN_WALK_CLIMB.length]);
      lines.push(RETURN_WALK_FINAL);
      return lines;
    }
    // 안전 귀환: 왔던 방을 되짚는 줄 + 마지막 도착 줄.
    const path = (risk && risk.path) || returnPathLength();
    const n = clamp(2 + Math.round(path / 3), 2, 6);
    const lines = [];
    for (let i = 0; i < n - 1; i++) lines.push(RETURN_WALK_RETRACE[(offset + i) % RETURN_WALK_RETRACE.length]);
    // 추격 중이면 도착 직전 한 줄을 발소리 비트로 바꿔 긴장을 유지한다.
    if (pursuit && lines.length) lines[lines.length - 1] = RETURN_WALK_PURSUIT[offset % RETURN_WALK_PURSUIT.length];
    lines.push(RETURN_WALK_FINAL);
    return lines;
  }

  // 걷기 시퀀스를 대사 큐로 쌓는다. 큐가 비는 마지막 탭에서 dismissDialogue가 returnToSurface를 호출한다.
  function startReturnWalk(risk, opts) {
    opts = opts || {};
    clearDialogue();
    run.pendingEvent = null;
    run.returnWalk = true;
    if (opts.lead) showDialogue(opts.lead, opts.leadTone || '');
    else log('왔던 길을 되짚어 지상으로 향한다.', 'win');
    const walk = buildReturnWalkLines(risk, opts);
    const pursuitSet = new Set(RETURN_WALK_PURSUIT);
    walk.forEach((text) => {
      const tone = pursuitSet.has(text) ? 'hot' : (text === RETURN_WALK_FINAL ? 'win' : '');
      showDialogue(text, tone);
    });
    render();
  }

  function makeReturnEvent(risk) {
    const choice = (id, label, sub, tone = '') => eventChoice(id, label, sub, tone);
    const has = (cause) => risk.causes.includes(cause);
    if (has('pursuit')) {
      const choices = [
        choice('lights-out', '조명을 끈다', '어둠에 숨는다', 'good'),
        choice('sprint', '그냥 뛴다', '숨이 차오른다', risk.score >= 90 ? 'danger' : ''),
      ];
      if (run.bag.length > 0) choices.splice(1, 0, choice('bait', '미끼를 던진다', '짐을 하나 버린다', 'good'));
      return {
        type: 'return-attempt',
        variant: 'pursuit',
        title: '따라오는 발소리',
        cue: '올라가는 계단 아래에서 들리는 젖은 발소리가 내 발소리에 겹쳐 들린다.',
        risk,
        choices,
      };
    }
    if (has('light')) {
      const choices = [
        choice('feel-wall', '벽을 짚고 오른다', '금 간 선을 따른다', 'good'),
        choice('save-light', '빛을 아낀다', '조명을 낮춘다'),
      ];
      if (run.bag.length > 0) choices.push(choice('drop-one', '가방 하나를 버린다', '몸을 가볍게 한다', 'good'));
      return {
        type: 'return-attempt',
        variant: 'light',
        title: '어두운 계단',
        cue: '손전등 원이 계단 중간에서 끊긴다. 위쪽 난간만 젖어 번들거린다.',
        risk,
        choices,
      };
    }
    if (has('bag')) {
      return {
        type: 'return-attempt',
        variant: 'bag',
        title: '무거운 가방',
        cue: '가방 끈이 어깨를 파고든다. 내려올 때보다 계단 폭이 좁아 보인다.',
        risk,
        choices: [
          choice('drop-light', '가벼운 것부터 버린다', '작은 무게를 놓는다', 'good'),
          choice('retie', '끈을 고쳐 묶는다', '매듭을 조인다'),
          choice('haul', '그대로 오른다', '어깨로 버틴다', risk.score >= 85 ? 'danger' : ''),
        ],
      };
    }
    return {
      type: 'return-attempt',
      variant: 'mental',
      title: '끝없는 복도',
      cue: '돌아가는 복도가 한 번 더 늘어난다. 뒤돌아보면 입구 표식이 지워질 것 같다.',
      risk,
      choices: [
        choice('count-breath', '호흡을 가다듬는다', '숨을 고른다', 'good'),
        choice('no-look', '뒤돌아보지 않는다', '표식을 믿는다'),
        choice('run-up', '뛰어 오른다', '무너진 길을 오른다', risk.score >= 85 ? 'danger' : ''),
      ],
    };
  }

  function attemptReturnToSurface() {
    if (!run || run.moving || run.dialogue || run.pendingEvent) return;
    clearDialogue();
    const risk = returnRisk();
    if (risk.score < 42) {
      // 안전 귀환도 즉시 순간이동하지 않고, 던전 화면에서 짧은 걷기 시퀀스를 탭으로 넘긴다.
      startReturnWalk(risk);
      return;
    }
    const ev = makeReturnEvent(risk);
    run.pendingEvent = ev;
    run.lastAction = ev.cue;
    log(ev.cue, 'hot');
    showDialogue(ev.cue, 'hot');
    render();
  }

  function resolveReturnAttempt(ev, choiceId) {
    let msg = '';
    let knockedOut = false;
    const risky = ev.risk.score >= 86;
    const veryRisky = ev.risk.score >= 102;
    // TODO(끌개 v2): 귀환 중 버린 짐은 dropLootTrace로 자국을 남기지 않는다 — 이 시점엔 이미
    // 계단을 오르며 층을 떠나므로(startReturnWalk) 플레이어가 되찾을 수 없다. 되찾기 루프가
    // 성립하지 않아 v1에서는 조용히 잃는다. 층에 남아 다시 내려갈 수 있게 되면 그때 연결한다.
    const loseCheapest = (fallback) => {
      const lost = takeCheapestBagItem();
      if (!lost) return fallback || '버릴 짐이 없다. 가방이 빈 소리만 낸다.';
      run.droppedCount += 1;
      return `${lost.name}${objectParticle(lost.name)} 놓고 왔다.`;
    };

    if (ev.variant === 'pursuit') {
      if (choiceId === 'lights-out') {
        run.light = Math.max(0, run.light - 4);
        run.danger = Math.max(0, run.danger - 18);
        msg = '조명을 끄자, 젖은 발소리가 한 층 아래에서 맴돈다. 난간을 붙잡고 위쪽 계단으로 붙는다.';
      } else if (choiceId === 'bait') {
        msg = `${loseCheapest()} 젖은 발소리가 그쪽으로 멀어진 틈에 계단으로 붙는다.`;
        run.danger = Math.max(0, run.danger - 28);
      } else {
        run.light = Math.max(0, run.light - 10);
        run.mental = Math.max(0, run.mental - 16);
        run.danger = Math.min(100, run.danger + 18);
        msg = '숨이 터질 때까지 뛰었다. 젖은 발소리가 마지막 계단까지 따라붙는다.';
        knockedOut = veryRisky || run.danger >= 100 || run.mental <= 0;
      }
    } else if (ev.variant === 'light') {
      if (choiceId === 'feel-wall') {
        run.mental = Math.max(0, run.mental - 8);
        run.danger = Math.max(0, run.danger - 4);
        msg = '벽의 금 간 선을 손끝으로 짚으며 오른다. 손바닥이 젖었지만 길은 잃지 않았다.';
      } else if (choiceId === 'drop-one') {
        msg = `${loseCheapest()} 가방이 가벼워지자 어둠 속 계단 폭이 다시 맞아떨어진다.`;
        run.danger = Math.max(0, run.danger - 10);
      } else {
        run.danger = Math.min(100, run.danger + 12);
        msg = '빛을 아끼자 계단참의 윤곽이 지워진다. 젖은 난간만 따라 겨우 짚어 나간다.';
        knockedOut = veryRisky && run.mental < 18;
      }
    } else if (ev.variant === 'bag') {
      if (choiceId === 'drop-light') {
        msg = `${loseCheapest()} 어깨에 걸린 무게가 줄었다. 남은 짐을 안고 계단으로 붙는다.`;
        run.danger = Math.max(0, run.danger - 8);
      } else if (choiceId === 'retie') {
        run.light = Math.max(0, run.light - 5);
        run.mental = clamp(run.mental + 3, 0, 100);
        msg = '끈을 짧게 묶자 무게가 등 가운데로 붙는다. 느리지만 흔들리지 않고 오른다.';
      } else {
        run.mental = Math.max(0, run.mental - 14);
        run.danger = Math.min(100, run.danger + 10);
        msg = '가방이 계단 모서리에 계속 걸린다. 마지막에는 거의 끌다시피 오른다.';
        knockedOut = veryRisky && (usedSlots() >= bagCap() || run.mental <= 0);
      }
    } else {
      if (choiceId === 'count-breath') {
        run.light = Math.max(0, run.light - 6);
        run.mental = clamp(run.mental + 10, 0, 100);
        msg = '호흡을 손안에 모으자 복도의 길이가 제자리로 돌아온다.';
      } else if (choiceId === 'no-look') {
        run.mental = Math.max(0, run.mental - 6);
        run.danger = Math.max(0, run.danger - 3);
        msg = '뒤를 보지 않았다. 사라지는 표식 대신 발밑 경사만 믿고 오른다.';
      } else {
        run.mental = Math.max(0, run.mental - 18);
        run.danger = Math.min(100, run.danger + 12);
        msg = '뛰어오르는 동안 복도가 접혔다 펴진다. 숨이 끊어질 듯하다.';
        knockedOut = risky && run.mental <= 10;
      }
    }

    if (knockedOut) {
      run.pendingEvent = null;
      run.failContext = msg;
      run.lastAction = msg;
      log(msg, 'hot');
      showDialogue(msg, 'hot');
      failRun();
      return;
    }
    run.pendingEvent = null;
    run.lastAction = msg;
    const returnTone = /발소리|사라진다|끊어질/.test(msg) ? 'hot' : 'win';
    log(msg, returnTone);
    // 위험 대응을 끝냈어도 곧장 지상으로 순간이동하지 않는다. 결과 문장을 먼저 보여준 뒤,
    // 마지막 계단을 오르는 짧은 걷기 시퀀스를 재생하고 마지막 탭에서 지상으로 나간다.
    startReturnWalk(ev.risk, { lead: msg, leadTone: returnTone, pursuit: ev.variant === 'pursuit', resolved: true });
  }

  function returnToSurface() {
    stopTick();
    run.lastSale = run.bag.slice();
    run.chasing = false;
    run.bought = false;
    const gainedMutation = grantMutationOnReturn();
    if (gainedMutation) {
      run.mutationNote = gainedMutation.gainLog;
      log(gainedMutation.gainLog, 'hot');
    }
    // 빈손 귀환도 판매 화면을 거친다: 출구 경로를 고르고 판매처(위원회/암시장)를 눌러야 강화로 넘어간다.
    // chooseBuyer가 raw 0을 안전 처리하므로 빈 가방이어도 문제없이 진행된다.
    renderReturnScreen();
    show('screen-return');
  }

  // 선택한 출구가 판매 견적에 더하는 결정적 보정. 물건은 파괴하지 않고 값만 조정한다.
  // gainDelta는 gained에 접어 넣어(통행료·긁힘 포함) chooseBuyer에서 딱 한 번만 반영된다.
  function routeEffect() {
    const route = run.exitRoute || 'official';
    if (route === 'crack') {
      const fragileValue = run.bag.reduce((s, it) => s + (itemFragile(it) ? it.value : 0), 0);
      const fissure = hasMutation('fissure-sight');
      const scratch = Math.round(fragileValue * (fissure ? FISSURE_SCRATCH_RATE : EXIT_SCRATCH_RATE));
      let note = scratch > 0
        ? `균열 출구 — 검문을 피하지만 물건이 긁힌다. 이번 짐은 -${scratch} RP.`
        : '균열 출구 — 검문을 피하지만 물건이 긁힌다. 이번엔 긁힐 게 없었다.';
      if (fissure && scratch > 0) note = `${note} ${FISSURE_EXIT_NOTE}`;
      return {
        route,
        suspDelta: -EXIT_CRACK_SUSP_RELIEF,
        gainDelta: -scratch,
        blackSuspRelief: 0,
        note,
      };
    }
    if (route === 'blackpass') {
      // 빈손이면 통행료를 받지 않는다. 견적에서 깎을 짐값이 없으니 gainDelta도 0으로 둔다.
      const noCargo = bagValue() <= 0;
      return {
        route,
        suspDelta: 0,
        gainDelta: noCargo ? 0 : -EXIT_PASSAGE_FEE,
        blackSuspRelief: EXIT_PASSAGE_BLACK_RELIEF,
        note: noCargo
          ? '암시장 통로 — 빈손이라 통행료를 받지 않았다. 바로 뒷골목에 붙어 꼬리가 덜 남는다.'
          : `암시장 통로 — 통행료 -${EXIT_PASSAGE_FEE} RP로 바로 뒷골목에 붙어 꼬리가 덜 남는다.`,
      };
    }
    const heatTotal = run.bag.reduce((s, it) => s + itemHeat(it), 0);
    const dueHeat = heatTotal >= EXIT_CHECKPOINT_HEAT;
    const dueSusp = meta.suspicion >= EXIT_CHECKPOINT_SUSP;
    const checkpoint = dueHeat || dueSusp;
    const insiderRelief = checkpoint && hasSurvivor('insider') ? INSIDER_CHECKPOINT_RELIEF : 0;
    let suspDelta = checkpoint ? Math.max(0, EXIT_CHECKPOINT_SUSP_ADD - insiderRelief) : 0;
    let note = checkpoint
      ? (insiderRelief > 0
        ? '공식 출구 — 검문이 있었지만 낡은 직원 코드가 의심을 조금 눌렀다.'
        : dueHeat
          ? '공식 출구 — 안전하지만 검문이 있다. 짐이 뜨거워 검문대가 의심도를 조금 올렸다.'
          : '공식 출구 — 안전하지만 검문이 있다. 이름이 검문 명단에 올라 의심도가 조금 올랐다.')
      : '공식 출구 — 안전하지만 검문이 있다. 이번엔 무사히 통과했다.';
    if (checkpoint && hasMutation('black-hand')) {
      suspDelta += BLACKHAND_CHECKPOINT_SUSP;
      note = `${note} ${BLACKHAND_CHECKPOINT_NOTE}`;
    }
    return {
      route,
      suspDelta,
      gainDelta: 0,
      blackSuspRelief: 0,
      note,
    };
  }

  function committeeSuspicionDelta(itemCount, muffled) {
    let delta = -Math.min(10, 2 + Math.max(0, itemCount) * 2);
    if (muffled) delta = Math.min(0, delta + MUFFLED_COMMITTEE_SUSP);
    return delta;
  }

  function saleQuote(buyer) {
    const raw = bagValue();
    const eff = routeEffect();
    let gained, suspDelta;
    if (buyer === 'committee') {
      gained = Math.ceil(raw * 0.72);
      suspDelta = committeeSuspicionDelta(run.bag.length, hasMutation('muffled-skin'));
    } else if (buyer === 'family') {
      return familyReturnQuote(run.bag, eff);
    } else {
      // 암시장 의심도는 물건별 heat 합(등급이 아니라 물건 태그). 태그 없으면 등급으로 보정.
      const heat = run.bag.reduce((sum, it) => sum + itemHeat(it), 0);
      gained = Math.ceil(raw * 1.35);
      suspDelta = eff.blackSuspRelief ? Math.max(0, heat - eff.blackSuspRelief) : heat;
    }
    gained = Math.max(0, gained + eff.gainDelta);
    suspDelta += eff.suspDelta;
    const muffledNote = buyer === 'committee' && hasMutation('muffled-skin') ? MUFFLED_COMMITTEE_NOTE : '';
    return { gained, suspDelta, note: [eff.note, muffledNote].filter(Boolean).join(' '), route: eff.route };
  }

  function chooseBuyer(buyer) {
    const quote = saleQuote(buyer);
    run.exitNote = quote.note; // 강화 화면 요약에 출구 결과를 남긴다
    const previousTruthCount = meta.truths.length;
    meta.rp += quote.gained;
    meta.totalEarned += quote.gained;
    meta.suspicion = Math.max(0, Math.min(99, meta.suspicion + quote.suspDelta));
    run.lastBuyer = buyer;
    run.lastTruth = null;

    if (buyer === 'black') {
      const unknown = run.lastSale.find((it) => it.truth && !meta.truths.includes(it.name));
      if (unknown) {
        meta.truths.push(unknown.name);
        run.lastTruth = unknown.truth;
      }
    }

    if (previousTruthCount !== meta.truths.length) {
      log('암시장 정보상이 진실 조각 하나를 넘겼다.', 'win');
    }
    // 마지막 진실 조각이 이번 판매로 처음 채워졌는가(아래→가득). 매 런 반복 발동을 막는다.
    const endingUnlocked =
      previousTruthCount < TRUTH_TOTAL &&
      meta.truths.length >= TRUTH_TOTAL &&
      !meta.endingSeen;

    resolveContract(buyer);
    saveMeta(); // 판매처 선택 후 자동 저장 (RP·의심도·진실 조각 반영)
    run.streetNews = makeStreetNews(buyer, quote);
    // RP/의심도/의뢰/저장은 그대로 반영하고, 강화 화면도 미리 렌더한다(계속 버튼이 곧장 보여줄 수 있게).
    renderUpgradeScreen(quote.gained);
    if (endingUnlocked) {
      renderEndingScreen();
      show('screen-ending');
    } else {
      show('screen-upgrade');
    }
  }

  function failRun() {
    stopTick();
    const lost = bagValue();
    const outcome = RECOVERY_OUTCOMES[Math.floor(Math.random() * RECOVERY_OUTCOMES.length)];
    // 의무병 구출 시: 오르는 의심도를 덜어내고(양수 델타만), 위로 보상을 조금 더 챙겨준다.
    const medic = hasSurvivor('medic');
    let consolation = lost > 0 ? Math.max(0, Math.round(lost * outcome.rpRate)) : 0;
    let suspDelta = outcome.suspDelta;
    let medicBonus = 0;
    if (medic) {
      if (suspDelta > 0) suspDelta = Math.max(0, suspDelta - MEDIC_SUSPICION_RELIEF);
      if (lost > 0) { medicBonus = Math.max(1, Math.round(lost * MEDIC_CONSOLATION_RATE)); consolation += medicBonus; }
    }
    const previousSuspicion = meta.suspicion;
    meta.rp += consolation;
    meta.totalEarned += consolation;
    meta.suspicion = Math.max(0, Math.min(99, meta.suspicion + suspDelta));
    const lostBag = bagProduct();
    const hadBag = meta.bagLevel > NO_BAG_LEVEL;
    meta.bagLevel = NO_BAG_LEVEL;
    saveMeta(); // 실패 보상 후 자동 저장
    el['fail-recovery'].innerHTML = `<b>${outcome.elapsed}</b><span>${outcome.title}</span><p>${outcome.body}</p>`;
    const suspChange = meta.suspicion - previousSuspicion;
    const suspText = suspChange === 0 ? '변화 없음' : signed(suspChange);
    el['fail-detail'].innerHTML = [
      run.failContext ? `마지막 순간: ${run.failContext}` : '',
      lost > 0
        ? `잃은 짐 ${lost} RP · 남은 조각 +${consolation} RP`
        : '빈손이라 잃은 회수품은 없었다.',
      outcome.loss,
      hadBag ? `${lostBag.name}${subjectParticle(lostBag.name)} 함께 사라졌다. 다음 조사는 맨손으로 시작한다.` : '가방은 없었다. 다음 조사도 맨손이다.',
      medic ? `의무병이 상처를 감싸고 뒤처리를 도왔다${medicBonus > 0 ? ` (+${medicBonus} RP)` : ''}.` : '',
      `의심도 ${suspText}`,
    ].filter(Boolean).map((line) => `<div>${line}</div>`).join('');
    el['fail-susp'].textContent = meta.suspicion;
    run.chasing = false;
    render();
    show('screen-fail');
  }

  /* ---------------- 강화 ---------------- */

  function buyUpgrade(type) {
    if (type === 'bag') { toggleBagShop(); return; }
    if (run.bought) return;
    const lvKey = type + 'Level';
    const cost = upgradeCost(type); // 정비공 구출 시 장비 강화는 할인가로 계산된다
    if (meta.rp < cost) return;
    meta.rp -= cost;
    meta[lvKey] += 1;
    run.bought = true;
    bagShopOpen = false;
    saveMeta(); // 강화 구매 후 자동 저장
    log(`${UPGRADES[type].label}${objectParticle(UPGRADES[type].label)} 손봤다. 다음엔 더 버틴다.`, 'win');
    renderUpgradeScreen(null); // 잔액/버튼 상태 갱신
  }

  function toggleBagShop() {
    if (!run || run.bought) return;
    bagShopOpen = !bagShopOpen;
    renderUpgradeScreen(null);
  }

  function buyBag(level) {
    if (!run || run.bought) return;
    const product = BAG_PRODUCTS.find((bag) => bag.level === level);
    if (!product || product.level <= NO_BAG_LEVEL || product.level <= meta.bagLevel) return;
    if (meta.rp < product.cost) return;
    meta.rp -= product.cost;
    meta.bagLevel = product.level;
    run.bought = true;
    bagShopOpen = false;
    saveMeta();
    log(`${product.name}${objectParticle(product.name)} 샀다. 다음 조사는 ${product.cap}칸까지 멜 수 있다.`, 'win');
    renderUpgradeScreen(null);
  }

  function riskState() {
    if (!run || !run.chasing) return { key: 'safe', label: '정적', copy: '' };
    if (run.danger >= 85) return { key: 'critical', label: '숨소리', copy: '' };
    if (run.danger >= 65) return { key: 'danger', label: '금속음', copy: '' };
    if (run.danger >= 35) return { key: 'warn', label: '잡음', copy: '' };
    return { key: 'safe', label: '먼곳에서', copy: '' };
  }

  /* ---------------- 렌더링 ---------------- */

  function render() {
    if (!run) return;
    const f = FLOORS[run.floor - 1];

    // HUD
    el['hud-rp'].textContent = meta.rp;
    el['hud-depth'].textContent = meta.maxDepth;
    const bagName = meta.bagLevel === NO_BAG_LEVEL ? '맨손' : `${usedSlots()}/${bagCap()}`;
    el['hud-bag'].textContent = bagName;
    el['start-rp'].textContent = meta.rp;
    el['start-depth'].textContent = meta.maxDepth;
    el['start-susp'].textContent = meta.suspicion;
    renderCodex();
    renderGoals();
    renderContractCards();

    // 층 배너
    el['floor-num'].textContent = f.n;
    el['floor-name'].textContent = f.name;

    // 조명 게이지
    const lightPct = lightPercent();
    const light = lightState();
    el['light-fill'].style.width = lightPct + '%';
    el['light-fill'].classList.toggle('low', lightPct <= 25);
    el['light-val'].textContent = `${light.label} ${lightPct}%`;

    // 멘탈 게이지
    const mentalPct = Math.round(run.mental);
    if (el['mental-fill']) {
      el['mental-fill'].style.width = mentalPct + '%';
      el['mental-fill'].classList.toggle('low', mentalPct <= 25);
    }
    if (el['mental-val']) el['mental-val'].textContent = mentalPct + '%';

    // 위험 게이지
    el['danger-fill'].style.width = run.danger + '%';
    el['danger-fill'].classList.toggle('high', run.danger >= 70);
    const risk = riskState();
    el['danger-val'].textContent = risk.label;
    if (el['risk-panel']) {
      el['risk-panel'].className = `risk-panel ${risk.key} minimal`;
      el['risk-chip'].textContent = risk.label;
      const encounter = run.pendingEvent && run.pendingEvent.type === 'monster-encounter';
      el['risk-copy'].textContent = encounter ? `어두운 형체 접근 ${Math.ceil(run.encounterTime || 0)}초` : risk.copy;
    }

    // 가방 슬롯
    renderBag();

    // 갈림길 / 스테이지 / 깊이 레일
    renderChoices();
    renderSituationLayer();
    const dialogueOpen = !!run.dialogue;
    if (el['stage']) {
      const monsterCrisisOpen = !!(run.pendingEvent && run.pendingEvent.type === 'monster-encounter');
      el['stage'].classList.toggle('moving', !!run.moving);
      el['stage'].classList.toggle('has-loot', !!run.currentItem);
      el['stage'].classList.toggle('monster-encounter', monsterCrisisOpen);
      el['stage'].classList.toggle('returning', !!run.returnWalk);
    }
    renderStage();
    renderDepthRail();
    renderMiniMap();

    // 액션 버튼: 줍기(스테이지 위), 버리고 도망, 나가기.
    if (el['dock']) {
      el['dock'].classList.toggle('hidden', !!(run.moving || dialogueOpen));
      el['dock'].setAttribute('aria-hidden', dialogueOpen ? 'true' : 'false');
    }
    const canTouchGrab = !!(run.currentItem && !run.moving && !run.pendingEvent && !dialogueOpen);
    const canGrab = !!(canTouchGrab && roomFor(run.currentItem));
    el['btn-grab'].classList.toggle('hidden', !canTouchGrab);
    el['btn-grab'].disabled = !canTouchGrab;
    el['btn-grab'].classList.toggle('danger', !!(canTouchGrab && !canGrab));
    el['btn-grab'].textContent = run.currentItem ? (canGrab ? '줍기' : '가방 가득') : '';

    const showDrop = run.chasing && run.bag.length > 0;
    el['btn-drop'].disabled = !showDrop || dialogueOpen;
    el['btn-drop'].classList.toggle('hidden-action', !showDrop);
    if (el['dock-actions']) el['dock-actions'].classList.toggle('has-drop', showDrop);
    el['btn-return'].disabled = !!(run.moving || run.pendingEvent || dialogueOpen);
    el['btn-drop'].textContent = '↙ 버리고 도망';
    el['btn-return'].textContent = run.pendingEvent && run.pendingEvent.type === 'return-attempt'
      ? '↩ 올라가는 중'
      : (run.bag.length > 0 ? '↩ 나가기' : '↩ 돌아가기');
  }

  function renderBag() {
    const cap = bagCap();
    const cells = [];
    // 각 물건이 차지하는 칸을 색으로 채운다. 채워진 칸은 같은 itemIndex를 공유해 어느 칸을 눌러도 그 물건을 버린다.
    run.bag.forEach((item, itemIndex) => {
      for (let s = 0; s < item.slots; s++) {
        cells.push({ color: TIER_COLOR[item.tier], icon: item.icon, label: s === 0 ? item.name : '', item, itemIndex });
      }
    });
    while (cells.length < cap) cells.push(null);

    el['bag-slots'].innerHTML = '';
    cells.forEach((c) => {
      const d = document.createElement('div');
      d.className = 'slot' + (c ? ' filled droppable' : '');
      if (c) {
        d.style.setProperty('--tier-color', c.color);
        d.setAttribute('role', 'button');
        d.setAttribute('tabindex', '0');
        d.setAttribute('aria-label', `${c.item.name} 버리기`);
        d.dataset.itemIndex = String(c.itemIndex);
        d.innerHTML = itemIcon(c.icon) + (c.label ? `<span class="slot-label">${c.label}</span>` : '');
        const handleDrop = (event) => {
          event.preventDefault();
          event.stopPropagation();
          dropBagItem(d.dataset.itemIndex);
        };
        d.addEventListener('click', handleDrop);
        d.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          handleDrop(event);
        });
      }
      el['bag-slots'].appendChild(d);
    });
  }

  const DIR_SLOTS = [
    { key: 'nw', cls: 'dir-nw', glyph: '↖', label: '왼쪽 앞' },
    { key: 'n',  cls: 'dir-n',  glyph: '↑',  label: '앞' },
    { key: 'ne', cls: 'dir-ne', glyph: '↗', label: '오른쪽 앞' },
    { key: 'w',  cls: 'dir-w',  glyph: '←',  label: '왼쪽' },
    { key: 'e',  cls: 'dir-e',  glyph: '→',  label: '오른쪽' },
    { key: 'sw', cls: 'dir-sw', glyph: '↙', label: '왼쪽 뒤' },
    { key: 's',  cls: 'dir-s',  glyph: '↓',  label: '뒤' },
    { key: 'se', cls: 'dir-se', glyph: '↘', label: '오른쪽 뒤' },
  ];

  function directionForExit(source, target, index, used) {
    const key = directionKeyBetween(source, target);
    if (key && !used.has(key)) {
      used.add(key);
      return DIR_SLOTS.find((d) => d.key === key);
    }
    // Coordinate placement tries to keep directions unique per node. If a rare
    // procedural collision still happens, keep every exit usable by placing the
    // overflow in the first empty pad slot rather than leaking destination names.
    const fallback = DIR_SLOTS[index % DIR_SLOTS.length];
    for (const dir of DIR_SLOTS) {
      if (!used.has(dir.key)) { used.add(dir.key); return dir; }
    }
    return fallback;
  }

  function movementChoiceCopy(dir, target) {
    const stairs = target && target.kind === 'stairs';
    return {
      label: stairs ? '계단' : dir.label,
      aria: stairs ? `${dir.label} 계단 아래로` : `${dir.label} 방향`,
    };
  }

  const GENERIC_SITUATION_SENTENCES = new Set();

  function cleanSituationText(text) {
    const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?。！？]+[.!?。！？]?/g) || [];
    const seen = new Set();
    return sentences.map((sentence) => sentence.trim()).filter((sentence) => {
      if (!sentence || GENERIC_SITUATION_SENTENCES.has(sentence) || seen.has(sentence)) return false;
      seen.add(sentence);
      return true;
    }).join(' ');
  }

  function situationCopy(node) {
    const here = node.kind === 'entry' ? '입구.' : (node.desc ? `${node.desc}.` : '어둠 속 공간.');
    const item = run.currentItem ? ` 눈앞에 ${run.currentItem.name}${subjectParticle(run.currentItem.name)} 있다. ${run.currentItem.slots}칸.` : '';
    const pending = run.pendingEvent ? ` ${run.pendingEvent.title}: ${run.pendingEvent.cue}` : '';
    // 추격자가 깨어 가까이 있으면 방향 큐를, 없으면 추격 중일 때만 일반 발소리 문구를 붙인다(중복 없음).
    const cue = stalkerCue();
    const chase = cue ? ` ${cue}` : (run.chasing ? ' 젖은 발소리가 따라붙는다.' : '');
    const action = run.lastAction && (!run.pendingEvent || run.lastAction !== run.pendingEvent.cue) ? ` ${run.lastAction}` : '';
    return cleanSituationText(`${here}${item}${pending}${chase}${action}`);
  }

  function stageSituationCopy() {
    if (!run || !run.floorMap) return '';
    const pending = run.pendingEvent ? `${run.pendingEvent.title}: ${run.pendingEvent.cue}` : '';
    return cleanSituationText(pending || run.lastAction || situationCopy(currentNode()));
  }

  function renderSituationLayer() {
    if (!run) return;
    const recent = stageSituationCopy();
    if (el['stage-situation']) el['stage-situation'].textContent = recent || '아래가 열린다.';
    if (!el['dialogue-card'] || !el['dialogue-copy']) return;
    const card = el['dialogue-card'];
    // 대사 큐가 비면, 대기 중인 이벤트의 큐를 선택지 위 sticky 카드로 계속 보여준다(탭으로 사라지지 않음).
    const pendingCue = !run.dialogue && run.pendingEvent && run.pendingEvent.cue
      ? { text: run.pendingEvent.cue, tone: run.pendingEvent.tone !== undefined ? run.pendingEvent.tone : 'hot', sticky: true }
      : null;
    const dialogue = run.dialogue || pendingCue;
    card.className = 'dialogue-card' + (dialogue ? '' : ' hidden') + (dialogue && dialogue.tone ? ` ${dialogue.tone}` : '') + (dialogue && dialogue.sticky ? ' sticky' : '');
    if (dialogue) el['dialogue-copy'].textContent = dialogue.text;
    if (dialogue) card.setAttribute('aria-label', dialogue.sticky ? '조우 상황' : '상황 대화 계속');
    const hint = card.querySelector('.dialogue-hint');
    if (hint && dialogue) hint.textContent = dialogue.sticky ? '선택으로 대응' : '탭해서 계속';
  }

  function mapperHint(node) {
    if (!node) return '';
    if (node.kind === 'stairs') return '아래 계단';
    if (node.item && !node.itemTaken) return '짐 그림자';
    return MAPPER_FEATURE[node.kind] || '';
  }

  function mapperCueLine(node) {
    if (!hasSurvivor('mapper') || !node) return '';
    const pairs = [
      ['앞', relativeExit('front')],
      ['왼쪽', relativeExit('left')],
      ['오른쪽', relativeExit('right')],
      ['뒤', relativeExit('back')],
    ];
    const parts = [];
    pairs.forEach(([label, id]) => {
      if (id == null) return;
      const hint = mapperHint(nodeById(id));
      if (hint) parts.push(`${label} ${hint}`);
    });
    return parts.length ? `지도공 표시: ${parts.slice(0, 3).join(' · ')}` : '';
  }

  function fissureCueLine(node) {
    if (!hasMutation('fissure-sight') || hasSurvivor('mapper') || !node) return '';
    const pairs = [
      ['앞', relativeExit('front')],
      ['왼쪽', relativeExit('left')],
      ['오른쪽', relativeExit('right')],
      ['뒤', relativeExit('back')],
    ];
    const parts = [];
    pairs.forEach(([label, id]) => {
      if (id == null) return;
      const target = nodeById(id);
      const hint = target && (target.kind === 'stairs' ? '계단' : target.item && !target.itemTaken ? '물건' : target.kind === 'crack' ? '틈' : '');
      if (hint) parts.push(`${label} ${hint}`);
    });
    return parts.length ? `균열 시야: ${parts.slice(0, 2).join(' / ')}` : '';
  }

  // 현재 노드의 출구(+상황 선택지)를 8방향 패드로 그린다. 장소명은 도착 후 상황 텍스트로만 알려준다.
  function renderChoices() {
    const dock = el['room-choices'];
    if (!dock) return;
    if (!run || run.moving || !run.floorMap) {
      if (dock.dataset.choiceSig !== 'empty') {
        dock.innerHTML = '';
        dock.dataset.choiceSig = 'empty';
      }
      if (el['choice-cue'] && run && run.floorMap) el['choice-cue'].textContent = situationCopy(currentNode());
      return;
    }
    const node = currentNode();
    const baseCue = situationCopy(node);
    const mapperLine = mapperCueLine(node);
    const fissureLine = mapperLine ? '' : fissureCueLine(node);
    const cue = [baseCue, mapperLine, fissureLine].filter(Boolean).join(' ');

    if (run.pendingEvent) {
      const sig = `event:${run.currentNodeId}:${run.pendingEvent.type}:${run.pendingEvent.choices.map((choice) => choice.id).join(',')}`;
      if (dock.dataset.choiceSig !== sig) {
        dock.classList.remove('spatial', 'facing-pad');
        dock.classList.add('event-choices');
        dock.innerHTML = run.pendingEvent.choices.map((choice) => {
          const tone = choice.tone ? ` ${choice.tone}` : '';
          const sub = choice.sub ? `<span>${choice.sub}</span>` : '';
          return `<button class="btn room-btn event-btn${tone}" data-act="event" data-choice="${choice.id}"><i class="dir-glyph">?</i><span class="choice-text"><b>${choice.label}</b>${sub}</span></button>`;
        }).join('');
        dock.dataset.choiceSig = sig;
        dock.querySelectorAll('[data-act="event"]').forEach((btn) => {
          btn.addEventListener('click', (event) => {
            event.stopPropagation();
            resolveRoomEvent(btn.dataset.choice);
          });
        });
      }
      if (el['choice-cue']) el['choice-cue'].textContent = cue;
      return;
    }

    const frontId = relativeExit('front');
    const backId = relativeExit('back');
    const towardId = stalkerTowardExit();
    const moveSig = `face:${run.currentNodeId}:${run.facing}:${frontId == null ? '-' : frontId}:${backId == null ? '-' : backId}:t${towardId == null ? '-' : towardId}:${run.lightOn === false ? 'off' : 'on'}:${lightPercent() <= 0 ? 'dead' : 'charged'}`;
    if (dock.dataset.choiceSig === moveSig) {
      if (el['choice-cue']) el['choice-cue'].textContent = cue;
      return;
    }

    dock.classList.remove('event-choices');
    dock.classList.add('spatial', 'facing-pad');
    const front = frontId != null ? nodeById(frontId) : null;
    const back = backId != null ? nodeById(backId) : null;
    const frontTone = frontId != null && frontId === towardId ? ' toward-threat' : '';
    const frontLabel = front ? (front.kind === 'stairs' ? '계단으로' : '앞으로') : '막힘';
    const backLabel = back ? '뒤로' : '뒤 막힘';
    const lightToggleLabel = run.lightOn === false ? '조명 켜기' : '조명 끄기';
    const lightToggleSub = run.lightOn === false ? '배터리를 쓰고 시야를 되찾는다' : '빛을 숨겨 기척을 낮춘다';
    const centerControl = run.lightOn === false
      ? `<button class="btn room-btn dir-wait good" data-act="toggle-light"><i class="dir-glyph">◉</i><span class="choice-text"><b>${lightToggleLabel}</b><span>${lightToggleSub}</span></span></button>`
      : (currentRoomHasCover()
        ? '<button class="btn room-btn dir-wait good" data-act="hide-cover"><i class="dir-glyph">•</i><span class="choice-text"><b>조명 끄고 숨기</b><span>캐비닛 뒤로 숨는다</span></span></button>'
        : (stalkerAwake()
          ? '<button class="btn room-btn dir-wait good" data-act="wait"><i class="dir-glyph">•</i><span class="choice-text"><b>멈춤</b><span>숨을 죽이고 발소리를 보낸다</span></span></button>'
          : `<button class="btn room-btn dir-wait" data-act="toggle-light"><i class="dir-glyph">◉</i><span class="choice-text"><b>${lightToggleLabel}</b><span>${lightToggleSub}</span></span></button>`));
    dock.innerHTML = [
      '<div class="room-pad-empty dir-nw" aria-hidden="true"></div>',
      `<button class="btn room-btn dir-n${frontTone}" data-act="forward" ${front ? '' : 'disabled'}><i class="dir-glyph">↑</i><span class="choice-text"><b>${frontLabel}</b><span>${front ? front.label : '벽이 막고 있다'}</span></span></button>`,
      '<div class="room-pad-empty dir-ne" aria-hidden="true"></div>',
      '<button class="btn room-btn dir-w" data-act="turn-left"><i class="dir-glyph">↶</i><span class="choice-text"><b>왼쪽 보기</b><span>조명을 돌린다</span></span></button>',
      centerControl,
      '<button class="btn room-btn dir-e" data-act="turn-right"><i class="dir-glyph">↷</i><span class="choice-text"><b>오른쪽 보기</b><span>조명을 돌린다</span></span></button>',
      '<div class="room-pad-empty dir-sw" aria-hidden="true"></div>',
      `<button class="btn room-btn dir-s danger" data-act="backstep" ${back ? '' : 'disabled'}><i class="dir-glyph">↓</i><span class="choice-text"><b>${backLabel}</b><span>${back ? '보이지 않는 쪽으로 물러난다' : '뒤가 막혔다'}</span></span></button>`,
      '<div class="room-pad-empty dir-se" aria-hidden="true"></div>',
    ].join('');
    dock.dataset.choiceSig = moveSig;
    if (el['choice-cue']) el['choice-cue'].textContent = cue;
    dock.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'turn-left') turnFacing(-1);
        else if (act === 'turn-right') turnFacing(1);
        else if (act === 'forward' && frontId != null) chooseExit(frontId);
        else if (act === 'backstep' && backId != null) chooseBackstep(backId);
        else if (act === 'hide-cover') chooseHideInCover();
        else if (act === 'wait') chooseWait();
        else if (act === 'toggle-light') toggleHandLight();
      });
    });
  }

  function renderMiniMap() {
    const svg = el['mini-map'];
    if (!svg || !run || !run.floorMap) return;
    const nodes = run.floorMap.nodes;
    const current = currentNode();
    if (!current || !current.pos) { svg.innerHTML = ''; return; }
    if (el['mini-mode']) {
      const modeLabel = meta.minimapMode === 'fixed' ? '고정 지도' : '회전 지도';
      el['mini-mode'].textContent = `현재: ${modeLabel}`;
      el['mini-mode'].setAttribute('aria-label', `미니맵 모드 바꾸기, 현재 ${modeLabel}`);
    }

    const seen = (id) => nodes[id] && nodes[id].entered;
    const visibleIdSet = new Set(nodes.filter((n) => seen(n.id)).map((n) => n.id));
    visibleIdSet.add(run.currentNodeId);
    current.exits.forEach((id) => visibleIdSet.add(id));
    const visibleNodes = nodes.filter((n) => visibleIdSet.has(n.id));
    const center = { x: 60, y: 45 };
    const pad = 14;
    const f = cardinalVector(run.facing || 'n');
    const right = { dx: -f.dy, dy: f.dx };
    const relative = (pos) => {
      const dx = pos.x - current.pos.x;
      const dy = pos.y - current.pos.y;
      if (meta.minimapMode === 'fixed') return { dx, dy };
      return { dx: dx * right.dx + dy * right.dy, dy: -(dx * f.dx + dy * f.dy) };
    };
    const rels = visibleNodes.map((n) => relative((n.pos || current.pos)));
    const maxDx = Math.max(1, ...rels.map((p) => Math.abs(p.dx)));
    const maxDy = Math.max(1, ...rels.map((p) => Math.abs(p.dy)));
    const cell = Math.min(22, (center.x - pad) / maxDx, (center.y - pad) / maxDy);
    const coords = nodes.map((n) => {
      const r = relative((n.pos || current.pos));
      return { x: center.x + r.dx * cell, y: center.y + r.dy * cell };
    });

    const travelled = run.floorMap.travelledEdges || new Set();
    let html = '';
    const compassLabels = meta.minimapMode === 'fixed'
      ? [ ['N', 60, 9], ['E', 112, 48], ['S', 60, 86], ['W', 8, 48] ]
      : [ ['앞', 60, 9], ['오', 112, 48], ['뒤', 60, 86], ['왼', 8, 48] ];
    compassLabels.forEach(([label, x, y]) => {
      html += `<text class="compass-label" x="${x}" y="${y}" text-anchor="middle">${label}</text>`;
    });
    travelled.forEach((key) => {
      const [aId, bId] = key.split('-').map((v) => parseInt(v, 10));
      if (!seen(aId) || !seen(bId)) return;
      const a = coords[aId], b = coords[bId];
      html += `<line class="seen" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    });

    const frontId = relativeExit('front');
    if (frontId != null) {
      const p = coords[frontId];
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const nx = dx / len;
      const ny = dy / len;
      const spread = Math.min(11, Math.max(5, len * 0.23));
      const tip = { x: center.x + nx * len * 0.92, y: center.y + ny * len * 0.92 };
      const left = { x: tip.x + (-ny) * spread, y: tip.y + nx * spread };
      const rightP = { x: tip.x - (-ny) * spread, y: tip.y - nx * spread };
      html += `<path class="flashlight-cone" d="M ${center.x} ${center.y} L ${left.x.toFixed(1)} ${left.y.toFixed(1)} Q ${tip.x.toFixed(1)} ${tip.y.toFixed(1)} ${rightP.x.toFixed(1)} ${rightP.y.toFixed(1)} Z"/>`;
    }
    current.exits.forEach((nid) => {
      const target = nodeById(nid);
      if (!target) return;
      const p = coords[nid];
      if (!seen(nid) && !travelled.has(edgeKey(current.id, nid))) {
        html += `<line class="exit-hint" x1="${center.x}" y1="${center.y}" x2="${p.x}" y2="${p.y}"/>`;
      }
      if (target.kind === 'stairs') html += `<circle class="stair-dot" cx="${p.x}" cy="${p.y}" r="3.8"/>`;
    });

    visibleNodes.forEach((n) => {
      const p = coords[n.id];
      const cls = n.id === run.currentNodeId ? 'current' : (seen(n.id) ? 'seen' : 'ghost');
      html += `<circle class="${cls}" cx="${p.x}" cy="${p.y}" r="${cls === 'current' ? 4.4 : cls === 'ghost' ? 2.4 : 3}"/>`;
    });
    const angle = meta.minimapMode === 'fixed'
      ? ({ n: -90, e: 0, s: 90, w: 180 }[run.facing || 'n'] || -90)
      : -90;
    html += `<path class="player-facing" transform="translate(${center.x} ${center.y}) rotate(${angle})" d="M 7 0 L -4 -5 L -2 0 L -4 5 Z"/>`;
    if (visibleStalkerInLight()) {
      const st = stalker();
      const p = coords[st.nodeId];
      html += `<text class="stalker-mark" x="${p.x}" y="${p.y - 6}" text-anchor="middle">!</text>`;
    }
    svg.innerHTML = html;
  }

  function renderReturnScreen() {
    if (!run.exitRoute) run.exitRoute = 'official';
    const list = el['return-list'];
    list.innerHTML = '';
    if (run.lastSale.length === 0) {
      list.innerHTML = '<div class="sale-empty">팔 건 없다. 빈손은 조용하다.</div>';
    } else {
      run.lastSale.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'sale-item';
        row.innerHTML = `<span class="sale-name">${itemIcon(it.icon)}${it.name}</span><span class="v">${it.value} RP</span>`;
        list.appendChild(row);
      });
    }
    const committee = saleQuote('committee');
    const black = saleQuote('black');
    const family = saleQuote('family');
    const hasFamily = family.familyCount > 0;
    el['return-susp'].textContent = meta.suspicion;
    el['committee-rp'].textContent = '+' + committee.gained;
    el['committee-susp'].textContent = signed(committee.suspDelta);
    el['black-rp'].textContent = '+' + black.gained;
    el['black-susp'].textContent = signed(black.suspDelta);
    if (el['buy-family']) {
      el['buy-family'].hidden = !hasFamily;
      el['buy-family'].disabled = !hasFamily;
    }
    if (el['family-rp']) el['family-rp'].textContent = '+' + family.gained;
    if (el['family-susp']) el['family-susp'].textContent = signed(family.suspDelta);
    // 빈손 귀환이라도 판매처를 골라 계속 진행할 수 있어야 한다(chooseBuyer가 raw 0을 안전 처리).
    el['buy-committee'].disabled = false;
    el['buy-black'].disabled = false;
    renderRouteChoice();
    renderContractCards();
  }

  function renderRouteChoice() {
    const routes = [['route-official', 'official'], ['route-crack', 'crack'], ['route-blackpass', 'blackpass']];
    routes.forEach(([id, route]) => {
      if (el[id]) el[id].classList.toggle('selected', run.exitRoute === route);
    });
    if (el['route-note']) el['route-note'].textContent = routeEffect().note;
  }

  function chooseRoute(route) {
    if (!run) return;
    run.exitRoute = route;
    renderReturnScreen(); // 견적·의심도·출구 문구를 선택한 길에 맞춰 다시 그린다
  }

  const FLOOR_THEME_CLASSES = ['floor-theme-ruins', 'floor-theme-lab', 'floor-theme-deep'];
  function floorThemeClass(floor) {
    if (floor >= 3) return 'floor-theme-deep';
    if (floor === 2) return 'floor-theme-lab';
    return 'floor-theme-ruins';
  }

  function presenceTier() {
    if (!run || !run.floorMap) return 'none';
    const encounterOpen = !!(run.pendingEvent && run.pendingEvent.type === 'monster-encounter');
    const dist = stalkerDistance();
    const danger = run.danger || 0;
    if (encounterOpen || dist <= 0 || danger >= 82) return 'contact';
    if ((stalkerAwake() && dist <= 2) || danger >= 55) return 'near';
    if (run.chasing || danger >= 30) return 'far';
    return 'none';
  }

  function renderPresenceFx() {
    const stage = el['stage'];
    if (!stage) return;
    stage.classList.remove('presence-far', 'presence-near', 'presence-contact');
    const tier = presenceTier();
    if (tier !== 'none') stage.classList.add(`presence-${tier}`);
  }

  function renderStageObjects(node, pct) {
    const box = el['stage-objects'];
    if (!box) return;
    if (!node || pct <= 0) { box.innerHTML = ''; return; }
    const objects = [];
    const prop = roomPropLabel(node);
    if (prop) objects.push({ cls: `prop ${node.kind || ''}`, label: prop });
    const loots = droppedLoots().filter((loot) => loot.nodeId === node.id);
    loots.slice(0, 4).forEach((loot) => objects.push({ cls: 'loot', label: loot.item.name, icon: itemIcon(loot.item.icon) }));
    if (loots.length > 4) objects.push({ cls: 'loot more', label: `+${loots.length - 4}` });
    box.innerHTML = objects.map((obj) => `<span class="stage-object ${obj.cls}">${obj.icon || ''}<b>${obj.label}</b></span>`).join('');
  }

  function renderStage() {
    const rpEl = el['recovery-point'];
    const node = currentNode();
    const front = relativeExit('front') != null ? nodeById(relativeExit('front')) : null;
    const left = relativeExit('left') != null ? nodeById(relativeExit('left')) : null;
    const right = relativeExit('right') != null ? nodeById(relativeExit('right')) : null;
    const pct = effectiveLightPercent();
    if (el['stage']) {
      el['stage'].classList.toggle('light-off', pct <= 0);
      el['stage'].classList.toggle('light-dim', pct > 0 && pct < 35);
      el['stage'].classList.toggle('light-flicker', pct > 0 && pct < 20);
      el['stage'].classList.remove(...FLOOR_THEME_CLASSES);
      el['stage'].classList.add(floorThemeClass(run.floor));
      el['stage'].dataset.facing = run.facing || 'n';
      el['stage'].dataset.roomKind = node ? node.kind : '';
      el['stage'].dataset.prop = pct > 0 ? roomPropLabel(node) : '';
      el['stage'].classList.toggle('has-dropped-loot', droppedLootCountHere(node) > 0 && pct > 0);
      el['stage'].classList.toggle('has-object-layer', pct > 0 && !!node);
      el['stage'].dataset.droppedCount = String(droppedLootCountHere(node));
      const view = el['stage'].querySelector('.fp-view');
      if (view) {
        view.dataset.prop = pct > 0 ? roomPropLabel(node) : '';
        view.dataset.dropped = droppedLootCountHere(node) > 0 && pct > 0 ? `내려놓은 짐 ×${droppedLootCountHere(node)}` : '';
      }
      renderStageObjects(node, pct);
      renderPresenceFx();
    }
    const setDoor = (sel, target, fallback, navLabel) => {
      const d = document.querySelector(sel);
      if (!d) return;
      const visible = !!target && pct > 0;
      d.classList.toggle('open', visible);
      d.classList.toggle('structure', visible && target.kind !== 'corridor');
      d.classList.toggle('stairs', visible && target.kind === 'stairs');
      d.dataset.nav = navLabel;
      d.dataset.kind = visible ? target.kind : 'blocked';
      d.dataset.label = visible ? (target.kind === 'stairs' ? '계단' : target.label) : fallback;
    };
    setDoor('.fp-door.fp-left', left, '왼쪽 어둠', '왼');
    setDoor('.fp-door.fp-center', front, pct <= 0 ? '조명 꺼짐' : '정면 벽', '앞');
    setDoor('.fp-door.fp-right', right, '오른쪽 어둠', '오');
    if (run.moving) {
      rpEl.className = 'recovery-point empty';
      rpEl.style.borderColor = '';
      rpEl.innerHTML = '<span class="rp-name">앞으로…</span>';
    } else if (run.currentItem && pct > 0) {
      const it = run.currentItem;
      rpEl.className = 'recovery-point';
      rpEl.style.borderColor = TIER_COLOR[it.tier];
      rpEl.innerHTML = `${itemIcon(it.icon)}<span class="rp-name">${it.name}</span>`;
    } else {
      rpEl.className = 'recovery-point empty';
      rpEl.style.borderColor = '';
      const cover = currentRoomHasCover() ? ' · 숨을 곳' : '';
      const shape = visibleStalkerInLight() ? ' · 어두운 형체' : '';
      const hint = pct <= 0 ? '조명이 꺼졌다' : front ? `${front.label}${cover}${shape}` : (node ? `${node.label}${cover}${shape}` : '…');
      rpEl.innerHTML = `<span class="rp-name">${hint}</span>`;
    }

    // 어두운 형체: 위험이 클수록 플레이어(왼쪽)에 가까워진다. 조우 위기 중에는
    // 중앙 시야에 고정해 '무엇을 만났는지'를 먼저 보여준다.
    const chaser = el['chaser'];
    const monsterCrisisOpen = !!(run.pendingEvent && run.pendingEvent.type === 'monster-encounter');
    chaser.classList.toggle('active', run.chasing || monsterCrisisOpen);
    chaser.classList.toggle('encounter', monsterCrisisOpen);
    if (monsterCrisisOpen) {
      chaser.style.left = '50%';
      chaser.classList.toggle('close', true);
    } else if (run.chasing) {
      const left = 88 - (run.danger / 100) * 70; // 88% → 18%
      chaser.style.left = left + '%';
      chaser.classList.toggle('close', run.danger >= 80);
    } else {
      chaser.style.left = '100%';
      chaser.classList.remove('close');
    }
  }

  function renderBagShop() {
    const shop = el['bag-shop'];
    if (!shop) return;
    const open = bagShopOpen && !run.bought;
    shop.hidden = !open;
    if (!open) { shop.innerHTML = ''; return; }
    shop.innerHTML = BAG_PRODUCTS.filter((bag) => bag.level > NO_BAG_LEVEL).map((bag) => {
      const owned = bag.level <= meta.bagLevel;
      const affordable = meta.rp >= bag.cost;
      const disabled = owned || !affordable || run.bought;
      return `<button class="btn bag-choice ${owned ? 'owned' : ''}" data-bag-level="${bag.level}" ${disabled ? 'disabled' : ''}>` +
        `<span class="bag-choice-name">${itemIcon(7)}${bag.name}</span>` +
        `<span class="bag-choice-cap">${bag.cap}칸</span>` +
        `<span class="bag-choice-cost">${owned ? '보유중' : bag.cost + ' RP'}</span>` +
      `</button>`;
    }).join('');
    shop.querySelectorAll('[data-bag-level]').forEach((btn) => {
      btn.addEventListener('click', () => buyBag(safeInt(btn.dataset.bagLevel, NO_BAG_LEVEL, NO_BAG_LEVEL, MAX_BAG_LEVEL)));
    });
  }

  function renderUpgradeScreen(gained) {
    // 판매 내역
    if (gained !== null) {
      const buyerLabel = run.lastBuyer === 'black' ? '암시장' : run.lastBuyer === 'family' ? '가족 반환' : '위원회';
      el['sale-buyer'].textContent = `판매처: ${buyerLabel}`;
      const list = el['sale-list'];
      list.innerHTML = '';
      if (run.lastSale.length === 0) {
        list.innerHTML = '<div class="sale-empty">팔 건 없다.</div>';
      } else {
        run.lastSale.forEach((it) => {
          const row = document.createElement('div');
          row.className = 'sale-item';
          row.innerHTML = `<span class="sale-name">${itemIcon(it.icon)}${it.name}</span><span class="v">+${it.value}</span>`;
          list.appendChild(row);
        });
      }
      el['sale-gain'].textContent = '+' + gained;
    }
    if (el['run-summary']) {
      const summaryLines = [run.exitNote, run.mutationNote].filter(Boolean);
      el['run-summary'].innerHTML = summaryLines.join('<br>');
    }
    el['sale-balance'].textContent = meta.rp;
    el['sale-susp'].textContent = meta.suspicion;
    renderGoals();
    renderContractCards();
    el['street-news'].textContent = run.streetNews;
    if (run.lastTruth) {
      el['truth-news'].hidden = false;
      el['truth-news'].textContent = `진실 조각: ${run.lastTruth}`;
    } else {
      el['truth-news'].hidden = true;
      el['truth-news'].textContent = '';
    }

    // 강화 버튼 3종. 가방은 순차 강화가 아니라 크기별 구매 목록을 연다.
    renderBagShop();
    const weaponSub = hasSurvivor('mechanic') ? `들키는 속도 -25% · 정비공 할인` : `들키는 속도 -25%`;
    const defs = [
      ['up-light',  'light',  `조명 손보기`,  `최대 조명 +35`],
      ['up-weapon', 'weapon', `장비 개조`,  weaponSub],
    ];
    const currentBag = bagProduct();
    const nextBag = BAG_PRODUCTS.find((bag) => bag.level > meta.bagLevel);
    const bagBtn = el['up-bag'];
    if (bagBtn) {
      const canOpenBag = !!nextBag && !run.bought;
      bagBtn.disabled = !canOpenBag;
      bagBtn.classList.toggle('bought', run.bought);
      bagBtn.classList.toggle('open', bagShopOpen && canOpenBag);
      const currentText = currentBag.level === NO_BAG_LEVEL ? '현재: 맨손' : `현재: ${currentBag.name} · ${currentBag.cap}칸`;
      bagBtn.innerHTML =
        `<span class="up-title">${itemIcon(7)}가방 구매</span>` +
        `<span class="up-sub">${currentText}${nextBag ? ` · 다음 ${nextBag.name}` : ' · 최대'}</span>` +
        `<span class="up-cost">${run.bought ? '오늘은 여기까지' : nextBag ? '목록 보기' : '최대'}</span>`;
    }
    defs.forEach(([id, type, title, sub]) => {
      const lvKey = type + 'Level';
      const cost = upgradeCost(type);
      const btn = el[id];
      const affordable = meta.rp >= cost && !run.bought;
      btn.disabled = !affordable;
      btn.classList.toggle('bought', run.bought);
      const upgradeIcon = type === 'bag' ? 7 : type === 'light' ? 8 : 9;
      btn.innerHTML =
        `<span class="up-title">${itemIcon(upgradeIcon)}${title}</span>` +
        `<span class="up-sub">${sub} · 현재 Lv.${meta[lvKey]}</span>` +
        `<span class="up-cost">${run.bought ? '오늘은 여기까지' : cost + ' RP'}</span>`;
    });
  }

  // 진실 6/6 엔딩 화면. 조각 개수만 갱신하면 되므로 run 없이도 안전하게 재표시할 수 있다.
  function renderEndingScreen() {
    if (el['ending-truth-count']) el['ending-truth-count'].textContent = meta.truths.length;
  }

  // 엔딩을 '확인함'으로 표시하고, 강화 루프로 돌아가 계속 플레이한다.
  function acknowledgeEnding() {
    meta.endingSeen = true;
    saveMeta();
    if (run) {
      renderUpgradeScreen(null); // 판매 내역은 유지하고 목표 문구만 '심층 루프 계속'으로 갱신.
      show('screen-upgrade');
    } else {
      renderStartScreen(); // 시작 화면에서 다시 열어본 경우엔 시작 화면으로 돌아간다.
      show('screen-start');
    }
  }

  /* ---------------- 이벤트 배선 ---------------- */

  function setMetaPanel(open) {
    if (!el['meta-panel'] || !el['btn-meta']) return;
    el['meta-panel'].hidden = !open;
    el['btn-meta'].setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function toggleMetaPanel() {
    if (!el['meta-panel']) return;
    setMetaPanel(el['meta-panel'].hidden);
  }

  function handleKeyControl(event) {
    if (!run || !el['screen-dungeon'] || !el['screen-dungeon'].classList.contains('active')) return;
    const key = event.key.toLowerCase();
    if (['arrowleft','arrowright','arrowup','arrowdown','a','d','w','s','l'].includes(key)) event.preventDefault();
    if (key === 'arrowleft' || key === 'a') turnFacing(-1);
    else if (key === 'arrowright' || key === 'd') turnFacing(1);
    else if (key === 'arrowup' || key === 'w') { const id = relativeExit('front'); if (id != null) chooseExit(id); }
    else if (key === 'arrowdown' || key === 's') { const id = relativeExit('back'); if (id != null) chooseBackstep(id); }
    else if (key === 'l') toggleHandLight();
    else if (key === ' ' || key === 'e') grab();
  }

  function bind() {
    el['btn-enter'].addEventListener('click', handleStartButton);
    if (el['screen-start']) el['screen-start'].addEventListener('click', handleStartScreenTap);
    if (el['btn-meta']) el['btn-meta'].addEventListener('click', (event) => {
      if (run && run.dialogue) {
        event.preventDefault();
        return;
      }
      toggleMetaPanel();
    });
    if (el['screen-dungeon']) {
      el['screen-dungeon'].addEventListener('pointerdown', handleDungeonDialoguePointer, true);
      el['screen-dungeon'].addEventListener('click', handleDungeonDialogueTap, true);
    }
    if (el['mini-mode']) el['mini-mode'].addEventListener('click', (event) => { event.stopPropagation(); toggleMinimapMode(); });
    window.addEventListener('keydown', handleKeyControl);
    el['btn-grab'].addEventListener('click', (event) => { event.stopPropagation(); grab(); });
    el['btn-drop'].addEventListener('click', (event) => { event.stopPropagation(); dropAndFlee(); });
    el['btn-return'].addEventListener('click', (event) => { event.stopPropagation(); attemptReturnToSurface(); });
    if (el['dialogue-card']) el['dialogue-card'].addEventListener('click', handleDialogueCardClick);
    if (el['route-official']) el['route-official'].addEventListener('click', () => chooseRoute('official'));
    if (el['route-crack']) el['route-crack'].addEventListener('click', () => chooseRoute('crack'));
    if (el['route-blackpass']) el['route-blackpass'].addEventListener('click', () => chooseRoute('blackpass'));
    el['buy-committee'].addEventListener('click', () => chooseBuyer('committee'));
    el['buy-black'].addEventListener('click', () => chooseBuyer('black'));
    if (el['buy-family']) el['buy-family'].addEventListener('click', () => chooseBuyer('family'));
    el['up-bag'].addEventListener('click', () => buyUpgrade('bag'));
    el['up-light'].addEventListener('click', () => buyUpgrade('light'));
    el['up-weapon'].addEventListener('click', () => buyUpgrade('weapon'));
    el['btn-again'].addEventListener('click', startNewRun);
    el['btn-retry'].addEventListener('click', startNewRun);
    if (el['btn-reset']) el['btn-reset'].addEventListener('click', resetProgress);
    if (el['ending-continue']) el['ending-continue'].addEventListener('click', acknowledgeEnding);
    if (el['ending-reset']) el['ending-reset'].addEventListener('click', resetProgress);
  }

  /* ---------------- 시작 ---------------- */

  // 진실 조각 진행 상태에 맞춘 코덱스 문구(개수/완성/엔딩 확인 여부에 따라 달라진다).
  function codexTail() {
    const n = meta.truths.length;
    if (n <= 0) return '아직 아무것도 모른다.';
    if (n < TRUTH_TOTAL) return '조각이 맞지 않는다.';
    return meta.endingSeen ? '이제 안다.' : '확인해야 한다.';
  }

  // 시작 화면 코덱스 줄(개수 + 상태 문구 + 완성 표시)을 한곳에서 갱신한다.
  function renderCodex() {
    el['start-truth-count'].textContent = meta.truths.length;
    el['start-codex-tail'].textContent = codexTail();
    el['start-codex'].classList.toggle('complete', meta.truths.length >= TRUTH_TOTAL);
  }

  // 구출한 생존자를 시작 화면에 짧게 표시한다(없으면 줄을 숨긴다).
  function renderStartSurvivors() {
    const line = el['start-survivors'];
    if (!line) return;
    const names = meta.survivors.map((id) => SURVIVORS[id] && SURVIVORS[id].name).filter(Boolean);
    if (!names.length) { line.hidden = true; line.textContent = ''; return; }
    line.hidden = false;
    line.innerHTML = `구출한 생존자 <b>${names.length}</b>명 · <b>${names.join(', ')}</b>`;
  }

  function renderStartMutations() {
    const line = el['start-mutations'];
    if (!line) return;
    const names = meta.mutations.map((id) => MUTATIONS[id] && MUTATIONS[id].name).filter(Boolean);
    if (!names.length) { line.hidden = true; line.textContent = ''; return; }
    line.hidden = false;
    line.innerHTML = `몸에 남은 흔적 · <b>${names.join(', ')}</b>`;
  }

  // 시작 화면 메타 표시를 한곳에서 갱신한다(초기 진입 + 기록 초기화 공용).
  function renderStartScreen() {
    el['start-rp'].textContent = meta.rp;
    el['start-depth'].textContent = meta.maxDepth;
    el['start-susp'].textContent = meta.suspicion;
    renderCodex();
    renderStartSurvivors();
    renderStartMutations();
    renderGoals();
    renderContractCards();
  }

  function init() {
    cacheDom();
    bind();
    loadMeta(); // 저장된 진행도 복원 (없거나 깨졌으면 기본값 유지)
    setupFirstStartIntro();
    renderStartScreen();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // 헤드리스(Node) 검증용: 순수 로직만 노출한다. 브라우저에는 영향 없음.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      generateFloorMap,
      bfs,
      FLOORS,
      ITEM_TABLE,
      NODE_KINDS,
      BAG_PRODUCTS,
      CABINET_BAG_FIND_RATES,
      MAX_BAG_LEVEL,
      FAMILY_KEEPSAKES,
      MISSING_TRACE_LOGS,
      MISSING_TRACE_SPAWN_CHANCE,
      FAMILY_RETURN_RATE,
      FAMILY_RETURN_SUSP_RELIEF,
      MUTATIONS,
      MUTATION_ORDER,
      MUTATION_TRIGGER_HEAT,
      MUTATION_TRIGGER_ROOMS,
      MUTATION_TRIGGER_FLOOR,
      FISSURE_SCRATCH_RATE,
      BLACKHAND_CABINET_LIGHT,
      BLACKHAND_CHECKPOINT_SUSP,
      MUFFLED_COMMITTEE_SUSP,
      pickupNoiseLevel,
      committeeSuspicionDelta,
      mutationCandidateForReturn,
      familyReturnQuote,
      cabinetBagFindCandidate,
      createBagDropReclaimSmokeState,
      smokeUsedSlots,
      smokeRoomFor,
      smokeDropBagItem,
      smokeReclaimDroppedLoot,
      smokeDroppedLootChoices,
      KNOWN_PLAYER_CHOICE_FIXTURES,
      collectKnownPlayerChoiceFixtures,
    };
  }
})();
