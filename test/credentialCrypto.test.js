const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// A real 32-byte key for this test only - never use this value anywhere real.
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { encrypt, decrypt } = require('../src/utils/credentialCrypto');

test('encrypt then decrypt returns the original plaintext', () => {
  const original = 'super-secret-router-password-123';
  const encrypted = encrypt(original);
  assert.notStrictEqual(encrypted, original, 'encrypted value must not equal the plaintext');
  assert.strictEqual(decrypt(encrypted), original);
});

test('encrypt returns null for empty input, decrypt returns null for null input', () => {
  assert.strictEqual(encrypt(null), null);
  assert.strictEqual(encrypt(''), null);
  assert.strictEqual(decrypt(null), null);
});

test('two encryptions of the same plaintext produce different ciphertext (random IV)', () => {
  const a = encrypt('same-value');
  const b = encrypt('same-value');
  assert.notStrictEqual(a, b, 'ciphertext should differ each time due to a fresh random IV');
  assert.strictEqual(decrypt(a), 'same-value');
  assert.strictEqual(decrypt(b), 'same-value');
});

test('decrypt throws on a tampered/malformed value rather than silently returning garbage', () => {
  assert.throws(() => decrypt('not:a:validvalue'));
});
