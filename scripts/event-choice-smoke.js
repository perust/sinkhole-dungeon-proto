#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  KNOWN_PLAYER_CHOICE_FIXTURES,
  collectKnownPlayerChoiceFixtures,
} = require('../src/game.js');

assert.ok(Array.isArray(KNOWN_PLAYER_CHOICE_FIXTURES), 'KNOWN_PLAYER_CHOICE_FIXTURES export missing');
assert.equal(typeof collectKnownPlayerChoiceFixtures, 'function', 'collectKnownPlayerChoiceFixtures export missing');

const fixtures = collectKnownPlayerChoiceFixtures();
assert.deepEqual(fixtures, KNOWN_PLAYER_CHOICE_FIXTURES, 'collector should return the exported fixture table');

function keyOf(choice) {
  return `${choice.id}\u0000${choice.label}`;
}

const exportedKeys = new Set();
for (const fixture of fixtures) {
  assert.equal(typeof fixture.type, 'string', `fixture type missing: ${JSON.stringify(fixture)}`);
  assert.equal(typeof fixture.source, 'string', `fixture source missing: ${JSON.stringify(fixture)}`);
  assert.ok(Array.isArray(fixture.choices) && fixture.choices.length > 0, `fixture choices missing: ${fixture.source}`);
  for (const choice of fixture.choices) {
    assert.equal(typeof choice.id, 'string', `choice id missing: ${fixture.source}`);
    assert.equal(typeof choice.label, 'string', `choice label missing: ${fixture.source}`);
    assert.ok(choice.id.length > 0, `empty choice id: ${fixture.source}`);
    assert.ok(choice.label.length > 0, `empty choice label: ${fixture.source}`);
    exportedKeys.add(keyOf(choice));
  }
}

function fixtureChoices(source) {
  const fixture = fixtures.find((entry) => entry.source === source);
  assert.ok(fixture, `fixture source missing: ${source}`);
  return new Set(fixture.choices.map(keyOf));
}

function assertFixtureIncludes(source, expected) {
  const keys = fixtureChoices(source);
  for (const [id, label] of expected) {
    assert.ok(keys.has(`${id}\u0000${label}`), `${source} missing ${id}/${label}`);
  }
}

assertFixtureIncludes('vent', [
  ['crawl', '기어서 통과한다'],
  ['turn', '돌아선다'],
]);
assertFixtureIncludes('light-recovery', [
  ['charge', '조명에 연결한다'],
  ['wipe', '렌즈만 닦는다'],
  ['skip', '그냥 둔다'],
]);
assertFixtureIncludes('cabinet', [
  ['open', '조심히 연다'],
  ['skip', '그냥 지나간다'],
  ['noise', '소리를 내서 확인한다'],
]);
assertFixtureIncludes('watchpost', [
  ['wipe-log', '기록을 지운다'],
  ['search', '단말을 뒤진다'],
  ['seal-code', '봉쇄 코드를 넣는다'],
  ['pass', '그냥 지나간다'],
]);
assertFixtureIncludes('dropped-loot', [
  ['take-back:*', '* 챙기기'],
  ['list-more', '나머지는 둔다'],
  ['leave', '그냥 둔다'],
]);
assertFixtureIncludes('monster-encounter', [
  ['backstep', '뒤로 물러난다'],
  ['side-left', '왼쪽으로 뛰어든다'],
  ['glare', '조명을 고정한다'],
  ['throw-bag', '짐을 던진다'],
]);

// Static render/runtime choices must be represented in the exported allowlist. Dynamic labels/IDs
// are represented by wildcard fixtures below because their actual text includes item names or outcomes.
const sourceText = fs.readFileSync(path.join(__dirname, '..', 'src', 'game.js'), 'utf8');
const eventChoiceCall = /eventChoice\(\s*'([^']+)'\s*,\s*'([^']+)'/g;
const staticRuntimeKeys = new Set();
let match;
while ((match = eventChoiceCall.exec(sourceText)) !== null) {
  staticRuntimeKeys.add(`${match[1]}\u0000${match[2]}`);
}
for (const key of staticRuntimeKeys) {
  assert.ok(exportedKeys.has(key), `static eventChoice missing from fixture export: ${key.replace('\u0000', ' / ')}`);
}

const requiredDynamic = [
  ['mental-break', 'recover', '*'],
  ['dropped-loot', 'take-back:*', '* 챙기기'],
  ['item-encounter', 'take-back:*', '* 되챙기기'],
];
for (const [source, id, label] of requiredDynamic) {
  assert.ok(fixtureChoices(source).has(`${id}\u0000${label}`), `dynamic fixture missing: ${source} ${id}/${label}`);
}

console.log(`event choice smoke passed: ${fixtures.length} fixture groups, ${exportedKeys.size} known choice id/label pairs, ${staticRuntimeKeys.size} static eventChoice calls covered`);
