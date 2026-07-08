/*
 * main.js — Phaser 1층 슬라이스 씬 + 부팅 + HTML 조작 배선
 *
 * 화면(캔버스): 어두운 노드 맵 위주의 오버헤드 탐색 뷰포트.
 * HUD/조작/결과: 캔버스 밖 HTML(가독성·모바일 톤). 둘을 얇게 배선한다.
 */
(function () {
  'use strict';
  var F = window.SLICE.floor;

  var MARGIN_X = 96, MARGIN_Y = 76;
  var LIGHT_MAX = 60;

  // 라디얼 비네트 텍스처(가장자리 어둠) 생성 — 외부 이미지 없이 캔버스로 그린다.
  function makeVignette(scene, key, r, g, b) {
    var W = scene.scale.width, H = scene.scale.height;
    var tex = scene.textures.createCanvas(key, W, H);
    var ctx = tex.getContext();
    var cx = W / 2, cy = H / 2;
    var grad = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.28, cx, cy, Math.max(W, H) * 0.62);
    grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    tex.refresh();
    return scene.add.image(cx, cy, key);
  }

  var FloorScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function FloorScene() { Phaser.Scene.call(this, { key: 'floor' }); },

    create: function () {
      var self = this;
      var W = this.scale.width, H = this.scale.height;

      // 그리기 레이어(순서대로 위로 쌓임).
      this.gEdges = this.add.graphics();
      this.gGlow = this.add.graphics();           // 플레이어 주변 빛무리(가산 혼합)
      this.gGlow.setBlendMode(Phaser.BlendModes.ADD);
      this.gNodes = this.add.graphics();
      this.gPlayer = this.add.graphics();

      // 노드 라벨 + 클릭 이동용 존.
      this.labels = {};
      F.nodes.forEach(function (n) {
        var p = self.pos(n);
        self.labels[n.key] = self.add.text(p.x, p.y + 20, n.label, {
          fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#c7cede',
        }).setOrigin(0.5, 0);
        var z = self.add.zone(p.x, p.y, 56, 64).setInteractive({ useHandCursor: true });
        z.on('pointerdown', function () { self.tryMoveTo(n.key); });
      });

      // 어둠 비네트(상시) + 조우 시 붉은 가장자리(맥동).
      try {
        this.vig = makeVignette(this, 'vig-dark', 4, 6, 12);
        this.vigRed = makeVignette(this, 'vig-red', 150, 20, 24);
      } catch (err) {
        // createCanvas 미지원 환경 방어 — 없어도 게임은 돈다.
        this.vig = null; this.vigRed = null;
      }
      if (this.vigRed) this.vigRed.setAlpha(0);

      // 캔버스 좌상단 캡션.
      this.caption = this.add.text(14, 12, '1층 · 조사', {
        fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#8b93a7',
      });

      // 입력: 방향키/WASD 이동, E 줍기, Enter 귀환, R 다시.
      this.input.keyboard.addCapture(['UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE']);
      this.input.keyboard.on('keydown', function (e) { self.onKey(e); });

      // HTML 버튼 → 씬 API 배선.
      window.SLICE.api = {
        pickup: function () { self.doPickup(); },
        surface: function () { self.doSurface(); },
        restart: function () { self.doRestart(); },
      };

      this.resetRun();
      this.render();
    },

    // 정규 좌표 → 픽셀.
    pos: function (n) {
      return {
        x: MARGIN_X + n.x * (this.scale.width - 2 * MARGIN_X),
        y: MARGIN_Y + n.y * (this.scale.height - 2 * MARGIN_Y),
      };
    },

    resetRun: function () {
      var loot = F.items[Math.floor(Math.random() * F.items.length)];
      this.run = {
        playerNode: F.startNode,
        shapeNode: F.shapeStart,
        carrying: null,          // 맨손 1칸: 아이템 하나 또는 null
        light: LIGHT_MAX,
        lootItem: loot,          // lootNode 방에 놓인 회수물
        lootTaken: false,
        seen: {},                // 밝혀진 노드(방문 + 인접)
        over: false,
        message: '맨손으로 1층에 내려섰다. 회수물 하나를 쥐고 입구로 돌아오자.',
      };
      this.reveal(F.startNode);
      this.setResultVisible(false);
    },

    // 노드와 그 인접을 '밝혀짐'으로 기록(탐색/어둠 연출).
    reveal: function (key) {
      this.run.seen[key] = true;
      F.neighbors(key).forEach(function (k) { this.run.seen[k] = true; }, this);
    },

    onKey: function (e) {
      var code = e.code;
      if (this.run.over) {
        if (code === 'KeyR' || code === 'Enter') this.doRestart();
        return;
      }
      if (code === 'ArrowUp' || code === 'KeyW') { e.preventDefault(); this.moveByArrow(0, -1); }
      else if (code === 'ArrowDown' || code === 'KeyS') { e.preventDefault(); this.moveByArrow(0, 1); }
      else if (code === 'ArrowLeft' || code === 'KeyA') { e.preventDefault(); this.moveByArrow(-1, 0); }
      else if (code === 'ArrowRight' || code === 'KeyD') { e.preventDefault(); this.moveByArrow(1, 0); }
      else if (code === 'KeyE') this.doPickup();
      else if (code === 'Enter') this.doSurface();
    },

    moveByArrow: function (vx, vy) {
      if (this.run.over) return;
      var next = F.bestNeighborForArrow(this.run.playerNode, vx, vy);
      if (next) this.performMove(next);
    },

    tryMoveTo: function (key) {
      if (this.run.over) return;
      if (F.neighbors(this.run.playerNode).indexOf(key) >= 0) this.performMove(key);
    },

    performMove: function (key) {
      var run = this.run;
      run.playerNode = key;
      this.reveal(key);
      var n = F.node(key);
      run.light = Math.max(0, Math.min(LIGHT_MAX, run.light - 3 + (n.light || 0)));
      run.message = n.label + ' — ' + n.desc;

      // 이동은 시간을 쓴다 → 어두운 형체가 한 칸 반응한다.
      this.stepShape();
      this.render();

      // 접촉 판정: 회수물을 쥐고 있을 때만 실패로 이어진다(빈손 접촉은 기척만).
      if (run.playerNode === run.shapeNode && run.carrying) {
        this.fail();
        return;
      }
      this.pulsePresence();
    },

    // 어두운 형체 이동: 회수물을 쥔 순간부터 물건을 좇아 다가온다(그전엔 배회).
    stepShape: function () {
      var run = this.run;
      var next;
      if (run.carrying) {
        next = F.nextHopToward(run.shapeNode, run.playerNode);
      } else {
        var nb = F.neighbors(run.shapeNode);
        var pool = nb.filter(function (k) { return k !== run.playerNode; });
        if (!pool.length) pool = nb;
        next = pool[Math.floor(Math.random() * pool.length)];
      }
      if (next) run.shapeNode = next;
    },

    doPickup: function () {
      var run = this.run;
      if (run.over) return;
      // 회수물은 lootNode 방에서만 집는다. 줍기는 조용해서 시간을 쓰지 않는다.
      if (run.playerNode !== F.lootNode || run.lootTaken) return;
      if (run.carrying) { run.message = F.copy.handFull; this.render(); return; }
      run.carrying = run.lootItem;
      run.lootTaken = true;
      run.message = F.copy.pickup(run.lootItem.name) + ' ' + run.lootItem.hint;
      this.render();
      this.pulsePresence();
    },

    doSurface: function () {
      var run = this.run;
      if (run.over) return;
      if (run.playerNode !== F.startNode) return;
      run.over = true;
      this.render();
      if (run.carrying) {
        this.showResult('귀환 성공', F.copy.surfaceWith(run.carrying.name), '회수물 · ' + run.carrying.name + ' (가치 ' + run.carrying.value + ')');
      } else {
        this.showResult('귀환', F.copy.surfaceEmpty, '맨손');
      }
    },

    fail: function () {
      var run = this.run;
      run.over = true;
      run.carrying = null; // 도로 빼앗김 → 맨손
      this.render();
      if (this.cameras && this.cameras.main) this.cameras.main.shake(260, 0.012);
      if (this.vigRed) {
        this.tweens.add({ targets: this.vigRed, alpha: 0.42, duration: 120, yoyo: true, hold: 200, onComplete: function () {} });
      }
      var self = this;
      this.time.delayedCall(360, function () {
        self.showResult('조사 실패', F.copy.caught, '맨손');
      });
    },

    doRestart: function () {
      this.resetRun();
      if (this.vigRed) { this.tweens.killTweensOf(this.vigRed); this.vigRed.setAlpha(0); }
      this.render();
    },

    // 기척 단계에 맞춰 붉은 가장자리를 짧게 맥동.
    pulsePresence: function () {
      if (!this.vigRed) return;
      var dist = F.bfsDist(this.run.playerNode, this.run.shapeNode);
      var tier = F.presenceTier(dist);
      var peak = tier === 'contact' ? 0.34 : tier === 'near' ? 0.2 : tier === 'far' ? 0.08 : 0;
      this.tweens.killTweensOf(this.vigRed);
      this.tweens.add({ targets: this.vigRed, alpha: peak, duration: 220, ease: 'Sine.out' });
    },

    render: function () {
      var run = this.run, self = this;
      var W = this.scale.width, H = this.scale.height;

      // --- 간선(복도) ---
      this.gEdges.clear();
      F.nodes.forEach(function (a) {
        F.neighbors(a.key).forEach(function (bk) {
          if (a.key < bk) { // 각 간선 1회
            var b = F.node(bk);
            var seen = run.seen[a.key] || run.seen[bk];
            var pa = self.pos(a), pb = self.pos(b);
            self.gEdges.lineStyle(2, 0x2a3446, seen ? 0.9 : 0.12);
            self.gEdges.beginPath();
            self.gEdges.moveTo(pa.x, pa.y); self.gEdges.lineTo(pb.x, pb.y);
            self.gEdges.strokePath();
          }
        });
      });

      // --- 플레이어 빛무리 ---
      this.gGlow.clear();
      var pp = this.pos(F.node(run.playerNode));
      var lightFrac = run.light / LIGHT_MAX;
      var glowR = 44 + lightFrac * 42;
      this.gGlow.fillStyle(0x9fb4e6, 0.10 + lightFrac * 0.10);
      this.gGlow.fillCircle(pp.x, pp.y, glowR);
      this.gGlow.fillStyle(0xcde0ff, 0.06 + lightFrac * 0.08);
      this.gGlow.fillCircle(pp.x, pp.y, glowR * 0.55);

      // --- 노드 ---
      this.gNodes.clear();
      F.nodes.forEach(function (n) {
        var p = self.pos(n);
        var isCur = n.key === run.playerNode;
        var seen = run.seen[n.key];
        var neighborOfCur = F.neighbors(run.playerNode).indexOf(n.key) >= 0;

        var label = self.labels[n.key];
        label.setAlpha(seen ? (isCur ? 1 : neighborOfCur ? 0.85 : 0.4) : 0.12);

        if (!seen) {
          // 아직 어둠 속 — 아주 흐린 흔적만.
          self.gNodes.fillStyle(0x151b28, 0.5);
          self.gNodes.fillCircle(p.x, p.y, 8);
          return;
        }

        var isEntry = n.key === F.startNode;
        var base = isEntry ? 0x3f7d5a : neighborOfCur ? 0x35405a : 0x252e42;
        self.gNodes.fillStyle(base, isCur ? 1 : 0.9);
        self.gNodes.fillCircle(p.x, p.y, isCur ? 16 : 13);
        self.gNodes.lineStyle(2, neighborOfCur && !isCur ? 0x6f7fa8 : 0x1a2130, 1);
        self.gNodes.strokeCircle(p.x, p.y, isCur ? 16 : 13);

        // 회수물 표시: 밝혀졌고 아직 안 집었을 때만.
        if (n.key === F.lootNode && !run.lootTaken) {
          self.gNodes.fillStyle(0xffd166, 0.95);
          self.gNodes.fillCircle(p.x, p.y - 22, 4);
        }
        // 입구 표식.
        if (isEntry) {
          self.gNodes.fillStyle(0x7fe0a8, 0.9);
          self.gNodes.fillCircle(p.x, p.y, 4);
        }
      });

      // --- 플레이어 ---
      this.gPlayer.clear();
      this.gPlayer.fillStyle(0xeaf1ff, 1);
      this.gPlayer.fillCircle(pp.x, pp.y, 6);
      this.gPlayer.lineStyle(2, 0x9fb4e6, 0.8);
      this.gPlayer.strokeCircle(pp.x, pp.y, 9);

      // --- 어둠 비네트(조명이 낮을수록 짙게) ---
      if (this.vig) this.vig.setAlpha(0.5 + (1 - lightFrac) * 0.4);

      this.updateHud();
    },

    updateHud: function () {
      var run = this.run;
      var dist = F.bfsDist(run.playerNode, run.shapeNode);
      var tier = F.presenceTier(dist);

      setText('hud-floor', '1층 · ' + F.node(run.playerNode).label);
      setBar('hud-light-bar', Math.round((run.light / LIGHT_MAX) * 100));
      setText('hud-hand', run.carrying ? run.carrying.name : '맨손');
      setText('hud-presence', F.copy.presence[tier]);
      setPresenceClass(tier);

      // 이동 가능한 곳 목록.
      var exits = F.neighbors(run.playerNode).map(function (k) { return F.node(k).label; });
      setText('hud-exits', exits.join(' · '));

      setText('log', run.message);

      // 상황 버튼 활성화.
      var atLoot = run.playerNode === F.lootNode && !run.lootTaken && !run.carrying;
      var atEntry = run.playerNode === F.startNode;
      enable('btn-pickup', atLoot && !run.over);
      enable('btn-surface', atEntry && !run.over);
    },

    setResultVisible: function (on) {
      var elr = document.getElementById('result');
      if (elr) elr.classList.toggle('hidden', !on);
    },

    showResult: function (title, body, tag) {
      setText('result-title', title);
      setText('result-body', body);
      setText('result-tag', tag);
      this.setResultVisible(true);
    },
  });

  // --- 작은 DOM 헬퍼 ---
  function setText(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
  function setBar(id, pct) { var e = document.getElementById(id); if (e) e.style.width = Math.max(0, Math.min(100, pct)) + '%'; }
  function enable(id, on) { var e = document.getElementById(id); if (e) { e.disabled = !on; } }
  function setPresenceClass(tier) {
    var wrap = document.getElementById('stage-wrap');
    var chip = document.getElementById('hud-presence');
    ['presence-none', 'presence-far', 'presence-near', 'presence-contact'].forEach(function (c) {
      if (wrap) wrap.classList.remove(c);
      if (chip) chip.classList.remove(c);
    });
    if (wrap) wrap.classList.add('presence-' + tier);
    if (chip) chip.classList.add('presence-' + tier);
  }

  // --- 부팅 ---
  function boot() {
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game',
      width: 720,
      height: 460,
      backgroundColor: '#070810',
      scene: [FloorScene],
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      render: { pixelArt: false, antialias: true },
    });
    window.SLICE.game = game;

    // HTML 버튼 배선(씬 API는 create 이후 준비됨 — 옵셔널 체이닝으로 방어).
    on('btn-pickup', function () { window.SLICE.api && window.SLICE.api.pickup(); });
    on('btn-surface', function () { window.SLICE.api && window.SLICE.api.surface(); });
    on('btn-restart', function () { window.SLICE.api && window.SLICE.api.restart(); });
    on('btn-start', function () {
      var intro = document.getElementById('intro');
      if (intro) intro.classList.add('hidden');
    });
  }
  function on(id, fn) { var e = document.getElementById(id); if (e) e.addEventListener('click', fn); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
