// Integration test for integrations/radius.js - unlike radius.smoketest.js
// and radius-acct.smoketest.js (which call the codec functions directly),
// this one actually starts startAuthServer()/startAcctServer() on real
// loopback UDP sockets and fires real packets at them over the network
// stack, the way a MikroTik router's RADIUS client actually would. It's
// the closest thing to a live-router test achievable without physical
// hardware: everything except "is this actually a MikroTik" is exercised
// for real - socket binding, packet-in/packet-out, timing, and the exact
// getSiteSecret/onAuthenticate/onAccounting callback contract server.js
// wires up in production (mocked here with in-memory fakes instead of
// Postgres, so this runs with zero external dependencies).
//
// Run directly: node test/radius-integration.test.js
const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const radius = require('../src/integrations/radius');

const SECRET = 'integration-test-secret';
const NAS_ID = 'site-integration-test';
const AUTH_PORT = 18120; // arbitrary high ports, unlikely to collide with anything else running locally
const ACCT_PORT = 18121;

// --- fakes standing in for the DB-backed lookups server.js wires up ---
const fakeSites = { [NAS_ID]: { secret: SECRET } };
async function getSiteSecret(nasIdentifier) {
  return fakeSites[nasIdentifier]?.secret || null;
}

const fakeVouchers = { 'TEST-0001': { redeemed: false } };
async function onAuthenticate({ username }) {
  const v = fakeVouchers[username];
  if (!v) return { ok: false, reason: 'not_found' };
  if (v.redeemed) return { ok: false, reason: 'already_used' };
  v.redeemed = true;
  return { ok: true, durationMinutes: 60, rateLimit: null };
}

const receivedAccountingEvents = [];
async function onAccounting(nasIdentifier, event) {
  receivedAccountingEvents.push({ nasIdentifier, event });
}

// --- packet builders (same technique as the other two smoke tests) ---
function encodeAttr(type, value) {
  const valBuf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([Buffer.from([type, valBuf.length + 2]), valBuf]);
}
function encodeUint32Attr(type, num) {
  const v = Buffer.alloc(4);
  v.writeUInt32BE(num, 0);
  return encodeAttr(type, v);
}
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
function buildAccessRequest({ identifier, username, password, nasIdentifier, secret, withMessageAuthenticator }) {
  const requestAuthenticator = crypto.randomBytes(16);
  let attrs = Buffer.concat([
    encodeAttr(1, username),
    encodeAttr(2, encryptUserPassword(password, secret, requestAuthenticator)),
    encodeAttr(32, nasIdentifier),
    encodeAttr(31, 'AA:BB:CC:DD:EE:FF'),
  ]);

  if (!withMessageAuthenticator) {
    const length = 20 + attrs.length;
    const head = Buffer.alloc(4);
    head.writeUInt8(1, 0);
    head.writeUInt8(identifier, 1);
    head.writeUInt16BE(length, 2);
    return Buffer.concat([head, requestAuthenticator, attrs]);
  }

  // RFC 2869 5.14 - placeholder zeroed MA attribute, then HMAC-MD5 over the
  // whole packet with it zeroed, then splice the real HMAC back in.
  attrs = Buffer.concat([attrs, encodeAttr(80, Buffer.alloc(16))]);
  const length = 20 + attrs.length;
  const head = Buffer.alloc(4);
  head.writeUInt8(1, 0);
  head.writeUInt8(identifier, 1);
  head.writeUInt16BE(length, 2);
  const full = Buffer.concat([head, requestAuthenticator, attrs]);
  const mac = crypto.createHmac('md5', secret).update(full).digest();
  mac.copy(attrs, attrs.length - 16);
  return Buffer.concat([head, requestAuthenticator, attrs]);
}
function buildAccountingRequest({ identifier, username, acctStatusType, acctSessionId, nasIdentifier, secret }) {
  const attrsList = [
    encodeAttr(1, username),
    encodeUint32Attr(40, acctStatusType),
    encodeAttr(44, acctSessionId),
    encodeAttr(31, 'AA:BB:CC:DD:EE:FF'),
    encodeAttr(32, nasIdentifier),
  ];
  const attrs = Buffer.concat(attrsList);
  const length = 20 + attrs.length;
  const head = Buffer.alloc(4);
  head.writeUInt8(4, 0);
  head.writeUInt8(identifier, 1);
  head.writeUInt16BE(length, 2);
  const zeroAuth = Buffer.alloc(16);
  const authenticator = crypto.createHash('md5').update(Buffer.concat([head, zeroAuth, attrs, Buffer.from(secret, 'utf8')])).digest();
  return Buffer.concat([head, authenticator, attrs]);
}

// --- a tiny "be a router" client: send one packet, wait for one reply (or a timeout meaning silent drop) ---
function sendAndWait(packet, port, { timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      client.close();
      resolve(null); // no reply within the window - counts as "dropped", which is sometimes the CORRECT behavior
    }, timeoutMs);
    client.on('message', (msg) => {
      clearTimeout(timer);
      client.close();
      resolve(msg);
    });
    client.send(packet, port, '127.0.0.1');
  });
}

async function main() {
  const authSocket = radius.startAuthServer({ port: AUTH_PORT, getSiteSecret, onAuthenticate });
  const acctSocket = radius.startAcctServer({ port: ACCT_PORT, getSiteSecret, onAccounting });
  // give both sockets a beat to finish binding before the first send
  await new Promise((r) => setTimeout(r, 100));

  try {
    // --- Test 1: real Access-Request over the wire -> Access-Accept ---
    {
      const pkt = buildAccessRequest({ identifier: 1, username: 'TEST-0001', password: 'TEST-0001', nasIdentifier: NAS_ID, secret: SECRET });
      const reply = await sendAndWait(pkt, AUTH_PORT);
      assert.ok(reply, 'expected an Access-Accept reply, got no reply at all');
      assert.strictEqual(reply.readUInt8(0), radius.CODE.ACCESS_ACCEPT);
      const parsed = radius.parsePacket(reply);
      assert.strictEqual(radius.getAttrString(parsed.attributes, radius.ATTR.SESSION_TIMEOUT), String(60 * 60));
      console.log('Test 1 (live Access-Request -> Access-Accept over UDP) passed');
    }

    // --- Test 2: replaying the SAME voucher code -> real Access-Reject ---
    {
      const pkt = buildAccessRequest({ identifier: 2, username: 'TEST-0001', password: 'TEST-0001', nasIdentifier: NAS_ID, secret: SECRET });
      const reply = await sendAndWait(pkt, AUTH_PORT);
      assert.ok(reply, 'expected an Access-Reject reply, got no reply at all');
      assert.strictEqual(reply.readUInt8(0), radius.CODE.ACCESS_REJECT);
      console.log('Test 2 (already-used voucher -> live Access-Reject) passed');
    }

    // --- Test 3: wrong secret, no Message-Authenticator -> decrypts to
    // garbage, garbage != username, so this is a REAL Access-Reject, not a
    // drop. Worth calling out explicitly: without a Message-Authenticator
    // attribute, there is no way to distinguish "wrong secret" from
    // "right secret, wrong password" before attempting the redemption
    // callback - RADIUS just doesn't carry that signal on its own. This
    // is expected protocol behavior, not a bug; see Test 3b for the case
    // that DOES defend against a secret being wrong, silently.
    {
      const pkt = buildAccessRequest({ identifier: 3, username: 'TEST-0001', password: 'TEST-0001', nasIdentifier: NAS_ID, secret: 'totally-wrong-secret' });
      const reply = await sendAndWait(pkt, AUTH_PORT);
      assert.ok(reply, 'expected a reply (garbage-decrypted password just looks like a wrong password)');
      assert.strictEqual(reply.readUInt8(0), radius.CODE.ACCESS_REJECT);
      console.log('Test 3 (wrong secret, no Message-Authenticator -> Access-Reject, not silently dropped) passed');
    }

    // --- Test 3b: wrong secret WITH Message-Authenticator -> THIS is what
    // actually catches a wrong-secret attempt before it's decrypted at
    // all, and it's why routers should be configured to send it whenever
    // supported. RouterOS's default RADIUS client behavior on this varies
    // by version - worth confirming against a real unit in phase 4's
    // hardware test, not assuming.
    {
      const pkt = buildAccessRequest({ identifier: 30, username: 'TEST-0001', password: 'TEST-0001', nasIdentifier: NAS_ID, secret: 'totally-wrong-secret', withMessageAuthenticator: true });
      const reply = await sendAndWait(pkt, AUTH_PORT, { timeoutMs: 300 });
      assert.strictEqual(reply, null, 'a wrong-secret request WITH a Message-Authenticator should be silently dropped');
      console.log('Test 3b (wrong secret WITH Message-Authenticator -> silent drop, caught before decrypt) passed');
    }

    // --- Test 4: unknown NAS-Identifier -> silently dropped ---
    {
      const pkt = buildAccessRequest({ identifier: 4, username: 'TEST-0001', password: 'TEST-0001', nasIdentifier: 'no-such-site', secret: SECRET });
      const reply = await sendAndWait(pkt, AUTH_PORT, { timeoutMs: 300 });
      assert.strictEqual(reply, null, 'an unknown NAS-Identifier should be silently dropped, not answered');
      console.log('Test 4 (unknown NAS-Identifier -> silent drop) passed');
    }

    // --- Test 5: real Accounting-Start/Stop over the wire -> Accounting-Response, callback fires ---
    {
      const startPkt = buildAccountingRequest({ identifier: 5, username: 'TEST-0001', acctStatusType: radius.ACCT_STATUS_TYPE.START, acctSessionId: 'live-sess-1', nasIdentifier: NAS_ID, secret: SECRET });
      const startReply = await sendAndWait(startPkt, ACCT_PORT);
      assert.ok(startReply, 'expected an Accounting-Response for Start');
      assert.strictEqual(startReply.readUInt8(0), radius.CODE.ACCOUNTING_RESPONSE);

      const stopPkt = buildAccountingRequest({ identifier: 6, username: 'TEST-0001', acctStatusType: radius.ACCT_STATUS_TYPE.STOP, acctSessionId: 'live-sess-1', nasIdentifier: NAS_ID, secret: SECRET });
      const stopReply = await sendAndWait(stopPkt, ACCT_PORT);
      assert.ok(stopReply, 'expected an Accounting-Response for Stop');

      assert.strictEqual(receivedAccountingEvents.length, 2);
      assert.strictEqual(receivedAccountingEvents[0].event.acctStatusType, radius.ACCT_STATUS_TYPE.START);
      assert.strictEqual(receivedAccountingEvents[1].event.acctStatusType, radius.ACCT_STATUS_TYPE.STOP);
      console.log('Test 5 (live Accounting Start/Stop over UDP, callback fired both times) passed');
    }

    console.log('All RADIUS integration tests passed (real UDP sockets, real network stack).');
  } finally {
    authSocket.close();
    acctSocket.close();
  }
}

main().catch((err) => {
  console.error('Integration test FAILED:', err);
  process.exit(1);
});
