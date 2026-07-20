#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  FAMILY_KEEPSAKES,
  FAMILY_RETURN_RATE,
  FAMILY_RETURN_SUSP_RELIEF,
  familyReturnQuote,
} = require('../src/game.js');

assert.ok(FAMILY_RETURN_RATE > 0 && FAMILY_RETURN_RATE < 1, 'family return rate should be bounded below committee/black sale rates');
assert.ok(Number.isInteger(FAMILY_RETURN_SUSP_RELIEF) && FAMILY_RETURN_SUSP_RELIEF > 0, 'family return suspicion relief should be positive');
assert.equal(typeof familyReturnQuote, 'function', 'familyReturnQuote export missing');

const keepsake = FAMILY_KEEPSAKES[0];
const other = { name: '실험용 배터리', slots: 1, value: 6, heat: 3, truth: 'truth' };
const route = { gainDelta: -1, suspDelta: 1, note: 'test route note', route: 'crack' };
const quote = familyReturnQuote([keepsake, other], route);
assert.equal(quote.familyCount, 1, 'only family-tagged cargo should count for family return');
assert.equal(quote.gained, Math.max(0, Math.ceil(keepsake.value * FAMILY_RETURN_RATE) - 1), 'family return RP should use only keepsake value plus route delta');
assert.equal(quote.suspDelta, -FAMILY_RETURN_SUSP_RELIEF + 1, 'family return should reduce suspicion per keepsake plus route delta');
assert.equal(quote.note, route.note, 'route note should be preserved');
assert.equal(quote.route, route.route, 'route id should be preserved');

const emptyQuote = familyReturnQuote([other], { gainDelta: 0, suspDelta: 0, note: '', route: 'official' });
assert.equal(emptyQuote.familyCount, 0, 'no keepsake means no family return candidate');
assert.equal(emptyQuote.gained, 0, 'non-family cargo should not pay through family route');
assert.equal(emptyQuote.suspDelta, 0, 'non-family cargo should not affect suspicion through family route');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src/game.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
for (const needle of ['id="buy-family"', 'id="family-rp"', 'id="family-susp"', '가족에게 돌려준다']) {
  assert.ok(index.includes(needle), `index missing ${needle}`);
}
for (const needle of ["'buy-family'", "'family-rp'", "'family-susp'", "chooseBuyer('family')", "saleQuote('family')", 'familyReturnQuote(run.bag, eff)', "makeStreetNews(buyer, quote)"]) {
  assert.ok(source.includes(needle), `source missing ${needle}`);
}
for (const needle of ['.buyer-btn[hidden]', '.buyer-btn.family:not(:disabled)']) {
  assert.ok(css.includes(needle), `css missing ${needle}`);
}

console.log(`family return smoke passed: rate ${FAMILY_RETURN_RATE}, relief ${FAMILY_RETURN_SUSP_RELIEF}, keepsakes ${FAMILY_KEEPSAKES.length}`);
