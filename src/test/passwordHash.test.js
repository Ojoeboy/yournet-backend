const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../src/utils/passwordHash');

test('hashPassword produces a salt:hash pair, never the plaintext', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.ok(hash.includes(':'), 'expected a salt:hash format');
  assert.ok(!hash.includes('correct horse battery staple'), 'hash must not contain the plaintext password');
});

test('verifyPassword accepts the correct password', () => {
  const hash = hashPassword('Joefredbenuboy');
  assert.strictEqual(verifyPassword('Joefredbenuboy', hash), true);
});

test('verifyPassword rejects a wrong password', () => {
  const hash = hashPassword('Joefredbenuboy');
  assert.strictEqual(verifyPassword('wrongpassword', hash), false);
});

test('verifyPassword rejects malformed stored values instead of throwing', () => {
  assert.strictEqual(verifyPassword('anything', 'not-a-valid-hash'), false);
  assert.strictEqual(verifyPassword('anything', ''), false);
  assert.strictEqual(verifyPassword('anything', null), false);
});
