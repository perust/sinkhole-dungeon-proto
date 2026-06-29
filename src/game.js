/* ============================================================
   도심 싱크홀 — 회수 잠수 (플레이어블 프로토타입)

   핵심 훅: "던전이 내가 훔친 물건을 다시 가져가려 한다."
   루프:    챙기고 → 도망치고 → 팔고 → 강화 → 더 깊이.

   - 메타 상태(meta): 런을 넘어 유지되는 영구 자산(RP, 강화 레벨, 최고 깊이).
   - 런 상태(run):    한 번의 잠수 동안만 존재하는 상태(층, 조명, 가방, 위험, 작은 맵).
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
    { n: 3, name: '시공간이 접힌 구역', drain: 0.55, dangerBase: 0.60 },
  ];

  // 회수물 6종 — 층이 깊을수록 무겁고(칸) 비싸다(RP).
  const ITEM_TABLE = {
    1: [
      { name: '실험용 배터리', slots: 1, value: 6,  tier: 'common', icon: 0, truth: '배터리에는 위원회 마크가 지워진 흔적이 있다.' },
      { name: '배관 부품',     slots: 1, value: 5,  tier: 'common', icon: 1, truth: '도시 배관은 사고 전부터 아래로 이어져 있었다.' },
    ],
    2: [
      { name: '봉인 데이터칩', slots: 2, value: 10, tier: 'rare', icon: 2, truth: '데이터칩의 날짜는 싱크홀 발생 전날로 찍혀 있다.' },
      { name: '연구 노트',     slots: 1, value: 7,  tier: 'rare', icon: 3, truth: '연구 노트에는 ‘회수자’가 방범 시스템이라고 적혀 있다.' },
    ],
    3: [
      { name: '안정화 코어',   slots: 2, value: 18, tier: 'epic', icon: 4, truth: '코어는 싱크홀을 막는 장치가 아니라 더 깊게 여는 열쇠다.' },
      { name: '봉인 유물',     slots: 3, value: 30, tier: 'epic', icon: 5, truth: '봉인 유물의 문양은 지상 허가증의 직인과 같다.' },
    ],
  };

  const TIER_COLOR = { common: '#7fb0ff', rare: '#b98bff', epic: '#ffd166' };
  const TIER_HEAT = { common: 4, rare: 8, epic: 14 };
  const TRUTH_TOTAL = Object.values(ITEM_TABLE).flat().length;

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
    { key: 'hall',     label: '무너진 통로', desc: '머리 위가 삐걱인다', style: '',       light: -6, danger: 5 },
    { key: 'crack',    label: '오른쪽 균열', desc: '젖은 발자국',        style: 'danger', light: -8, danger: 9 },
  ];
  const ENTRY_KIND  = { key: 'entry',  label: '입구',       desc: '',            style: '', light: 0, danger: 0 };
  const STAIRS_KIND = { key: 'stairs', label: '계단 아래로', desc: '더 깊은 냉기', style: '', light: 0, danger: 0 };

  const FLOOR_OPEN_CUE = [
    '아래에서 찬바람이 올라온다.',
    '벽이 미세하게 떨린다.',
    '공간이 접힌 듯 어긋나 있다.',
  ];

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
  const WAIT_LIGHT_COST     = 4;  // 기다리기: 시간이 흘러 조명 소모
  // 몬스터 이벤트 위험 수치
  const SIGHT_DANGER        = 8;  // 직선 끝에서 이상한 기척
  const SIGHT_MOVE_DANGER   = 6;  // 그쪽으로 전진할 때 추가 위험
  const CROSS_DANGER        = 4;  // 갈림길을 회수자가 지나감(도착)
  const CROSS_MOVE_DANGER   = 14; // 지나가는 중에 움직이면 들킴
  const AMBUSH_MOVE_DANGER  = 20; // '움직이면 들킴' 상태에서 이동
  const TICK_MS            = 150;
  const MOVE_MS            = 420; // 전진 연출은 짧게, 상황 문구는 상단 패널에 지속
  const DESCEND_MS         = 560; // 층 이동 연출도 조작감을 해치지 않게 짧게 유지

  const RECOVERY_OUTCOMES = [
    {
      elapsed: '1시간 후',
      title: '다른 조사자에게 발견됐다.',
      body: '낯선 조사자가 비상등 하나를 흔들며 당신을 끌어냈다.',
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
      body: '치료비는 말없이 계산됐다. 누가 당신을 맡겼는지는 모른다.',
      rpRate: 0.25,
      suspDelta: 7,
      loss: '쓸 만한 회수품 일부가 치료비로 사라졌다.',
    },
  ];

  // 강화: 레벨에 비례해 비용 상승
  const UPGRADES = {
    bag:    { label: '가방',  cost: lv => 8  * lv },
    light:  { label: '조명',  cost: lv => 5  * lv },
    weapon: { label: '무기',  cost: lv => 10 * lv },
  };

  /* ---------------- 상태 ---------------- */

  const meta = {
    rp: 0,
    bagLevel: 1,
    lightLevel: 1,
    weaponLevel: 1,
    maxDepth: 1,
    totalEarned: 0,
    suspicion: 0,
    truths: [],
    contractIndex: 0,
  };

  /* ---------------- 저장 / 이어하기 ---------------- */
  // localStorage에 메타(런을 넘는 영구 자산)만 저장한다. 런 상태는 저장하지 않는다.
  // SAVE_VERSION을 올리면 이전 구조의 저장값은 무시되고 기본값으로 새로 시작한다.

  const SAVE_KEY = 'sinkhole-dungeon-save';
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

    meta.bagLevel    = safeInt(data.bagLevel,    1, 1);
    meta.lightLevel  = safeInt(data.lightLevel,  1, 1);
    meta.weaponLevel = safeInt(data.weaponLevel, 1, 1);
    meta.rp          = safeInt(data.rp,          0, 0);
    meta.totalEarned = safeInt(data.totalEarned, meta.rp, 0);
    meta.maxDepth    = safeInt(data.maxDepth,    1, 1, FLOORS.length);
    meta.suspicion   = safeInt(data.suspicion,   0, 0, 99);
    meta.contractIndex = safeInt(data.contractIndex, 0, 0);
    // truths: 배열이면서 현재 회수물에 실제로 존재하는 이름만 남기고 중복 제거.
    if (Array.isArray(data.truths)) {
      meta.truths = [...new Set(data.truths.filter((t) => KNOWN_TRUTHS.has(t)))];
    }
  }

  function clearSave() {
    if (!storageOk) return;
    try { window.localStorage.removeItem(SAVE_KEY); } catch (e) { /* 무시 */ }
  }

  // '기록 초기화' — 저장값을 지우고 meta를 출고 상태로 되돌린다.
  function resetProgress() {
    if (!window.confirm('모든 기록(RP·강화·깊이·의심도·진실 조각)을 지울까요?')) return;
    clearSave();
    Object.assign(meta, {
      rp: 0, bagLevel: 1, lightLevel: 1, weaponLevel: 1,
      maxDepth: 1, totalEarned: 0, suspicion: 0, truths: [], contractIndex: 0,
    });
    renderStartScreen();
  }

  const activeContract = () => CONTRACTS[meta.contractIndex % CONTRACTS.length];

  function nextGoal() {
    if (meta.maxDepth < FLOORS.length) return `${meta.maxDepth + 1}층 도달`;
    if (meta.truths.length < TRUTH_TOTAL) return '진실 조각 더 찾기';
    return '3층에서 더 많이 들고 나오기';
  }

  let run = null;
  let timer = null;

  // 파생값
  const maxLight   = () => 100 + (meta.lightLevel  - 1) * 35;
  const bagCap     = () => 3   + (meta.bagLevel    - 1) * 2;
  const weaponFactor = () => 1 + (meta.weaponLevel - 1) * 0.25; // 위험 상승 둔화
  const usedSlots  = () => run.bag.reduce((s, i) => s + i.slots, 0);
  const bagValue   = () => run.bag.reduce((s, i) => s + i.value, 0);
  const roomFor    = (item) => bagCap() - usedSlots() >= item.slots;

  function newRun() {
    return {
      floor: 1,
      light: maxLight(),
      bag: [],
      danger: 0,
      chasing: false,
      currentItem: null,   // 현재 노드에 놓인, 아직 안 집은 물건
      floorMap: null,      // 이번 층의 작은 맵
      currentNodeId: 0,    // 현재 위치한 노드 id
      holdEvent: null,     // 활성 몬스터 대기 이벤트({type:'cross'|'ambush', node})
      pendingEvent: null,  // 방 도착 후 플레이어가 고르는 짧은 환경 이벤트
      moving: false,       // 전진/강하 연출 중
      lastAction: '',      // 다음 의미 있는 행동/상태 갱신 전까지 상단 상황판에 남길 최근 맥락
      maxFloor: 1,
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

    // 6) 방 유형 배정.
    applyKind(nodes[0], ENTRY_KIND);
    if (stairsId >= 0) applyKind(nodes[stairsId], STAIRS_KIND);
    const others = [];
    for (let i = 0; i < count; i++) if (i !== 0 && i !== stairsId) others.push(i);
    const pool = shuffle(NODE_KINDS.slice());
    others.forEach((id, idx) => applyKind(nodes[id], pool[idx % pool.length]));

    // 7) 아이템 배치: 입구/계단을 제외한 노드 중 2~3개.
    const itemSlots = shuffle(others.slice());
    const itemCount = Math.min(itemSlots.length, 2 + (Math.random() < 0.5 ? 1 : 0));
    for (let i = 0; i < itemCount; i++) nodes[itemSlots[i]].item = pickFloorItem(floor, nodes[itemSlots[i]]);

    // 8) 몬스터 이벤트 배치.
    placeMonsters(nodes, others, stairsId, floor);

    return { nodes, entryId: 0, stairsId, count, travelledEdges: new Set() };
  }

  // 몬스터 이벤트 3종:
  //  - sight : 직선 끝에서 이상한 기척(위험 상승, 선택은 가능, 그쪽으로 가면 위험 추가)
  //  - cross : 앞 갈림길을 회수자가 지나감(기다리거나 다른 길; 지나가는 중 움직이면 들킴)
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
      nodes[id].monster = { type };
      if (type === 'sight') {
        const nb = nodes[id].exits;
        nodes[id].dangerExit = nb.length ? nb[Math.floor(Math.random() * nb.length)] : null;
      }
    });
  }

  /* ---------------- DOM 캐시 ---------------- */

  const el = {};
  const IDS = [
    'screen-start', 'screen-dungeon', 'screen-return', 'screen-upgrade', 'screen-fail',
    'btn-enter', 'btn-reset', 'start-rp', 'start-depth', 'start-susp', 'start-truth-count', 'start-codex', 'start-contract', 'start-goal',
    'hud-rp', 'hud-depth', 'hud-bag',
    'floor-num', 'floor-name',
    'light-val', 'light-fill', 'danger-val', 'danger-fill', 'risk-panel', 'risk-chip', 'risk-copy',
    'room-choices', 'dock', 'dock-actions',
    'bag-slots', 'choice-cue', 'mini-map', 'recovery-point', 'chaser', 'stage', 'depth-rail', 'log',
    'btn-grab', 'btn-drop', 'btn-return',
    'return-list', 'return-susp', 'committee-rp', 'committee-susp', 'black-rp', 'black-susp', 'return-contract',
    'buy-committee', 'buy-black', 'sale-buyer', 'sale-list', 'sale-gain', 'sale-balance', 'sale-susp', 'truth-news', 'sale-contract', 'street-news', 'return-goal',
    'up-bag', 'up-light', 'up-weapon', 'btn-again',
    'fail-recovery', 'fail-detail', 'fail-susp', 'btn-retry',
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

  /* ---------------- 틱 루프 ---------------- */

  function startTick() { stopTick(); timer = setInterval(tick, TICK_MS); }
  function stopTick()  { if (timer) { clearInterval(timer); timer = null; } }

  function tick() {
    if (!run) return;

    // 조명은 잠수 내내 천천히 닳는다.
    run.light = Math.max(0, run.light - FLOORS[run.floor - 1].drain);

    // 추격 중에만 위험이 오른다.
    if (run.chasing) {
      let rate = FLOORS[run.floor - 1].dangerBase / weaponFactor();
      if (run.light <= 0) rate *= 2.2; // 조명 0 → 회수자 광폭화
      run.danger = Math.min(100, run.danger + rate);

      if (run.danger >= 100) { failRun(); return; }
    }
    render();
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
    run.holdEvent = null;
    const entry = currentNode();
    entry.entered = true; // 입구 환경 효과는 없음
    run.currentItem = entry.item && !entry.itemTaken ? entry.item : null;
    const f = FLOORS[floor - 1];
    run.lastAction = `${f.n}층 진입. ${FLOOR_OPEN_CUE[floor - 1] || ''}`.trim();
    log(`${f.n}층. ${FLOOR_OPEN_CUE[floor - 1] || ''}`);
  }

  function startNewRun() {
    if (el['log']) el['log'].innerHTML = '<div class="log-line">아래가 열린다.</div>';
    run = newRun();
    bumpMaxDepth(run.floor);
    enterFloor(1);
    show('screen-dungeon');
    render();
    startTick();
  }

  // 노드 도착: 환경 효과 1회 적용 → 아이템 노출 → 몬스터 이벤트 발동.
  function arriveAtNode() {
    const node = currentNode();
    if (!node.entered) {
      node.entered = true;
      if (node.light) run.light = Math.max(0, Math.min(maxLight(), run.light + node.light));
      if (node.danger > 0) run.danger = Math.min(100, run.danger + node.danger);
      else if (node.danger < 0) run.danger = Math.max(0, run.danger + node.danger);
    }
    run.currentItem = node.item && !node.itemTaken ? node.item : null;
    run.lastAction = run.currentItem ? `${run.currentItem.name}${subjectParticle(run.currentItem.name)} 눈에 들어온다.` : '새 구역에 도착했다.';
    if (run.currentItem) log(`${run.currentItem.name}.`, node.style === 'danger' ? 'hot' : undefined);
    maybeStartRoomEvent(node);
    triggerMonster(node);
  }

  function eventChoice(id, label, sub, tone = '') {
    return { id, label, sub, tone };
  }

  function maybeStartRoomEvent(node) {
    if (!node || node.roomEventResolved || node.kind === 'entry' || node.kind === 'stairs') return;
    let ev = null;
    if (node.kind === 'office') {
      ev = {
        type: 'cabinet',
        title: '잠긴 캐비닛',
        cue: '찌그러진 캐비닛 문이 반쯤 벌어져 있다.',
        choices: [
          eventChoice('open', '조심히 연다', '회수물 확인', 'good'),
          eventChoice('skip', '그냥 지나간다', '조용히 무시'),
          eventChoice('noise', '소리를 내서 확인한다', '기척을 떠본다', 'danger'),
        ],
      };
    } else if (node.kind === 'crack' || node.kind === 'corridor' || node.kind === 'hall') {
      ev = {
        type: 'footprints',
        title: node.kind === 'crack' ? '젖은 발자국' : '짙은 복도',
        cue: node.kind === 'crack' ? '젖은 발자국이 방금 찍힌 듯 빛난다.' : '앞쪽 어둠이 유난히 낮게 깔려 있다.',
        choices: [
          eventChoice('hold', '숨을 죽인다', '기척 낮춤', 'good'),
          eventChoice('rush', '빠르게 지난다', '조명 절약', 'danger'),
        ],
      };
      if (run.bag.length > 0) ev.choices.push(eventChoice('bait', '미끼를 던진다', '짐 1개 소모', 'good'));
    } else if (node.kind === 'vent') {
      ev = {
        type: 'vent',
        title: '낮은 환풍구',
        cue: '사람 하나 겨우 지날 낮은 틈이 열린다.',
        choices: [
          eventChoice('crawl', '기어서 통과한다', '작은 단서 탐색', 'good'),
          eventChoice('turn', '돌아선다', '위험 피함'),
        ],
      };
    }
    if (!ev) return;
    node.roomEventResolved = true;
    run.pendingEvent = { ...ev, node: node.id };
    run.lastAction = ev.cue;
    log(ev.cue, ev.type === 'footprints' ? 'hot' : undefined);
  }

  function takeCheapestBagItem() {
    if (!run.bag.length) return null;
    let idx = 0;
    run.bag.forEach((it, i) => { if (it.value < run.bag[idx].value) idx = i; });
    return run.bag.splice(idx, 1)[0];
  }

  function resolveRoomEvent(choiceId) {
    if (!run || run.moving || !run.pendingEvent) return;
    const ev = run.pendingEvent;
    const node = nodeById(ev.node) || currentNode();
    let msg = '';
    if (ev.type === 'cabinet') {
      if (choiceId === 'open') {
        run.light = Math.max(0, run.light - 3);
        if (!run.currentItem && !node.itemTaken) {
          node.item = node.item || pickFloorItem(run.floor, node);
          run.currentItem = node.item;
          msg = `${run.currentItem.name}${subjectParticle(run.currentItem.name)} 안쪽에서 굴러 나왔다.`;
        } else {
          run.danger = Math.max(0, run.danger - 2);
          msg = '문을 천천히 닫았다. 주변 소리가 가라앉는다.';
        }
      } else if (choiceId === 'noise') {
        run.danger = Math.min(100, run.danger + 7);
        msg = '금속음이 울렸다. 먼 곳에서 같은 박자가 돌아온다.';
      } else {
        run.danger = Math.max(0, run.danger - 1);
        msg = '캐비닛은 그대로 둔다. 조용히 지나갈 수 있다.';
      }
    } else if (ev.type === 'footprints') {
      if (choiceId === 'hold') {
        run.light = Math.max(0, run.light - 2);
        run.danger = Math.max(0, run.danger - 5);
        msg = '숨을 죽이자 발자국의 물기가 천천히 마른다.';
      } else if (choiceId === 'bait') {
        const bait = takeCheapestBagItem();
        if (bait) {
          run.droppedCount += 1;
          run.danger = Math.max(0, run.danger - 12);
          if (run.bag.length === 0) run.chasing = false;
          msg = `${bait.name}${objectParticle(bait.name)} 미끼로 던졌다. 젖은 소리가 멀어진다.`;
        } else {
          run.danger = Math.min(100, run.danger + 4);
          msg = '던질 게 없다. 빈손만 어둠 속에서 떨린다.';
        }
      } else {
        run.light = Math.max(0, run.light - 1);
        run.danger = Math.min(100, run.danger + 5);
        msg = '빠르게 지나쳤다. 뒤에서 물 밟는 소리가 한 번 늦게 따라온다.';
      }
    } else if (ev.type === 'vent') {
      if (choiceId === 'crawl') {
        run.light = Math.max(0, run.light - 4);
        run.danger = Math.max(0, run.danger - 3);
        msg = '낮게 기어 통과했다. 먼지 속에서 안전한 길의 감이 잡힌다.';
      } else {
        run.danger = Math.max(0, run.danger - 1);
        msg = '좁은 틈은 포기했다. 몸이 걸릴 위험은 없다.';
      }
    }
    run.pendingEvent = null;
    run.lastAction = msg || '상황을 정리했다.';
    log(run.lastAction, /울렸다|따라온다|없다/.test(run.lastAction) ? 'hot' : undefined);
    render();
  }

  function markTravelledEdge(fromId, toId) {
    if (!run || !run.floorMap || fromId === toId) return;
    if (!run.floorMap.travelledEdges) run.floorMap.travelledEdges = new Set();
    run.floorMap.travelledEdges.add(edgeKey(fromId, toId));
  }

  function triggerMonster(node) {
    if (!node.monster || node.monsterResolved) return;
    const type = node.monster.type;
    if (type === 'sight') {
      node.monsterResolved = true; // 정보성 1회 이벤트
      run.danger = Math.min(100, run.danger + SIGHT_DANGER);
      const cue = directionCueFromNode(node, node.dangerExit, {
        known: (dir) => `${dir} 어둠에서 젖은 쇳소리가 멈췄다.`,
        unknown: '어둠 속에서 젖은 쇳소리가 멈췄다.',
      });
      run.lastAction = cue;
      log(cue, 'hot');
    } else if (type === 'cross') {
      run.holdEvent = { type: 'cross', node: node.id };
      run.danger = Math.min(100, run.danger + CROSS_DANGER);
      run.lastAction = '갈림길 쪽에서 발소리가 스친다.';
      log('갈림길 쪽에서 발소리가 스쳐 간다. 멈출까, 다른 길로 갈까.', 'hot');
    } else if (type === 'ambush') {
      run.holdEvent = { type: 'ambush', node: node.id };
      run.lastAction = '바로 옆 어둠에서 무언가 숨을 멈췄다. 움직이면 들킨다.';
      log('바로 옆 어둠에서 무언가 숨을 멈췄다. 움직이면 들킨다.', 'hot');
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
    if (!run || run.moving || run.pendingEvent) return;
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

    // 회수자가 보이는 방향으로 전진하면 위험이 더 오른다.
    if (node.dangerExit === targetId) {
      run.danger = Math.min(100, run.danger + SIGHT_MOVE_DANGER);
    }

    if (target.kind === 'stairs') { descend(); return; }

    const fromId = node.id;
    beginTransition(() => {
      markTravelledEdge(fromId, targetId);
      run.currentNodeId = targetId;
      arriveAtNode();
    }, 'move', MOVE_MS);
  }

  // 대기. 지나가는/매복 회수자를 흘려보낸다. 시간이 흘러 조명이 조금 닳는다.
  function chooseWait() {
    if (!run || !run.holdEvent || run.moving || run.pendingEvent) return;
    const ev = run.holdEvent;
    run.light = Math.max(0, run.light - WAIT_LIGHT_COST);
    if (ev.type === 'cross') {
      run.danger = Math.max(0, run.danger - 6);
      run.lastAction = '발소리가 갈림길을 지나갔다.';
      log('발소리가 갈림길을 지나갔다.');
    } else {
      run.danger = Math.max(0, run.danger - 3);
      run.lastAction = '숨을 죽였다. 발소리가 멀어진다.';
      log('숨을 죽였다. 발소리가 멀어진다.');
    }
    const evNode = nodeById(ev.node);
    if (evNode) evNode.monsterResolved = true;
    run.holdEvent = null;
    render();
  }

  function grab() {
    if (run.pendingEvent || !run.currentItem || !roomFor(run.currentItem)) return;
    const node = currentNode();
    const item = run.currentItem;
    run.bag.push(item);
    node.itemTaken = true;
    run.grabbedCount += 1;
    run.currentItem = null;
    run.light = Math.max(0, run.light - GRAB_LIGHT_COST);
    playGrabFx();
    if (!run.chasing) {
      run.chasing = true;
      run.danger = Math.max(run.danger, GRAB_DANGER_BUMP);
      const cue = pickupThreatCue(node);
      run.lastAction = `${item.name}${objectParticle(item.name)} 집었다. ${cue}`;
      log(`집었다. ${cue}`, 'hot');
    } else {
      run.danger = Math.min(100, run.danger + GRAB_DANGER_BUMP);
      const dir = reversePathDirection(node);
      const cue = dir ? `${dir}에서 발소리가 가까워진다.` : '젖은 발소리가 가까워진다.';
      run.lastAction = `${item.name}까지 챙겼다. ${cue}`;
      log(`${item.name}까지 챙겼다. ${cue}`, 'hot');
    }
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
      enterFloor(run.floor);
    }, 'descend', DESCEND_MS);
  }

  function dropAndFlee() {
    if (!run.chasing || run.bag.length === 0) return;
    // 가장 비싼 물건을 미끼로 떨군다 → 위험 급감.
    let idx = 0;
    run.bag.forEach((it, i) => { if (it.value > run.bag[idx].value) idx = i; });
    const dropped = run.bag.splice(idx, 1)[0];
    run.droppedCount += 1;
    run.danger = Math.max(0, run.danger * DROP_DANGER_FACTOR - DROP_DANGER_MINUS);
    const droppedObject = `${dropped.name}${objectParticle(dropped.name)}`;
    if (run.bag.length === 0) {
      run.chasing = false;
      run.lastAction = `${droppedObject} 던졌다. 발소리가 멀어진다.`;
      log(`${droppedObject} 던졌다. 발소리가 멀어진다.`);
    } else {
      run.lastAction = `${droppedObject} 미끼로 던졌다. 발소리와 거리가 조금 벌어진다.`;
      log(`${droppedObject} 미끼로 던졌다. 발소리와 거리가 조금 벌어진다.`);
    }
    render();
  }

  function returnToSurface() {
    stopTick();
    run.lastSale = run.bag.slice();
    run.chasing = false;
    run.bought = false;
    if (run.lastSale.length === 0) {
      run.lastBuyer = 'committee';
      run.lastTruth = null;
      resolveContract('committee');
      run.streetNews = '공보: 빈손 귀환자는 빠르게 검문대를 통과했다.';
      renderUpgradeScreen(0);
      show('screen-upgrade');
      return;
    }
    renderReturnScreen();
    show('screen-return');
  }

  function saleQuote(buyer) {
    const raw = bagValue();
    if (buyer === 'committee') {
      return { gained: Math.ceil(raw * 0.72), suspDelta: -Math.min(10, 2 + run.bag.length * 2) };
    }
    const heat = run.bag.reduce((sum, it) => sum + TIER_HEAT[it.tier], 0);
    return { gained: Math.ceil(raw * 1.35), suspDelta: heat };
  }

  function chooseBuyer(buyer) {
    const quote = saleQuote(buyer);
    const previousTruthCount = meta.truths.length;
    meta.rp += quote.gained;
    meta.totalEarned += quote.gained;
    meta.suspicion = Math.max(0, Math.min(99, meta.suspicion + quote.suspDelta));
    run.lastBuyer = buyer;
    run.lastTruth = null;

    if (buyer === 'black') {
      const unknown = run.lastSale.find((it) => !meta.truths.includes(it.name));
      if (unknown) {
        meta.truths.push(unknown.name);
        run.lastTruth = unknown.truth;
      }
    }

    if (previousTruthCount !== meta.truths.length) {
      log('암시장 정보상이 진실 조각 하나를 넘겼다.', 'win');
    }
    resolveContract(buyer);
    saveMeta(); // 판매처 선택 후 자동 저장 (RP·의심도·진실 조각 반영)
    run.streetNews = makeStreetNews(buyer, quote);
    renderUpgradeScreen(quote.gained);
    show('screen-upgrade');
  }

  function failRun() {
    stopTick();
    const lost = bagValue();
    const outcome = RECOVERY_OUTCOMES[Math.floor(Math.random() * RECOVERY_OUTCOMES.length)];
    const consolation = lost > 0 ? Math.max(0, Math.round(lost * outcome.rpRate)) : 0;
    const previousSuspicion = meta.suspicion;
    meta.rp += consolation;
    meta.totalEarned += consolation;
    meta.suspicion = Math.max(0, Math.min(99, meta.suspicion + outcome.suspDelta));
    saveMeta(); // 실패 보상 후 자동 저장
    el['fail-recovery'].innerHTML = `<b>${outcome.elapsed}</b><span>${outcome.title}</span><p>${outcome.body}</p>`;
    const suspChange = meta.suspicion - previousSuspicion;
    const suspText = suspChange === 0 ? '변화 없음' : signed(suspChange);
    el['fail-detail'].innerHTML = [
      lost > 0
        ? `잃은 짐 ${lost} RP · 남은 조각 +${consolation} RP`
        : '빈손이라 잃은 회수품은 없었다.',
      outcome.loss,
      `의심도 ${suspText}`,
    ].map((line) => `<div>${line}</div>`).join('');
    el['fail-susp'].textContent = meta.suspicion;
    run.chasing = false;
    render();
    show('screen-fail');
  }

  /* ---------------- 강화 ---------------- */

  function buyUpgrade(type) {
    if (run.bought) return;
    const lvKey = type + 'Level';
    const cost = UPGRADES[type].cost(meta[lvKey]);
    if (meta.rp < cost) return;
    meta.rp -= cost;
    meta[lvKey] += 1;
    run.bought = true;
    saveMeta(); // 강화 구매 후 자동 저장
    log(`${UPGRADES[type].label}을 손봤다. 다음엔 더 버틴다.`, 'win');
    renderUpgradeScreen(null); // 잔액/버튼 상태 갱신
  }

  function riskState() {
    if (!run || !run.chasing) return { key: 'safe', label: '정적', copy: '' };
    if (run.danger >= 85) return { key: 'critical', label: '숨소리', copy: '' };
    if (run.danger >= 65) return { key: 'danger', label: '금속음', copy: '' };
    if (run.danger >= 35) return { key: 'warn', label: '잡음', copy: '' };
    return { key: 'safe', label: '먼 소리', copy: '' };
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
    el['start-truth-count'].textContent = meta.truths.length;
    el['start-codex'].classList.toggle('complete', meta.truths.length >= TRUTH_TOTAL);
    renderGoals();
    renderContractCards();

    // 층 배너
    el['floor-num'].textContent = f.n;
    el['floor-name'].textContent = f.name;

    // 조명 게이지
    const lightPct = Math.round((run.light / maxLight()) * 100);
    el['light-fill'].style.width = lightPct + '%';
    el['light-fill'].classList.toggle('low', lightPct <= 25);
    el['light-val'].textContent = lightPct + '%';

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
    if (el['stage']) {
      el['stage'].classList.toggle('moving', !!run.moving);
      el['stage'].classList.toggle('has-loot', !!run.currentItem);
    }
    renderStage();
    renderDepthRail();
    renderMiniMap();

    // 액션 버튼: 줍기(스테이지 위), 버리고 도망, 나가기.
    if (el['dock']) el['dock'].classList.toggle('hidden', !!run.moving);
    const canGrab = !!(run.currentItem && roomFor(run.currentItem) && !run.pendingEvent);
    el['btn-grab'].classList.toggle('hidden', !(run.currentItem && !run.moving && !run.pendingEvent));
    el['btn-grab'].disabled = !canGrab;
    el['btn-grab'].textContent = run.currentItem ? (canGrab ? '줍기' : '가방 가득') : '';

    const showDrop = run.chasing && run.bag.length > 0;
    el['btn-drop'].disabled = !showDrop;
    el['btn-drop'].classList.toggle('hidden-action', !showDrop);
    if (el['dock-actions']) el['dock-actions'].classList.toggle('has-drop', showDrop);
    el['btn-return'].disabled = false;
    el['btn-drop'].textContent = '↙ 버리고 도망';
    el['btn-return'].textContent = run.bag.length > 0 ? '↩ 나가기' : '↩ 돌아가기';
  }

  function renderBag() {
    const cap = bagCap();
    const cells = [];
    // 각 물건이 차지하는 칸을 색으로 채운다.
    run.bag.forEach((item) => {
      for (let s = 0; s < item.slots; s++) {
        cells.push({ color: TIER_COLOR[item.tier], icon: item.icon, label: s === 0 ? item.name : '' });
      }
    });
    while (cells.length < cap) cells.push(null);

    el['bag-slots'].innerHTML = '';
    cells.forEach((c) => {
      const d = document.createElement('div');
      d.className = 'slot' + (c ? ' filled' : '');
      if (c) {
      d.style.setProperty('--tier-color', c.color);
      d.innerHTML = itemIcon(c.icon) + (c.label ? `<span class="slot-label">${c.label}</span>` : '');
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
    const item = run.currentItem ? ` 눈앞에 ${run.currentItem.name}${subjectParticle(run.currentItem.name)} 있다. ${run.currentItem.slots}칸, ${run.currentItem.value}RP.` : '';
    const pending = run.pendingEvent ? ` ${run.pendingEvent.title}: ${run.pendingEvent.cue}` : '';
    const event = run.holdEvent ? (run.holdEvent.type === 'ambush' ? ' 옆 어둠에서 숨소리가 멎었다.' : ' 갈림길 쪽에서 발소리가 스친다.') : '';
    const chase = run.chasing && !run.holdEvent ? ' 젖은 발소리가 따라붙는다.' : '';
    const action = run.lastAction && (!run.pendingEvent || run.lastAction !== run.pendingEvent.cue) ? ` ${run.lastAction}` : '';
    return cleanSituationText(`${here}${item}${pending}${event}${chase}${action}`);
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
          return `<button class="btn room-btn event-btn${tone}" data-act="event" data-choice="${choice.id}"><i class="dir-glyph">?</i><span class="choice-text"><b>${choice.label}</b><span>${choice.sub}</span></span></button>`;
        }).join('');
        dock.dataset.choiceSig = sig;
        dock.querySelectorAll('[data-act="event"]').forEach((btn) => {
          btn.addEventListener('click', () => resolveRoomEvent(btn.dataset.choice));
        });
      }
      if (el['choice-cue']) el['choice-cue'].textContent = cue;
      return;
    }

    const holdSig = run.holdEvent ? `${run.holdEvent.type}:${run.holdEvent.node}` : 'none';
    const moveSig = `move:${run.currentNodeId}:${holdSig}:${node.exits.join(',')}`;
    if (dock.dataset.choiceSig === moveSig) {
      if (el['choice-cue']) el['choice-cue'].textContent = cue;
      return;
    }

    dock.classList.remove('event-choices');

    const exitsByDir = new Map();
    const cues = [];
    const usedDirs = new Set();
    let waitButton = '';

    if (run.holdEvent) {
      const waitDesc = run.holdEvent.type === 'ambush' ? '숨을 죽이고 보낸다' : '지나갈 때까지 멈춘다';
      waitButton = `<button class="btn room-btn good dir-wait" data-act="wait"><i class="dir-glyph">•</i><span class="choice-text"><b>멈춤</b></span></button>`;
      cues.push(`• ${waitDesc}`);
    }

    node.exits.forEach((nid, index) => {
      const t = nodeById(nid);
      const stairs = t.kind === 'stairs';
      const dir = directionForExit(node, t, index, usedDirs);
      const copy = movementChoiceCopy(dir, t);
      cues.push(`${dir.glyph} ${copy.label}`);
      exitsByDir.set(dir.key, `<button class="btn room-btn ${dir.cls}" data-act="${stairs ? 'descend' : 'move'}" data-to="${nid}" aria-label="${copy.aria}"><i class="dir-glyph">${dir.glyph}</i><span class="choice-text"><b>${copy.label}</b></span></button>`);
    });

    const out = DIR_SLOTS.map((dir) => exitsByDir.get(dir.key) || `<div class="room-pad-empty ${dir.cls}" aria-hidden="true"><i class="dir-glyph">${dir.glyph}</i></div>`);
    out.splice(4, 0, waitButton || '<div class="room-pad-center" aria-hidden="true"></div>');
    dock.innerHTML = out.join('');
    dock.dataset.choiceSig = moveSig;
    dock.classList.toggle('spatial', true);
    if (el['choice-cue']) el['choice-cue'].textContent = cue;
    dock.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
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
      current.exits.forEach((nid, index) => {
        const target = nodeById(nid);
        if (!target) return;
        const slot = directionForExit(current, target, index, usedDirs);
        if (seen(nid) || travelled.has(edgeKey(current.id, nid))) return;
        const dir = slot && MAP_DIRECTION_BY_KEY[slot.key];
        if (!dir) return;
        const len = Math.hypot(dir.dx, dir.dy) || 1;
        const ux = dir.dx / len;
        const uy = dir.dy / len;
        html += `<line class="exit-hint" x1="${center.x + ux * stubStart}" y1="${center.y + uy * stubStart}" x2="${center.x + ux * stubEnd}" y2="${center.y + uy * stubEnd}"/>`;
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
    el['return-susp'].textContent = meta.suspicion;
    el['committee-rp'].textContent = '+' + committee.gained;
    el['committee-susp'].textContent = committee.suspDelta;
    el['black-rp'].textContent = '+' + black.gained;
    el['black-susp'].textContent = '+' + black.suspDelta;
    el['buy-committee'].disabled = run.lastSale.length === 0;
    el['buy-black'].disabled = run.lastSale.length === 0;
    renderContractCards();
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
      rpEl.innerHTML = `${itemIcon(it.icon)}<span class="rp-name">${it.name}</span>`;
    } else {
      rpEl.className = 'recovery-point empty';
      rpEl.style.borderColor = '';
      const hint = node && node.kind === 'entry' ? '입구' : node ? node.label : '…';
      rpEl.innerHTML = `<span class="rp-name">${hint}</span>`;
    }

    // 회수자: 위험이 클수록 플레이어(왼쪽)에 가까워진다.
    const chaser = el['chaser'];
    chaser.classList.toggle('active', run.chasing);
    if (run.chasing) {
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
      el['sale-buyer'].textContent = run.lastBuyer === 'black' ? '판매처: 암시장' : '판매처: 위원회';
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

    // 강화 버튼 3종
    const defs = [
      ['up-bag',    'bag',    `가방 넓히기`,  `${bagCap()}칸 → ${bagCap() + 2}칸`],
      ['up-light',  'light',  `조명 손보기`,  `최대 조명 +35`],
      ['up-weapon', 'weapon', `무기 손보기`,  `추격 속도 -25%`],
    ];
    defs.forEach(([id, type, title, sub]) => {
      const lvKey = type + 'Level';
      const cost = UPGRADES[type].cost(meta[lvKey]);
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

  /* ---------------- 이벤트 배선 ---------------- */

  function bind() {
    el['btn-enter'].addEventListener('click', startNewRun);
    el['btn-grab'].addEventListener('click', grab);
    el['btn-drop'].addEventListener('click', dropAndFlee);
    el['btn-return'].addEventListener('click', returnToSurface);
    el['buy-committee'].addEventListener('click', () => chooseBuyer('committee'));
    el['buy-black'].addEventListener('click', () => chooseBuyer('black'));
    el['up-bag'].addEventListener('click', () => buyUpgrade('bag'));
    el['up-light'].addEventListener('click', () => buyUpgrade('light'));
    el['up-weapon'].addEventListener('click', () => buyUpgrade('weapon'));
    el['btn-again'].addEventListener('click', startNewRun);
    el['btn-retry'].addEventListener('click', startNewRun);
    if (el['btn-reset']) el['btn-reset'].addEventListener('click', resetProgress);
  }

  /* ---------------- 시작 ---------------- */

  // 시작 화면 메타 표시를 한곳에서 갱신한다(초기 진입 + 기록 초기화 공용).
  function renderStartScreen() {
    el['start-rp'].textContent = meta.rp;
    el['start-depth'].textContent = meta.maxDepth;
    el['start-susp'].textContent = meta.suspicion;
    el['start-truth-count'].textContent = meta.truths.length;
    el['start-codex'].classList.toggle('complete', meta.truths.length >= TRUTH_TOTAL);
    renderGoals();
    renderContractCards();
  }

  function init() {
    cacheDom();
    bind();
    loadMeta(); // 저장된 진행도 복원 (없거나 깨졌으면 기본값 유지)
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
    module.exports = { generateFloorMap, bfs, FLOORS, ITEM_TABLE, NODE_KINDS };
  }
})();
