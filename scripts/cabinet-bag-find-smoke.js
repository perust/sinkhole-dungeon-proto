#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  BAG_PRODUCTS,
  CABINET_BAG_FIND_RATES,
  MAX_BAG_LEVEL,
  cabinetBagFindCandidate,
} = require('../src/game.js');

assert.equal(typeof cabinetBagFindCandidate, 'function', 'cabinetBagFindCandidate export missing');

const paidBags = BAG_PRODUCTS.filter((bag) => bag.level > 0);
const byLevel = new Map(BAG_PRODUCTS.map((bag) => [bag.level, bag]));

// 이미 최대 가방이면 어떤 확정 당첨 roll이라도 후보가 없어야 한다.
assert.equal(cabinetBagFindCandidate(MAX_BAG_LEVEL, 0), null, 'max bag level should not find a candidate');

// roll=0은 현재 레벨보다 큰 가장 가까운 가방을 찾아야 한다.
for (let level = 0; level < MAX_BAG_LEVEL; level += 1) {
  const found = cabinetBagFindCandidate(level, 0);
  assert.ok(found, `level ${level} should find a bag at roll=0`);
  assert.equal(found.level, level + 1, `level ${level} should find next larger bag`);
}

// 매우 높은 roll은 어느 레벨에서도 발견 없음이어야 한다.
for (let level = 0; level <= MAX_BAG_LEVEL; level += 1) {
  assert.equal(cabinetBagFindCandidate(level, 0.999), null, `level ${level} high roll should find nothing`);
}

// 여러 roll에서 나온 후보는 항상 현재보다 크고, cap/cost가 있는 제품표 안에 있어야 한다.
for (let level = 0; level <= MAX_BAG_LEVEL; level += 1) {
  for (let step = 0; step <= 100; step += 1) {
    const roll = step / 100;
    const found = cabinetBagFindCandidate(level, roll);
    if (!found) continue;
    const product = byLevel.get(found.level);
    assert.ok(found.level > level, `candidate level ${found.level} must be greater than current ${level}`);
    assert.ok(found.level <= MAX_BAG_LEVEL, `candidate level ${found.level} must be within max`);
    assert.equal(found, product, `candidate level ${found.level} must come from BAG_PRODUCTS`);
    assert.equal(typeof found.cap, 'number', `candidate level ${found.level} must have cap`);
    assert.equal(typeof found.cost, 'number', `candidate level ${found.level} must have cost`);
    assert.ok(Object.hasOwn(CABINET_BAG_FIND_RATES, found.level), `candidate level ${found.level} must have a find rate`);
  }
}

console.log(`cabinet bag find smoke passed: ${paidBags.length} bag products, max level ${MAX_BAG_LEVEL}`);
