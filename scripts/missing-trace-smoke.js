#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  FAMILY_KEEPSAKES,
  MISSING_TRACE_LOGS,
  MISSING_TRACE_SPAWN_CHANCE,
  NODE_KINDS,
  generateFloorMap,
  KNOWN_PLAYER_CHOICE_FIXTURES,
} = require('../src/game.js');

assert.ok(Array.isArray(FAMILY_KEEPSAKES) && FAMILY_KEEPSAKES.length >= 3, 'family keepsake table should be exported');
assert.ok(Array.isArray(MISSING_TRACE_LOGS) && MISSING_TRACE_LOGS.length >= 3, 'missing trace logs should be exported');
assert.ok(MISSING_TRACE_SPAWN_CHANCE > 0 && MISSING_TRACE_SPAWN_CHANCE < 1, 'missing trace spawn chance should be a bounded probability');

for (const item of FAMILY_KEEPSAKES) {
  assert.equal(item.family, true, `${item.name} should be tagged as family keepsake`);
  assert.equal(typeof item.name, 'string', 'keepsake name missing');
  assert.ok(item.slots >= 1, `${item.name} should occupy bag slots`);
  assert.ok(item.heat <= 1, `${item.name} should stay low-heat personal cargo`);
  assert.ok(!Object.hasOwn(item, 'truth'), `${item.name} must not count as a truth item`);
}

const traceKind = NODE_KINDS.find((kind) => kind.key === 'missing-trace');
assert.ok(traceKind, 'missing-trace node kind should exist');
assert.equal(traceKind.uncommon, true, 'missing-trace should be uncommon');
assert.match(traceKind.label, /실종자/, 'missing-trace label should be player-readable');

const fixture = KNOWN_PLAYER_CHOICE_FIXTURES.find((entry) => entry.source === 'missing-trace');
assert.ok(fixture, 'missing-trace choice fixture should exist');
const choiceKeys = new Set(fixture.choices.map((choice) => `${choice.id}\u0000${choice.label}`));
for (const [id, label] of [
  ['recover', '유품을 챙긴다'],
  ['inspect', '사진만 확인한다'],
  ['pass', '그냥 지나간다'],
]) {
  assert.ok(choiceKeys.has(`${id}\u0000${label}`), `missing-trace fixture missing ${id}/${label}`);
}

// Force rare-room chances to fire. The exact graph does not matter here; we only need to
// prove the generator can place the missing-trace room and keep native item placement off it.
const originalRandom = Math.random;
try {
  Math.random = () => 0.01;
  const map = generateFloorMap(1);
  const traceNodes = map.nodes.filter((node) => node.kind === 'missing-trace');
  assert.equal(traceNodes.length, 1, 'forced generation should place exactly one missing-trace room');
  assert.ok(traceNodes[0].id !== map.entryId, 'missing trace should not replace entry');
  assert.ok(traceNodes[0].id !== map.stairsId, 'missing trace should not replace stairs');
  assert.equal(traceNodes[0].item, null, 'missing trace room should not receive native loot before its event resolves');
} finally {
  Math.random = originalRandom;
}

console.log(`missing trace smoke passed: ${FAMILY_KEEPSAKES.length} keepsakes, ${MISSING_TRACE_LOGS.length} trace logs`);
