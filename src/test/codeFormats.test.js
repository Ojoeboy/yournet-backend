const test = require('node:test');
const assert = require('node:assert');
const { randomCode } = require('../src/services/voucherService');
const { generateKeyCode } = require('../src/services/licenseService');

test('voucher codes match the expected XXXX-XXXX format with no ambiguous characters', () => {
  for (let i = 0; i < 50; i++) {
    const code = randomCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
      `code "${code}" should be 4 chars, dash, 4 chars, using only unambiguous characters`);
  }
});

test('license keys match the expected YNET-XXXX-XXXX-XXXX format', () => {
  for (let i = 0; i < 50; i++) {
    const key = generateKeyCode();
    assert.match(key, /^YNET-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
      `key "${key}" should match the expected format`);
  }
});

test('repeated calls produce different codes (not a fixed/predictable sequence)', () => {
  const codes = new Set();
  for (let i = 0; i < 100; i++) codes.add(randomCode());
  // Not a strict uniqueness guarantee (random collisions are possible in
  // principle), but 100 draws from a large space should essentially always
  // produce 100 distinct values - a failure here would suggest something
  // is wrong with the randomness source, not bad luck.
  assert.ok(codes.size > 95, `expected close to 100 unique codes, got ${codes.size}`);
});
