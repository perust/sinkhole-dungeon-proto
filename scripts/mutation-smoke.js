#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ITEM_TABLE,
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
} = require('../src/game.js');

assert.deepEqual(MUTATION_ORDER, ['fissure-sight', 'black-hand', 'muffled-skin'], 'mutation order should stay deterministic');
for (const id of MUTATION_ORDER) {
  assert.ok(MUTATIONS[id], `missing mutation ${id}`);
  assert.equal(MUTATIONS[id].id, id, `mutation ${id} id mismatch`);
  assert.ok(MUTATIONS[id].name && MUTATIONS[id].gainLog, `mutation ${id} should have UI text`);
}
assert.equal(MUTATION_TRIGGER_HEAT, 15, 'hot cargo threshold should match epic item heat');
assert.ok(MUTATION_TRIGGER_ROOMS >= 2, 'room threshold should require a meaningful run');
assert.ok(MUTATION_TRIGGER_FLOOR >= 2, 'floor threshold should require depth');
assert.equal(FISSURE_SCRATCH_RATE, 0.2, 'fissure sight scratch tradeoff should be 20%');
assert.equal(BLACKHAND_CABINET_LIGHT, 1, 'black hand should lower cabinet light cost to 1');
assert.equal(BLACKHAND_CHECKPOINT_SUSP, 1, 'black hand checkpoint cost should be +1 suspicion');
assert.equal(MUFFLED_COMMITTEE_SUSP, 1, 'muffled skin committee cost should weaken relief by 1');
assert.equal(pickupNoiseLevel({ noise: 'high' }, true), 'medium', 'muffled skin should lower high pickup noise');
assert.equal(pickupNoiseLevel({ noise: 'medium' }, true), 'low', 'muffled skin should lower medium pickup noise');
assert.equal(pickupNoiseLevel({ noise: 'low' }, true), 'low', 'muffled skin should leave low pickup noise low');
assert.equal(pickupNoiseLevel({ noise: 'high' }, false), 'high', 'normal pickup noise should stay unchanged');
assert.equal(committeeSuspicionDelta(2, false), -6, 'normal committee relief should remain unchanged');
assert.equal(committeeSuspicionDelta(2, true), -5, 'muffled skin should weaken committee relief by exactly 1');

const hot = ITEM_TABLE[3].find((it) => it.heat >= MUTATION_TRIGGER_HEAT);
const cold = ITEM_TABLE[1][0];
assert.ok(hot, 'need at least one hot item in floor 3 table');

assert.equal(mutationCandidateForReturn({ bag: [], maxFloor: 3, roomsEntered: 9, mutations: [] }), null, 'empty bag should not mutate');
assert.equal(mutationCandidateForReturn({ bag: [cold], maxFloor: 3, roomsEntered: 9, mutations: [] }), null, 'cold cargo should not mutate');
assert.equal(mutationCandidateForReturn({ bag: [hot], maxFloor: 1, roomsEntered: 1, mutations: [] }), null, 'hot cargo without depth/rooms should not mutate');
assert.equal(mutationCandidateForReturn({ bag: [hot], maxFloor: MUTATION_TRIGGER_FLOOR, roomsEntered: 1, mutations: [] }).id, 'fissure-sight', 'depth should grant first mutation');
assert.equal(mutationCandidateForReturn({ bag: [hot], maxFloor: 1, roomsEntered: MUTATION_TRIGGER_ROOMS, mutations: [] }).id, 'fissure-sight', 'room count should grant first mutation');
assert.equal(mutationCandidateForReturn({ bag: [hot], maxFloor: 3, roomsEntered: 9, mutations: ['fissure-sight'] }).id, 'black-hand', 'second mutation should follow order');
assert.equal(mutationCandidateForReturn({ bag: [hot], maxFloor: 3, roomsEntered: 9, mutations: ['black-hand', 'fissure-sight'] }).id, 'muffled-skin', 'known mutations should be treated as set for candidate');
assert.equal(mutationCandidateForReturn({ bag: [hot], maxFloor: 3, roomsEntered: 9, mutations: MUTATION_ORDER }), null, 'all mutations owned should not grant more');
assert.equal(mutationCandidateForReturn({ bag: [hot], maxFloor: 3, roomsEntered: 9, mutations: ['unknown'] }).id, 'fissure-sight', 'unknown saved mutation ids should not block order');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/game.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const needle of [
  'meta.mutations',
  'grantMutationOnReturn()',
  'run.mutationNote',
  'roomsEntered += 1',
  'renderStartMutations()',
  "'start-mutations'",
  'mutations: meta.mutations',
  "pickupNoiseLevel(item, hasMutation('muffled-skin'))",
  "blackHand ? BLACKHAND_CABINET_LIGHT : 3",
  "hasMutation('fissure-sight')",
  "hasMutation('black-hand')",
  'committeeSuspicionDelta(run.bag.length',
  'fissureCueLine(node)',
  'BLACKHAND_CHECKPOINT_NOTE',
  'MUFFLED_COMMITTEE_NOTE',
]) {
  assert.ok(source.includes(needle), `source missing ${needle}`);
}
assert.ok(index.includes('id="start-mutations"'), 'index missing start-mutations line');

console.log(`mutation smoke passed: ${MUTATION_ORDER.length} mutations, hot threshold ${MUTATION_TRIGGER_HEAT}`);
