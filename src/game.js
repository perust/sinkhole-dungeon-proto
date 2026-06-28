/* ============================================================
   도심 싱크홀 — 회수 잠수 (플레이어블 프로토타입)

   핵심 훅: "던전이 내가 훔친 물건을 다시 가져가려 한다."
   루프:    챙기고 → 도망치고 → 팔고 → 강화 → 더 깊이.

   - 메타 상태(meta): 런을 넘어 유지되는 영구 자산(RP, 강화 레벨, 최고 깊이).
   - 런 상태(run):    한 번의 잠수 동안만 존재하는 상태(층, 조명, 가방, 위험).
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

  // 짧은 의뢰는 \"한 번 더 내려가기\"의 명분과 판매처 선택의 압박을 만든다.
  const CONTRACTS = [
    { title: '합법 샘플 반납', desc: '위원회에 회수물 2개 이상 넘기기', reward: 6, suspDelta: -3, test: (ctx) => ctx.buyer === 'committee' && ctx.items.length >= 2 },
    { title: '뜨거운 증거', desc: '희귀 이상을 암시장에 팔기', reward: 9, suspDelta: 2, test: (ctx) => ctx.buyer === 'black' && ctx.items.some((it) => it.tier !== 'common') },
    { title: '하층 동선 확인', desc: '2층 이상까지 내려갔다가 생환', reward: 7, suspDelta: 0, test: (ctx) => ctx.maxFloor >= 2 },
  ];

  const ROOM_TYPES = [
    { key: 'camp', name: '안전 캠프', style: 'good', copy: '조명 +18 · 낮은 보상 · 쉬움', light: 18, danger: -8, lootBias: 'common', dc: -2 },
    { key: 'lab', name: '폐쇄 연구실', style: '', copy: '희귀 단서 확률↑ · 조명 -6 · 보통', light: -6, danger: 6, lootBias: 'rare', dc: 1 },
    { key: 'nest', name: '회수자 둥지', style: 'danger', copy: '고가 유물 확률↑ · 추적도 +12 · 어려움', light: -10, danger: 12, lootBias: 'epic', dc: 4 },
  ];

  const ROLL_OUTCOMES = {
    critical: { label: '대성공', cls: 'win' },
    success: { label: '성공', cls: 'win' },
    mixed: { label: '대가 있는 성공', cls: 'hot' },
    fail: { label: '실패', cls: 'hot' },
  };

  function itemIcon(index) {
    return `<span class="loot-icon" style="--icon-index:${index}" aria-hidden="true"></span>`;
  }

  // 행동 비용
  const GRAB_LIGHT_COST    = 6;   // 회수물 집기: 공명으로 조명 소모
  const GRAB_DANGER_BUMP   = 4;   // 집는 순간 위험 점프
  const DESCEND_LIGHT_COST = 14;  // 더 깊이: 강하 비용
  const DESCEND_DANGER_BUMP= 8;   // 추격 중 강하 시 위험 점프
  const DROP_DANGER_FACTOR = 0.45;// 버리고 도망: 위험 ×0.45
  const DROP_DANGER_MINUS  = 6;
  const TICK_MS            = 150;
  const FAIL_CONSOLATION   = 0.25;// 실패 시 가방 가치의 25%만 긁어 회수

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

  const storageOk = hasStorage();

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
      currentItem: null, // 현재 층 회수 포인트에 놓인 물건 (집으면 null)
      awaitingRoom: true,
      currentRoom: null,
      lastRoll: null,
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

  function pickItem(floor) {
    const table = ITEM_TABLE[floor];
    return { ...table[Math.floor(Math.random() * table.length)] };
  }

  function pickRoomItem(floor, room) {
    const table = ITEM_TABLE[floor];
    const biased = table.filter((it) => it.tier === room.lootBias);
    const source = biased.length && Math.random() < 0.7 ? biased : table;
    return { ...source[Math.floor(Math.random() * source.length)] };
  }

  /* ---------------- DOM 캐시 ---------------- */

  const el = {};
  const IDS = [
    'screen-start', 'screen-dungeon', 'screen-return', 'screen-upgrade', 'screen-fail',
    'btn-enter', 'btn-reset', 'start-rp', 'start-depth', 'start-susp', 'start-truth-count', 'start-codex', 'start-contract', 'start-goal',
    'hud-rp', 'hud-depth', 'hud-bag',
    'floor-num', 'floor-name',
    'light-val', 'light-fill', 'danger-val', 'danger-fill', 'risk-panel', 'risk-chip', 'risk-copy',
    'roll-panel', 'roll-face', 'roll-copy',
    'room-panel', 'room-choices',
    'bag-slots', 'recovery-point', 'chaser', 'stage', 'depth-rail', 'log', 'actions',
    'btn-grab', 'btn-deeper', 'btn-drop', 'btn-return',
    'return-list', 'return-susp', 'committee-rp', 'committee-susp', 'black-rp', 'black-susp', 'return-contract',
    'buy-committee', 'buy-black', 'sale-buyer', 'sale-list', 'sale-gain', 'sale-balance', 'sale-susp', 'truth-news', 'sale-contract', 'street-news', 'return-goal',
    'up-bag', 'up-light', 'up-weapon', 'btn-again',
    'fail-detail', 'fail-susp', 'btn-retry',
  ];
  function cacheDom() { IDS.forEach((id) => { el[id] = document.getElementById(id); }); }

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

  function startNewRun() {
    run = newRun();
    run.currentItem = null;
    run.awaitingRoom = true;
    run.currentRoom = null;
    bumpMaxDepth(run.floor);
    show('screen-dungeon');
    log('1층. 어느 쪽으로 갈까.');
    render();
    startTick();
  }

  function resolveRoomCheck(room) {
    const roll = Math.floor(Math.random() * 20) + 1;
    const lightPct = Math.round((run.light / maxLight()) * 100);
    const lightMod = lightPct >= 70 ? 2 : lightPct <= 25 ? -2 : 0;
    const bagMod = usedSlots() === 0 ? 1 : usedSlots() >= bagCap() - 1 ? -1 : 0;
    const mod = lightMod + bagMod + (room.key === 'camp' ? 2 : room.key === 'nest' ? -1 : 0);
    const dc = 10 + run.floor * 2 + room.dc;
    const total = roll + mod;
    let outcome = 'fail';
    if (roll === 20 || total >= dc + 5) outcome = 'critical';
    else if (total >= dc) outcome = 'success';
    else if (total >= dc - 3) outcome = 'mixed';

    const result = { roll, mod, dc, total, outcome };
    const face = ROLL_OUTCOMES[outcome];
    if (outcome === 'critical') {
      run.light = Math.min(maxLight(), run.light + 6);
      run.danger = Math.max(0, run.danger - 6);
      log(`판정 ${roll}${mod ? signed(mod) : ''} vs ${dc}. ${face.label} — 길을 먼저 잡았다.`, face.cls);
    } else if (outcome === 'success') {
      log(`판정 ${roll}${mod ? signed(mod) : ''} vs ${dc}. ${face.label} — 조용히 들어갔다.`, face.cls);
    } else if (outcome === 'mixed') {
      run.danger = Math.min(100, run.danger + 5);
      log(`판정 ${roll}${mod ? signed(mod) : ''} vs ${dc}. ${face.label} — 얻지만 소리가 났다.`, face.cls);
    } else {
      run.light = Math.max(0, run.light - 6);
      run.danger = Math.min(100, run.danger + 11);
      if (run.danger > 0) run.chasing = true;
      log(`판정 ${roll}${mod ? signed(mod) : ''} vs ${dc}. ${face.label} — 회수자가 먼저 들었다.`, face.cls);
    }
    return result;
  }

  function chooseRoom(key) {
    if (!run || !run.awaitingRoom) return;
    const room = ROOM_TYPES.find((r) => r.key === key) || ROOM_TYPES[0];
    run.awaitingRoom = false;
    run.currentRoom = room;
    run.light = Math.max(0, Math.min(maxLight(), run.light + room.light));
    if (room.danger > 0) {
      run.danger = Math.min(100, run.danger + room.danger);
      if (room.key === 'nest') run.chasing = true;
    } else if (room.danger < 0) {
      run.danger = Math.max(0, run.danger + room.danger);
    }
    run.currentItem = pickRoomItem(run.floor, room);
    run.lastRoll = resolveRoomCheck(room);
    log(`${room.name}. ${run.currentItem.name} 발견.`, room.key === 'nest' ? 'hot' : undefined);
    render();
  }

  function grab() {
    if (!run.currentItem || !roomFor(run.currentItem)) return;
    const item = run.currentItem;
    run.bag.push(item);
    run.grabbedCount += 1;
    run.currentItem = null;
    run.light = Math.max(0, run.light - GRAB_LIGHT_COST);
    if (!run.chasing) {
      run.chasing = true;
      run.danger = Math.max(run.danger, GRAB_DANGER_BUMP);
      log('집었다. 회수자가 가방을 노린다!', 'hot');
    } else {
      run.danger = Math.min(100, run.danger + GRAB_DANGER_BUMP);
      log(`${item.name}까지 챙겼다. 발소리가 가까워진다.`, 'hot');
    }
    render();
  }

  function descend() {
    if (run.floor >= FLOORS.length) return;
    run.floor += 1;
    run.light = Math.max(0, run.light - DESCEND_LIGHT_COST);
    if (run.chasing) run.danger = Math.min(100, run.danger + DESCEND_DANGER_BUMP);
    bumpMaxDepth(run.floor);
    if (run.floor > run.maxFloor) run.maxFloor = run.floor;
    run.currentItem = null;
    run.awaitingRoom = true;
    run.currentRoom = null;
    run.lastRoll = null;
    const f = FLOORS[run.floor - 1];
    log(`${f.n}층. 다음 방을 고르자.`);
    playDescendFx();
    render();
  }

  function dropAndFlee() {
    if (!run.chasing || run.bag.length === 0) return;
    // 가장 비싼 물건을 미끼로 떨군다 → 위험 급감.
    let idx = 0;
    run.bag.forEach((it, i) => { if (it.value > run.bag[idx].value) idx = i; });
    const dropped = run.bag.splice(idx, 1)[0];
    run.droppedCount += 1;
    run.danger = Math.max(0, run.danger * DROP_DANGER_FACTOR - DROP_DANGER_MINUS);
    if (run.bag.length === 0) {
      run.chasing = false;
      log(`${dropped.name}을 던졌다. 겨우 따돌렸다.`);
    } else {
      log(`${dropped.name}을 미끼로 던졌다. 조금 벌어졌다.`);
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
    const consolation = lost > 0 ? Math.max(1, Math.round(lost * FAIL_CONSOLATION)) : 0;
    meta.rp += consolation;
    meta.totalEarned += consolation;
    meta.suspicion = Math.max(0, meta.suspicion - 3);
    saveMeta(); // 실패 보상 후 자동 저장
    el['fail-detail'].textContent =
      lost > 0
        ? `${lost} RP어치를 되찾겼다. 남은 조각 +${consolation} RP`
        : '빈손이라 잃을 것도 없었다.';
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
    if (!run || !run.chasing) return { key: 'safe', label: '대기', copy: '회수물을 집는 순간 추격이 시작된다.' };
    if (run.danger >= 85) return { key: 'critical', label: '코앞', copy: '지금 탈출하거나 미끼를 던져야 한다.' };
    if (run.danger >= 65) return { key: 'danger', label: '위험', copy: '다음 행동 하나가 런을 끝낼 수 있다.' };
    if (run.danger >= 35) return { key: 'warn', label: '주의', copy: '아직 거리는 있지만 욕심내면 따라잡힌다.' };
    return { key: 'safe', label: '여유', copy: '한 번 더 챙길지, 안전하게 나갈지 고르자.' };
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
    el['danger-val'].textContent = run.chasing ? `${risk.label} · ${Math.round(run.danger)}%` : '대기';
    if (el['risk-panel']) {
      el['risk-panel'].className = `risk-panel ${risk.key}`;
      el['risk-chip'].textContent = risk.label;
      el['risk-copy'].textContent = risk.copy;
    }

    // 가방 슬롯
    renderBag();
    renderRoomChoices();
    renderRollPanel();

    // 회수 포인트 / 추격 연출
    renderStage();
    renderDepthRail();

    // 액션 버튼 활성화
    if (el['actions']) el['actions'].classList.toggle('hidden', run.awaitingRoom);
    el['btn-grab'].disabled = !(run.currentItem && roomFor(run.currentItem));
    el['btn-grab'].textContent = run.awaitingRoom
      ? '방을 먼저 고르자'
      : run.currentItem
        ? (roomFor(run.currentItem) ? `챙기기 · 위험 +${GRAB_DANGER_BUMP}` : '가방이 꽉 찼다')
        : '남은 게 없다';
    el['btn-deeper'].disabled = run.awaitingRoom || run.floor >= FLOORS.length;
    el['btn-deeper'].textContent = run.floor >= FLOORS.length
      ? '최심부다'
      : `더 깊이 · 조명 -${DESCEND_LIGHT_COST}${run.chasing ? ` / 위험 +${DESCEND_DANGER_BUMP}` : ''}`;
    el['btn-drop'].disabled   = !(run.chasing && run.bag.length > 0);
    el['btn-drop'].textContent = run.bag.length > 0 ? '미끼 던지기 · 위험↓' : '버릴 짐 없음';
    el['btn-return'].disabled = false;
    el['btn-return'].textContent = run.bag.length > 0 ? `탈출 · ${bagValue()}RP 판매` : '그냥 나가기';
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

  function renderRoomChoices() {
    if (!el['room-panel'] || !el['room-choices']) return;
    el['room-panel'].classList.toggle('hidden', !run.awaitingRoom);
    if (!run.awaitingRoom) {
      el['room-choices'].innerHTML = '';
      return;
    }
    el['room-choices'].innerHTML = ROOM_TYPES.map((room) =>
      `<button class="btn room-btn ${room.style}" data-room="${room.key}">` +
      `<b>${room.name}</b><span>${room.copy}</span></button>`
    ).join('');
    el['room-choices'].querySelectorAll('[data-room]').forEach((btn) => {
      btn.addEventListener('click', () => chooseRoom(btn.dataset.room));
    });
  }

  function renderRollPanel() {
    if (!el['roll-panel'] || !el['roll-face'] || !el['roll-copy']) return;
    const roll = run.lastRoll;
    el['roll-panel'].classList.toggle('hidden', !roll || run.awaitingRoom);
    if (!roll || run.awaitingRoom) return;
    const face = ROLL_OUTCOMES[roll.outcome];
    el['roll-panel'].className = `roll-panel ${roll.outcome}`;
    el['roll-face'].textContent = `d20 ${roll.roll}`;
    el['roll-copy'].textContent = `${face.label} · 보정 ${signed(roll.mod)} · 난이도 ${roll.dc}`;
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
    if (run.awaitingRoom) {
      rpEl.classList.add('empty');
      rpEl.style.borderColor = '';
      rpEl.innerHTML = '<span class="rp-name">방을 고르자</span>';
    } else if (run.currentItem) {
      const it = run.currentItem;
      rpEl.classList.remove('empty');
      rpEl.style.borderColor = TIER_COLOR[it.tier];
      rpEl.innerHTML = `${itemIcon(it.icon)}<span class="rp-name">${it.name}<br>${it.slots}칸 · ${it.value} RP</span>`;
    } else {
      rpEl.classList.add('empty');
      rpEl.style.borderColor = '';
      rpEl.innerHTML = '<span class="rp-name">비었다</span>';
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
    el['btn-deeper'].addEventListener('click', descend);
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
