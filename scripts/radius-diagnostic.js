#!/usr/bin/env node
// Standalone diagnostic: sends a real Access-Request (and optionally an
// Accounting-Start/Stop pair) at a deployed YourNet RADIUS server, exactly
// the way a MikroTik router's RADIUS client would, and reports what came
// back. Run this FIRST when a router "isn't working" - it isolates
// whether the problem is server-side (wrong secret/NAS-Identifier on file,
// server unreachable, firewall) or router-side (RouterOS config), before
// you go anywhere near the router's own logs.
//
// Needs no DB access and no dependencies beyond Node's built-ins - runs
// from any machine with a route to the server (your laptop, the tenant's
// machine, a box on the same LAN as the router).
//
// Usage:
//   node scripts/radius-diagnostic.js --host <server-address> \
//     --secret <secret> --nas-id <nas-identifier> --code <voucher-code> \
//     [--auth-port 1812] [--acct-port 1813] [--skip-accounting]
//
// Get --host/--secret/--nas-id from the admin panel's RADIUS mode panel
// (Manage Sites -> RADIUS mode). --code should be a real, currently
// 'unused' voucher for that site - this diagnostic actually redeems it
// on success, same as a real customer logging in would, so don't point it
// at a code you need to keep unused.

const crypto = require('crypto');
const dgram = require('dgram');

function parseArgs() {
  const args = { authPort: 1812, acctPort: 1813, skipAccounting: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') args.host = argv[++i];
    else if (a === '--secret') args.secret = argv[++i];
    else if (a === '--nas-id') args.nasId = argv[++i];
    else if (a === '--code') args.code = argv[++i];
    else if (a === '--auth-port') args.authPort = parseInt(argv[++i], 10);
    else if (a === '--acct-port') args.acctPort = parseInt(argv[++i], 10);
    else if (a === '--skip-accounting') args.skipAccounting = true;
    else if (a === '--help' || a === '-h') { printUsageAndExit(); }
  }
  if (!args.host || !args.secret || !args.nasId || !args.code) printUsageAndExit();
  return args;
}

function printUsageAndExit() {
  console.error(`Usage: node scripts/radius-diagnostic.js --host <server-address> --secret <secret> --nas-id <nas-identifier> --code <voucher-code> [--auth-port 1812] [--acct-port 1813] [--skip-accounting]`);
  process.exit(1);
}

// --- minimal RADIUS packet building (same technique as test/radius*.js -
// deliberately not requiring integrations/radius.js so this script can be
// copied out and run standalone with no repo checkout, e.g. by a tenant) ---
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
function buildAccessRequest({ username, password, nasIdentifier, secret }) {
  const requestAuthenticator = crypto.randomBytes(16);
  const attrs = Buffer.concat([
    encodeAttr(1, username),
    encodeAttr(2, encryptUserPassword(password, secret, requestAuthenticator)),
    encodeAttr(32, nasIdentifier),
    encodeAttr(31, 'AA:BB:CC:DD:EE:FF'), // Calling-Station-Id - a fake MAC, real routers send the client's actual one
  ]);
  const length = 20 + attrs.length;
  const head = Buffer.alloc(4);
  head.writeUInt8(1, 0); // Access-Request
  head.writeUInt8(Math.floor(Math.random() * 256), 1);
  head.writeUInt16BE(length, 2);
  return Buffer.concat([head, requestAuthenticator, attrs]);
}
function buildAccountingRequest({ username, acctStatusType, acctSessionId, nasIdentifier, secret }) {
  const attrs = Buffer.concat([
    encodeAttr(1, username),
    encodeUint32Attr(40, acctStatusType),
    encodeAttr(44, acctSessionId),
    encodeAttr(31, 'AA:BB:CC:DD:EE:FF'),
    encodeAttr(32, nasIdentifier),
  ]);
  const length = 20 + attrs.length;
  const head = Buffer.alloc(4);
  head.writeUInt8(4, 0); // Accounting-Request
  head.writeUInt8(Math.floor(Math.random() * 256), 1);
  head.writeUInt16BE(length, 2);
  const zeroAuth = Buffer.alloc(16);
  const authenticator = crypto.createHash('md5').update(Buffer.concat([head, zeroAuth, attrs, Buffer.from(secret, 'utf8')])).digest();
  return Buffer.concat([head, authenticator, attrs]);
}

function sendAndWait(packet, host, port, timeoutMs) {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const start = Date.now();
    const timer = setTimeout(() => {
      client.close();
      resolve({ reply: null, ms: Date.now() - start });
    }, timeoutMs);
    client.on('error', (err) => {
      clearTimeout(timer);
      client.close();
      resolve({ reply: null, ms: Date.now() - start, error: err.message });
    });
    client.on('message', (msg) => {
      clearTimeout(timer);
      client.close();
      resolve({ reply: msg, ms: Date.now() - start });
    });
    client.send(packet, port, host);
  });
}

async function main() {
  const args = parseArgs();
  console.log(`Testing RADIUS auth against ${args.host}:${args.authPort} (NAS-Identifier: ${args.nasId})...`);

  const authPkt = buildAccessRequest({ username: args.code, password: args.code, nasIdentifier: args.nasId, secret: args.secret });
  const { reply, ms, error } = await sendAndWait(authPkt, args.host, args.authPort, 3000);

  if (error) {
    console.error(`\n❌ Network error sending to ${args.host}:${args.authPort} - ${error}`);
    console.error(`   Check the address is right and reachable (not blocked by a firewall between here and Render).`);
    process.exit(1);
  }

  if (!reply) {
    console.error(`\n❌ No response after 3s.`);
    console.error(`   RADIUS silently drops a request it can't identify or verify (this is correct RFC`);
    console.error(`   behavior, not a bug) - so a silent drop most likely means one of:`);
    console.error(`     - the NAS-Identifier ('${args.nasId}') doesn't match what's on file for this site`);
    console.error(`       (re-check it in the admin panel's RADIUS mode panel - it's regenerated every`);
    console.error(`       time RADIUS mode is turned off and back on)`);
    console.error(`     - RADIUS_ENABLED isn't set to 'true' on the deployment, so nothing is listening`);
    console.error(`     - a firewall/NAT between here and the server is dropping UDP on port ${args.authPort}`);
    process.exit(1);
  }

  const code = reply.readUInt8(0);
  const codeName = { 2: 'Access-Accept', 3: 'Access-Reject' }[code] || `unknown code ${code}`;
  console.log(`\n✅ Got a reply in ${ms}ms: ${codeName}`);

  if (code === 2) {
    console.log(`   The server, secret, and NAS-Identifier are all correctly wired for this site.`);
    console.log(`   Voucher '${args.code}' has now been redeemed by this test (same as a real login).`);
  } else if (code === 3) {
    console.log(`   Server/secret/NAS-Identifier are correctly wired (it answered, not dropped) - but`);
    console.log(`   this specific voucher code was rejected. Most likely: '${args.code}' doesn't exist`);
    console.log(`   for this site, or is already used/expired. Try again with a fresh 'unused' code.`);
  }

  if (args.skipAccounting) return;

  console.log(`\nTesting RADIUS accounting against ${args.host}:${args.acctPort}...`);
  const sessionId = 'diag-' + Date.now();
  const startResult = await sendAndWait(
    buildAccountingRequest({ username: args.code, acctStatusType: 1, acctSessionId: sessionId, nasIdentifier: args.nasId, secret: args.secret }),
    args.host, args.acctPort, 3000
  );
  const stopResult = await sendAndWait(
    buildAccountingRequest({ username: args.code, acctStatusType: 2, acctSessionId: sessionId, nasIdentifier: args.nasId, secret: args.secret }),
    args.host, args.acctPort, 3000
  );

  if (startResult.reply && stopResult.reply) {
    console.log(`✅ Accounting-Start and Accounting-Stop both acknowledged.`);
    console.log(`   Check the dashboard's live-clients view for this site - this test session should`);
    console.log(`   have briefly appeared there and then cleared.`);
  } else {
    console.error(`❌ Accounting did not respond as expected (start: ${startResult.reply ? 'ok' : 'no reply'}, stop: ${stopResult.reply ? 'ok' : 'no reply'}).`);
    console.error(`   Same causes as an auth drop above, but check --acct-port and RADIUS_ACCT_PORT specifically.`);
  }
}

main().catch((err) => {
  console.error('Diagnostic script error:', err);
  process.exit(1);
});
