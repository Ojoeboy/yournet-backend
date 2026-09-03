// RADIUS server (RFC 2865/2866) for the CGNAT-safe voucher redemption path.
//
// WHY THIS EXISTS: the existing mikrotik.js integration is a PUSH model -
// our backend (on Render) reaches OUT to the tenant's router over the
// RouterOS API to create a hotspot user. That requires the router to be
// reachable from the internet, which fails for any tenant behind CGNAT
// (most residential ISPs, most Starlink plans without the public-IP
// add-on). RADIUS flips the direction: the ROUTER opens the outbound
// connection to US (an Access-Request) whenever a customer logs in on the
// hotspot page, and we answer Accept/Reject. Outbound-only, so it works
// from behind CGNAT with no port-forwarding, no tunnel, no static IP.
//
// Hand-rolled codec rather than an npm RADIUS library: this server only
// ever needs to speak a small, well-specified subset of RFC 2865/2866
// (Access-Request/Accept/Reject, a handful of attributes, User-Password
// decryption), and hand-rolling it means every byte of what we send to a
// customer's router is something we've actually read the RFC for and can
// account for - not an unaudited transitive dependency making decisions
// on our behalf on a security-relevant wire protocol.
//
// MULTI-TENANCY: standard single-tenant RADIUS deployments identify which
// shared secret to use by the request's source IP. That doesn't work here
// - multiple tenants can sit behind the SAME CGNAT egress IP, so several
// different routers could appear to us as the same source address. Instead
// every radius-mode site is given a random `radius_nas_identifier`
// (sites.radius_nas_identifier), and the tenant configures their router to
// send that exact value in the NAS-Identifier attribute (RouterOS: /radius
// set [...] nas-identifier). NAS-Identifier is sent in the clear (it does
// NOT need the shared secret to read), so we can look it up first and only
// THEN fetch and use that site's secret to decrypt/verify the rest of the
// packet.
//
// KNOWN LIMITATION (documented, not silently swept under the rug):
// Session-Timeout (sent in every Access-Accept below) is enforced by the
// router locally, which is exactly what makes it CGNAT-safe - but like the
// existing limit-uptime approach in mikrotik.js, it counts *connected*
// time, not wall-clock time from purchase. A true wall-clock cutoff would
// need us to reach back into the router (CoA/Disconnect-Message, RFC
// 3576) mid-session, which fails under CGNAT for the same reason the
// RouterOS API push does. voucherExpiry.js's sweep still flips the DB
// record to 'expired' on schedule, so billing/reporting stay accurate;
// only the live kick-the-session part doesn't reach radius-mode sites yet.

const dgram = require('dgram');
const crypto = require('crypto');
const logger = require('../utils/logger');

// --- RADIUS packet codes (RFC 2865/2866) -----------------------------------
const CODE = {
  ACCESS_REQUEST: 1,
  ACCESS_ACCEPT: 2,
  ACCESS_REJECT: 3,
  ACCOUNTING_REQUEST: 4,
  ACCOUNTING_RESPONSE: 5,
};

// --- Attribute types we actually read or send -------------------------------
const ATTR = {
  USER_NAME: 1,
  USER_PASSWORD: 2,
  NAS_IP_ADDRESS: 4,
  NAS_PORT: 5,
  FRAMED_IP_ADDRESS: 8,
  SESSION_TIMEOUT: 27,
  CALLED_STATION_ID: 30,
  CALLING_STATION_ID: 31,
  NAS_IDENTIFIER: 32,
  ACCT_STATUS_TYPE: 40,
  ACCT_SESSION_ID: 44,
  MESSAGE_AUTHENTICATOR: 80,
  ACCT_INPUT_OCTETS: 42,
  ACCT_OUTPUT_OCTETS: 43,
  ACCT_SESSION_TIME: 46,
  ACCT_INPUT_GIGAWORDS: 52,
  ACCT_OUTPUT_GIGAWORDS: 53,
  ACCT_TERMINATE_CAUSE: 49,
};

// RFC 2866 6 - Acct-Status-Type values (the enum lives inside a 4-byte
// integer attribute, only the low byte is ever non-zero in practice).
const ACCT_STATUS_TYPE = {
  START: 1,
  STOP: 2,
  INTERIM_UPDATE: 3,
  ACCOUNTING_ON: 7,
  ACCOUNTING_OFF: 8,
};

const HEADER_LEN = 20; // code(1) + identifier(1) + length(2) + authenticator(16)

/**
 * Structural parse only - splits the packet into header fields + a raw
 * attribute list. Deliberately does NOT need the shared secret: every
 * attribute except User-Password's *meaning* (its bytes are still just
 * bytes) is either plaintext or self-contained, so this step works
 * identically for every request regardless of which tenant sent it. That's
 * what lets us read NAS-Identifier before we know which secret to use.
 */
function parsePacket(buf) {
  if (buf.length < HEADER_LEN) throw new Error('RADIUS packet shorter than header');
  const code = buf.readUInt8(0);
  const identifier = buf.readUInt8(1);
  const length = buf.readUInt16BE(2);
  const authenticator = buf.subarray(4, 20);

  const attributes = []; // [{ type, value: Buffer }], duplicates preserved in order
  let offset = HEADER_LEN;
  const end = Math.min(length, buf.length);
  while (offset < end) {
    const type = buf.readUInt8(offset);
    const attrLen = buf.readUInt8(offset + 1);
    if (attrLen < 2 || offset + attrLen > end) break; // malformed - stop, don't throw on a garbage tail
    attributes.push({ type, value: buf.subarray(offset + 2, offset + attrLen), offset });
    offset += attrLen;
  }

  return { code, identifier, length, authenticator, attributes, raw: buf };
}

function getAttr(attributes, type) {
  const found = attributes.find((a) => a.type === type);
  return found ? found.value : null;
}

function getAttrString(attributes, type) {
  const v = getAttr(attributes, type);
  return v ? v.toString('utf8') : null;
}

/**
 * RFC 2865 5.2 - User-Password is obfuscated (not encrypted in the
 * cryptographic sense) by XORing 16-byte blocks of the password against
 * repeated MD5(secret + previous-16-bytes), chained starting from the
 * request authenticator.
 */
function decryptUserPassword(encrypted, secret, requestAuthenticator) {
  const blocks = [];
  let prev = requestAuthenticator;
  for (let i = 0; i < encrypted.length; i += 16) {
    const hash = crypto.createHash('md5').update(Buffer.concat([Buffer.from(secret, 'utf8'), prev])).digest();
    const chunk = encrypted.subarray(i, i + 16);
    const out = Buffer.alloc(chunk.length);
    for (let j = 0; j < chunk.length; j++) out[j] = chunk[j] ^ hash[j];
    blocks.push(out);
    prev = chunk; // next hash chains off the CIPHERTEXT block just consumed, per RFC
  }
  // Password is null-padded to a multiple of 16 - trim trailing NULs.
  let plaintext = Buffer.concat(blocks).toString('utf8');
  const nul = plaintext.indexOf('\u0000');
  if (nul !== -1) plaintext = plaintext.slice(0, nul);
  return plaintext;
}

/**
 * RFC 2869 5.14 - if the request carries a Message-Authenticator, it's an
 * HMAC-MD5 over the whole packet (with the Message-Authenticator field
 * itself zeroed for the computation) keyed on the shared secret. Verifying
 * it catches both a wrong-secret guess and a tampered-in-transit packet.
 * Returns true if there's nothing to verify (attribute absent) - RouterOS
 * can be configured either way, and we already gated on NAS-Identifier +
 * per-site secret before getting here.
 */
function verifyMessageAuthenticator(parsed, secret) {
  const attr = parsed.attributes.find((a) => a.type === ATTR.MESSAGE_AUTHENTICATOR);
  if (!attr) return true;
  const zeroed = Buffer.from(parsed.raw.subarray(0, parsed.length));
  zeroed.fill(0, attr.offset + 2, attr.offset + 2 + attr.value.length); // zero the value bytes only, per RFC 2869 5.14
  const expected = crypto.createHmac('md5', secret).update(zeroed).digest();
  return crypto.timingSafeEqual(expected, attr.value);
}

function getAttrUint32(attributes, type) {
  const v = getAttr(attributes, type);
  if (!v || v.length !== 4) return null;
  return v.readUInt32BE(0);
}

/**
 * RFC 2866 4.1/5 - unlike an Access-Request (where the authenticator is a
 * random nonce used only for User-Password obfuscation), an
 * Accounting-Request's authenticator IS the integrity check: it must equal
 * MD5(Code + Identifier + Length + 16-zero-octets + Attributes + Secret).
 * Verifying this is what stops an arbitrary host from phoning in fake
 * usage data for a site whose secret it doesn't have - there's no
 * Message-Authenticator convention on accounting packets the way there can
 * be on auth ones, so this is the only integrity check available.
 */
function verifyAccountingRequestAuthenticator(parsed, secret) {
  const zeroAuth = Buffer.alloc(16);
  const head = parsed.raw.subarray(0, 4);
  const attrs = parsed.raw.subarray(HEADER_LEN, parsed.length);
  const expected = crypto
    .createHash('md5')
    .update(Buffer.concat([head, zeroAuth, attrs, Buffer.from(secret, 'utf8')]))
    .digest();
  return crypto.timingSafeEqual(expected, parsed.authenticator);
}

function encodeAttr(type, value) {
  const valBuf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const header = Buffer.from([type, valBuf.length + 2]);
  return Buffer.concat([header, valBuf]);
}

/**
 * Builds an Access-Accept/Access-Reject/Accounting-Response. The Response
 * Authenticator is MD5(code + identifier + length + RequestAuthenticator +
 * attributes + secret) per RFC 2865 3 - this is what lets the router trust
 * the reply actually came from someone holding the shared secret.
 */
function buildResponse({ code, identifier, requestAuthenticator, attributes, secret }) {
  const attrBuf = Buffer.concat(attributes.map((a) => encodeAttr(a.type, a.value)));
  const length = HEADER_LEN + attrBuf.length;
  const head = Buffer.alloc(4);
  head.writeUInt8(code, 0);
  head.writeUInt8(identifier, 1);
  head.writeUInt16BE(length, 2);

  const respAuth = crypto
    .createHash('md5')
    .update(Buffer.concat([head, requestAuthenticator, attrBuf, Buffer.from(secret, 'utf8')]))
    .digest();

  return Buffer.concat([head, respAuth, attrBuf]);
}

/**
 * Starts the Access-Request listener (UDP, default port 1812).
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {(ctx: {nasIdentifier: string, username: string, password: string, callingStationId: string|null}) =>
 *          Promise<{ok: true, durationMinutes: number, rateLimit: string|null} | {ok: false, reason: string}>} opts.onAuthenticate
 * @param {(nasIdentifier: string) => Promise<string|null>} opts.getSiteSecret - looks up + decrypts a site's
 *          radius_secret_encrypted by its radius_nas_identifier. Returns null if no active radius-mode site matches.
 */
function startAuthServer({ port, onAuthenticate, getSiteSecret }) {
  const socket = dgram.createSocket('udp4');

  socket.on('message', async (msg, rinfo) => {
    let parsed;
    try {
      parsed = parsePacket(msg);
    } catch (err) {
      logger.warn('RADIUS: dropped unparseable packet', { from: rinfo.address, message: err.message });
      return;
    }
    if (parsed.code !== CODE.ACCESS_REQUEST) return; // this socket only handles auth

    const nasIdentifier = getAttrString(parsed.attributes, ATTR.NAS_IDENTIFIER);
    if (!nasIdentifier) {
      // Per RFC 2865: if we can't identify/trust the client, silently drop -
      // don't reply, which would confirm to an arbitrary internet host that
      // something is listening and how it behaves.
      logger.warn('RADIUS: Access-Request with no NAS-Identifier, dropping', { from: rinfo.address });
      return;
    }

    let secret;
    try {
      secret = await getSiteSecret(nasIdentifier);
    } catch (err) {
      logger.error('RADIUS: site secret lookup failed', { message: err.message, nasIdentifier });
      return;
    }
    if (!secret) {
      logger.warn('RADIUS: no active radius-mode site for NAS-Identifier, dropping', { nasIdentifier, from: rinfo.address });
      return;
    }

    if (!verifyMessageAuthenticator(parsed, secret)) {
      logger.warn('RADIUS: Message-Authenticator verification failed, dropping', { nasIdentifier, from: rinfo.address });
      return;
    }

    const username = getAttrString(parsed.attributes, ATTR.USER_NAME);
    const encPassword = getAttr(parsed.attributes, ATTR.USER_PASSWORD);
    if (!username || !encPassword) {
      logger.warn('RADIUS: Access-Request missing username/password', { nasIdentifier });
      return;
    }
    const password = decryptUserPassword(encPassword, secret, parsed.authenticator);
    const callingStationId = getAttrString(parsed.attributes, ATTR.CALLING_STATION_ID);

    // YourNet's voucher model: the voucher code IS both the RADIUS username
    // and password (mirrors how it's already used as the hotspot
    // username+password in the 'api' flow's createHotspotUser - see
    // mikrotik.js). Require them to match rather than trusting whichever
    // one is present, so this can't be satisfied by a leaked username alone.
    if (username !== password) {
      const reject = buildResponse({
        code: CODE.ACCESS_REJECT,
        identifier: parsed.identifier,
        requestAuthenticator: parsed.authenticator,
        attributes: [],
        secret,
      });
      socket.send(reject, rinfo.port, rinfo.address);
      return;
    }

    let result;
    try {
      result = await onAuthenticate({ nasIdentifier, username, password, callingStationId });
    } catch (err) {
      logger.error('RADIUS: onAuthenticate threw', { message: err.message, nasIdentifier });
      return; // no reply - router will retry, safer than guessing accept/reject on our own bug
    }

    if (!result.ok) {
      const reject = buildResponse({
        code: CODE.ACCESS_REJECT,
        identifier: parsed.identifier,
        requestAuthenticator: parsed.authenticator,
        attributes: [],
        secret,
      });
      socket.send(reject, rinfo.port, rinfo.address);
      return;
    }

    const replyAttrs = [{ type: ATTR.SESSION_TIMEOUT, value: String(result.durationMinutes * 60) }];
    // Mikrotik-Rate-Limit (vendor attribute, VSA) intentionally omitted from
    // phase 1 - RouterOS also accepts a plain Session-Timeout fine on its
    // own, and getting a Vendor-Specific attribute's TLV framing wrong is
    // exactly the kind of thing worth its own tested pass rather than
    // bolting on here. Rate limiting for radius-mode sites for now should
    // be configured via the router's hotspot profile default, same as
    // before RADIUS existed.
    const accept = buildResponse({
      code: CODE.ACCESS_ACCEPT,
      identifier: parsed.identifier,
      requestAuthenticator: parsed.authenticator,
      attributes: replyAttrs,
      secret,
    });
    socket.send(accept, rinfo.port, rinfo.address);
  });

  socket.on('error', (err) => {
    logger.error('RADIUS auth server socket error', { message: err.message });
  });

  socket.bind(port, () => {
    logger.info('RADIUS auth server listening', { port, protocol: 'udp' });
  });

  return socket;
}

/**
 * Starts the Accounting-Request listener (UDP, default port 1813) - Start/
 * Stop/Interim-Update packets the router sends about a session it already
 * has an Access-Accept for. This is separate from the auth port because
 * that's how the RADIUS protocol itself splits them (RFC 2865 vs 2866),
 * and RouterOS's own /radius config has independent auth-port/acct-port
 * fields to match.
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {(nasIdentifier: string) => Promise<string|null>} opts.getSiteSecret - same lookup as startAuthServer's.
 * @param {(nasIdentifier: string, event: object) => Promise<void>} opts.onAccounting
 */
function startAcctServer({ port, getSiteSecret, onAccounting }) {
  const socket = dgram.createSocket('udp4');

  socket.on('message', async (msg, rinfo) => {
    let parsed;
    try {
      parsed = parsePacket(msg);
    } catch (err) {
      logger.warn('RADIUS acct: dropped unparseable packet', { from: rinfo.address, message: err.message });
      return;
    }
    if (parsed.code !== CODE.ACCOUNTING_REQUEST) return;

    const nasIdentifier = getAttrString(parsed.attributes, ATTR.NAS_IDENTIFIER);
    if (!nasIdentifier) {
      logger.warn('RADIUS acct: Accounting-Request with no NAS-Identifier, dropping', { from: rinfo.address });
      return;
    }

    let secret;
    try {
      secret = await getSiteSecret(nasIdentifier);
    } catch (err) {
      logger.error('RADIUS acct: site secret lookup failed', { message: err.message, nasIdentifier });
      return;
    }
    if (!secret) {
      logger.warn('RADIUS acct: no active radius-mode site for NAS-Identifier, dropping', { nasIdentifier, from: rinfo.address });
      return;
    }

    if (!verifyAccountingRequestAuthenticator(parsed, secret)) {
      logger.warn('RADIUS acct: request authenticator verification failed, dropping', { nasIdentifier, from: rinfo.address });
      return;
    }

    const statusTypeRaw = getAttrUint32(parsed.attributes, ATTR.ACCT_STATUS_TYPE);
    const gwIn = getAttrUint32(parsed.attributes, ATTR.ACCT_INPUT_GIGAWORDS) || 0;
    const gwOut = getAttrUint32(parsed.attributes, ATTR.ACCT_OUTPUT_GIGAWORDS) || 0;
    const octIn = getAttrUint32(parsed.attributes, ATTR.ACCT_INPUT_OCTETS);
    const octOut = getAttrUint32(parsed.attributes, ATTR.ACCT_OUTPUT_OCTETS);

    const event = {
      acctStatusType: statusTypeRaw,
      username: getAttrString(parsed.attributes, ATTR.USER_NAME),
      acctSessionId: getAttrString(parsed.attributes, ATTR.ACCT_SESSION_ID),
      callingStationId: getAttrString(parsed.attributes, ATTR.CALLING_STATION_ID),
      sessionTimeSeconds: getAttrUint32(parsed.attributes, ATTR.ACCT_SESSION_TIME),
      // Gigawords is the wrap-count of the 32-bit octet counter (RFC 2869
      // 5.1) - each wrap is 2^32 bytes (~4.29GB). Combined here so a long
      // session's usage total is correct instead of silently rolling over
      // at 4GB, which a voucher-funded video/streaming session could
      // plausibly hit.
      inputOctets: octIn != null ? gwIn * 2 ** 32 + octIn : null,
      outputOctets: octOut != null ? gwOut * 2 ** 32 + octOut : null,
      terminateCause: getAttrUint32(parsed.attributes, ATTR.ACCT_TERMINATE_CAUSE),
    };

    try {
      await onAccounting(nasIdentifier, event);
    } catch (err) {
      // Don't send a response - RFC 2866 accounting is at-least-once
      // delivery by design (the NAS retries on no response), and the DB
      // writes in radiusAccountingService.js are all idempotent
      // (ON CONFLICT upserts keyed on acct_session_id), so it's safe to
      // let a retry redo the work rather than ack a write we're not sure
      // landed.
      logger.error('RADIUS acct: onAccounting threw, not acking (NAS will retry)', {
        message: err.message, nasIdentifier, acctSessionId: event.acctSessionId,
      });
      return;
    }

    const response = buildResponse({
      code: CODE.ACCOUNTING_RESPONSE,
      identifier: parsed.identifier,
      requestAuthenticator: parsed.authenticator,
      attributes: [],
      secret,
    });
    socket.send(response, rinfo.port, rinfo.address);
  });

  socket.on('error', (err) => {
    logger.error('RADIUS acct server socket error', { message: err.message });
  });

  socket.bind(port, () => {
    logger.info('RADIUS accounting server listening', { port, protocol: 'udp' });
  });

  return socket;
}

module.exports = {
  CODE,
  ATTR,
  ACCT_STATUS_TYPE,
  parsePacket,
  getAttr,
  getAttrString,
  getAttrUint32,
  decryptUserPassword,
  verifyMessageAuthenticator,
  verifyAccountingRequestAuthenticator,
  buildResponse,
  startAuthServer,
  startAcctServer,
};
