/* ============================================================
   도심 싱크홀 — 회수 잠수 (플레이어블 프로토타입)

   핵심 훅: "던전이 내가 훔친 물건을 다시 가져가려 한다."
   루프:    훔치고 → 도망치고 → 팔고 → 강화 → 더 깊이.

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
      { name: '실험용 배터리', slots: 1, value: 6,  tier: 'common' },
      { name: '배관 부품',     slots: 1, value: 5,  tier: 'common' },
    ],
    2: [
      { name: '봉인 데이터칩', slots: 2, value: 10, tier: 'rare' },
      { name: '연구 노트',     slots: 1, value: 7,  tier: 'rare' },
    ],
    3: [
      { name: '안정화 코어',   slots: 2, value: 18, tier: 'epic' },
      { name: '봉인 유물',     slots: 3, value: 30, tier: 'epic' },
    ],
  };

  const TIER_COLOR = { common: '#7fb0ff', rare: '#b98bff', epic: '#ffd166' };

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
  };

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
      bought: false,     // 이번 귀환에서 강화를 샀는가
      lastSale: [],      // 판매 화면용 스냅샷
    };
  }

  function pickItem(floor) {
    const table = ITEM_TABLE[floor];
    return { ...table[Math.floor(Math.random() * table.length)] };
  }

  /* ---------------- DOM 캐시 ---------------- */

  const el = {};
  const IDS = [
    'screen-start', 'screen-dungeon', 'screen-upgrade', 'screen-fail',
    'btn-enter', 'start-rp', 'start-depth',
    'hud-rp', 'hud-depth', 'hud-bag',
    'floor-num', 'floor-name',
    'light-val', 'light-fill', 'danger-val', 'danger-fill',
    'bag-slots', 'recovery-point', 'chaser', 'log',
    'btn-grab', 'btn-deeper', 'btn-drop', 'btn-return',
    'sale-list', 'sale-gain', 'sale-balance',
    'up-bag', 'up-light', 'up-weapon', 'btn-again',
    'fail-detail', 'btn-retry',
  ];
  function cacheDom() { IDS.forEach((id) => { el[id] = document.getElementById(id); }); }

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

  function startNewRun() {
    run = newRun();
    run.currentItem = pickItem(run.floor);
    if (run.floor > meta.maxDepth) meta.maxDepth = run.floor;
    show('screen-dungeon');
    log('싱크홀 아래, 1층으로 내려왔다.');
    render();
    startTick();
  }

  function grab() {
    if (!run.currentItem || !roomFor(run.currentItem)) return;
    const item = run.currentItem;
    run.bag.push(item);
    run.currentItem = null;
    run.light = Math.max(0, run.light - GRAB_LIGHT_COST);
    if (!run.chasing) {
      run.chasing = true;
      run.danger = Math.max(run.danger, GRAB_DANGER_BUMP);
      log('공명음 — 회수자가 깨어나 가방을 노린다!', 'hot');
    } else {
      run.danger = Math.min(100, run.danger + GRAB_DANGER_BUMP);
      log(`${item.name}을(를) 챙겼다. 추격이 거세진다.`, 'hot');
    }
    render();
  }

  function descend() {
    if (run.floor >= FLOORS.length) return;
    run.floor += 1;
    run.light = Math.max(0, run.light - DESCEND_LIGHT_COST);
    if (run.chasing) run.danger = Math.min(100, run.danger + DESCEND_DANGER_BUMP);
    if (run.floor > meta.maxDepth) meta.maxDepth = run.floor;
    run.currentItem = pickItem(run.floor);
    const f = FLOORS[run.floor - 1];
    log(`${f.n}층 · ${f.name}으로 내려간다.`);
    render();
  }

  function dropAndFlee() {
    if (!run.chasing || run.bag.length === 0) return;
    // 가장 비싼 물건을 미끼로 떨군다 → 위험 급감.
    let idx = 0;
    run.bag.forEach((it, i) => { if (it.value > run.bag[idx].value) idx = i; });
    const dropped = run.bag.splice(idx, 1)[0];
    run.danger = Math.max(0, run.danger * DROP_DANGER_FACTOR - DROP_DANGER_MINUS);
    if (run.bag.length === 0) {
      run.chasing = false;
      log(`${dropped.name}을(를) 던지고 추격을 따돌렸다.`);
    } else {
      log(`${dropped.name}을(를) 미끼로 던졌다. 위험이 가라앉는다.`);
    }
    render();
  }

  function returnToSurface() {
    stopTick();
    const gained = bagValue();
    run.lastSale = run.bag.slice();
    meta.rp += gained;
    meta.totalEarned += gained;
    run.chasing = false;
    run.bought = false;
    renderUpgradeScreen(gained);
    show('screen-upgrade');
  }

  function failRun() {
    stopTick();
    const lost = bagValue();
    const consolation = lost > 0 ? Math.max(1, Math.round(lost * FAIL_CONSOLATION)) : 0;
    meta.rp += consolation;
    meta.totalEarned += consolation;
    el['fail-detail'].textContent =
      lost > 0
        ? `가방 ${lost} RP어치를 빼앗겼다 · 긁어모은 RP +${consolation}`
        : '빈손이라 잃은 것은 없다.';
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
    log(`${UPGRADES[type].label} 강화 완료.`, 'win');
    renderUpgradeScreen(null); // 잔액/버튼 상태 갱신
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
    el['danger-val'].textContent = run.chasing ? Math.round(run.danger) + '%' : '대기';

    // 가방 슬롯
    renderBag();

    // 회수 포인트 / 추격 연출
    renderStage();

    // 액션 버튼 활성화
    el['btn-grab'].disabled = !(run.currentItem && roomFor(run.currentItem));
    el['btn-grab'].textContent = run.currentItem
      ? (roomFor(run.currentItem) ? '회수물 집기' : '가방 가득')
      : '이 층은 비었다';
    el['btn-deeper'].disabled = run.floor >= FLOORS.length;
    el['btn-drop'].disabled   = !(run.chasing && run.bag.length > 0);
    el['btn-return'].disabled = false;
    el['btn-return'].textContent = run.bag.length > 0 ? '들고 귀환' : '빈손 귀환';
  }

  function renderBag() {
    const cap = bagCap();
    const cells = [];
    // 각 물건이 차지하는 칸을 색으로 채운다.
    run.bag.forEach((item) => {
      for (let s = 0; s < item.slots; s++) {
        cells.push({ color: TIER_COLOR[item.tier], label: s === 0 ? item.name : '' });
      }
    });
    while (cells.length < cap) cells.push(null);

    el['bag-slots'].innerHTML = '';
    cells.forEach((c) => {
      const d = document.createElement('div');
      d.className = 'slot' + (c ? ' filled' : '');
      if (c) {
        d.style.background = c.color;
        d.textContent = c.label;
      }
      el['bag-slots'].appendChild(d);
    });
  }

  function renderStage() {
    const rpEl = el['recovery-point'];
    if (run.currentItem) {
      const it = run.currentItem;
      rpEl.classList.remove('empty');
      rpEl.style.borderColor = TIER_COLOR[it.tier];
      rpEl.innerHTML = `<span class="rp-name">✦ ${it.name}<br>${it.slots}칸 · ${it.value} RP</span>`;
    } else {
      rpEl.classList.add('empty');
      rpEl.style.borderColor = '';
      rpEl.innerHTML = '<span class="rp-name">회수 포인트 비었음</span>';
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
      const list = el['sale-list'];
      list.innerHTML = '';
      if (run.lastSale.length === 0) {
        list.innerHTML = '<div class="sale-empty">판매할 회수물이 없다.</div>';
      } else {
        run.lastSale.forEach((it) => {
          const row = document.createElement('div');
          row.className = 'sale-item';
          row.innerHTML = `<span>${it.name}</span><span class="v">+${it.value}</span>`;
          list.appendChild(row);
        });
      }
      el['sale-gain'].textContent = '+' + gained;
    }
    el['sale-balance'].textContent = meta.rp;

    // 강화 버튼 3종
    const defs = [
      ['up-bag',    'bag',    `가방 +2칸`,    `최대 ${bagCap()} → ${bagCap() + 2}칸`],
      ['up-light',  'light',  `조명 강화`,    `최대 조명 +35`],
      ['up-weapon', 'weapon', `무기 강화`,    `추격 둔화 +25%`],
    ];
    defs.forEach(([id, type, title, sub]) => {
      const lvKey = type + 'Level';
      const cost = UPGRADES[type].cost(meta[lvKey]);
      const btn = el[id];
      const affordable = meta.rp >= cost && !run.bought;
      btn.disabled = !affordable;
      btn.classList.toggle('bought', run.bought);
      btn.innerHTML =
        `<span class="up-title">${title}</span>` +
        `<span class="up-sub">${sub} · 현재 Lv.${meta[lvKey]}</span>` +
        `<span class="up-cost">${run.bought ? '이번 강화 완료' : cost + ' RP'}</span>`;
    });
  }

  /* ---------------- 이벤트 배선 ---------------- */

  function bind() {
    el['btn-enter'].addEventListener('click', startNewRun);
    el['btn-grab'].addEventListener('click', grab);
    el['btn-deeper'].addEventListener('click', descend);
    el['btn-drop'].addEventListener('click', dropAndFlee);
    el['btn-return'].addEventListener('click', returnToSurface);
    el['up-bag'].addEventListener('click', () => buyUpgrade('bag'));
    el['up-light'].addEventListener('click', () => buyUpgrade('light'));
    el['up-weapon'].addEventListener('click', () => buyUpgrade('weapon'));
    el['btn-again'].addEventListener('click', startNewRun);
    el['btn-retry'].addEventListener('click', startNewRun);
  }

  /* ---------------- 시작 ---------------- */

  function init() {
    cacheDom();
    bind();
    el['start-rp'].textContent = meta.rp;
    el['start-depth'].textContent = meta.maxDepth;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
