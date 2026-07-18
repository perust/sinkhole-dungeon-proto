#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  FLOORS,
  generateFloorMap,
  bfs,
} = require('../src/game.js');

assert.equal(typeof generateFloorMap, 'function', 'generateFloorMap export missing');
assert.equal(typeof bfs, 'function', 'bfs export missing');
assert.ok(Array.isArray(FLOORS) && FLOORS.length >= 2, 'at least two floors are required for descend smoke');

function mulberry32(seed) {
  return function rand() {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withSeed(seed, fn) {
  const originalRandom = Math.random;
  Math.random = mulberry32(seed >>> 0);
  try {
    return fn();
  } finally {
    Math.random = originalRandom;
  }
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function assertStrictCardinalEdge(map, fromId, toId, context) {
  const from = map.nodes[fromId];
  const to = map.nodes[toId];
  assert.ok(from, `${context}: missing from node ${fromId}`);
  assert.ok(to, `${context}: missing to node ${toId}`);
  assert.ok(from.exits.includes(toId), `${context}: ${fromId} must exit to ${toId}`);
  assert.ok(to.exits.includes(fromId), `${context}: ${toId} must exit back to ${fromId}`);
  assert.ok(from.pos, `${context}: node ${fromId} missing pos`);
  assert.ok(to.pos, `${context}: node ${toId} missing pos`);
  assert.equal(manhattan(from.pos, to.pos), 1, `${context}: edge ${fromId}<->${toId} must be strict cardinal adjacent`);
}

function reconstructShortestPath(map, floor, seed) {
  assert.equal(map.entryId, 0, `seed ${seed} floor ${floor}: entry should be node 0`);
  assert.ok(map.stairsId > 0, `seed ${seed} floor ${floor}: stairs must exist before final floor`);
  const distFromEntry = bfs(map.nodes, map.entryId);
  assert.ok(Number.isFinite(distFromEntry[map.stairsId]), `seed ${seed} floor ${floor}: stairs must be reachable from entry`);

  const distToStairs = bfs(map.nodes, map.stairsId);
  const path = [map.entryId];
  const seen = new Set(path);
  while (path[path.length - 1] !== map.stairsId) {
    const cur = path[path.length - 1];
    const next = map.nodes[cur].exits
      .filter((id) => distToStairs[id] === distToStairs[cur] - 1)
      .sort((a, b) => a - b)[0];
    assert.notEqual(next, undefined, `seed ${seed} floor ${floor}: no next shortest-path step from ${cur}`);
    assert.ok(!seen.has(next), `seed ${seed} floor ${floor}: path loop at ${next}`);
    assertStrictCardinalEdge(map, cur, next, `seed ${seed} floor ${floor} path`);
    path.push(next);
    seen.add(next);
  }
  assert.equal(path.length - 1, distFromEntry[map.stairsId], `seed ${seed} floor ${floor}: reconstructed path length should match BFS distance`);
  return path;
}

function assertMapEdges(map, floor, seed) {
  assert.ok(map.count >= 9 && map.count <= 12, `seed ${seed} floor ${floor}: node count should be 9..12`);
  assert.equal(map.nodes.length, map.count, `seed ${seed} floor ${floor}: count should match nodes length`);
  const positions = new Set();
  for (const node of map.nodes) {
    assert.equal(node.id, map.nodes.indexOf(node), `seed ${seed} floor ${floor}: node id/index mismatch`);
    assert.ok(node.pos, `seed ${seed} floor ${floor}: node ${node.id} missing pos`);
    const key = `${node.pos.x},${node.pos.y}`;
    assert.ok(!positions.has(key), `seed ${seed} floor ${floor}: duplicate grid position ${key}`);
    positions.add(key);
    for (const exit of node.exits) {
      assertStrictCardinalEdge(map, node.id, exit, `seed ${seed} floor ${floor} map`);
    }
  }
}

function smokeOneSeed(seed) {
  return withSeed(seed, () => {
    const simulatedRun = { floor: 1, currentNodeId: 0, maxFloor: 1 };
    const floorSummaries = [];

    for (const floor of [1, 2]) {
      const map = generateFloorMap(floor);
      assertMapEdges(map, floor, seed);
      const path = reconstructShortestPath(map, floor, seed);

      simulatedRun.floor = floor;
      simulatedRun.currentNodeId = map.entryId;
      for (const nextId of path.slice(1)) {
        assertStrictCardinalEdge(map, simulatedRun.currentNodeId, nextId, `seed ${seed} floor ${floor} simulated movement`);
        simulatedRun.currentNodeId = nextId;
      }
      assert.equal(map.nodes[simulatedRun.currentNodeId].kind, 'stairs', `seed ${seed} floor ${floor}: simulated run should end on stairs`);
      assert.equal(simulatedRun.currentNodeId, map.stairsId, `seed ${seed} floor ${floor}: simulated run should reach stairsId`);
      if (floor < FLOORS.length) {
        simulatedRun.floor += 1;
        simulatedRun.maxFloor = Math.max(simulatedRun.maxFloor, simulatedRun.floor);
      }

      floorSummaries.push(`F${floor}:${map.count}nodes/${path.length - 1}steps`);
    }

    assert.equal(simulatedRun.maxFloor, 3, `seed ${seed}: two one-floor descents should reach floor 3 state`);
    return floorSummaries.join(' ');
  });
}

const seeds = [
  0x00000001,
  0x00000002,
  0x00000003,
  0x12345678,
  0x5eedc0de,
  0x9e3779b9,
  0xc001d00d,
  0xffffffff,
];

const summaries = seeds.map(smokeOneSeed);
console.log(`floor run smoke passed: ${seeds.length} deterministic seeds, floors 1-2 path-to-stairs and strict cardinal movement verified`);
console.log(summaries.map((summary, i) => `seed ${seeds[i]} ${summary}`).join('\n'));
