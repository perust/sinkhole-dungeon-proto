/* ============================================================
   도심 싱크홀 — 회수 잠수 (플레이어블 프로토타입)

   핵심 훅: "던전이 내가 훔친 물건을 다시 가져가려 한다."
   루프:    챙기고 → 도망치고 → 팔고 → 장비를 챙겨 → 더 깊이.

   - 메타 상태(meta): 조사를 넘어 유지되는 영구 자산(RP, 장비 구매 상태, 최고 깊이).
   - 조사 상태(run):  한 번의 조사 동안만 존재하는 상태(층, 조명, 가방, 위험, 작은 맵).
   각 층은 5~7개 노드짜리 작은 맵으로 생성된다. 노드에는 출구(exits),
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
  // 아이템 태그 v1 — 태그는 등급이 아니라 물건마다 붙는다.
  // 같은 rare여도 데이터칩은 조용하고(low) 연구 노트는 소리가 난다(medium).
  //   heat   — 암시장 판매 시 물건 하나가 더하는 의심도. MUTATION_TRIGGER_HEAT 이상이면
  //            손에 남는 열기로 한 줄 흘린다(itemTraitHint) — 수치는 감춘다.
  //   noise  — 집는 순간의 소음 압박('low'|'medium'|'high'). 조심/재빨리와 함께 추격 압박을 정한다.
  //   fragile— 깨지기 쉬운 물건(true). 버리고 도망친 뒤 되챙기면 깨진 채로 돌아와 값이 크게 떨어지고
  //            (BROKEN_VALUE_RATE), 균열 출구에서는 성한 것만 긁힌다.
  //   marked — 위원회가 추적 중인 회수물(true). 정식 반납이면 그 물건이 공개 수배·검문 목록에서 빠져
  //            의심도가 조금 더 눅고, 암시장에 넘기면 표식된 물건이 뒷골목에 다시 떠올라 꼬리가 조금 더 잡힌다.
  //   hints  — 태그를 물건마다 다른 감각 문구로 흘린다. 없으면 태그별 기본 문구를 쓴다.
  const ITEM_TABLE = {
    1: [
      { name: '실험용 배터리', slots: 1, value: 6,  tier: 'common', icon: 0, heat: 3,  noise: 'medium', fragile: false, truth: true, truthText: '배터리에는 위원회 마크가 지워진 흔적이 있다.' },
      { name: '배관 부품',     slots: 1, value: 5,  tier: 'common', icon: 1, heat: 2,  noise: 'low',    fragile: false, truth: true, truthText: '도시 배관은 사고 전부터 아래로 이어져 있었다.' },
    ],
    2: [
      { name: '봉인 데이터칩', slots: 2, value: 10, tier: 'rare', icon: 2, heat: 9,  noise: 'low',    fragile: true,  marked: true, truth: true,
        hints: { fragile: '케이스에 실금이 가 있다' },
        truthText: '데이터칩의 날짜는 싱크홀 발생 전날로 찍혀 있다.' },
      { name: '연구 노트',     slots: 1, value: 7,  tier: 'rare', icon: 3, heat: 7,  noise: 'medium', fragile: true,  truth: true,
        hints: { fragile: '종이가 눅어 손대면 바스러질 것 같다' },
        truthText: '연구 노트에는 ‘어둠붙이’가 빛과 소리에 다르게 반응한다고 적혀 있다.' },
    ],
    3: [
      { name: '안정화 코어',   slots: 2, value: 18, tier: 'epic', icon: 4, heat: 15, noise: 'high',   fragile: false, truth: true,
        hints: { noise: '안에서 낮은 진동음이 새어 나온다', heat: '쥐고 있으면 손바닥이 미지근해진다' },
        truthText: '코어는 싱크홀을 막는 장치가 아니라 더 깊게 여는 열쇠다.' },
      { name: '봉인 유물',     slots: 3, value: 30, tier: 'epic', icon: 5, heat: 20, noise: 'high',   fragile: true,  marked: true, truth: true,
        hints: { noise: '기울일 때마다 안쪽 벽을 구르며 부딪치는 소리가 난다', fragile: '문양을 따라 금이 번져 있다', heat: '표면이 체온보다 따뜻하다' },
        truthText: '봉인 유물의 문양은 지상 허가증의 직인과 같다.' },
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
  function itemMarked(it) { return !!(it && it.marked); }
  // broken은 ITEM_TABLE에 없다 — 깨진 채 되챙긴 사본에만 붙는 실행 중 태그다(breakItem).
  function itemBroken(it) { return !!(it && it.broken); }
  // 원본을 건드리지 않고 깨진 사본을 만든다. name·truth·truthText가 그대로라 단서 해금은 유지된다.
  function breakItem(it) {
    return { ...it, value: Math.max(1, Math.round(it.value * BROKEN_VALUE_RATE)), broken: true };
  }
  // 단서 여부(태그)와 해금 문구(텍스트)를 분리한다. 구버전 물건은 truth가 문자열이었다 →
  // itemTruth는 문자열도 참으로 보고, itemTruthText는 그 문자열을 그대로 문구로 돌려준다(하위호환).
  function itemTruth(it) {
    if (!it) return false;
    if (it.truth === true) return true;
    return typeof it.truth === 'string' && it.truth.length > 0;
  }
  function itemTruthText(it) {
    if (!it) return '';
    if (typeof it.truthText === 'string') return it.truthText;
    if (typeof it.truth === 'string') return it.truth; // 구버전: truth가 문구를 담던 시절
    return '';
  }
  // 단서 총량은 truth 태그가 붙은 물건만 센다(itemTruth). 앞으로 truth 없는 일반 회수물이 ITEM_TABLE에
  // 들어와도 6/6 목표가 흔들리지 않는다.
  const TRUTH_TOTAL = Object.values(ITEM_TABLE).flat().filter(itemTruth).length;

  // 실종자 흔적방 유품 v1: 실종자 방에서만 나오는 가족 keepsake.
  // ITEM_TABLE 밖에 두어 단서 총량(TRUTH_TOTAL=6)에 영향이 없다. truth 필드가 없어
  // 암시장에 팔아도 비밀을 풀지 않는다(chooseBuyer는 truth 있는 물건만 단서로 센다).
  // family:true 태그로 지상 귀환 시 '가족에게 돌려준다' 경로가 열린다. 값·heat는 낮다(개인 유품).
  // 유품도 물건마다 태그가 다르다: 사진은 찢어지고(fragile), 목걸이는 쇠사슬이 잘그락거린다(noise).
  // heat는 셋 다 1 — 개인 유품이라 암시장에서도 눈에 띄지 않는다.
  const FAMILY_KEEPSAKES = [
    { name: '가족 사진',     slots: 1, value: 4, tier: 'common', icon: 3, heat: 1, noise: 'low',    fragile: true,  family: true, hints: { fragile: '접힌 자리가 닳아 곧 찢어질 것 같다' }, familyNote: '사진 뒤에 “아빠 꼭 돌아와”라고 적혀 있다.' },
    { name: '이름표 목걸이', slots: 1, value: 5, tier: 'common', icon: 0, heat: 1, noise: 'medium', fragile: false, family: true, familyNote: '목걸이에 아이 이름과 집 주소가 새겨져 있다.' },
    { name: '아이 배낭',     slots: 1, value: 3, tier: 'common', icon: 1, heat: 1, noise: 'low',    fragile: false, family: true, familyNote: '배낭 안에 반쯤 쓴 색연필과 위원회 출입증이 들어 있다.' },
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
    // 실종자 흔적방: 드물게 등장(uncommon). 벽에 붙은 사진/이름표/배낭 — 유품(family) 회수와 가족 반환 루트로 이어진다.
    { key: 'missing-trace', label: '실종자 흔적', desc: '벽에 붙은 사진',  style: '',       light: -1, danger: 1, uncommon: true },
  ];
  const ENTRY_KIND  = { key: 'entry',  label: '입구',       desc: '',            style: '', light: 0, danger: 0 };
  const STAIRS_KIND = { key: 'stairs', label: '계단 아래로', desc: '더 깊은 냉기', style: '', light: 0, danger: 0 };

  // 위원회 감시소 튜닝값과 단말 로그. 로그는 비밀을 공짜로 풀지 않고 단서 한 줄만 흘린다.
  const WATCHPOST_SPAWN_CHANCE = 0.28;     // 층마다 감시소가 나타날 확률(드물게)
  const WATCHPOST_TENSE_SUSPICION = 40;    // 이 이상이면 단말을 뒤지는 게 위험해진다
  const WATCHPOST_LOGS = [
    '단말 로그: “회수물은 폐기가 아니라 재봉인 창고로 이송.” 날짜 칸은 지워져 있다.',
    '깨진 화면에 한 줄이 떠 있다 — “감시등 소등은 상부 지시.” 서명란은 비어 있다.',
    '명단이 스친다. 현장 인력 몇 사람 이름 옆에 붉은 표시가 찍혀 있다.',
  ];

  // 실종자 흔적방 튜닝값과 단서 로그. '사진만 확인'하면 단서 한 줄만 흘린다 — 비밀은 주지 않는다.
  const MISSING_TRACE_SPAWN_CHANCE = 0.24;  // 층마다 실종자 흔적방이 나타날 확률(드물게)
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
  const BROKEN_VALUE_RATE = 0.5;        // 깨진 채 되챙긴 물건이 지키는 값 비율(물건당 한 번만 적용)
  const EXIT_PASSAGE_FEE = 8;           // 암시장 통로 통행료(RP)
  const EXIT_PASSAGE_BLACK_RELIEF = 4;  // 암시장 통로로 뒷골목에 바로 붙어 줄어드는 암시장 의심도

  // 가족 반환 v1: 유품(family 태그)을 가족에게 돌려주는 판매 경로. 암시장/위원회보다 값은 낮지만 의심도가 눅는다.
  const FAMILY_RETURN_RATE = 0.4;        // 유품 값 중 가족이 사례로 돌려주는 비율(암시장 1.35·위원회 0.72보다 낮다)
  const FAMILY_RETURN_SUSP_RELIEF = 2;   // 유품 하나를 가족에게 돌려줄 때마다 줄어드는 의심도

  // 회수물 태그 marked v1: 위원회 추적 명단에 오른 회수물. 판매 선택을 안전 제출 쪽으로 살짝 기울인다.
  // 보정은 결정적이며 판당 상한(MARKED_SUSPICION_CAP)으로 묶어 한쪽 경로가 항상 최선이 되지 않게 한다.
  const MARKED_COMMITTEE_RELIEF = 2;   // 표식 물건 하나를 위원회에 정식 반납할 때마다 추가로 덜어내는 의심도
  const MARKED_BLACK_SUSPICION = 3;    // 표식 물건 하나를 암시장에 넘길 때마다 추가로 오르는 의심도
  const MARKED_SUSPICION_CAP = 6;      // 표식 보정(양방향)이 한 판매에서 넘지 못하는 상한(유계)

  // 의심도 대가 v1: 의심도가 실제로 아프도록 두 문턱을 둔다. 값이 낮을 땐 아무 대가도 없고(비징벌),
  // 문턱을 넘을수록 위원회 감시가 지상까지 따라붙어 조사 시작과 뒷거래가 불리해진다. 보정은 전부 결정적·유계.
  const SUSPICION_TENSE = 35;          // 긴장선: 입구에 위원회 밴이 붙기 시작한다(가벼운 시작 압박)
  const SUSPICION_HOT   = 60;          // 과열선: 짐·차량이 검문 명단 위쪽에 오른다(무거운 시작 압박 + 뒷거래 불이익)
  const SUSPICION_TENSE_MENTAL = 8;    // 긴장선에서 검문을 피해 내려오느라 깎이는 시작 멘탈
  const SUSPICION_HOT_MENTAL   = 16;   // 과열선에서 더 크게 깎이는 시작 멘탈
  const SUSPICION_HOT_LIGHT    = 20;   // 과열선에서 감시등을 피하느라 미리 닳는 시작 조명
  const BLACK_RATE      = 1.35;        // 암시장 기본 매입 배율(위험 프리미엄)
  const BLACK_RATE_HOT  = 1.15;        // 과열 상태면 물건 출처가 의심스러워져 중개상이 위험 프리미엄을 깎는다(자기도 부담이라)
  const BROKER_HOT_SUSP = 2;           // 과열 상태에서 뒷거래로 더 붙는 의심도(유계)

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
    full: '가방이 꽉 찼다. 천이 팽팽하게 당겨져 있다.',
    blocked: '가방 입구가 벌어져 있다. 더 넣으면 찢어질 것 같다.',
  };
  // 맨손(가방 없음)일 때는 '가방' 대신 맨손 상태에 맞는 문구를 쓴다 — 없는 가방을 두고 꽉 찼다고 하지 않게.
  const NO_BAG_ALERTS = {
    full: '손이 가득 찼다. 맨손이라 더는 못 든다.',
    blocked: '맨손이라 더 쥘 자리가 없다. 손에 쥔 것만으로 벅차다.',
  };
  // 가방 용량 경고 문구를 고른다: 맨손이면 맨손용 문구, 가방을 멨으면 기존 문구.
  function bagAlert(key) {
    if (meta.bagLevel === NO_BAG_LEVEL && NO_BAG_ALERTS[key]) return NO_BAG_ALERTS[key];
    return BAG_ALERTS[key];
  }
  function noBag() { return meta.bagLevel === NO_BAG_LEVEL; }
  function packItemLine(item, mode = 'cautious') {
    const obj = objectParticle(item.name);
    if (mode === 'recovered') return noBag() ? `버리고 왔던 ${item.name}${obj} 다시 손에 쥐었다.` : `버리고 왔던 ${item.name}${obj} 다시 가방에 넣었다.`;
    if (mode === 'direct') return noBag() ? `${item.name}까지 손에 쥐었다.` : `${item.name}까지 챙겼다.`;
    return noBag() ? `숨을 죽이고 ${item.name}${obj} 두 손으로 단단히 쥐었다.` : `숨을 죽이고 ${item.name}${obj} 천천히 가방에 넣었다.`;
  }

  // 회수물 스트립(loot-icons-strip.png)에서 물건별 아이콘 한 칸을 잘라 보여준다.
  // name을 넘기면 좁은 슬롯에서 이름이 잘려도 hover로 확인할 수 있게 title을 달되,
  // 곁에 보이는 텍스트가 접근성 라벨을 이미 담당하므로 아이콘은 aria-hidden으로 둬
  // 스크린 리더가 이름을 두 번 읽지 않게 한다.
  function itemIcon(index, name) {
    const title = name ? ` title="${name}"` : '';
    return `<span class="loot-icon" style="--icon-index:${index}"${title} aria-hidden="true"></span>`;
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
  const LOOT_RETRIEVE_TICKS = 6;  // 끌개: 버린 물건을 어두운 형체가 거둬 가기까지의 유예(틱). 이후 가까우면 사라진다.
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
        critical: '젖은 쇳소리가 등 뒤에서 끊긴다. 빛이 닿지 않는 곳에서 어두운 형체가 몸을 숙인다.',
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
        ambush: '바로 옆 물웅덩이에 새 발자국이 찍힌다. 어두운 형체는 숨소리보다 발소리에 먼저 반응한다.',
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
      body: '구조 기록에 이름이 찍혔다. 대신 현장 물품은 대부분 압수됐다.',
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
      after: '돌아보면 아무도 없다. 손바닥에 벽의 물기만 축축하게 묻는다.',
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

  // 조명/장비는 단계가 오를수록 비싸진다. 가방은 정해진 크기 제품 중 하나를 고른다.
  const UPGRADES = {
    light:  { label: '조명',  cost: lv => 5  * lv },
    weapon: { label: '장비',  cost: lv => 10 * lv },
  };

  // 가방은 크기별 제품이다. level 0은 시작·상실 시의 맨손 상태다.
  // level 1~4는 구매·발견 가능한 실제 가방으로, 값이 제품마다 고정이라 큰 가방을 곧장 사면 그만큼 더 든다.
  const BAG_PRODUCTS = [
    { level: 0, name: '맨손',     cap: 1 },
    { level: 1, name: '작은 가방', cap: 3, cost: 8 },
    { level: 2, name: '큰 가방',   cap: 5, cost: 20 },
    { level: 3, name: '대형 가방', cap: 7, cost: 40 },
    { level: 4, name: '특대 가방', cap: 9, cost: 64 },
  ];
  const MAX_BAG_LEVEL = BAG_PRODUCTS[BAG_PRODUCTS.length - 1].level;
  const NO_BAG_LEVEL = 0; // 맨손 — 가방을 아직 안 샀거나 어두운 형체에게 빼앗긴 상태
  const CABINET_BAG_FIND_RATES = { 1: 0.20, 2: 0.08, 3: 0.035, 4: 0.015 }; // 큰 가방일수록 발견 확률이 낮다.
  function bagProduct(level = meta.bagLevel) {
    const safe = Math.max(NO_BAG_LEVEL, Math.min(MAX_BAG_LEVEL, Math.floor(Number(level)) || 0));
    return BAG_PRODUCTS.find((bag) => bag.level === safe) || BAG_PRODUCTS[0];
  }
  // 구매 가능한 가방(맨손 제외).
  const purchasableBags = () => BAG_PRODUCTS.filter((bag) => bag.level > NO_BAG_LEVEL);
  function bagCost(level) {
    const product = BAG_PRODUCTS.find((bag) => bag.level === level);
    return product && product.cost != null ? product.cost : Infinity;
  }
  // 캐비닛에서 나오는 가방: 지금 것보다 큰 제품만 후보가 되며, 큰 가방일수록 낮은 확률로 발견된다.
  function bagFindCandidate() {
    const candidates = purchasableBags().filter((bag) => bag.level > meta.bagLevel);
    if (!candidates.length) return null;
    const roll = Math.random();
    let acc = 0;
    for (const bag of candidates) {
      acc += CABINET_BAG_FIND_RATES[bag.level] || 0;
      if (roll < acc) return bag;
    }
    return null;
  }

  /* ---------------- 생존자 v1 ---------------- */
  // 던전에서 구출해 지상으로 데려온 사람들. 조사를 넘어 유지되며(meta.survivors),
  // 각자 하나의 영구 효과를 준다. 정비공(장비 강화 할인)·의무병(기절 후유증 완화)·
  // 지도공(갈림길에서 앞쪽 방 미리보기)·전 위원회 직원(감시소 봉쇄 코드·공식 출구 통행 완화) 넷.
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
      eventCue: '휘어진 벽판 뒤에서 접힌 지도를 쥔 손이 흔들린다. 젖은 종이에는 아래층 통로가 손으로 그려져 있고, 낮은 목소리가 판을 두드리며 꺼내 달라고 한다.',
      rescueSub: '벽판을 뜯어 끌어낸다',
      rescueLog: '휘어진 벽판을 뜯어 그 사람을 끌어냈다. 지도공이라던 이가 젖은 지도를 접어 넣으며 따라붙는다. 이제부터 갈림길마다 앞쪽 방이 뭔지 짚어 준다.',
    },
    insider: {
      id: 'insider',
      name: '전 위원회 직원',
      eventTitle: '게이트에 낀 사람',
      eventCue: '부서진 ID 게이트 사이에 팔이 낀 사람이 몸을 비튼다. 찢어진 끈에 위원회 출입증이 매달려 흔들리고, 갈라진 목소리가 봉쇄 코드를 안다며 꺼내 달라고 한다.',
      rescueSub: '게이트 틈을 벌려 빼낸다',
      rescueLog: '뒤틀린 ID 게이트를 벌려 그 사람을 빼냈다. 전 위원회 직원이라던 이가 출입증을 움켜쥔 채 따라붙는다. 이제부터 감시소 단말과 지상 검문에서 낡은 직원 코드가 쓸모가 있다.',
    },
  };
  const SURVIVOR_IDS = Object.keys(SURVIVORS);
  const KNOWN_SURVIVORS = new Set(SURVIVOR_IDS);
  // 구출하지 않고 표시해 둔 생존자의 뒤처리 상태. 'marked'=위치만 표시, 'abandoned'=그냥 지나감.
  const SURVIVOR_OUTCOMES = new Set(['marked', 'abandoned']);

  const MECHANIC_DISCOUNT = 0.25;        // 정비공: 장비(weapon) 강화 비용을 이 비율만큼 깎는다
  const MEDIC_SUSPICION_RELIEF = 2;      // 의무병: 기절 시 오르는 의심도를 이만큼 덜어낸다(양수 델타에만)
  const MEDIC_CONSOLATION_RATE = 0.15;   // 의무병: 잃은 짐 값의 이 비율만큼 위로 보상을 더 챙겨준다
  const INSIDER_WATCHPOST_RELIEF = 4;    // 전 직원: 감시소에서 낡은 직원 코드로 덜어내는 의심도(결정적)
  const INSIDER_WATCHPOST_LIGHT = 3;     // 전 직원: 봉쇄 코드를 넣느라 드는 조명(소음·위험은 없음)
  const INSIDER_CHECKPOINT_RELIEF = 2;   // 전 직원: 공식 출구 검문에서 통행 암구호로 덜어내는 의심도

  // 전 위원회 직원: 감시소 봉쇄 코드로 열면 흘러나오는 봉쇄문/재봉인 단서. 비밀은 공짜로 풀지 않는다.
  const INSIDER_SEAL_LOG = '낡은 직원 코드가 먹혔다. 단말이 순순히 열리고 한 줄이 떠오른다 — “봉쇄문 재봉인은 3단계, 마지막 인증은 현장 직원 코드.” 코드 주인이 옆에서 조용히 고개를 끄덕인다.';

  // 지도공: 갈림길에서 앞쪽 방 목적지의 특징을 낮은 정밀도로 미리 보여준다(kind → 짧은 특징어).
  // 계단·물건 유무는 mapperHint에서 따로 처리한다. 좌표·정확한 전리품·추격자 위치는 드러내지 않는다.
  const MAPPER_FEATURE = {
    corridor: '곧은 복도',
    door: '문',
    storage: '창고',
    office: '관리실',
    vent: '좁은 통로',
    hall: '잔해',
    crack: '균열',
    watchpost: '꺼진 감시등',
    'missing-trace': '벽에 붙은 사진',
  };

  const SURVIVOR_EVENT_CHANCE = 0.16;    // 방 도착 시 생존자 조우가 열릴 확률(드물게)
  const SURVIVOR_RESCUE_LIGHT = 8;       // 구출: 끌어내느라 드는 조명
  const SURVIVOR_RESCUE_MENTAL = 5;      // 구출: 끌어내느라 드는 멘탈
  const SURVIVOR_RESCUE_DANGER = 6;      // 구출: 소음으로 오르는 위험
  // 미구출 후속 v1: 등진(abandoned) 생존자 기록당 딱 한 번, 다음 조사에서 뒤늦게 돌아오는 대가.
  const SURVIVOR_ABANDON_SUSPICION = 1;  // 등진 기록 하나당 다음 조사에서 오르는 의심도(한 번만)
  const SURVIVOR_STREET_RUMOR = '거리 소문: 어젯밤 누군가 두드리는 소리가 멈췄다.';

  /* ---------------- 왜곡 변이 v1 ---------------- */
  // 아주 뜨거운 유물을 들고 지상으로 나오면 몸에 번지는 영구 흔적. 조사를 넘어 유지되며(meta.mutations),
  // 하나가 이득과 대가를 함께 준다. v1은 둘뿐이고, 더 큰 변이 트리는 후속으로 미룬다.
  //  - fissure-sight(균열 시야): 앞쪽 틈/계단/물건 방향을 낮은 정밀도로 짚어 주지만,
  //    균열 출구에서 길을 더 잘못 짚어 파손되기 쉬운 짐이 조금 더 긁힌다.
  //  - black-hand(검은 손): 캐비닛을 더 쉽게 열지만, 공식 출구 검문에서 손이 눈에 띄어 의심도가 조금 더 오른다.
  const MUTATIONS = {
    'fissure-sight': {
      id: 'fissure-sight',
      name: '균열 시야',
      gainLog: '벽 틈이 더 선명하게 보인다. 어느 쪽에 무언가 있는지 어렴풋이 짚인다.',
    },
    'black-hand': {
      id: 'black-hand',
      name: '검은 손',
      gainLog: '손등에 검은 얼룩이 번졌다. 손가락이 전보다 쉽게 틈을 비집는다.',
    },
  };
  // 지급은 이 순서대로 첫 번째 미보유 변이를 준다(무작위 없음 — 테스트 결정성).
  const MUTATION_ORDER = ['fissure-sight', 'black-hand'];
  const KNOWN_MUTATIONS = new Set(MUTATION_ORDER);

  const MUTATION_TRIGGER_HEAT = 15;    // 이 이상 뜨거운 유물을 하나라도 들고 나오면 변이 후보(안정화 코어·봉인 유물)
  const MUTATION_TRIGGER_ROOMS = 3;    // 이번 조사에서 이만큼 방을 밟았거나
  const MUTATION_TRIGGER_FLOOR = 2;    // 이 층 이상 내려갔으면 트리거 조건 충족(둘 중 하나)
  const FISSURE_SCRATCH_RATE = 0.20;   // 균열 시야가 있으면 균열 출구 긁힘 비율이 조금 커진다(기본 0.15 → 0.20)
  const FISSURE_EXIT_NOTE = '벽 틈이 너무 많이 보여 빠져나오는 길을 한번 잘못 짚었다.';
  const BLACKHAND_CHECKPOINT_SUSP = 1; // 검은 손이 있으면 공식 출구 검문에서 의심도가 1 더 오른다(과하지 않게)
  const BLACKHAND_CHECKPOINT_NOTE = '검은 손이 드러나 검문관이 손등을 한 번 더 훑어봤다.';
  const BLACKHAND_CABINET_NOTE = '휘어진 손잡이가 검은 손에 너무 쉽게 딸려 온다.';

  /* ---------------- 상태 ---------------- */

  const meta = {
    rp: 0,
    bagLevel: 0, // 처음엔 가방이 없다 — 맨손(NO_BAG_LEVEL)
    lightLevel: 1,
    weaponLevel: 1,
    maxDepth: 1,
    totalEarned: 0,
    suspicion: 0,
    truths: [],
    contractIndex: 0,
    extractionCueSeen: false,
    endingSeen: false,
    survivors: [],   // 구출해 지상으로 데려온 생존자 id 목록(조사를 넘어 유지)
    // 구출하지 않고 표시해 둔 생존자 기록(조사를 넘어 유지). id → { outcome, reported }.
    // outcome: 'marked'|'abandoned'. reported: abandoned의 뒤늦은 대가를 이미 치렀는지.
    // 여기에 있어도 meta.survivors에는 없으므로, 후속 조사에서 다시 나타나 구출할 수 있다.
    survivorNotes: {},
    mutations: [],   // 몸에 번진 왜곡 변이 id 목록(조사를 넘어 유지). 알려진 id만, MUTATION_ORDER 순.
  };

  const hasSurvivor = (id) => meta.survivors.includes(id);
  const hasMutation = (id) => meta.mutations.includes(id);
  // 구출하지 않고 표시해 둔 생존자를 기록한다. 같은 사람은 마지막 선택으로 덮어쓴다.
  function noteSurvivor(id, outcome) {
    if (!KNOWN_SURVIVORS.has(id) || !SURVIVOR_OUTCOMES.has(outcome)) return;
    meta.survivorNotes[id] = { outcome, reported: false };
    saveMeta(); // 선택 즉시 저장 — 이번 조사가 실패로 끝나도 기록은 유지된다
  }
  // 나중에 구출했으면 표시해 둔 기록을 지운다(같은 사람이 다시 나타나 구출된 경우).
  function clearSurvivorNote(id) {
    if (meta.survivorNotes[id]) delete meta.survivorNotes[id];
  }
  // 아직 구출하지 않은 생존자 중 하나를 고른다(중복 방지). 없으면 null.
  function nextUnrescuedSurvivor() {
    const pool = SURVIVOR_IDS.filter((id) => !hasSurvivor(id));
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  // 강화 비용: 정비공을 구출했으면 장비(weapon) 강화가 싸진다(결정적). 가방 값은 bagCost로 따로 매긴다.
  function upgradeCost(type) {
    const base = UPGRADES[type].cost(meta[type + 'Level']);
    if (type === 'weapon' && hasSurvivor('mechanic')) {
      return Math.max(1, Math.round(base * (1 - MECHANIC_DISCOUNT)));
    }
    return base;
  }

  // 지상 귀환 시 왜곡 변이 지급(조사당 한 번). 조건이 맞으면 미보유 변이 중 MUTATION_ORDER 순으로
  // 첫 번째를 준다. 무작위 없음(테스트 결정성). 빈 가방이거나 조건 미달이면 아무것도 주지 않는다.
  function grantMutationOnReturn() {
    if (!run || run.mutationChecked) return null;
    run.mutationChecked = true; // 이 조사에서는 다시 판정하지 않는다
    if (!run.bag.length) return null; // 빈손 귀환에서는 발동하지 않는다
    // 아주 뜨거운 유물(heat>=15)을 하나라도 들고 나와야 한다.
    if (!run.bag.some((it) => itemHeat(it) >= MUTATION_TRIGGER_HEAT)) return null;
    // 충분히 깊이 내려갔거나 방을 여럿 밟았어야 한다.
    const deepEnough = run.maxFloor >= MUTATION_TRIGGER_FLOOR || run.roomsEntered >= MUTATION_TRIGGER_ROOMS;
    if (!deepEnough) return null;
    const nextId = MUTATION_ORDER.find((id) => !hasMutation(id));
    if (!nextId) return null; // 이미 v1 변이를 모두 가짐
    meta.mutations.push(nextId);
    saveMeta(); // 지급 즉시 저장 — 이번 조사 결과와 무관하게 몸에 새겨진다
    return MUTATIONS[nextId];
  }

  /* ---------------- 저장 / 이어하기 ---------------- */
  // localStorage에 메타(조사를 넘는 영구 자산)만 저장한다. 조사 상태는 저장하지 않는다.
  // SAVE_VERSION을 올리면 이전 구조의 저장값은 무시되고 기본값으로 새로 시작한다.

  const SAVE_KEY = 'sinkhole-dungeon-save';
  const INTRO_KEY = 'unlit-halls-intro-seen';
  const SOUND_KEY = 'unlit-halls-sound-off'; // '1'이면 소리를 재생하지 않는다(사용자 무음 선택)
  const SAVE_VERSION = 1;

  // 알려진 단서 이름 집합 — 깨진/오래된 truths 값을 거를 때 쓴다.
  // truth 태그가 있는 물건 이름만 담는다(앞으로 truth 없는 일반 회수물이 섞여도 저장값이 오염되지 않게).
  const KNOWN_TRUTHS = new Set(Object.values(ITEM_TABLE).flat().filter(itemTruth).map((it) => it.name));

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
        survivorNotes: meta.survivorNotes,
        mutations: meta.mutations,
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

    // 맨손(0)부터 특대(4)까지. 구버전 저장값(1~4)도 그대로 실린다.
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
    // truths: 배열이면서 현재 회수물에 실제로 존재하는 이름만 두고 중복 제거.
    if (Array.isArray(data.truths)) {
      meta.truths = [...new Set(data.truths.filter((t) => KNOWN_TRUTHS.has(t)))];
    }
    // survivors: 구버전 저장값에는 없다 → 기본 []. 알려진 id만 두고 중복 제거(하위호환).
    if (Array.isArray(data.survivors)) {
      meta.survivors = [...new Set(data.survivors.filter((id) => KNOWN_SURVIVORS.has(id)))];
    }
    // survivorNotes: 구버전 저장값에는 없다 → 기본 {}. 알려진 id·유효 outcome만 두고,
    // 이미 구출한 사람은 기록에서 제외한다(하위호환·깨진 값 정리). SAVE_VERSION은 올리지 않는다.
    meta.survivorNotes = {};
    const rawNotes = data.survivorNotes;
    if (rawNotes && typeof rawNotes === 'object') {
      for (const id of Object.keys(rawNotes)) {
        if (!KNOWN_SURVIVORS.has(id) || meta.survivors.includes(id)) continue;
        const note = rawNotes[id];
        if (note && typeof note === 'object' && SURVIVOR_OUTCOMES.has(note.outcome)) {
          meta.survivorNotes[id] = { outcome: note.outcome, reported: !!note.reported };
        }
      }
    }
    // mutations: 구버전 저장값에는 없다 → 기본 []. 알려진 id만 두고 중복 제거,
    // 표시·지급 순서가 흔들리지 않게 MUTATION_ORDER 순으로 정렬한다. SAVE_VERSION은 올리지 않는다.
    if (Array.isArray(data.mutations)) {
      const known = new Set(data.mutations.filter((id) => KNOWN_MUTATIONS.has(id)));
      meta.mutations = MUTATION_ORDER.filter((id) => known.has(id));
    }
  }

  function clearSave() {
    if (!storageOk) return;
    try { window.localStorage.removeItem(SAVE_KEY); } catch (e) { /* 무시 */ }
  }

  // '기록 초기화' — 저장값을 지우고 meta를 출고 상태로 되돌린다.
  function resetProgress() {
    if (!window.confirm('모든 기록(RP·장비·깊이·의심도·단서·생존자·변이)을 지울까요?')) return;
    clearSave();
    Object.assign(meta, {
      rp: 0, bagLevel: NO_BAG_LEVEL, lightLevel: 1, weaponLevel: 1,
      maxDepth: 1, totalEarned: 0, suspicion: 0, truths: [], contractIndex: 0, extractionCueSeen: false,
      endingSeen: false, survivors: [], survivorNotes: {}, mutations: [],
    });
    renderStartScreen();
  }

  const activeContract = () => CONTRACTS[meta.contractIndex % CONTRACTS.length];

  function nextGoal() {
    if (meta.maxDepth < FLOORS.length) return `${meta.maxDepth + 1}층 도달`;
    if (meta.truths.length < TRUTH_TOTAL) return '단서 더 찾기';
    if (!meta.endingSeen) return '비밀 확인하기';
    return '심층 루프 계속';
  }

  let run = null;
  let timer = null;
  let introMode = 'normal';
  let introLine = 0;
  let bagShopOpen = false; // 강화 화면에서 가방 선택 목록이 열려 있는가

  // 파생값
  const maxLight   = () => 100 + (meta.lightLevel  - 1) * 35;
  const bagCap     = () => bagProduct().cap;
  const weaponFactor = () => 1 + (meta.weaponLevel - 1) * 0.25; // 위험 상승 둔화
  const usedSlots  = () => run.bag.reduce((s, i) => s + i.slots, 0);
  const bagValue   = () => run.bag.reduce((s, i) => s + i.value, 0);
  const roomFor    = (item) => bagCap() - usedSlots() >= item.slots;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function lightPercent() {
    return run ? Math.round((run.light / maxLight()) * 100) : 0;
  }

  function lightState() {
    const pct = lightPercent();
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
      mental: START_MENTAL,
      bag: [],
      danger: 0,
      chasing: false,
      currentItem: null,   // 현재 노드에 놓인, 아직 안 집은 물건
      floorMap: null,      // 이번 층의 작은 맵
      currentNodeId: 0,    // 현재 위치한 노드 id
      holdEvent: null,     // 활성 몬스터 대기 이벤트({type:'cross'|'ambush', node})
      pendingEvent: null,  // 방 도착 후 플레이어가 고르는 짧은 환경 이벤트
      returnWalk: false,   // 귀환 걷기 연출 진행 중(마지막 탭에서 지상으로 나간다)
      exitRoute: 'official', // 지상으로 나가는 길: official|crack|blackpass (판매처 선택 전에 고른다)
      exitNote: '',        // 선택한 출구의 결과 문구(장비 화면 요약에 노출)
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
      roomsEntered: 0,   // 이번 조사에서 처음 밟은 방 수(왜곡 변이 트리거 판정용)
      mutationChecked: false, // 이번 귀환에서 변이 지급을 이미 판정했는가(조사당 한 번)
      mutationNote: '',  // 이번 조사에서 새로 얻은 변이 안내 문구(장비 화면 요약에 노출)
      markedNote: '',    // 이번 판매에서 표식(marked) 회수물 처리 결과 한 줄(장비 화면 요약에 노출)
      grabbedCount: 0,
      droppedCount: 0,
      bought: false,     // 이번 귀환에서 강화를 샀는가
      lastSale: [],      // 판매 화면용 스냅샷
      lastBuyer: null,
      lastTruth: null,
      contractResult: null,
      streetNews: '허가소 앞 전광판이 조용하다.',
      lastPresenceSfx: 'none', // 마지막으로 소리 낸 기척 단계(엣지 트리거로 반복 방지)
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
    { key: 'n',  dx: 0,  dy: -1 },
    { key: 'ne', dx: 1,  dy: -1 },
    { key: 'e',  dx: 1,  dy: 0 },
    { key: 'se', dx: 1,  dy: 1 },
    { key: 's',  dx: 0,  dy: 1 },
    { key: 'sw', dx: -1, dy: 1 },
    { key: 'w',  dx: -1, dy: 0 },
    { key: 'nw', dx: -1, dy: -1 },
  ];
  const MAP_DIRECTION_BY_KEY = Object.fromEntries(MAP_DIRECTIONS.map((d) => [d.key, d]));
  const MAP_DIRECTION_ORDER = ['n', 'ne', 'nw', 'e', 'w', 'se', 'sw', 's'];

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
  // 잠들어 있으면 아주 가끔 인접 칸으로 배회한다. silent면 접근 큐를 두지 않는다.
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
    // 바로 옆까지 붙으면 짧은 큐를 한 번만 띄운다(소리 없는 이동은 제외).
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

  // 집기 소음 처리: 아이템 noise와 조심/재빨리에 따라 추격 압박을 다르게 준다.
  // - careful: 어느 noise든 즉시 한 칸 끌어당기지 않는다(loud=false).
  //     · low/medium: 깨우고 이 칸을 기억시키는 정도.
  //     · high: 조용히 다뤄도 티가 난다 — 이미 두 칸 이상 떨어져 있으면 소리 없이 한 칸 좁혀오고
  //       경고 한 줄을 띄운다. 붙어 있을 때(dist<=1)는 좁히지 않아 부당한 즉살은 없다.
  // - quick: medium/high는 큰 소리라 즉시 한 칸 끌어당긴다(loud=true).
  //     low는 재빨라도 즉시 한 칸까지는 아니다(loud=false) — 대신 호출부에서 위험만 더 오른다.
  // 반환: 상황 문구에 덧붙일 경고(없으면 '').
  function applyPickupNoise(nodeId, item, cautious) {
    const noise = itemNoise(item);
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

  // 숨은 어두운 형체의 '기척'을 4단계로 거칠게 요약한다. 정확한 거리·위험 수치는 절대 노출하지 않고,
  // 화면 연출(가장자리 어둠·미세 깜빡임·짧은 진동)의 강도만 고르기 위한 값이다.
  //   none    안전 — 연출 없음
  //   far     추격이 붙었거나 위험이 어느 정도 — 아주 옅은 가장자리 어둠
  //   near    깨어 바로 옆(≤2)이거나 위험이 높음 — 어둠 강화 + 미세 깜빡임/약한 진동
  //   contact 조우 위기창이 열렸거나 같은 칸이거나 위험이 극에 달함 — 짧게 조이는 강한 가장자리
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

  // 기척 단계를 무대 CSS 클래스로만 반영한다. 매 렌더마다 이전 단계 클래스를 지우고
  // 현재 단계 하나만 붙인다 — 텍스트·숫자·스프라이트는 전혀 노출하지 않는다.
  function renderPresenceFx() {
    const stage = el['stage'];
    if (!stage) return;
    stage.classList.remove('presence-far', 'presence-near', 'presence-contact');
    const tier = presenceTier();
    if (tier !== 'none') stage.classList.add('presence-' + tier);
    maybePlayPresenceSfx(tier);
  }

  // 기척 사운드는 단계가 올라갈 때만, near/contact에서만 짧은 맥동 하나로 낸다.
  // renderPresenceFx는 매 렌더 호출되므로 run.lastPresenceSfx로 엣지 트리거만 잡는다(반복 방지).
  const PRESENCE_RANK = { none: 0, far: 1, near: 2, contact: 3 };
  function maybePlayPresenceSfx(tier) {
    if (!run) return;
    const rank = PRESENCE_RANK[tier] || 0;
    const prevRank = PRESENCE_RANK[run.lastPresenceSfx || 'none'] || 0;
    if (rank > prevRank && rank >= PRESENCE_RANK.near) {
      playSfx(tier === 'contact' ? 'presence-contact' : 'presence-near');
    }
    run.lastPresenceSfx = tier;
  }

  // 층별 배경 테마 v1: 1층 도시 잔해(따뜻한 잔해 톤) · 2층 연구시설(차가운 톤) · 3층+ 시공간 심층(뒤틀린 심층 톤).
  // 무대 배경/시야에 옅은 색조만 얹는 CSS 클래스 하나만 붙인다 — DOM·연출은 그대로, 층에 맞춰 CSS 변수만 바뀐다.
  const FLOOR_THEME_CLASSES = ['floor-theme-ruins', 'floor-theme-lab', 'floor-theme-deep'];
  function floorThemeClass(floor) {
    if (floor >= 3) return 'floor-theme-deep';
    if (floor === 2) return 'floor-theme-lab';
    return 'floor-theme-ruins';
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

  // 끌개 v1: 버린 물건을 바닥 자국으로 두고, 추격자가 그것을 되찾으러 오게 한다.
  // 한 층에 활성 자국은 하나뿐(새로 버리면 이전 자국은 덮인다). 인접 칸(추격자 반대쪽) 우선.
  function dropLootTrace(item) {
    if (!run || !run.floorMap || !item) return null;
    const nodeId = baitAdjacentNodeId();
    run.floorMap.droppedLoot = { nodeId, item, ticks: 0, broken: itemFragile(item) };
    // 추격자를 물건 쪽으로 돌린다 — 플레이어가 아니라 훔친 물건을 좇게 한다.
    const s = stalker();
    if (s) {
      s.lastHeardId = nodeId;
      s.quietSteps = 0;   // 깨워서 회수하러 오게 한다
      s.stepCounter = 0;  // 새 목표이므로 이동 주기를 처음부터
      s.nearCued = false;
    }
    return run.floorMap.droppedLoot;
  }

  // 끌개 회수 판정(틱마다): 추격자가 버린 물건 칸에 닿거나, 깨어 가까이서 유예가 다하면 거둬 간다.
  function maybeRetrieveDroppedLoot() {
    const loot = run && run.floorMap ? run.floorMap.droppedLoot : null;
    if (!loot) return;
    loot.ticks += 1;
    const s = stalker();
    if (!s) return;
    const reached = s.nodeId === loot.nodeId;
    let grace = false;
    if (!reached && loot.ticks >= LOOT_RETRIEVE_TICKS && stalkerAwake()) {
      const d = bfs(run.floorMap.nodes, loot.nodeId)[s.nodeId];
      grace = d != null && d <= 1; // 어두운 형체가 바로 옆까지 왔을 때만 — 멀리서 사라지지 않게
    }
    if (!reached && !grace) return;
    run.floorMap.droppedLoot = null;
    const item = loot.item;
    const obj = `${item.name}${objectParticle(item.name)}`;
    const line = loot.broken
      ? `깨진 채 버린 ${obj}, 어둠이 조각째 훑어 가는 소리가 났다.`
      : `버리고 온 ${obj}, 어둠 저편에서 무언가 도로 끌어가는 소리가 났다.`;
    // 플레이어가 같은/인접 칸일 때만 상황판에도 띄운다(멀면 로그만 — 대사로 도배하지 않는다).
    const nearDist = bfs(run.floorMap.nodes, run.currentNodeId)[loot.nodeId];
    const near = nearDist != null && nearDist <= 1;
    log(line, near ? 'hot' : undefined);
    if (near) run.lastAction = line;
  }

  // 각 층 진입 시 5~7개 노드짜리 작은 맵을 만든다.
  // - 0번은 입구. 가장 깊은 잎 노드는 계단(다음 층 입구)으로 둔다(마지막 층 제외).
  // - 계단은 항상 차수 1(잎)이라, 계단 직전 노드를 반드시 지나가야 한다.
  function generateFloorMap(floor) {
    const isLast = floor >= FLOORS.length;
    const count = 5 + Math.floor(Math.random() * 3); // 5..7
    const nodes = [];
    for (let i = 0; i < count; i++) {
      nodes.push({
        id: i, exits: [], pos: null, kind: null, label: '', desc: '', style: '',
        light: 0, danger: 0, item: null, itemTaken: false,
        monster: null, monsterResolved: false, dangerExit: null, entered: false, roomEventResolved: false,
      });
    }
    nodes[0].pos = { x: 0, y: 0 };

    // 1) 깊이가 보장되도록 등뼈(backbone)를 직선으로 잇는다.
    const spine = Math.max(3, Math.ceil(count * 0.6));
    for (let i = 1; i < spine; i++) addPositionedEdge(nodes, i - 1, i, ['n', 'ne', 'nw']);
    // 2) 나머지 노드는 앞쪽 노드 어딘가에 가지로 붙인다.
    for (let i = spine; i < count; i++) addPositionedEdge(nodes, Math.floor(Math.random() * i), i, ['e', 'w', 'ne', 'nw', 'se', 'sw']);

    // 3) 계단(또는 마지막 층의 가장 깊은 방)은 트리상 가장 먼 잎으로 정한다.
    const treeDist = bfs(nodes, 0);
    let deepestId = 1;
    for (let i = 1; i < count; i++) if (treeDist[i] > treeDist[deepestId]) deepestId = i;
    const stairsId = isLast ? -1 : deepestId;

    // 4) 입구에 갈림길 느낌을 주기 위해 차수를 최소 2로 보장한다.
    if (nodes[0].exits.length < 2) {
      const cand = [];
      for (let k = 1; k < count; k++) if (k !== stairsId && !nodes[0].exits.includes(k)) cand.push(k);
      if (cand.length) {
        const free = cand.filter((id) => canAddVisibleDirectionEdge(nodes, 0, id));
        addEdge(nodes, 0, (free.length ? free : cand)[Math.floor(Math.random() * (free.length ? free.length : cand.length))]);
      }
    }

    // 5) 갈림길을 더 만들기 위해 여분의 연결을 1~2개 추가한다(계단은 잎으로 보존).
    const extra = 1 + Math.floor(Math.random() * 2);
    const extraCandidates = [];
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        if (a !== stairsId && b !== stairsId && canAddVisibleDirectionEdge(nodes, a, b)) extraCandidates.push([a, b]);
      }
    }
    shuffle(extraCandidates);
    for (let e = 0; e < extra && e < extraCandidates.length; e++) {
      addEdge(nodes, extraCandidates[e][0], extraCandidates[e][1]);
    }

    // 6) 방 유형 배정. 흔한 유형만 기본 풀에 넣고, 감시소 같은 드문 유형은 따로 주입한다.
    applyKind(nodes[0], ENTRY_KIND);
    if (stairsId >= 0) applyKind(nodes[stairsId], STAIRS_KIND);
    const others = [];
    for (let i = 0; i < count; i++) if (i !== 0 && i !== stairsId) others.push(i);
    const pool = shuffle(NODE_KINDS.filter((k) => !k.uncommon));
    others.forEach((id, idx) => applyKind(nodes[id], pool[idx % pool.length]));

    // 위원회 감시소는 드물게 등장한다: 낮은 확률로 비입구/비계단 노드 하나를 감시소로 바꾼다.
    let watchpostId = -1;
    const watchpostKind = NODE_KINDS.find((k) => k.key === 'watchpost');
    if (watchpostKind && others.length && Math.random() < WATCHPOST_SPAWN_CHANCE) {
      watchpostId = others[Math.floor(Math.random() * others.length)];
      applyKind(nodes[watchpostId], watchpostKind);
    }

    // 실종자 흔적방도 드물게 등장한다: 감시소가 아닌 비입구/비계단 노드 하나를 흔적방으로 바꾼다(층당 최대 하나).
    let traceId = -1;
    const traceKind = NODE_KINDS.find((k) => k.key === 'missing-trace');
    if (traceKind && Math.random() < MISSING_TRACE_SPAWN_CHANCE) {
      const traceCandidates = others.filter((id) => id !== watchpostId);
      if (traceCandidates.length) {
        traceId = traceCandidates[Math.floor(Math.random() * traceCandidates.length)];
        applyKind(nodes[traceId], traceKind);
      }
    }

    // 7) 아이템 배치: 입구/계단/감시소/흔적방을 제외한 노드 중 2~3개(방 이벤트가 물건에 가려지지 않게).
    const itemSlots = shuffle(others.filter((id) => id !== watchpostId && id !== traceId));
    const itemCount = Math.min(itemSlots.length, 2 + (Math.random() < 0.5 ? 1 : 0));
    for (let i = 0; i < itemCount; i++) nodes[itemSlots[i]].item = pickFloorItem(floor, nodes[itemSlots[i]]);

    // 8) 몬스터 이벤트 배치(시딩/분위기용 — 실제 조우는 숨은 추격자가 전담한다).
    placeMonsters(nodes, others, stairsId, floor);

    // 9) 숨은 이동 추격자 하나를 배치한다.
    const stalker = seedStalker(nodes, 0, stairsId, floor);

    return { nodes, entryId: 0, stairsId, count, travelledEdges: new Set(), stalker, droppedLoot: null };
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
    'btn-enter', 'btn-reset', 'btn-sound', 'start-art', 'intro-panel', 'intro-line', 'intro-hint', 'enter-fade', 'start-rp', 'start-depth', 'start-susp', 'start-codex', 'start-codex-tail', 'start-contract', 'start-goal',
    'btn-meta', 'meta-panel', 'hud-rp', 'hud-depth', 'hud-bag',
    'floor-num', 'floor-name',
    'light-val', 'light-fill', 'mental-val', 'mental-fill', 'danger-val', 'danger-fill', 'risk-panel', 'risk-chip', 'risk-copy',
    'room-choices', 'dock', 'dock-actions',
    'bag-slots', 'choice-cue', 'mini-map', 'recovery-point', 'chaser', 'stage', 'stage-situation', 'dialogue-card', 'dialogue-copy', 'depth-rail', 'log',
    'btn-grab', 'btn-drop', 'btn-return',
    'return-list', 'return-susp', 'committee-rp', 'committee-susp', 'black-rp', 'black-susp', 'return-contract',
    'route-choice', 'route-official', 'route-crack', 'route-blackpass', 'route-note',
    'buy-committee', 'buy-black', 'buy-family', 'family-rp', 'family-susp', 'committee-line', 'black-line', 'family-line', 'sale-buyer', 'run-summary', 'sale-list', 'sale-gain', 'sale-balance', 'sale-susp', 'truth-news', 'sale-contract', 'street-news', 'return-goal',
    'start-survivors', 'start-mutations',
    'up-bag', 'bag-shop', 'up-light', 'up-weapon', 'btn-again',
    'fail-recovery', 'fail-detail', 'fail-susp', 'btn-retry',
    'ending-continue', 'ending-reset',
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
    if (buyer === 'black') return '소문: 암시장 매입가가 올랐다. 대신 검문소가 물건 출처를 캐기 시작했다.';
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
    playSfx('grab'); // 챙기기/되챙기기 공용 훅 — 짧은 천/금속 틱
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

  /* ---------------- 사운드 (WebAudio · 코드 생성 · 파일 없음) ----------------
     모든 소리는 첫 사용자 제스처 이후에만 시작한다(자동재생 금지). AudioContext가
     없거나 브라우저가 막으면 조용히 무시하고 절대 throw하지 않는다. 파일/네트워크
     없이 짧은 톤·노이즈로만 생성한다. localStorage 무음 플래그로 끌 수 있다. */

  let audioCtx = null;
  let masterGain = null;
  let soundOff = false;

  // 저장된 무음 선호를 읽는다(막힌 환경이면 소리 켜짐 기본).
  function loadSoundPref() {
    try { soundOff = window.localStorage.getItem(SOUND_KEY) === '1'; }
    catch (e) { soundOff = false; }
  }

  // 무음 여부를 바꾸고 저장한다. 켜는 순간은 제스처 안이므로 컨텍스트를 깨운다.
  function setSoundOff(off) {
    soundOff = !!off;
    try { window.localStorage.setItem(SOUND_KEY, soundOff ? '1' : '0'); }
    catch (e) { /* 저장 차단 환경 무시 */ }
    if (!soundOff) ensureAudio();
  }

  // 첫 제스처에 컨텍스트를 만들거나 깨운다. 실패해도 조용히 포기한다.
  function ensureAudio() {
    if (soundOff) return null;
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.16; // 마스터 게인 낮게 — 저피로
        masterGain.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
    } catch (e) {
      audioCtx = null; // 막히면 조용히 포기
      return null;
    }
    return audioCtx;
  }

  // 짧은 톤 하나. {freq, to(글라이드 목표), dur(s), type, gain, delay(s)}.
  function tone(opts) {
    const ctx = ensureAudio();
    if (!ctx || !masterGain) return;
    try {
      const o = opts || {};
      const t0 = ctx.currentTime + (o.delay || 0);
      const dur = o.dur || 0.12;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.freq || 440, t0);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + dur);
      const peak = o.gain != null ? o.gain : 0.5;
      // 짧은 어택 + 부드러운 감쇠 — 클릭/거친 소리 방지
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(masterGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch (e) { /* 무시 */ }
  }

  // 짧은 감쇠 노이즈 버스트(천/금속 틱·긁힘·둔탁한 낙하). {dur(s), gain, cutoff(Hz), delay(s)}.
  function noiseBurst(opts) {
    const ctx = ensureAudio();
    if (!ctx || !masterGain) return;
    try {
      const o = opts || {};
      const t0 = ctx.currentTime + (o.delay || 0);
      const dur = o.dur || 0.1;
      const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const g = ctx.createGain();
      const peak = o.gain != null ? o.gain : 0.4;
      g.gain.setValueAtTime(peak, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      let node = src;
      if (o.cutoff) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = o.cutoff;
        src.connect(lp); node = lp;
      }
      node.connect(g); g.connect(masterGain);
      src.start(t0);
      src.stop(t0 + dur + 0.03);
    } catch (e) { /* 무시 */ }
  }

  // 이름표 하나로 핵심 행동 소리를 재생한다. 무음/막힌 오디오/모르는 이름은 조용히 무시.
  function playSfx(name) {
    if (soundOff) return;
    if (!ensureAudio()) return;
    switch (name) {
      case 'grab': // 챙기기 — 짧은 천/금속 틱 + 낮은 확인음
        noiseBurst({ dur: 0.05, gain: 0.26, cutoff: 2600 });
        tone({ freq: 320, to: 360, dur: 0.08, type: 'triangle', gain: 0.26, delay: 0.02 });
        break;
      case 'drop': // 버리고 도망 — 바닥을 긁는 스크레이프
        noiseBurst({ dur: 0.22, gain: 0.3, cutoff: 1400 });
        tone({ freq: 180, to: 90, dur: 0.2, type: 'sawtooth', gain: 0.12 });
        break;
      case 'sale': // 판매/반환 — 낮은 확인 펄스 두 번
        tone({ freq: 210, dur: 0.12, type: 'sine', gain: 0.5 });
        tone({ freq: 280, dur: 0.16, type: 'sine', gain: 0.42, delay: 0.11 });
        break;
      case 'upgrade': // 강화 성공 — 부드럽게 오르는 차임
        tone({ freq: 440, dur: 0.14, type: 'sine', gain: 0.4 });
        tone({ freq: 587, dur: 0.16, type: 'sine', gain: 0.4, delay: 0.1 });
        tone({ freq: 784, dur: 0.24, type: 'sine', gain: 0.34, delay: 0.2 });
        break;
      case 'fail': // 실패/기절 — 짧고 둔탁한 낙하(거칠지 않게)
        tone({ freq: 160, to: 70, dur: 0.32, type: 'sine', gain: 0.5 });
        noiseBurst({ dur: 0.14, gain: 0.16, cutoff: 500, delay: 0.02 });
        break;
      case 'presence-near': // 기척 접근 — 아주 낮고 짧은 맥동 하나
        tone({ freq: 96, dur: 0.5, type: 'sine', gain: 0.32 });
        break;
      case 'presence-contact': // 기척 접촉 — 조금 더 낮고 무거운 맥동 하나
        tone({ freq: 72, dur: 0.6, type: 'sine', gain: 0.4 });
        break;
      default:
        break;
    }
  }

  // 첫 사용자 제스처에 오디오를 깨운다(자동재생 금지 준수). 한 번 쓰면 리스너를 뗀다.
  function unlockAudioOnce() {
    ensureAudio();
    document.removeEventListener('pointerdown', unlockAudioOnce);
    document.removeEventListener('touchstart', unlockAudioOnce);
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

  function handleDungeonDialogueTap(event) {
    if (!run || !run.dialogue || !el['screen-dungeon'] || !el['screen-dungeon'].classList.contains('active')) return;
    if (event && event.target && event.target.closest && event.target.closest('#dialogue-card')) return;
    if (event) event.preventDefault();
    dismissDialogue();
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
    if (run.dialogue) {
      render();
      return;
    }

    // 조명은 잠수 내내 천천히 닳는다.
    run.light = Math.max(0, run.light - FLOORS[run.floor - 1].drain);

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
      // 끌개: 버린 물건 자국이 있으면 매 틱 유예를 세고, 어두운 형체가 닿으면 거둬 간다.
      maybeRetrieveDroppedLoot();
    }

    // 추격 여부는 추격자가 깨어 있는지로만 결정한다.
    run.chasing = stalkerAwake();

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
    const pct = lightPercent();
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

  /* ---------------- 조사 진행 액션 ---------------- */

  // 최고 깊이를 갱신하고, 실제로 늘었을 때만 저장한다.
  function bumpMaxDepth(floor) {
    if (floor > meta.maxDepth) { meta.maxDepth = floor; saveMeta(); }
  }

  // 새 층의 맵을 만들고 입구에 선다.
  function enterFloor(floor) {
    run.floorMap = generateFloorMap(floor);
    run.currentNodeId = run.floorMap.entryId;
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

  // 다음 조사가 시작될 때, 지난 조사에서 등진(abandoned) 생존자 기록마다 딱 한 번 대가를 치른다.
  // 거리 소문 한 줄과 의심도 +1(기록당). 위치만 표시(marked)한 기록은 대가가 없다(안내만).
  function settleSurvivorNotes() {
    let reportedNow = 0;
    for (const id of Object.keys(meta.survivorNotes)) {
      const note = meta.survivorNotes[id];
      if (note.outcome === 'abandoned' && !note.reported) {
        meta.suspicion = Math.min(99, meta.suspicion + SURVIVOR_ABANDON_SUSPICION);
        note.reported = true;
        reportedNow += 1;
      }
    }
    if (reportedNow > 0) {
      saveMeta();
      log(SURVIVOR_STREET_RUMOR, 'hot');
    }
  }

  // 지상 의심도가 문턱을 넘으면 위원회 감시가 입구까지 따라붙는다. 결정적·유계 보정이라
  // 낮을 땐 아무 대가도 없지만(비징벌), 뜨거우면 검문을 피해 내려오느라 시작 멘탈/조명이 깎인다.
  // 이게 '오늘은 위원회에 식히고 가자'는 선택에 실제 이유를 준다.
  function applySuspicionStart() {
    const s = meta.suspicion;
    if (s >= SUSPICION_HOT) {
      run.mental = Math.max(20, run.mental - SUSPICION_HOT_MENTAL);
      run.light = Math.max(20, run.light - SUSPICION_HOT_LIGHT);
      log('입구에 위원회 밴이 늘어서 있다. 감시등을 피해 기어 내려오느라 진이 빠졌다.', 'hot');
    } else if (s >= SUSPICION_TENSE) {
      run.mental = Math.max(30, run.mental - SUSPICION_TENSE_MENTAL);
      log('입구 근처에 위원회 밴 한 대가 서 있다. 신경이 곤두선 채로 내려간다.');
    }
  }

  function startNewRun() {
    if (el['log']) el['log'].innerHTML = '<div class="log-line">아래가 열린다.</div>';
    bagShopOpen = false; // 새 조사로 내려가면 가방 목록은 접어 둔다
    run = newRun();
    settleSurvivorNotes(); // 지난 조사에서 등진 생존자의 뒤늦은 대가(거리 소문·의심도)를 반영
    applySuspicionStart(); // 지상 의심도가 높으면 위원회 감시가 입구까지 따라붙어 시작이 불리해진다
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

  // 던전 진입 연출: 배경이 커지며 화면이 어두워진 뒤 새 조사를 시작한다.
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
    // 재시작·기존 세이브: '들어가기' 버튼을 그대로 눌러 새 조사를 시작한다.
    if (introMode === 'ready') {
      beginEntering();
      return;
    }
    // 단서를 다 모았지만 엔딩을 아직 확인하지 않았다면, 새 조사 대신 엔딩을 먼저 보여준다.
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
        (event.target.closest('#btn-reset') || event.target.closest('#btn-enter') || event.target.closest('#btn-sound'))) return;
    if (event) event.preventDefault();
    advanceIntro();
  }

  // 노드 도착: 환경 효과 1회 적용 → 아이템 노출 → 몬스터 이벤트 발동.
  function arriveAtNode() {
    const node = currentNode();
    const firstVisit = !node.entered;
    if (!node.entered) {
      node.entered = true;
      run.roomsEntered += 1; // 처음 밟은 방만 센다(왜곡 변이 트리거 판정용)
      if (node.light) run.light = Math.max(0, Math.min(maxLight(), run.light + node.light));
      if (node.danger > 0) run.danger = Math.min(100, run.danger + node.danger);
      else if (node.danger < 0) run.danger = Math.max(0, run.danger + node.danger);
    }
    run.currentItem = node.item && !node.itemTaken ? node.item : null;
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

  // 인던 물건 힌트: RP·수치는 감추고 '소리가 클 것 같다 / 깨질 것 같다'만 짧게 흘린다.
  // 물건에 hints가 있으면 그 문구를 쓰고, 없으면 태그별 기본 문구로 떨어진다.
  function itemTraitHint(item) {
    const bits = [];
    const hints = (item && item.hints) || {};
    if (itemMarked(item)) bits.push(hints.marked || '위원회 직인이 작게 찍혀 있다');
    if (itemNoise(item) === 'high') bits.push(hints.noise || '금속이 부딪치면 소리가 클 것 같다');
    if (itemFragile(item)) bits.push(hints.fragile || '모서리가 금 가 있다');
    // 아주 뜨거운 물건은 손에 남는 열기로만 알린다(의심도 수치는 끝까지 감춘다).
    if (itemHeat(item) >= MUTATION_TRIGGER_HEAT) bits.push(hints.heat || '쥐고 있으면 손바닥이 미지근해진다');
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

  // 끌개: 되찾을 수 있는, 내가 버린 물건이 이 칸에 아직 그대로 있는가.
  function droppedLootHere(node) {
    const loot = run && run.floorMap ? run.floorMap.droppedLoot : null;
    return loot && node && loot.nodeId === node.id ? loot : null;
  }

  // 생존자 조우: 아직 구출 안 한 사람이 있을 때만, 드물게 이 방에서 열린다.
  // 물건이 없는 방에서만 호출되므로 회수물 이벤트를 밀어내지 않는다. 열면 true.
  function maybeStartSurvivorEvent(node) {
    if (!node || Math.random() >= SURVIVOR_EVENT_CHANCE) return false;
    const id = nextUnrescuedSurvivor();
    if (!id) return false; // 모두 구출했으면 이벤트 없음
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
        eventChoice('mark', '위치만 표시한다', '벽에 분필로 긋고 물러난다'),
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
      const item = loot.item;
      const brokenHint = loot.broken ? ' 모서리가 깨졌지만, 아직 바닥에 걸려 있다.' : '';
      run.pendingEvent = {
        type: 'dropped-loot',
        title: '버리고 온 물건',
        cue: `버리고 도망쳤던 ${item.name}${subjectParticle(item.name)} 아직 이 자리에 있다.${brokenHint} 지금이라면 되챙길 수 있다.`,
        node: node.id,
        tone: 'hot',
        choices: [
          eventChoice('take-back', '다시 챙긴다', loot.broken ? '깨진 채로 회수한다' : '조용히 되챙긴다', 'good'),
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
      // 서브라벨을 물건 성질에 맞춘다: 깨질 물건은 조심히, 소리 큰 물건은 재빨리 챙길 때 크게 울린다.
      const carefulSub = itemFragile(item) ? '조용히, 깨지지 않게 다룬다' : '조용하지만 시간이 걸린다';
      const grabSub = itemNoise(item) === 'high' ? '빠르지만 크게 울린다' : '빠르지만 소리가 난다';
      ev = {
        type: 'item-encounter',
        title: '눈앞의 회수물',
        cue: itemEncounterCue(node, item),
        choices: [
          eventChoice('careful', '조심히 집는다', carefulSub, 'good'),
          eventChoice('grab', '재빨리 챙긴다', grabSub, 'danger'),
          eventChoice('skip', '그냥 지나간다', '건드리지 않는다'),
        ],
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
      // 전 위원회 직원을 구출했다면 낡은 직원 코드로 조용히 의심도를 더는 안전한 선택지를 연다.
      if (hasSurvivor('insider')) {
        ev.choices.splice(1, 0, eventChoice('seal-code', '봉쇄 코드를 넣는다', '낡은 직원 코드를 쓴다', 'good'));
      }
    } else if (node.kind === 'missing-trace') {
      // 실종자 흔적방 v1: 벽의 사진/이름표/배낭/가족 편지. 유품(family)을 조심히 챙기거나, 사진만 확인하거나, 둔다.
      // 피로가 적고, 선택 큐에 대가(빛·멘탈)를 짧게 드러낸다.
      ev = {
        type: 'missing-trace',
        title: '실종자 흔적',
        cue: '벽에 사진 몇 장과 이름표가 붙어 있다. 그 아래 작은 배낭이 놓였고, 접힌 가족 편지가 삐져나와 있다. 위원회 사람이 여기서 멈춘 것 같다.',
        choices: [
          eventChoice('keep', '조심히 챙긴다', '유품을 조용히 챙긴다 · 빛·멘탈 조금', 'good'),
          eventChoice('photo', '사진만 확인한다', '이름과 날짜만 눈에 담는다'),
          eventChoice('leave', '그냥 둔다', '건드리지 않고 지나친다'),
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
          : '깨진 비상등 안쪽에서 약한 빛이 새어 나온다.',
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

  function resolveMonsterEncounter(ev, choiceId) {
    const kind = MONSTER_ARCHETYPES[ev.monsterKind] || MONSTER_ARCHETYPES.longFace;
    let msg = '';
    let knockedOut = false;

    if (ev.monsterKind === 'longFace') {
      if (choiceId === 'shine') {
        const enoughLight = run.light >= 12;
        run.light = Math.max(0, run.light - 12);
        if (enoughLight) {
          run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 30);
          run.mental = clamp(run.mental + 2, 0, 100);
          msg = '빛을 정면에 고정했다. 구부러진 목이 멈춘다. 어두운 형체가 팔로 눈을 가리는 사이 벽 틈으로 빠져나왔다.';
        } else {
          run.danger = Math.min(100, run.danger + 14);
          msg = '빛이 힘없이 튄다. 검은 팔이 깜빡인 방향으로 먼저 뻗는다.';
          knockedOut = run.danger >= 100;
        }
      } else if (choiceId === 'sidestep') {
        run.light = Math.max(0, run.light - 4);
        if (run.danger < 90 || run.mental >= 18) {
          run.danger = Math.max(0, Math.min(run.danger, MONSTER_GRACE_DANGER) - 14);
          msg = '어두운 형체가 몸을 접는 틈에 옆으로 빠져나왔다. 손끝이 벽만 길게 긁고 지나간다.';
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
      msg = '어두운 형체가 잠깐 물러난 틈에 빠져나왔다.';
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
      if (lightPercent() <= 0) run.light = Math.max(run.light, maxLight() * (MENTAL_BREAK_MIN_LIGHT_PCT / 100));
      if (run.lastMentalLoss) msg = `${outcome.after} ${run.lastMentalLoss}${subjectParticle(run.lastMentalLoss)} 손에서 빠져나갔다.`;
      else msg = outcome ? outcome.after : '간신히 정신을 붙잡았다.';
    } else if (ev.type === 'cabinet') {
      if (choiceId === 'open') {
        // 검은 손 변이: 휘어진 손잡이가 너무 쉽게 딸려 와 조명 소모가 준다(결정적).
        const blackHand = hasMutation('black-hand');
        run.light = Math.max(0, run.light - (blackHand ? 1 : 3));
        const foundBag = !run.currentItem ? bagFindCandidate() : null;
        if (foundBag) {
          meta.bagLevel = foundBag.level;
          saveMeta();
          msg = `찌그러진 캐비닛 안에 멀쩡한 ${foundBag.name}${subjectParticle(foundBag.name)} 걸려 있다. ${foundBag.name}${objectParticle(foundBag.name)} 멨다. ${foundBag.cap}칸 정도의 공간이 생겼다.`;
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
        msg = '캐비닛은 그대로 둔다. 열린 틈이 등 뒤에서 계속 벌어져 있다.';
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
        msg = '잔해 더미를 등지고 물러났다. 무너진 통로는 그대로 막혀 있다.';
      }
    } else if (ev.type === 'watchpost') {
      const tense = meta.suspicion >= WATCHPOST_TENSE_SUSPICION;
      if (choiceId === 'wipe-log') {
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
      } else if (choiceId === 'seal-code' && hasSurvivor('insider')) {
        // 전 직원의 낡은 직원 코드: 소음·위험 없이 의심도를 조금 덜고 봉쇄문/재봉인 단서 한 줄을 흘린다.
        // 비밀은 공짜로 주지 않는다 — 단서 로그일 뿐.
        run.light = Math.max(0, run.light - INSIDER_WATCHPOST_LIGHT);
        if (meta.suspicion > 0) {
          meta.suspicion = Math.max(0, meta.suspicion - INSIDER_WATCHPOST_RELIEF);
          saveMeta();
        }
        msg = INSIDER_SEAL_LOG;
      } else if (choiceId === 'search') {
        run.light = Math.max(0, run.light - 3);
        if (tense) {
          // 의심도가 높으면 뒤지는 게 위험하다 — 경보가 표시되고 의심도가 오른다.
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
          // 비밀을 공짜로 풀지 않는다 — 단서 로그 한 줄만 띄운다.
          msg = WATCHPOST_LOGS[Math.floor(Math.random() * WATCHPOST_LOGS.length)];
        }
      } else {
        run.danger = Math.max(0, run.danger - 1);
        msg = '감시소는 건드리지 않고 지나쳤다. 꺼진 감시등이 등 뒤로 멀어진다.';
      }
    } else if (ev.type === 'missing-trace') {
      if (choiceId === 'keep') {
        // 조심히 챙긴다: 빛·멘탈을 조금 쓰고 유품을 드러낸다.
        // 실제 줍기는 일반 줍기 흐름이 맡는다 — 거기서는 늘 조심히 다루므로 유품 noise는 큰 소리로 번지지 않는다.
        run.light = Math.max(0, run.light - 3);
        run.mental = Math.max(0, run.mental - 2);
        if (!run.currentItem && !node.itemTaken) {
          const keepsake = pickFamilyKeepsake();
          node.item = keepsake;
          run.currentItem = keepsake;
          msg = `벽에서 ${keepsake.name}${objectParticle(keepsake.name)} 조심히 떼어 냈다. ${keepsake.familyNote}`;
        } else {
          msg = '흐트러진 자리를 조용히 정리했다. 더 가져갈 것은 없다.';
        }
      } else if (choiceId === 'photo') {
        // 사진만 확인: 단서 한 줄, 물건 없음. 비밀은 주지 않는다.
        run.mental = Math.max(0, run.mental - 1);
        msg = MISSING_TRACE_LOGS[Math.floor(Math.random() * MISSING_TRACE_LOGS.length)];
      } else {
        // 그냥 둔다: 물건 없음, 등을 돌린 작은 대가(멘탈).
        run.mental = Math.max(0, run.mental - 2);
        msg = '사진도 배낭도 그대로 두고 등을 돌렸다. 이름을 읽지 않은 게 한동안 마음이 무겁다.';
      }
    } else if (ev.type === 'survivor') {
      const s = SURVIVORS[ev.survivorId] || {};
      if (choiceId === 'rescue') {
        // 구출: 빛·멘탈을 쓰고 소음이 나지만, 생존자를 지상으로 데려간다(영구 효과 해금).
        run.light = Math.max(0, run.light - SURVIVOR_RESCUE_LIGHT);
        run.mental = Math.max(0, run.mental - SURVIVOR_RESCUE_MENTAL);
        run.danger = Math.min(100, run.danger + SURVIVOR_RESCUE_DANGER);
        emitNoise(node.id, { loud: false }); // 끌어내는 소리 — 작지 않은 소음
        if (!hasSurvivor(ev.survivorId)) meta.survivors.push(ev.survivorId);
        clearSurvivorNote(ev.survivorId); // 예전에 표시해 뒀던 사람이면 그 기록을 지운다
        saveMeta(); // 구출 즉시 저장 — 이번 조사가 실패로 끝나도 구한 사람은 유지된다
        msg = s.rescueLog || '갇혀 있던 사람을 끌어냈다.';
      } else if (choiceId === 'mark') {
        // 위치만 표시: 구출하지 않지만 표식을 새긴다. 소음·의심은 없고, 새긴 자리는 시작 화면에 기록된다.
        run.mental = Math.max(0, run.mental - 2);
        run.danger = Math.min(100, run.danger + 2);
        noteSurvivor(ev.survivorId, 'marked');
        msg = '벽에 분필로 표시를 두고 물러났다. 손이 비면 다시 오겠다고 스스로에게 말했다.';
      } else {
        // 그냥 지나감: 지금은 조용하지만, 다음 조사에서 거리 소문·의심도로 뒤늦게 돌아온다.
        run.mental = Math.max(0, run.mental - 3);
        run.danger = Math.min(100, run.danger + 1);
        noteSurvivor(ev.survivorId, 'abandoned');
        msg = '못 본 척 등을 돌렸다. 뒤에서 무언가를 두드리는 소리가 한참 따라왔다.';
      }
    } else if (ev.type === 'item-encounter') {
      const item = run.currentItem;
      if (!item) {
        msg = '물건은 이미 챙겼다.';
      } else if (choiceId === 'skip') {
        // 지금은 지나친다. 자국은 그대로라, 다시 이 방을 지날 때 조용히 집을 수 있다.
        run.currentItem = null;
        run.danger = Math.max(0, run.danger - 2);
        msg = `${item.name}${objectParticle(item.name)} 그대로 두고 지나쳤다. 발소리를 죽인 채 물러난다.`;
      } else if (!roomFor(item)) {
        // 가방이 가득 차(맨손이면 손이 가득 차) 집을 수 없다 → 이벤트를 유지해 지나치기/재선택하게 둔다.
        const alert = bagAlert('blocked');
        run.seenBagAlerts.add('blocked');
        run.lastAction = alert;
        log(alert, 'hot');
        showDialogue(alert, 'hot');
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
          msg = packItemLine(item, 'cautious');
          if (noiseWarn) msg += ` ${noiseWarn}`; // 소리 큰 물건은 조심해도 티가 난다.
        } else {
          run.danger = Math.min(100, run.danger + GRAB_DANGER_BUMP + 4);
          const dir = reversePathDirection(node);
          const cue = dir ? `${dir}에서 발소리가 붙는다.` : '뒤쪽에서 발소리가 붙는다.';
          msg = `${item.name}${objectParticle(item.name)} 재빨리 낚아챘다. ${cue}`;
        }
        maybeQueueBagAlert();
        maybeQueueLightAlert();
        maybeQueueMentalAlert();
      }
    } else if (ev.type === 'dropped-loot') {
      const loot = droppedLootHere(node);
      if (!loot) {
        msg = '버린 물건은 이미 어둠 속으로 사라졌다.'; // 그새 어두운 형체가 거둬 갔다.
      } else if (choiceId === 'leave') {
        // 두고 물러난다 — 바닥의 자국을 따라 어두운 형체가 나중에 되찾으러 온다.
        run.danger = Math.max(0, run.danger - 2);
        msg = `${loot.item.name}${objectParticle(loot.item.name)} 그대로 두고 물러났다. 바닥의 자국을 따라 어두운 형체가 되찾으러 올 것이다.`;
      } else if (!roomFor(loot.item)) {
        // 가방이 가득 차(맨손이면 손이 가득 차) 되챙길 수 없다 → 이벤트를 유지해 지나치기/재선택하게 둔다.
        const alert = bagAlert('blocked');
        run.seenBagAlerts.add('blocked');
        run.lastAction = alert;
        log(alert, 'hot');
        showDialogue(alert, 'hot');
        render();
        return;
      } else {
        // 되챙기기: 같은 물건이 가방으로 돌아온다(복제 아님). 되찾으면 버림 카운트도 되돌린다.
        // 깨진 물건은 깨진 채로 돌아온다 — 값이 크게 떨어진다. 이미 깨진 물건을 또 버렸다 주워도
        // 더 부서지진 않는다(itemBroken 확인). 단서·표식은 사본이 그대로 지닌다.
        const taken = loot.broken && !itemBroken(loot.item) ? breakItem(loot.item) : loot.item;
        run.bag.push(taken);
        run.floorMap.droppedLoot = null;
        run.grabbedCount += 1;
        run.droppedCount = Math.max(0, run.droppedCount - 1);
        run.currentItem = null;
        run.light = Math.max(0, run.light - GRAB_LIGHT_COST);
        playGrabFx();
        run.chasing = true;
        applyPickupNoise(node.id, taken, true); // 되챙기는 소리가 난다(조심히 다뤄도 티가 날 수 있다).
        run.danger = Math.min(100, run.danger + GRAB_DANGER_BUMP);
        // 깨진 물건은 값이 떨어진 채로 돌아온다 — 수치 대신 '성한 값은 못 받는다'로만 알린다.
        const brokenTail = itemBroken(taken) ? ' 깨진 모서리가 손끝을 스친다. 성한 값은 못 받을 것이다.' : '';
        msg = `${packItemLine(taken, 'recovered')}${brokenTail}`;
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
        run.mental = clamp(run.mental + 3, 0, 100);
        msg = node && node.kind === 'storage'
          ? '비상 배터리를 연결했다. 손전등 빛이 조금 밝아진다.'
          : '비상등의 남은 빛을 끌어왔다. 앞쪽 윤곽이 잠깐 선명해진다.';
      } else if (choiceId === 'wipe') {
        run.light = clamp(run.light + 7, 0, maxLight());
        run.mental = clamp(run.mental + 5, 0, 100);
        msg = '렌즈의 흙탕물을 닦아냈다. 앞뒤의 깊이가 조금 돌아온다.';
      } else {
        msg = '불안정한 빛은 건드리지 않는다. 등 뒤에서 계속 깜빡인다.';
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
    }
    run.pendingEvent = null;
    run.lastAction = msg || '상황을 정리했다.';
    const actionTone = /울렸다|따라온다|없다|어둠붙이|젖은 발소리|손가락|얼굴|붙는다/.test(run.lastAction) ? 'hot' : undefined;
    log(run.lastAction, actionTone);
    showDialogue(run.lastAction, actionTone || (ev.type === 'mental-break' ? 'good' : ''));
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
    const kind = MONSTER_ARCHETYPES[monsterKind] || MONSTER_ARCHETYPES.longFace;
    const ctx = {
      canLight: run.light >= 6,
      lightStrong: run.light >= 18,
      mentalOk: run.mental >= 18,
      hasBag: run.bag.length > 0,
    };
    const choices = kind.choices(ctx);
    return choices.length ? choices : [eventChoice('hold', '버틴다', '', 'danger')];
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
    showDialogue(run.pendingEvent.cue, 'hot');
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

    if (target.kind === 'stairs') { descend(); return; }

    const fromId = node.id;
    // 이미 깨어 있거나 추격 중이거나 짐을 들었을 때만 발소리를 흘린다.
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

  // 대기. 발소리를 흘려보낸다. 시간이 흘러 조명이 조금 닳고, 조용한 걸음이 쌓여 추격자는 결국 잠든다.
  function chooseWait() {
    if (!run || run.dialogue || run.moving || run.pendingEvent || !stalkerAwake()) return;
    clearDialogue();
    run.light = Math.max(0, run.light - WAIT_LIGHT_COST);
    const s = stalker();
    if (s) {
      s.quietSteps += 1 + (Math.random() < 0.5 ? 1 : 0);
      // 소리 없이 기다리는 동안에도 어두운 형체는 마지막 발소리 쪽으로 느리게 걷는다.
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
      const alert = bagAlert('blocked');
      run.seenBagAlerts.add('blocked');
      run.lastAction = alert;
      log(alert, 'hot');
      showDialogue(alert, 'hot');
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
      run.lastAction = `${packItemLine(item, 'direct')} ${cue}${tail}`;
      log(`${packItemLine(item, 'direct')} ${cue}${tail}`, 'hot');
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
    // 가장 비싼 물건을 떨군다 → 위험 급감. 이제 물건은 사라지지 않고 바닥 자국으로 바뀐다(끌개):
    // 던전은 미끼가 아니라 '되찾을 물건'을 좇는다. 어두운 형체보다 먼저 닿으면 다시 집을 수 있다.
    let idx = 0;
    run.bag.forEach((it, i) => { if (it.value > run.bag[idx].value) idx = i; });
    const dropped = run.bag.splice(idx, 1)[0];
    run.droppedCount += 1;
    run.danger = Math.max(0, run.danger * DROP_DANGER_FACTOR - DROP_DANGER_MINUS);
    dropLootTrace(dropped); // 던진 물건 쪽으로 추격자를 돌리고, 되찾을 수 있는 자국을 만든다.
    playSfx('drop'); // 바닥을 긁는 스크레이프
    const droppedObject = `${dropped.name}${objectParticle(dropped.name)}`;
    const shatter = itemFragile(dropped) ? ' 깨지는 소리가 났다.' : '';
    run.lastAction = `${droppedObject} 던지고 반대쪽으로 뛰었다.${shatter} 발소리가 던진 물건 쪽으로 돌아선다.`;
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
    else log('왔던 길을 거슬러 지상으로 향한다.', 'win');
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
    // TODO(끌개 v2): 귀환 중 버린 짐은 dropLootTrace로 자국을 두지 않는다 — 이 시점엔 이미
    // 계단을 오르며 층을 떠나므로(startReturnWalk) 플레이어가 되찾을 수 없다. 되찾기 루프가
    // 성립하지 않아 v1에서는 조용히 잃는다. 층에 머물러 다시 내려갈 수 있게 되면 그때 연결한다.
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
    // 판매 전에 왜곡 변이 지급을 판정한다(조사당 한 번). 뜨거운 유물을 들고 나왔으면 몸에 흔적이 생긴다.
    const gainedMutation = grantMutationOnReturn();
    if (gainedMutation) {
      run.mutationNote = gainedMutation.gainLog;
      log(gainedMutation.gainLog, 'hot'); // 장비 화면 요약과 함께 던전 로그에도 함께 띄운다
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
      // 이미 깨진 물건은 되챙길 때 값을 한 번 치렀다 — 균열 출구에서 또 긁지 않는다(이중 차감 방지).
      const fragileValue = run.bag.reduce((s, it) => s + (itemFragile(it) && !itemBroken(it) ? it.value : 0), 0);
      // 균열 시야 변이: 틈이 너무 많이 보여 빠져나오는 길을 잘못 짚어 긁힘 비율이 조금 커진다(결정적).
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
          ? '암시장 통로 — 빈손이라 통행료를 받지 않았다. 바로 뒷골목에 붙어 꼬리를 덜 잡힌다.'
          : `암시장 통로 — 통행료 -${EXIT_PASSAGE_FEE} RP로 바로 뒷골목에 붙어 꼬리를 덜 잡힌다.`,
      };
    }
    const heatTotal = run.bag.reduce((s, it) => s + itemHeat(it), 0);
    // 검문이 걸리는 이유를 둘로 나눠 둔다 — 안내 문구가 실제 사유와 맞아야 한다.
    // (뜨거운 짐 때문인지, 이름이 검문 명단에 올랐는지, 혹은 둘 다인지)
    const dueHeat = heatTotal >= EXIT_CHECKPOINT_HEAT;
    const dueSusp = meta.suspicion >= EXIT_CHECKPOINT_SUSP;
    const checkpoint = dueHeat || dueSusp;
    const insider = hasSurvivor('insider');
    let suspAdd = checkpoint ? EXIT_CHECKPOINT_SUSP_ADD : 0;
    let note;
    if (checkpoint) {
      // 전 직원을 구출했다면 미리 넣어 둔 통행 암구호로 오르는 의심도를 조금 덜어낸다.
      // 다만 완전히 없애진 않는다 — 뜨거운 짐/높은 의심도면 여전히 조금은 오른다.
      if (insider) {
        suspAdd = Math.max(0, suspAdd - INSIDER_CHECKPOINT_RELIEF);
        note = suspAdd > 0
          ? '공식 출구 — 검문에 걸렸지만, 전 직원이 준비해 둔 통행 암구호로 검문대가 한풀 눅었다.'
          : '공식 출구 — 검문에 걸렸지만, 전 직원의 통행 암구호에 검문대가 그냥 손을 저었다.';
      } else if (dueHeat) {
        // 뜨거운 짐 때문(둘 다인 경우도 포함) — 짐을 걸고 넘어진 게 맞다.
        note = '공식 출구 — 안전하지만 검문이 있다. 짐이 뜨거워 검문대가 의심도를 조금 올렸다.';
      } else {
        // 짐은 뜨겁지 않은데 의심도만 높은 경우 — 이름이 검문 명단에 올라 걸린 것이다.
        note = '공식 출구 — 안전하지만 검문이 있다. 이름이 검문 명단에 올라 검문대가 의심도를 조금 올렸다.';
      }
      // 검은 손 변이: 검문에 걸리면 손이 눈에 띄어 의심도가 조금 더 오른다(과하지 않게 +1).
      if (hasMutation('black-hand')) {
        suspAdd += BLACKHAND_CHECKPOINT_SUSP;
        note = `${note} ${BLACKHAND_CHECKPOINT_NOTE}`;
      }
    } else {
      note = insider
        ? '공식 출구 — 전 직원이 통행 암구호를 미리 넣어 둬 검문을 매끈하게 통과했다.'
        : '공식 출구 — 안전하지만 검문이 있다. 이번엔 무사히 통과했다.';
    }
    return {
      route,
      suspDelta: suspAdd,
      gainDelta: 0,
      blackSuspRelief: 0,
      note,
    };
  }

  function saleQuote(buyer) {
    const raw = bagValue();
    const eff = routeEffect();
    let gained, suspDelta;
    if (buyer === 'committee') {
      gained = Math.ceil(raw * 0.72);
      suspDelta = -Math.min(10, 2 + run.bag.length * 2);
      // 표식 물건은 위원회 추적 명단에 오른 회수물이라, 정식 반납하면 그 명단이 함께 지워져 의심도가 조금 더 눅는다(유계).
      const markedCount = run.bag.filter(itemMarked).length;
      if (markedCount) suspDelta -= Math.min(MARKED_SUSPICION_CAP, markedCount * MARKED_COMMITTEE_RELIEF);
    } else if (buyer === 'family') {
      // 유품은 가족에게(사례로 값의 일부만), 나머지는 위원회 반납가로 조용히 넘긴다.
      const familyItems = run.bag.filter(itemFamily);
      const otherItems = run.bag.filter((it) => !itemFamily(it));
      const familyRaw = familyItems.reduce((s, it) => s + it.value, 0);
      const otherRaw = otherItems.reduce((s, it) => s + it.value, 0);
      gained = Math.ceil(familyRaw * FAMILY_RETURN_RATE) + Math.ceil(otherRaw * 0.72);
      // 유품 반환 + 조용한 위원회 반납 → 의심도가 눅는다(유품 개수 + 반납 물건 수 기준).
      const committeeRelief = otherItems.length ? Math.min(10, 2 + otherItems.length * 2) : 0;
      suspDelta = -(FAMILY_RETURN_SUSP_RELIEF * familyItems.length + committeeRelief);
      // 유품 자체는 표식이 없다. 위원회 반납분(유품이 아닌 짐)에 표식 물건이 섞여 있으면 그 명단이 함께 지워져 조금 더 눅는다(유계).
      const markedOther = otherItems.filter(itemMarked).length;
      if (markedOther) suspDelta -= Math.min(MARKED_SUSPICION_CAP, markedOther * MARKED_COMMITTEE_RELIEF);
    } else {
      // 암시장 의심도는 물건별 heat 합(등급이 아니라 물건 태그). 태그 없으면 등급으로 보정.
      const heat = run.bag.reduce((sum, it) => sum + itemHeat(it), 0);
      // 과열선(SUSPICION_HOT)을 넘긴 상황이면 물건 출처가 의심스러워 중개상도 부담이 커져 위험 프리미엄을 깎고, 뒷거래로 꼬리가 조금 더 붙는다.
      // 뜨거울수록 '위험 판매'가 더는 공짜가 아니게 되어 위원회 냉각과 저울질하게 된다(결정적·유계).
      const hot = meta.suspicion >= SUSPICION_HOT;
      gained = Math.ceil(raw * (hot ? BLACK_RATE_HOT : BLACK_RATE));
      suspDelta = eff.blackSuspRelief ? Math.max(0, heat - eff.blackSuspRelief) : heat;
      if (hot) suspDelta += BROKER_HOT_SUSP;
      // 표식 물건을 뒷골목에 넘기면 표식된 물건이 단속·소문에 다시 떠올라 꼬리가 조금 더 잡힌다(추가 의심도·유계).
      const markedCount = run.bag.filter(itemMarked).length;
      if (markedCount) suspDelta += Math.min(MARKED_SUSPICION_CAP, markedCount * MARKED_BLACK_SUSPICION);
    }
    gained = Math.max(0, gained + eff.gainDelta);
    suspDelta += eff.suspDelta;
    return { gained, suspDelta, note: eff.note, route: eff.route };
  }

  // 판매처를 'NPC와의 짧은 대화'로 보여주는 한 줄. 왜 그 값·의심도가 나오는지 숫자 대신 사람 말로 전한다.
  // 중개상 대사는 상태에 따라 달라진다 — 물건 출처가 의심스러우면 값을 깎고, 이번 짐에 단서가 있으면 장부 한 줄을 흘린다.
  function buyerDialogue(buyer) {
    if (buyer === 'committee') {
      return '접수창 너머 직원이 서류에 도장을 찍는다. “정식 반납이면 값은 낮습니다. 대신 접수증을 끊어 드리죠. 검문에서 이 짐을 어디서 냈는지 설명이 됩니다.”';
    }
    if (buyer === 'family') {
      return '유족이 유품을 두 손으로 받아 든다. “고맙습니다… 이건 조용히 간직하겠습니다.”';
    }
    // 암시장 중개상: 이름은 묻지 않고 위로 못 올리는 물건이라 더 쳐주는 대신, 짐이 단속·소문에 걸리면 최초 판매자가 누군지 알아낸다.
    const unknown = run.lastSale.find((it) => itemTruth(it) && !meta.truths.includes(it.name));
    const hot = meta.suspicion >= SUSPICION_HOT;
    let line = hot
      ? '중개상이 물건을 보다 혀를 찬다. “이 물건, 출처가 너무 의심스러워. 비싸게는 못 쳐줘. 그래도 꼬리는 잡힐 수 있어.”'
      : '중개상이 천을 걷어 물건을 살핀다. “이름은 안 물어. 위로 못 올리는 물건이라 더 쳐주지. 대신 이게 단속에 걸리면 최초 판매자가 누군지 알아낼 거야.”';
    if (unknown) line += ' 그가 낡은 장부를 밀어 준다. “이 번호, 싱크홀 전날에도 찍혔어.”';
    return line;
  }

  // 표식(marked) 회수물을 이번 판매처로 넘긴 결과를 한 줄로 요약한다(수치·명단은 감춘다).
  // 표식 물건이 없으면 빈 문자열이라 요약 영역에 아무 줄도 더하지 않는다.
  function markedSaleNote(buyer) {
    const markedSold = run.lastSale.filter(itemMarked);
    if (!markedSold.length) return '';
    if (buyer === 'black') {
      return '표식 있는 물건이 뒷골목에 다시 떠올라, 순찰이 이걸 누가 올렸는지 캐고 다닌다.';
    }
    if (buyer === 'committee') {
      return '표식 있는 물건을 정식 창구에 올리자, 그 물건이 공개 수배·검문 목록에서 조용히 빠졌다.';
    }
    if (buyer === 'family') {
      // 유품 자체는 표식이 없다. 위원회 반납분으로 함께 넘어간 표식 짐이 있을 때만 알린다.
      const markedOther = markedSold.filter((it) => !itemFamily(it));
      if (markedOther.length) return '유품과 함께 넘긴 표식 물건이 위원회 반납분에서 조용히 정리됐다.';
    }
    return '';
  }

  function chooseBuyer(buyer) {
    const quote = saleQuote(buyer);
    playSfx('sale'); // 판매처/가족 선택 확인 펄스(위원회·암시장·가족 공용)
    run.exitNote = quote.note; // 장비 화면 요약에 출구 결과를 적어 둔다
    run.markedNote = markedSaleNote(buyer); // 표식(marked) 회수물 처리 결과 한 줄(있을 때만)
    const previousTruthCount = meta.truths.length;
    meta.rp += quote.gained;
    meta.totalEarned += quote.gained;
    meta.suspicion = Math.max(0, Math.min(99, meta.suspicion + quote.suspDelta));
    run.lastBuyer = buyer;
    run.lastTruth = null;

    if (buyer === 'black') {
      // truth 태그가 붙은 회수물만 단서가 된다 — 유품(family, truth 없음)은 팔아도 단서를 늘리지 않는다.
      const unknown = run.lastSale.find((it) => itemTruth(it) && !meta.truths.includes(it.name));
      if (unknown) {
        meta.truths.push(unknown.name);
        run.lastTruth = itemTruthText(unknown);
      }
    }

    if (previousTruthCount !== meta.truths.length) {
      log('암시장 정보상이 단서 하나를 넘겼다.', 'win');
    }
    // 마지막 단서가 이번 판매로 처음 채워졌는가(아래→가득). 매 조사 반복 발동을 막는다.
    const endingUnlocked =
      previousTruthCount < TRUTH_TOTAL &&
      meta.truths.length >= TRUTH_TOTAL &&
      !meta.endingSeen;

    resolveContract(buyer);
    saveMeta(); // 판매처 선택 후 자동 저장 (RP·의심도·단서 반영)
    run.streetNews = makeStreetNews(buyer, quote);
    bagShopOpen = false; // 새 강화 화면은 가방 목록을 접은 채로 연다
    // RP/의심도/의뢰/저장은 그대로 반영하고, 장비 화면도 미리 렌더한다(계속 버튼이 곧장 보여줄 수 있게).
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
    playSfx('fail'); // 기절 — 짧고 둔탁한 낙하(거칠지 않게)
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
    const lostBag = bagProduct();
    const hadBag = meta.bagLevel > NO_BAG_LEVEL; // 빼앗길 가방이 있었는가
    meta.rp += consolation;
    meta.totalEarned += consolation;
    meta.suspicion = Math.max(0, Math.min(99, meta.suspicion + suspDelta));
    meta.bagLevel = NO_BAG_LEVEL; // 가방이 있었으면 통째로 사라지고, 없었으면 그대로 맨손. 다음 조사는 가방 없이 재개.
    saveMeta(); // 실패 보상·가방 상실 후 자동 저장
    el['fail-recovery'].innerHTML = `<b>${outcome.elapsed}</b><span>${outcome.title}</span><p>${outcome.body}</p>`;
    const suspChange = meta.suspicion - previousSuspicion;
    const suspText = suspChange === 0 ? '변화 없음' : signed(suspChange);
    el['fail-detail'].innerHTML = [
      run.failContext ? `마지막 순간: ${run.failContext}` : '',
      hadBag
        ? (lost > 0
            ? `어두운 형체가 후려쳐 기절했다. ${lostBag.name}과 안에 든 물건이 사라져있었다. · 위로금 +${consolation} RP`
            : `어두운 형체가 후려쳐 기절했다. 빈 ${lostBag.name}${subjectParticle(lostBag.name)} 사라져있었다.`)
        : (lost > 0
            ? `어두운 형체가 후려쳐 기절했다. 주머니에 숨겨놓은 물건이 사라져있었다. · 위로금 +${consolation} RP`
            : '어두운 형체가 후려쳐 기절했다. 가진게 없어 사라진 물건은 없었다.'),
      '다음 조사는 가방 없이 가야할지도 모르겠다.',
      outcome.loss,
      medic ? `의무병이 상처를 감싸고 뒤처리를 도왔다${medicBonus > 0 ? ` (+${medicBonus} RP)` : ''}.` : '',
      `의심도 ${suspText}`,
    ].filter(Boolean).map((line) => `<div>${line}</div>`).join('');
    el['fail-susp'].textContent = meta.suspicion;
    run.chasing = false;
    render();
    show('screen-fail');
  }

  /* ---------------- 장비/구매 ---------------- */

  // 조명·장비 손질(가방은 아래 openBagShop/buyBag로 따로 처리한다).
  function buyUpgrade(type) {
    if (run.bought) return;
    const lvKey = type + 'Level';
    const cost = upgradeCost(type); // 정비공 구출 시 장비 강화는 할인가로 계산된다
    if (meta.rp < cost) return;
    meta.rp -= cost;
    meta[lvKey] += 1;
    run.bought = true;
    playSfx('upgrade'); // 장비 마련 성공 — 부드럽게 오르는 차임
    saveMeta(); // 구매 후 자동 저장
    log(`${UPGRADES[type].label}${objectParticle(UPGRADES[type].label)} 손봤다. 다음엔 더 버틴다.`, 'win');
    renderUpgradeScreen(null); // 잔액/버튼 상태 갱신
    flashUpgradeSuccess(type); // 성공한 버튼에 짧은 반짝임 + 가벼운 진동감
  }

  // 가방 구매는 순차 강화가 아니다. '가방 구매'를 누르면 크기 선택 목록을 열고, 원하는 가방을 곧장 산다.
  function openBagShop() {
    if (!run || run.bought) return;
    bagShopOpen = !bagShopOpen;
    renderUpgradeScreen(null);
  }

  // 고른 크기의 가방을 산다(맨손 제외, 지금 것보다 큰 것만). RP가 되면 큰 가방도 곧장 살 수 있다.
  function buyBag(level) {
    if (run.bought) return;
    const product = BAG_PRODUCTS.find((bag) => bag.level === level);
    if (!product || product.level <= NO_BAG_LEVEL) return;
    if (product.level <= meta.bagLevel) return; // 이미 같은/더 큰 가방을 멨다
    const cost = bagCost(level);
    if (cost === Infinity || meta.rp < cost) return;
    meta.rp -= cost;
    meta.bagLevel = product.level; // 고른 가방을 그 자리에서 소유·착용
    run.bought = true;
    bagShopOpen = false;
    playSfx('upgrade'); // 가방 마련 성공 — 부드럽게 오르는 차임
    saveMeta(); // 구매 후 자동 저장
    log(`${product.name}${objectParticle(product.name)} 샀다. ${product.cap}칸 정도의 공간이 생겼다.`, 'win');
    renderUpgradeScreen(null); // 잔액/버튼 상태 갱신
    flashUpgradeSuccess('bag'); // 가방 구매 버튼에 짧은 반짝임 + 가벼운 진동감
  }

  // 구매/손질이 성공한 그 버튼에만 짧은 반짝임/진동 느낌을 준다. 실패·비활성 탭에는 붙지 않는다.
  function flashUpgradeSuccess(type) {
    const btn = el['up-' + type];
    if (!btn) return;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return; // 모션 최소화 설정이면 정적으로 둔다
    btn.classList.remove('up-flash');
    void btn.offsetWidth; // 리플로우로 애니메이션을 확실히 재시작
    btn.classList.add('up-flash');
    window.setTimeout(() => btn.classList.remove('up-flash'), 560); // 가장 긴 반짝임 길이 + 여유
    if (navigator.vibrate) { try { navigator.vibrate(18); } catch (e) {} } // 지원 기기 한정 가벼운 햅틱
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
    el['hud-bag'].textContent = `${usedSlots()}/${bagCap()}`;
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
      el['risk-copy'].textContent = risk.copy;
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
      // 현재 층 테마 클래스 하나만 붙인다 — 층을 내려가면(run.floor) 자동으로 바뀌고, 매 렌더에서 유지된다.
      el['stage'].classList.remove(...FLOOR_THEME_CLASSES);
      el['stage'].classList.add(floorThemeClass(run.floor));
      renderPresenceFx();
    }
    renderStage();
    renderDepthRail();
    renderMiniMap();

    // 액션 버튼: 줍기(스테이지 위), 짐 버리고 튀기, 지상으로 나가기/발길 돌리기.
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
    el['btn-drop'].textContent = '↙ 짐 버리고 튀기';
    el['btn-return'].textContent = run.pendingEvent && run.pendingEvent.type === 'return-attempt'
      ? '↩ 올라가는 중'
      : (run.bag.length > 0 ? '↩ 지상으로 나가기' : '↩ 발길 돌리기');
  }

  function renderBag() {
    const cap = bagCap();
    const cells = [];
    // 각 물건이 차지하는 칸을 색으로 채운다.
    run.bag.forEach((item) => {
      for (let s = 0; s < item.slots; s++) {
        cells.push({ color: TIER_COLOR[item.tier], icon: item.icon, name: item.name, label: s === 0 ? item.name : '' });
      }
    });
    while (cells.length < cap) cells.push(null);

    el['bag-slots'].innerHTML = '';
    cells.forEach((c) => {
      const d = document.createElement('div');
      d.className = 'slot' + (c ? ' filled' : '');
      if (c) {
      d.style.setProperty('--tier-color', c.color);
      d.innerHTML = itemIcon(c.icon, c.name) + (c.label ? `<span class="slot-label">${c.label}</span>` : '');
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

  // 지도공: 한 출구 목적지에 붙일 짧은 표시. 계단·물건 유무·방 특징만, 낮은 정밀도로.
  // 정확한 전리품/RP·몬스터 위치·좌표는 절대 드러내지 않는다.
  function mapperHint(node) {
    if (!node) return '';
    if (node.kind === 'stairs') return '계단';
    if (node.item && !node.itemTaken) return '물건 있음';
    return MAPPER_FEATURE[node.kind] || '';
  }

  // 지도공을 구출했을 때만: 현재 방 각 출구의 목적지 특징을 방향 기호와 함께 한 줄로 미리 보여준다.
  // 방 생성/좌표는 건드리지 않고 이동 선택지 큐에만 붙는다. 방향 배정은 이동 패드와 같은 규칙을 쓴다.
  function mapperCueLine(node) {
    if (!hasSurvivor('mapper') || !node || !node.exits || !node.exits.length) return '';
    const used = new Set();
    const parts = [];
    node.exits.forEach((nid, index) => {
      const t = nodeById(nid);
      if (!t) return;
      const dir = directionForExit(node, t, index, used);
      const hint = mapperHint(t);
      if (hint) parts.push(`${dir.glyph} ${hint}`);
    });
    return parts.length ? `지도공 표시: ${parts.join(' · ')}` : '';
  }

  // 균열 시야 변이: 지도공을 쓰지 않을 때만, 앞쪽 출구 중 틈/계단/아직 안 집은 물건이 있는 방향을
  // 방향 기호와 함께 아주 짧게 짚어 준다. 정확한 전리품·RP·좌표·추격자 위치는 절대 드러내지 않는다.
  // 지도공이 있으면 그쪽 표시가 더 자세하므로 이 줄은 붙이지 않는다(문구가 길어지지 않게).
  function fissureCueLine(node) {
    if (!hasMutation('fissure-sight') || hasSurvivor('mapper')) return '';
    if (!node || !node.exits || !node.exits.length) return '';
    const used = new Set();
    const parts = [];
    node.exits.forEach((nid, index) => {
      const t = nodeById(nid);
      if (!t) return;
      const dir = directionForExit(node, t, index, used);
      let hint = '';
      if (t.kind === 'stairs') hint = '계단';
      else if (t.item && !t.itemTaken) hint = '물건';
      else if (t.kind === 'crack') hint = '틈';
      if (hint) parts.push(`${dir.glyph} ${hint}`);
    });
    return parts.length ? `균열 시야: ${parts.join(' / ')}` : '';
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
    const cue = situationCopy(node);

    if (run.pendingEvent) {
      const sig = `event:${run.currentNodeId}:${run.pendingEvent.type}:${run.pendingEvent.choices.map((choice) => choice.id).join(',')}`;
      if (dock.dataset.choiceSig !== sig) {
        dock.classList.remove('spatial');
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

    // 지도공을 구출했으면 앞쪽 방 미리보기를, 아니면 균열 시야 변이의 짧은 방향 단서를 이동 큐에 덧붙인다.
    // (둘은 겹치지 않는다 — fissureCueLine이 지도공이 있으면 빈 문자열을 돌려준다.)
    const previewLine = mapperCueLine(node) || fissureCueLine(node);
    const moveCue = previewLine ? `${cue}  ${previewLine}` : cue;

    const s = stalker();
    const towardId = stalkerTowardExit(); // 깨어 가까이 붙은 추격자 쪽 출구(없으면 null) — 서 있는 동안에도 갱신되게 서명에 포함한다.
    const waitSig = `wait:${stalkerAwake() ? 1 : 0}:${s ? s.quietSteps : 0}`;
    const moveSig = `move:${run.currentNodeId}:${waitSig}:${node.exits.join(',')}:t${towardId == null ? '-' : towardId}`;
    if (dock.dataset.choiceSig === moveSig) {
      if (el['choice-cue']) el['choice-cue'].textContent = moveCue;
      return;
    }

    dock.classList.remove('event-choices');

    const exitsByDir = new Map();
    const cues = [];
    const usedDirs = new Set();
    let waitButton = '';

    if (stalkerAwake()) {
      waitButton = `<button class="btn room-btn good dir-wait" data-act="wait"><i class="dir-glyph">•</i><span class="choice-text"><b>멈춤</b></span></button>`;
      cues.push('• 발소리를 보내며 기다린다');
    }

    node.exits.forEach((nid, index) => {
      const t = nodeById(nid);
      const stairs = t.kind === 'stairs';
      const dir = directionForExit(node, t, index, usedDirs);
      const copy = movementChoiceCopy(dir, t);
      cues.push(`${dir.glyph} ${copy.label}`);
      const toward = towardId != null && nid === towardId; // 최대 한 개 출구만 표시된다(다음 걸음은 유일하므로).
      const cls = toward ? `${dir.cls} toward-threat` : dir.cls;
      const aria = toward ? `${copy.aria} · 기척이 가까운 쪽` : copy.aria;
      exitsByDir.set(dir.key, `<button class="btn room-btn ${cls}" data-act="${stairs ? 'descend' : 'move'}" data-to="${nid}" aria-label="${aria}"><i class="dir-glyph">${dir.glyph}</i><span class="choice-text"><b>${copy.label}</b></span></button>`);
    });

    const out = DIR_SLOTS.map((dir) => exitsByDir.get(dir.key) || `<div class="room-pad-empty ${dir.cls}" aria-hidden="true"><i class="dir-glyph">${dir.glyph}</i></div>`);
    out.splice(4, 0, waitButton || '<div class="room-pad-center" aria-hidden="true"></div>');
    dock.innerHTML = out.join('');
    dock.dataset.choiceSig = moveSig;
    dock.classList.toggle('spatial', true);
    if (el['choice-cue']) el['choice-cue'].textContent = moveCue;
    dock.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'wait') chooseWait();
        else chooseExit(parseInt(btn.dataset.to, 10));
      });
    });
  }

  function renderMiniMap() {
    const svg = el['mini-map'];
    if (!svg || !run || !run.floorMap) return;
    const nodes = run.floorMap.nodes;
    const current = currentNode();
    if (!current || !current.pos) { svg.innerHTML = ''; return; }

    // Radar behavior: the player is fixed at the center and only already
    // travelled nodes/edges are drawn. Unknown branches and unvisited exits stay
    // hidden; currently active exits may only add tiny center ticks in the same
    // directions as the movement pad, never target nodes or full path length.
    const seen = (id) => nodes[id] && nodes[id].entered;
    const visibleNodes = nodes.filter((n) => seen(n.id) || n.id === run.currentNodeId);
    const center = { x: 60, y: 45 };
    const pad = 14;
    const maxDx = Math.max(1, ...visibleNodes.map((n) => Math.abs((n.pos || current.pos).x - current.pos.x)));
    const maxDy = Math.max(1, ...visibleNodes.map((n) => Math.abs((n.pos || current.pos).y - current.pos.y)));
    const cell = Math.min(22, (center.x - pad) / maxDx, (center.y - pad) / maxDy);
    const coords = nodes.map((n) => {
      const p = n.pos || current.pos;
      return {
        x: center.x + (p.x - current.pos.x) * cell,
        y: center.y + (p.y - current.pos.y) * cell,
      };
    });

    const travelled = run.floorMap.travelledEdges || new Set();
    let html = '';
    travelled.forEach((key) => {
      const [aId, bId] = key.split('-').map((v) => parseInt(v, 10));
      if (!seen(aId) || !seen(bId)) return;
      const a = coords[aId], b = coords[bId];
      html += `<line class="seen" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    });

    if (!run.moving && !run.pendingEvent) {
      const usedDirs = new Set();
      const stubStart = 5.5;
      const stubEnd = 15;
      const stairMark = 18;
      current.exits.forEach((nid, index) => {
        const target = nodeById(nid);
        if (!target) return;
        const slot = directionForExit(current, target, index, usedDirs);
        const dir = slot && MAP_DIRECTION_BY_KEY[slot.key];
        if (!dir) return;
        const len = Math.hypot(dir.dx, dir.dy) || 1;
        const ux = dir.dx / len;
        const uy = dir.dy / len;
        const isTravelled = travelled.has(edgeKey(current.id, nid));
        const isSeen = seen(nid);
        const isStairs = target.kind === 'stairs';

        if (!isSeen && !isTravelled) {
          html += `<line class="exit-hint" x1="${center.x + ux * stubStart}" y1="${center.y + uy * stubStart}" x2="${center.x + ux * stubEnd}" y2="${center.y + uy * stubEnd}"/>`;
        }

        // Stairs are visible structures, but not map reveal. Mark only the
        // current exit direction near the center; never draw the stair node or
        // any destination-floor geometry for an unvisited stair.
        if (isStairs) {
          const x = center.x + ux * stairMark;
          const y = center.y + uy * stairMark;
          const angle = Math.atan2(uy, ux) * 180 / Math.PI;
          const state = isSeen || isTravelled ? ' travelled' : '';
          html += `<g class="stair-marker${state}" transform="translate(${x} ${y}) rotate(${angle})"><path d="M -5 4 H -2 V 1 H 1 V -2 H 4"/><path d="M -4 -4 L 4 -4"/></g>`;
        }
      });
    }

    visibleNodes.forEach((n) => {
      const p = coords[n.id];
      const cls = n.id === run.currentNodeId ? 'current' : 'seen';
      html += `<circle class="${cls}" cx="${p.x}" cy="${p.y}" r="${cls === 'current' ? 4.4 : 3}"/>`;
    });
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
        // 깨진 물건은 이름 옆에 한 마디만 붙인다. 값은 이미 떨어진 채로 찍힌다.
        const brokenTag = itemBroken(it) ? ' · 깨짐' : '';
        row.innerHTML = `<span class="sale-name">${itemIcon(it.icon, it.name)}${it.name}${brokenTag}</span><span class="v">${it.value} RP</span>`;
        list.appendChild(row);
      });
    }
    const committee = saleQuote('committee');
    const black = saleQuote('black');
    el['return-susp'].textContent = meta.suspicion;
    el['committee-rp'].textContent = '+' + committee.gained;
    el['committee-susp'].textContent = signed(committee.suspDelta);
    el['black-rp'].textContent = '+' + black.gained;
    el['black-susp'].textContent = signed(black.suspDelta);
    // 판매처마다 NPC 대사 한 줄을 얹어 '사람과 흥정하는' 느낌을 준다(중개상 대사는 상태에 따라 달라진다).
    if (el['committee-line']) el['committee-line'].textContent = buyerDialogue('committee');
    if (el['black-line']) {
      el['black-line'].textContent = buyerDialogue('black');
      el['black-line'].classList.toggle('hot', meta.suspicion >= SUSPICION_HOT);
    }
    // 가족 반환 v1: 가방에 유품(family)이 있을 때만 '가족에게 돌려준다' 버튼을 연다(없으면 숨겨 잡동사니를 줄인다).
    if (el['buy-family']) {
      const showFamily = run.lastSale.some(itemFamily);
      el['buy-family'].hidden = !showFamily;
      el['buy-family'].disabled = !showFamily;
      if (showFamily) {
        const family = saleQuote('family');
        el['family-rp'].textContent = '+' + family.gained;
        el['family-susp'].textContent = signed(family.suspDelta);
        if (el['family-line']) el['family-line'].textContent = buyerDialogue('family');
      }
    }
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

  function renderStage() {
    const rpEl = el['recovery-point'];
    const node = currentNode();
    if (run.moving) {
      rpEl.className = 'recovery-point empty';
      rpEl.style.borderColor = '';
      rpEl.innerHTML = '<span class="rp-name">앞으로…</span>';
    } else if (run.currentItem) {
      const it = run.currentItem;
      rpEl.className = 'recovery-point';
      rpEl.style.borderColor = TIER_COLOR[it.tier];
      rpEl.innerHTML = `${itemIcon(it.icon, it.name)}<span class="rp-name">${it.name}</span>`;
    } else {
      rpEl.className = 'recovery-point empty';
      rpEl.style.borderColor = '';
      const hint = node && node.kind === 'entry' ? '입구' : node ? node.label : '…';
      rpEl.innerHTML = `<span class="rp-name">${hint}</span>`;
    }

    // 어둠붙이: 위험이 클수록 플레이어(왼쪽)에 가까워진다. 조우 위기 중에는
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

  function renderUpgradeScreen(gained) {
    // 판매 내역
    if (gained !== null) {
      el['sale-buyer'].textContent = run.lastBuyer === 'black' ? '판매처: 암시장' : run.lastBuyer === 'family' ? '판매처: 가족 반환' : '판매처: 위원회';
      const list = el['sale-list'];
      list.innerHTML = '';
      if (run.lastSale.length === 0) {
        list.innerHTML = '<div class="sale-empty">팔 건 없다.</div>';
      } else {
        run.lastSale.forEach((it) => {
          const row = document.createElement('div');
          row.className = 'sale-item';
          row.innerHTML = `<span class="sale-name">${itemIcon(it.icon, it.name)}${it.name}</span><span class="v">+${it.value}</span>`;
          list.appendChild(row);
        });
      }
      el['sale-gain'].textContent = '+' + gained;
    }
    // 출구 결과와, 이번 조사에서 새로 얻은 변이 안내를 한 요약 영역에 함께 보여준다(둘 다 고정 문구).
    if (el['run-summary']) {
      const summaryLines = [run.exitNote, run.markedNote, run.mutationNote].filter(Boolean);
      el['run-summary'].innerHTML = summaryLines.join('<br>');
    }
    el['sale-balance'].textContent = meta.rp;
    el['sale-susp'].textContent = meta.suspicion;
    renderGoals();
    renderContractCards();
    el['street-news'].textContent = run.streetNews;
    if (run.lastTruth) {
      el['truth-news'].hidden = false;
      el['truth-news'].textContent = `단서: ${run.lastTruth}`;
    } else {
      el['truth-news'].hidden = true;
      el['truth-news'].textContent = '';
    }

    // 손질 버튼 2종(조명·장비). 정비공을 구출했으면 장비 설명에 할인을 덧붙인다. 가방은 아래에서 따로 그린다.
    const weaponSub = hasSurvivor('mechanic') ? `들키는 속도 -25% · 정비공 할인` : `들키는 속도 -25%`;
    const gearDefs = [
      ['up-light',  'light',  `조명 손보기`,  `최대 조명 +35`, 8],
      ['up-weapon', 'weapon', `장비 개조`,   weaponSub,       9],
    ];
    gearDefs.forEach(([id, type, title, sub, upgradeIcon]) => {
      const lvKey = type + 'Level';
      const cost = upgradeCost(type);
      const btn = el[id];
      const affordable = cost !== Infinity && meta.rp >= cost && !run.bought;
      btn.disabled = !affordable;
      btn.classList.toggle('bought', run.bought);
      btn.innerHTML =
        `<span class="up-title">${itemIcon(upgradeIcon)}${title}</span>` +
        `<span class="up-sub">${sub} · 현재 Lv.${meta[lvKey]}</span>` +
        `<span class="up-cost">${run.bought ? '오늘은 여기까지' : cost + ' RP'}</span>`;
    });

    renderBagShop();
  }

  // 가방 구매 버튼과 크기 선택 목록을 그린다. 상단 버튼을 누르면 목록이 열리고, 원하는 크기를 곧장 산다.
  function renderBagShop() {
    const currentBag = bagProduct();
    const open = bagShopOpen && !run.bought;
    const btn = el['up-bag'];
    if (btn) {
      btn.disabled = !!run.bought;
      btn.classList.toggle('bought', run.bought);
      btn.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const currentText = currentBag.level === NO_BAG_LEVEL ? '현재: 맨손' : `현재: ${currentBag.name} · ${currentBag.cap}칸`;
      const hint = run.bought ? '오늘은 여기까지' : (open ? '접기' : '고르기');
      btn.innerHTML =
        `<span class="up-title">${itemIcon(7)}가방 구매</span>` +
        `<span class="up-sub">${currentText}</span>` +
        `<span class="up-cost">${hint}</span>`;
    }
    const panel = el['bag-shop'];
    if (!panel) return;
    panel.hidden = !open;
    panel.innerHTML = '';
    if (!open) return;
    purchasableBags().forEach((product) => {
      const owned = product.level === meta.bagLevel;
      const smaller = product.level < meta.bagLevel;
      const cost = bagCost(product.level);
      const affordable = meta.rp >= cost;
      const canBuy = !owned && !smaller && affordable;
      const choice = document.createElement('button');
      choice.className = 'btn bag-choice' + (owned ? ' owned' : '');
      choice.disabled = !canBuy;
      let state;
      if (owned) state = '사용 중';
      else if (smaller) state = '가진 것보다 작음';
      else if (!affordable) state = `${cost} RP · 부족`;
      else state = `${cost} RP`;
      choice.innerHTML =
        `<span class="bag-choice-name">${itemIcon(7)}${product.name}</span>` +
        `<span class="bag-choice-cap">${product.cap}칸</span>` +
        `<span class="bag-choice-cost">${state}</span>`;
      choice.addEventListener('click', (event) => { event.stopPropagation(); buyBag(product.level); });
      panel.appendChild(choice);
    });
  }

  // 단서를 다 모은 뒤 열리는 엔딩 화면. 문구가 전부 고정이라 run 없이도 안전하게 재표시할 수 있다(별도 갱신 불필요).
  function renderEndingScreen() {}

  // 엔딩을 '확인함'으로 표시하고, 장비 루프로 돌아가 계속 플레이한다.
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

  function bind() {
    // 첫 사용자 제스처에 오디오 컨텍스트를 깨운다(자동재생 금지). 한 번 쓰면 스스로 뗀다.
    document.addEventListener('pointerdown', unlockAudioOnce);
    document.addEventListener('touchstart', unlockAudioOnce);
    el['btn-enter'].addEventListener('click', handleStartButton);
    if (el['screen-start']) el['screen-start'].addEventListener('click', handleStartScreenTap);
    if (el['btn-meta']) el['btn-meta'].addEventListener('click', (event) => {
      if (run && run.dialogue) {
        event.preventDefault();
        return;
      }
      toggleMetaPanel();
    });
    if (el['screen-dungeon']) el['screen-dungeon'].addEventListener('click', handleDungeonDialogueTap);
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
    el['up-bag'].addEventListener('click', () => openBagShop());
    el['up-light'].addEventListener('click', () => buyUpgrade('light'));
    el['up-weapon'].addEventListener('click', () => buyUpgrade('weapon'));
    el['btn-again'].addEventListener('click', startNewRun);
    el['btn-retry'].addEventListener('click', startNewRun);
    if (el['btn-reset']) el['btn-reset'].addEventListener('click', resetProgress);
    if (el['btn-sound']) el['btn-sound'].addEventListener('click', (event) => { event.stopPropagation(); toggleSound(); });
    if (el['ending-continue']) el['ending-continue'].addEventListener('click', acknowledgeEnding);
    if (el['ending-reset']) el['ending-reset'].addEventListener('click', resetProgress);
  }

  /* ---------------- 시작 ---------------- */

  // 시작 화면의 속마음 한 줄. 숫자 카운터가 아니라 진행에 맞춰 달라지는 캐릭터의 혼잣말이다.
  function codexTail() {
    const n = meta.truths.length;
    if (n <= 0) return '왜 이런 일이 나에게 일어난 거지…';
    if (n < TRUTH_TOTAL) return '팔아넘긴 물건마다 이상한 말이 따라온다.';
    return meta.endingSeen ? '아래가 아직 끝나지 않았다.' : '이제 단서가 다 모인 것 같다.';
  }

  // 시작 화면 속마음 줄을 한곳에서 갱신한다(단서를 다 모으면 색을 바꿔 완성감을 준다).
  function renderCodex() {
    el['start-codex-tail'].textContent = codexTail();
    el['start-codex'].classList.toggle('complete', meta.truths.length >= TRUTH_TOTAL);
  }

  // 구출한 생존자와, 구출하지 않고 표시해 둔 자리를 시작 화면에 짧게 표시한다(둘 다 없으면 줄을 숨긴다).
  function renderStartSurvivors() {
    const line = el['start-survivors'];
    if (!line) return;
    const names = meta.survivors.map((id) => SURVIVORS[id] && SURVIVORS[id].name).filter(Boolean);
    const notes = Object.values(meta.survivorNotes);
    const markedCount = notes.filter((n) => n.outcome === 'marked').length;
    const abandonedCount = notes.filter((n) => n.outcome === 'abandoned').length;
    if (!names.length && !markedCount && !abandonedCount) { line.hidden = true; line.textContent = ''; return; }
    line.hidden = false;
    const parts = [];
    if (names.length) parts.push(`구출한 생존자 <b>${names.length}</b>명 · <b>${names.join(', ')}</b>`);
    if (markedCount) parts.push(`표시해 둔 위치 <b>${markedCount}</b>곳`);
    if (abandonedCount) parts.push(`등진 생존자 <b>${abandonedCount}</b>명`);
    line.innerHTML = parts.join(' / ');
  }

  // 몸에 남은 왜곡 변이를 시작 화면에 짧게 표시한다(없으면 줄을 숨긴다).
  function renderStartMutations() {
    const line = el['start-mutations'];
    if (!line) return;
    const names = meta.mutations.map((id) => MUTATIONS[id] && MUTATIONS[id].name).filter(Boolean);
    if (!names.length) { line.hidden = true; line.textContent = ''; return; }
    line.hidden = false;
    line.innerHTML = `몸에 남은 흔적 · <b>${names.join(', ')}</b>`;
  }

  // 소리/무음 토글 라벨과 상태를 갱신한다(현재 상태를 그대로 표시하는 스위치).
  function renderSoundToggle() {
    const btn = el['btn-sound'];
    if (!btn) return;
    btn.textContent = soundOff ? '무음' : '소리';
    btn.setAttribute('aria-pressed', soundOff ? 'true' : 'false');
    btn.setAttribute('aria-label', soundOff ? '소리 꺼짐, 눌러서 켜기' : '소리 켜짐, 눌러서 끄기');
  }

  function toggleSound() {
    setSoundOff(!soundOff);
    renderSoundToggle();
    if (!soundOff) playSfx('sale'); // 켜는 순간(제스처 안) 짧은 확인음 하나
  }

  // 시작 화면 메타 표시를 한곳에서 갱신한다(초기 진입 + 기록 초기화 공용).
  function renderStartScreen() {
    el['start-rp'].textContent = meta.rp;
    el['start-depth'].textContent = meta.maxDepth;
    el['start-susp'].textContent = meta.suspicion;
    renderCodex();
    renderStartSurvivors();
    renderStartMutations();
    renderSoundToggle();
    renderGoals();
    renderContractCards();
  }

  function init() {
    cacheDom();
    bind();
    loadSoundPref(); // 무음 선호 복원 (막힌 환경이면 소리 켜짐 기본)
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

  // 헤드리스(Node) 검증용: 순수 맵 생성 로직만 노출한다. 브라우저에는 영향 없음.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { generateFloorMap, bfs, FLOORS, ITEM_TABLE, NODE_KINDS, itemTruth, itemTruthText, TRUTH_TOTAL };
  }
})();
