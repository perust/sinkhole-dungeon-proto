#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ITEM_TABLE,
  NO_BAG_LEVEL,
  bagStatusText,
  bagDropAllowedDuringEvent,
  KNOWN_PLAYER_CHOICE_FIXTURES,
  createBagDropReclaimSmokeState,
  smokeUsedSlots,
  smokeRoomFor,
  smokeDropBagItem,
  smokeReclaimDroppedLoot,
  smokeDroppedLootChoices,
} = require('../src/game.js');

for (const [name, fn] of Object.entries({
  bagStatusText,
  bagDropAllowedDuringEvent,
  createBagDropReclaimSmokeState,
  smokeUsedSlots,
  smokeRoomFor,
  smokeDropBagItem,
  smokeReclaimDroppedLoot,
  smokeDroppedLootChoices,
})) {
  assert.equal(typeof fn, 'function', `${name} export missing`);
}

const battery = { ...ITEM_TABLE[1][0] }; // 1 slot
const pipe = { ...ITEM_TABLE[1][1] };    // 1 slot
const chip = { ...ITEM_TABLE[2][0] };    // 2 slots, fragile
const note = { ...ITEM_TABLE[2][1] };    // 1 slot, fragile
const core = { ...ITEM_TABLE[3][0] };    // 2 slots

assert.equal(bagStatusText(1, 0, 3, null), '가방 · 0/3칸', 'bag status should stay visible when empty');
assert.match(bagStatusText(1, 3, 3, null), /가득 참.*짐을 눌러 내려놓기/, 'full bag status should explain on-site drop');
assert.match(bagStatusText(1, 2, 3, core), /안정화 코어 넣을 공간 없음.*가방 슬롯/, 'blocked item status should name item and slot action');
assert.match(bagStatusText(NO_BAG_LEVEL, 1, 1, battery), /맨손.*넣을 공간 없음.*손에 든 물건/, 'hand-full status should avoid bag wording');
assert.equal(bagDropAllowedDuringEvent(null), true, 'bag slot drop should work outside events');
assert.equal(bagDropAllowedDuringEvent('item-encounter'), true, 'bag slot drop must work while blocked by a found item');
assert.equal(bagDropAllowedDuringEvent('dropped-loot'), true, 'bag slot drop must work while reclaiming floor loot');
assert.equal(bagDropAllowedDuringEvent('monster-encounter'), false, 'critical encounter should still block inventory cleanup');
assert.equal(bagDropAllowedDuringEvent('return-attempt'), false, 'return attempt should still block inventory cleanup');

let state = createBagDropReclaimSmokeState({
  cap: 3,
  currentNodeId: 7,
  bag: [battery, chip],
});
assert.equal(state.cap, 3, 'smoke state should preserve capacity');
assert.equal(smokeUsedSlots(state), 3, 'initial bag should use all 3 slots');
assert.equal(smokeRoomFor(state, pipe), false, 'full bag should reject another 1-slot item');

const firstDrop = smokeDropBagItem(state, 1);
assert.equal(firstDrop.ok, true, 'dropping a bag item should succeed');
state = firstDrop.state;
assert.equal(smokeUsedSlots(state), 1, 'dropping a 2-slot item should free two slots');
assert.equal(firstDrop.usedSlots, 1, 'drop result should report used slots after drop');
assert.equal(firstDrop.freeSlots, 2, 'drop result should report freed capacity');
assert.equal(firstDrop.loot.id, 'smoke-loot-7-0', 'first dropped loot id should be deterministic and node-scoped');
assert.equal(firstDrop.loot.nodeId, 7, 'manual drop should create loot at current node');
assert.equal(firstDrop.loot.item.name, chip.name, 'dropped loot should preserve the selected item');
assert.equal(firstDrop.loot.source, 'manual', 'manual bag-slot drop should mark source=manual');
assert.equal(firstDrop.loot.broken, true, 'fragile dropped item should carry broken marker fixture parity');

state.bag.push(pipe);
assert.equal(smokeUsedSlots(state), 2, 'adding a 1-slot item should update used slots deterministically');
const secondDrop = smokeDropBagItem(state, 1);
state = secondDrop.state;
assert.equal(secondDrop.ok, true, 'second drop in same room should succeed');
assert.equal(secondDrop.loot.id, 'smoke-loot-7-1', 'multiple drops in same room should have distinct stable ids');
assert.notEqual(secondDrop.loot.id, firstDrop.loot.id, 'two dropped entries must not alias');
assert.deepEqual(
  state.droppedLoot.map((loot) => loot.id),
  ['smoke-loot-7-0', 'smoke-loot-7-1'],
  'drop order should be stable',
);

// Reclaim only fails on capacity and must not remove any floor loot.
state.bag = [battery, core]; // 3/3 full; first dropped chip needs 2 slots.
const blockedReclaim = smokeReclaimDroppedLoot(state, firstDrop.loot.id);
assert.equal(blockedReclaim.ok, false, 'reclaim should fail when there is no capacity');
assert.equal(blockedReclaim.reason, 'no-capacity', 'blocked reclaim should report no-capacity');
assert.deepEqual(
  blockedReclaim.state.droppedLoot.map((loot) => loot.id),
  state.droppedLoot.map((loot) => loot.id),
  'blocked reclaim must not remove floor loot',
);

// Free capacity by dropping one bag slot, then reclaim only the requested loot.
const capacityDrop = smokeDropBagItem(blockedReclaim.state, 1);
assert.equal(capacityDrop.ok, true, 'freeing capacity with a bag-slot drop should succeed');
state = capacityDrop.state;
assert.equal(smokeUsedSlots(state), 1, 'capacity drop should leave one used slot');
assert.deepEqual(
  state.droppedLoot.map((loot) => loot.id),
  ['smoke-loot-7-0', 'smoke-loot-7-1', 'smoke-loot-7-2'],
  'capacity drop should append a third distinct loot entry',
);

const reclaimSecond = smokeReclaimDroppedLoot(state, secondDrop.loot.id);
assert.equal(reclaimSecond.ok, true, 'reclaim should succeed after freeing capacity');
state = reclaimSecond.state;
assert.equal(smokeUsedSlots(state), 2, 'reclaiming a 1-slot item should consume one free slot');
assert.equal(state.bag.at(-1).name, pipe.name, 'reclaim should append selected loot item back to bag');
assert.deepEqual(
  state.droppedLoot.map((loot) => loot.id),
  ['smoke-loot-7-0', 'smoke-loot-7-2'],
  'reclaim must remove only the selected loot',
);

const choices = smokeDroppedLootChoices(createBagDropReclaimSmokeState({
  cap: 6,
  currentNodeId: 7,
  droppedLoot: [
    ...state.droppedLoot,
    { id: 'fixture-extra-0', nodeId: 7, item: note, broken: true },
    { id: 'fixture-extra-1', nodeId: 7, item: battery, broken: false },
    { id: 'fixture-extra-2', nodeId: 7, item: pipe, broken: false },
  ],
}), 7);
assert.equal(choices.filter((choice) => choice.id.startsWith('take-back:')).length, 4, 'choice fixture should expose at most four take-back buttons');
assert.ok(choices.some((choice) => choice.id === 'list-more' && choice.label === '나머지는 둔다'), 'overflow choice should include list-more label path');
assert.ok(choices.some((choice) => choice.id === 'leave' && choice.label === '그냥 둔다'), 'dropped-loot choices should include leave option');
assert.ok(choices[0].id.startsWith('take-back:smoke-loot-7-0'), 'take-back choice ids should include the selected loot id');

const droppedLootFixture = KNOWN_PLAYER_CHOICE_FIXTURES.find((entry) => entry.source === 'dropped-loot');
assert.ok(droppedLootFixture, 'dropped-loot fixture source missing');
assert.ok(
  droppedLootFixture.choices.some((choice) => choice.id === 'take-back:*' && choice.label === '* 챙기기'),
  'wildcard dropped-loot take-back:* fixture missing',
);
const itemEncounterFixture = KNOWN_PLAYER_CHOICE_FIXTURES.find((entry) => entry.source === 'item-encounter');
assert.ok(
  itemEncounterFixture && itemEncounterFixture.choices.some((choice) => choice.id === 'take-back:*' && choice.label === '* 되챙기기'),
  'wildcard item-encounter take-back:* fixture missing',
);

const sourceText = fs.readFileSync(path.join(__dirname, '..', 'src', 'game.js'), 'utf8');
const indexText = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const cssText = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
assert.match(sourceText, /function dropBagItem\(index\)/, 'manual bag-slot drop handler should exist');
assert.match(sourceText, /dropLootHere\(dropped\)/, 'manual bag-slot drop should place loot at current node');
assert.ok(sourceText.includes('d.dataset.itemIndex = String(c.itemIndex);'), 'bag slots should surface item index for deterministic drop selection');
assert.ok(sourceText.includes('d.setAttribute(\'aria-label\', `${c.item.name} 버리기`);'), 'bag slots should expose discard/drop label');
assert.ok(indexText.includes('id="bag-status"') && indexText.includes('aria-live="polite"'), 'inline bag status live region should exist');
assert.match(cssText, /\.slot\s*\{[^}]*height:\s*44px/s, 'bag slot touch target height should be 44px');
assert.ok(cssText.includes('.bag-status.blocked'), 'blocked bag status styling should exist');
assert.ok(sourceText.includes('suppressDungeonClickUntil = 0;'), 'dialogue pointer suppression should consume only the matching synthetic click');
assert.ok(sourceText.includes("el['bag-status'].textContent !== nextBagStatus"), 'bag live region should update only when its copy changes');

console.log(`bag drop reclaim smoke passed: cap ${state.cap}, used ${smokeUsedSlots(state)}, dropped ${state.droppedLoot.length}, choices ${choices.length}`);
