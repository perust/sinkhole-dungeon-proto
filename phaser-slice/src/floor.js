/*
 * floor.js — 1층 슬라이스의 순수 데이터 + 그래프 헬퍼 (Phaser 비의존)
 *
 * 본 게임(src/game.js)의 노드 그래프/기척 감각/맨손 1칸을 작게 재현하기 위한
 * 최소 모델이다. 규칙·상수·저장 형식은 본 게임과 공유하지 않는다(격리 실험).
 */
(function () {
  'use strict';
  var SLICE = (window.SLICE = window.SLICE || {});

  // 노드: 좌표는 0..1 정규값(뷰포트에 맞춰 스케일). light는 도착 시 조명 증감.
  var nodes = [
    { key: 'entry',    label: '입구',        desc: '지상으로 오르는 계단', x: 0.16, y: 0.82, light: 0 },
    { key: 'corridor', label: '정면 복도',   desc: '곧게 뻗은 어둠',       x: 0.16, y: 0.46, light: -4 },
    { key: 'storage',  label: '낮은 창고',   desc: '먼지 쌓인 선반',       x: 0.44, y: 0.22, light: 6 },
    { key: 'vent',     label: '환풍구',      desc: '좁고 찬 바람',         x: 0.50, y: 0.68, light: -2 },
    { key: 'office',   label: '관리실',      desc: '잠긴 캐비닛',          x: 0.78, y: 0.46, light: 0 },
    { key: 'hall',     label: '무너진 통로', desc: '내려앉은 콘크리트',    x: 0.86, y: 0.18, light: -6 },
  ];

  // 무향 간선(복도). 연결성 보장: 모든 노드가 입구에서 도달 가능.
  var edges = [
    ['entry', 'corridor'],
    ['corridor', 'storage'],
    ['corridor', 'vent'],
    ['vent', 'office'],
    ['storage', 'office'],
    ['office', 'hall'],
  ];

  // 1층 회수물(본 게임 ITEM_TABLE의 1층 값과 톤을 맞춘 최소 사본).
  var items = [
    { name: '실험용 배터리', value: 6, hint: '집을 때 소리가 조금 난다.' },
    { name: '배관 부품',     value: 5, hint: '묵직하지만 조용하다.' },
  ];

  // 인접 리스트 구성.
  var adj = {};
  nodes.forEach(function (n) { adj[n.key] = []; });
  edges.forEach(function (e) { adj[e[0]].push(e[1]); adj[e[1]].push(e[0]); });

  var byKey = {};
  nodes.forEach(function (n) { byKey[n.key] = n; });

  function node(key) { return byKey[key]; }
  function neighbors(key) { return adj[key] || []; }

  // 그래프 거리(노드 수). 도달 불가 시 Infinity.
  function bfsDist(a, b) {
    if (a === b) return 0;
    var q = [[a, 0]], seen = {};
    seen[a] = true;
    while (q.length) {
      var cur = q.shift(), c = cur[0], d = cur[1];
      var nb = neighbors(c);
      for (var i = 0; i < nb.length; i++) {
        if (nb[i] === b) return d + 1;
        if (!seen[nb[i]]) { seen[nb[i]] = true; q.push([nb[i], d + 1]); }
      }
    }
    return Infinity;
  }

  // from에서 to로 가는 최단 경로의 '첫 한 칸'을 돌려준다(어두운 형체 추적용).
  function nextHopToward(from, to) {
    if (from === to) return from;
    var q = [from], prev = {};
    prev[from] = from;
    while (q.length) {
      var c = q.shift();
      var nb = neighbors(c);
      for (var i = 0; i < nb.length; i++) {
        var k = nb[i];
        if (!(k in prev)) {
          prev[k] = c;
          if (k === to) {
            var cell = to;
            while (prev[cell] !== from) cell = prev[cell];
            return cell;
          }
          q.push(k);
        }
      }
    }
    return from;
  }

  // 누른 방향키 벡터(화면 좌표, y는 아래로 +)에 가장 잘 맞는 인접 노드.
  function bestNeighborForArrow(fromKey, vx, vy) {
    var from = node(fromKey);
    var best = null, bestDot = 0.35; // 어느 정도 정렬돼야 채택(오조작 방지)
    var nb = neighbors(fromKey);
    for (var i = 0; i < nb.length; i++) {
      var t = node(nb[i]);
      var dx = t.x - from.x, dy = t.y - from.y;
      var len = Math.hypot(dx, dy) || 1;
      var dot = (dx / len) * vx + (dy / len) * vy;
      if (dot > bestDot) { bestDot = dot; best = nb[i]; }
    }
    return best;
  }

  // 기척 단계: 그래프 거리로만 거칠게 요약(정확한 위치·수치는 절대 노출 안 함).
  //   none 안전 · far 먼 움직임 · near 바로 옆 · contact 같은 칸
  function presenceTier(dist) {
    if (dist <= 0) return 'contact';
    if (dist === 1) return 'near';
    if (dist === 2) return 'far';
    return 'none';
  }

  function objectParticle(word) {
    if (!word) return '을';
    var ch = word.charCodeAt(word.length - 1);
    return (ch >= 0xac00 && ch <= 0xd7a3 && ((ch - 0xac00) % 28)) ? '을' : '를';
  }

  // 플레이어에게 보이는 문구. 금지어를 피하고 본 게임 톤(조사·어두운 형체·맨손)에 맞춘다.
  var copy = {
    presence: {
      none: '잠잠하다',
      far: '먼 어둠에서 발소리가 스친다',
      near: '어두운 형체가 가까이 있다',
      contact: '바로 곁이다',
    },
    pickup: function (name) { return name + objectParticle(name) + ' 집어 손에 쥐었다.'; },
    handFull: '손이 가득 찼다. 맨손이라 더는 못 든다.',
    surfaceEmpty: '빈손으로 지상에 올라왔다. 다음엔 뭔가 쥐고 나오고 싶다.',
    surfaceWith: function (name) { return name + objectParticle(name) + ' 들고 지상으로 나왔다. 계단 아래는 다시 어둠뿐이다.'; },
    caught: '어두운 형체가 손에 쥔 것을 도로 가져갔다. 빈손으로 계단을 뛰어올랐다.',
  };

  SLICE.floor = {
    nodes: nodes,
    items: items,
    startNode: 'entry',   // 지상 귀환 지점
    shapeStart: 'hall',   // 어두운 형체 시작(입구에서 가장 먼 곳)
    lootNode: 'storage',  // 회수물이 놓인 방
    node: node,
    neighbors: neighbors,
    bfsDist: bfsDist,
    nextHopToward: nextHopToward,
    bestNeighborForArrow: bestNeighborForArrow,
    presenceTier: presenceTier,
    copy: copy,
  };
})();
