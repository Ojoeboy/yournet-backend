// Standalone smoke test for integrations/radius.js's hand-rolled codec.
// Not wired into `npm test` (that suite uses node:test + assert on pure
// functions with no network/mocking needed) - this one builds an actual
// Access-Request packet by hand, the way a real MikroTik router would, and
// feeds it through the module's own decrypt/verify path end-to-end. Run
// directly: node test/radius.smoketest.js
const assert = require('assert');
const crypto = require('crypto');
const radius = require('../src/integrations/radius');

const SECRET = 'testing123';

function encodeAttr(type, value) {
  const valBuf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([Buffer.from([type, valBuf.length + 2]), valBuf]);
}

// RFC 2865 5.2 User-Password obfuscation - independent re-implementation
// (not calling radius.js's own encryptor, since it doesn't export one -
// only the router-side encrypt / server-side decrypt direction is needed
// in production) so this test isn't just checking the code against itself.
function encryptUserPassword(password, secret, requestAuthenticator) {
  const padLen = Math.ceil(password.length / 16) * 16 || 16;
  const padded = Buffer.alloc(padLen);
  Buffer.from(password, 'utf8').copy(padded);
  const out = Buffer.alloc(padLen);
  let prev = requestAuthenticator;
  for (let i = 0; i < padLen; i += 16) {
    const hash = crypto.createHash('md5').update(Buffer.concat([Buffer.from(secret, 'utf8'), prev])).digest();
    const block = padded.subarray(i, i + 16);
    const enc = Buffer.alloc(16);
    for (let j = 0; j < 16; j++) enc[j] = block[j] ^ hash[j];
    enc.copy(out, i);
    prev = enc;
  }
  return out;
}

function buildAccessRequest({ username, password, nasIdentifier, callingStationId, secret, withMessageAuthenticator }) {
  const requestAuthenticator = crypto.randomBytes(16);
  const encPassword = encryptUserPassword(password, secret, requestAuthenticator);

  let attrs = Buffer.concat([
    encodeAttr(1, username), // User-Name
    encodeAttr(2, encPassword), // User-Password
    encodeAttr(32, nasIdentifier), // NAS-Identifier
    encodeAttr(31, callingStationId), // Calling-Station-Id
  ]);

  if (withMessageAuthenticator) {
    // Placeholder zero MA attribute first, then HMAC-MD5 over the whole
    // packet with it zeroed, per RFC 2869 5.14.
    const placeholder = encodeAttr(80, Buffer.alloc(16));
    attrs = Buffer.concat([attrs, placeholder]);
    const length = 20 + attrs.length;
    const head = Buffer.alloc(4);
    head.writeUInt8(1, 0); // Access-Request
    head.writeUInt8(7, 1); // identifier
    head.writeUInt16BE(length, 2);
    const full = Buffer.concat([head, requestAuthenticator, attrs]);
    const mac = crypto.createHmac('md5', secret).update(full).digest();
    mac.copy(attrs, attrs.length - 16); // overwrite the placeholder's value bytes in place
    return Buffer.concat([head, requestAuthenticator, attrs]);
  }

  const length = 20 + attrs.length;
  const head = Buffer.alloc(4);
  head.writeUInt8(1, 0);
  head.writeUInt8(7, 1);
  head.writeUInt16BE(length, 2);
  return Buffer.concat([head, requestAuthenticator, attrs]);
}

// --- Test 1: parse + decrypt password, no Message-Authenticator ---
{
  const pkt = buildAccessRequest({
    username: 'ABCD-1234',
    password: 'ABCD-1234',
    nasIdentifier: 'site-abc123',
    callingStationId: 'AA:BB:CC:DD:EE:FF',
    secret: SECRET,
    withMessageAuthenticator: false,
  });
  const parsed = radius.parsePacket(pkt);
  assert.strictEqual(parsed.code, 1);
  assert.strictEqual(radius.getAttrString(parsed.attributes, radius.ATTR.NAS_IDENTIFIER), 'site-abc123');
  assert.strictEqual(radius.getAttrString(parsed.attributes, radius.ATTR.USER_NAME), 'ABCD-1234');
  const encPw = radius.getAttr(parsed.attributes, radius.ATTR.USER_PASSWORD);
  const decrypted = radius.decryptUserPassword(encPw, SECRET, parsed.authenticator);
  assert.strictEqual(decrypted, 'ABCD-1234');
  assert.strictEqual(radius.verifyMessageAuthenticator(parsed, SECRET), true); // nothing to verify -> true
  console.log('Test 1 (no Message-Authenticator) passed');
}

// --- Test 2: parse + verify Message-Authenticator (valid secret) ---
{
  const pkt = buildAccessRequest({
    username: 'WXYZ-9999',
    password: 'WXYZ-9999',
    nasIdentifier: 'site-xyz789',
    callingStationId: '11:22:33:44:55:66',
    secret: SECRET,
    withMessageAuthenticator: true,
  });
  const parsed = radius.parsePacket(pkt);
  assert.strictEqual(radius.verifyMessageAuthenticator(parsed, SECRET), true);
  assert.strictEqual(radius.verifyMessageAuthenticator(parsed, 'wrong-secret'), false);
  console.log('Test 2 (Message-Authenticator verify) passed');
}

// --- Test 3: build an Access-Accept and check header framing sanity ---
{
  const requestAuthenticator = crypto.randomBytes(16);
  const resp = radius.buildResponse({
    code: radius.CODE.ACCESS_ACCEPT,
    identifier: 42,
    requestAuthenticator,
    attributes: [{ type: radius.ATTR.SESSION_TIMEOUT, value: '3600' }],
    secret: SECRET,
  });
  assert.strictEqual(resp.readUInt8(0), 2); // Access-Accept
  assert.strictEqual(resp.readUInt8(1), 42);
  assert.strictEqual(resp.readUInt16BE(2), resp.length);
  const reparsed = radius.parsePacket(resp);
  assert.strictEqual(radius.getAttrString(reparsed.attributes, radius.ATTR.SESSION_TIMEOUT), '3600');
  console.log('Test 3 (Access-Accept build) passed');
}

console.log('All RADIUS smoke tests passed.');
