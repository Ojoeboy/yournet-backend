// Standalone smoke test for integrations/radius.js's accounting path.
// Run directly: node test/radius-acct.smoketest.js
const assert = require('assert');
const crypto = require('crypto');
const radius = require('../src/integrations/radius');

const SECRET = 'acct-secret-456';

function encodeAttr(type, value) {
  const valBuf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([Buffer.from([type, valBuf.length + 2]), valBuf]);
}

function encodeUint32Attr(type, num) {
  const v = Buffer.alloc(4);
  v.writeUInt32BE(num, 0);
  return encodeAttr(type, v);
}

// Builds a real Accounting-Request the way a MikroTik router would: the
// Request Authenticator is NOT random here (unlike Access-Request) - per
// RFC 2866 4.1, it's MD5(Code+ID+Length+16-zero-octets+Attributes+Secret).
function buildAccountingRequest({ identifier, username, acctStatusType, acctSessionId, callingStationId, sessionTime, inputOctets, outputOctets, gigawordsIn, nasIdentifier, secret }) {
  const attrsList = [
    encodeAttr(1, username),
    encodeUint32Attr(40, acctStatusType),
    encodeAttr(44, acctSessionId),
    encodeAttr(31, callingStationId),
    encodeAttr(32, nasIdentifier),
  ];
  if (sessionTime != null) attrsList.push(encodeUint32Attr(46, sessionTime));
  if (inputOctets != null) attrsList.push(encodeUint32Attr(42, inputOctets));
  if (outputOctets != null) attrsList.push(encodeUint32Attr(43, outputOctets));
  if (gigawordsIn != null) attrsList.push(encodeUint32Attr(52, gigawordsIn));

  const attrs = Buffer.concat(attrsList);
  const length = 20 + attrs.length;
  const head = Buffer.alloc(4);
  head.writeUInt8(4, 0); // Accounting-Request
  head.writeUInt8(identifier, 1);
  head.writeUInt16BE(length, 2);

  const zeroAuth = Buffer.alloc(16);
  const authenticator = crypto
    .createHash('md5')
    .update(Buffer.concat([head, zeroAuth, attrs, Buffer.from(secret, 'utf8')]))
    .digest();

  return Buffer.concat([head, authenticator, attrs]);
}

// --- Test 1: valid Accounting-Start verifies, wrong secret does not ---
{
  const pkt = buildAccountingRequest({
    identifier: 3,
    username: 'MNOP-4321',
    acctStatusType: radius.ACCT_STATUS_TYPE.START,
    acctSessionId: 'sess-0001',
    callingStationId: 'DE:AD:BE:EF:00:01',
    nasIdentifier: 'site-abc123',
    secret: SECRET,
  });
  const parsed = radius.parsePacket(pkt);
  assert.strictEqual(parsed.code, radius.CODE.ACCOUNTING_REQUEST);
  assert.strictEqual(radius.verifyAccountingRequestAuthenticator(parsed, SECRET), true);
  assert.strictEqual(radius.verifyAccountingRequestAuthenticator(parsed, 'wrong'), false);
  assert.strictEqual(radius.getAttrUint32(parsed.attributes, radius.ATTR.ACCT_STATUS_TYPE), radius.ACCT_STATUS_TYPE.START);
  assert.strictEqual(radius.getAttrString(parsed.attributes, radius.ATTR.ACCT_SESSION_ID), 'sess-0001');
  console.log('Test 1 (Accounting-Start authenticator + fields) passed');
}

// --- Test 2: Interim-Update with a >4GB transfer (gigawords wrap) decodes correctly ---
{
  // 5,000,000,000 bytes = 1 wrap (2^32 = 4,294,967,296) + 705,032,704 remainder
  const totalBytes = 5_000_000_000;
  const wrapSize = 2 ** 32;
  const gigawords = Math.floor(totalBytes / wrapSize);
  const remainder = totalBytes % wrapSize;

  const pkt = buildAccountingRequest({
    identifier: 4,
    username: 'MNOP-4321',
    acctStatusType: radius.ACCT_STATUS_TYPE.INTERIM_UPDATE,
    acctSessionId: 'sess-0001',
    callingStationId: 'DE:AD:BE:EF:00:01',
    nasIdentifier: 'site-abc123',
    sessionTime: 7200,
    inputOctets: remainder,
    gigawordsIn: gigawords,
    secret: SECRET,
  });
  const parsed = radius.parsePacket(pkt);
  assert.strictEqual(radius.verifyAccountingRequestAuthenticator(parsed, SECRET), true);

  const gwIn = radius.getAttrUint32(parsed.attributes, radius.ATTR.ACCT_INPUT_GIGAWORDS) || 0;
  const octIn = radius.getAttrUint32(parsed.attributes, radius.ATTR.ACCT_INPUT_OCTETS);
  const reconstructed = gwIn * 2 ** 32 + octIn;
  assert.strictEqual(reconstructed, totalBytes);
  console.log('Test 2 (gigawords reconstruction for >4GB session) passed');
}

// --- Test 3: Accounting-Response framing via buildResponse ---
{
  const requestAuthenticator = crypto.randomBytes(16); // response formula only needs SOME 16 bytes to echo back
  const resp = radius.buildResponse({
    code: radius.CODE.ACCOUNTING_RESPONSE,
    identifier: 9,
    requestAuthenticator,
    attributes: [],
    secret: SECRET,
  });
  assert.strictEqual(resp.readUInt8(0), radius.CODE.ACCOUNTING_RESPONSE);
  assert.strictEqual(resp.readUInt8(1), 9);
  assert.strictEqual(resp.length, 20); // no attributes -> just the header
  console.log('Test 3 (Accounting-Response build) passed');
}

console.log('All RADIUS accounting smoke tests passed.');
