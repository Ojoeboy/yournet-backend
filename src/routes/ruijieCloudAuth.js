// PUBLIC, UNAUTHENTICATED endpoints - Ruijie Cloud's own infrastructure
// calls these directly (server-to-server, or via the customer's browser
// being redirected through Ruijie Cloud's hosted flow), the same shape as
// integrations/radius.js's Access-Request listener: the router/cloud opens
// the connection to US, not the other way around, so this works from
// behind CGNAT with no port-forwarding - see radius.js's header for the
// full "why" that applies equally here.
//
// SETUP (per-site, via POST /api/sites/:id/ruijie-cloud-mode in
// routes/sites.js): in Ruijie Cloud's dashboard, Project > Config >
// Captive Portal > Authentication > Cloud Integration or External Portal,
// set:
//   Auth Server URL:       https://YOUR-DOMAIN/api/ruijie/:siteId/auth?t=TOKEN
//   Accounting URL:        https://YOUR-DOMAIN/api/ruijie/:siteId/accounting?t=TOKEN
//
// HONEST LIMITS - read before relying on this in production:
// The exact request/response wire format below (query params: mac, ip,
// gw_id, gw_sn, stage, code; response: plaintext "Auth: 1" / "Auth: 0") is
// carried over from an unofficial reconstruction of Ruijie's Cloud Auth
// docs, NOT a confirmed spec from Ruijie - and Ruijie Cloud's "Cloud Auth"
// setting has two different sub-modes (Cloud Integration vs External
// Portal) that may not share an identical wire format; which one your
// account presents hasn't been confirmed against a real test project. It
// needs validating against an actual Ruijie Cloud test account before a
// live deployment depends on it - watch the request logs (logger.info
// calls below) the first time a real gateway hits this.
//
// SECURITY: the `t` query param is a per-site random token (see
// sites.ruijie_callback_token_encrypted / routes/sites.js's
// ruijie-cloud-mode endpoint) checked with a constant-time compare before
// anything else runs. Without it, this URL would otherwise be guessable
// (sequential/enumerable siteIds) and callable by anyone, and while an
// attacker still can't grant themselves access without ALSO guessing a
// real unredeemed voucher code (32^8 keyspace, same as the portal's own
// public redeem endpoint), there's no reason to skip an extra layer that
// costs nothing on a route Ruijie Cloud calls with the same query param on
// every single request anyway.

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const voucherService = require('../services/voucherService');
const { decrypt } = require('../utils/credentialCrypto');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');

const router = express.Router();

// Generous but bounded - this is real gateway traffic (potentially many
// devices reconnecting), not a login form, but it still shouldn't be able
// to hammer the DB unbounded if a gateway misbehaves or the URL leaks.
const callbackLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

function sendAuthResult(res, granted) {
  // Plaintext, not JSON - this is what the Ruijie Cloud side is documented
  // (per the reconstructed spec) to parse for a pass/fail signal, mirroring
  // radius.js's Access-Accept/Reject in spirit if not in wire format.
  res.set('Content-Type', 'text/plain');
  res.send(granted ? 'Auth: 1' : 'Auth: 0');
}

async function verifyCallbackToken(siteId, providedToken) {
  const { rows } = await pool.query(
    `SELECT ruijie_callback_token_encrypted FROM sites WHERE id=$1 AND type='ruijie' AND mk_auth_mode='ruijie_cloud' AND active=true`,
    [siteId]
  );
  if (!rows.length || !rows[0].ruijie_callback_token_encrypted) return false;
  let expected;
  try {
    expected = decrypt(rows[0].ruijie_callback_token_encrypted);
  } catch {
    return false;
  }
  if (!providedToken || !expected) return false;
  const a = Buffer.from(providedToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Handles both the initial login (code present) and Ruijie Cloud's
// logout/session-teardown call (stage=logout) - same split radius.js's
// Access-Request handling makes between a fresh request and a re-auth.
router.all('/:siteId/auth', callbackLimiter, asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  const params = { ...req.query, ...(req.body || {}) };
  const { mac, gw_id: gwId, gw_sn: gwSn, stage, code, t: token } = params;

  const tokenOk = await verifyCallbackToken(siteId, token);
  if (!tokenOk) {
    logger.warn('ruijie_cloud auth: bad or missing callback token', { siteId, gwSn });
    return sendAuthResult(res, false);
  }

  if (stage === 'logout') {
    await voucherService.endRuijieCloudSession(siteId, mac || null);
    return sendAuthResult(res, true);
  }

  if (!code) {
    return sendAuthResult(res, false);
  }

  try {
    const result = await voucherService.redeemVoucherByRuijieCloudAuth(siteId, String(code).trim().toUpperCase(), {
      clientMac: mac || null,
      gwSn: gwSn || null,
    });
    if (!result.ok) {
      logger.info('ruijie_cloud auth: redemption rejected', { siteId, reason: result.reason, gwSn });
      return sendAuthResult(res, false);
    }
    return sendAuthResult(res, true);
  } catch (err) {
    logger.error('ruijie_cloud auth: redemption threw', { siteId, message: err.message, gwSn });
    return sendAuthResult(res, false);
  }
}));

// Accounting/heartbeat callback - best-effort session bookkeeping only
// (see voucherService.redeemVoucherByRuijieCloudAuth's session-telemetry
// insert). Never something a customer's access should depend on, so this
// always acknowledges once the token checks out, even if the underlying
// update is a no-op (e.g. an accounting ping for a session we never saw
// the auth call for).
router.all('/:siteId/accounting', callbackLimiter, asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  const params = { ...req.query, ...(req.body || {}) };
  const { mac, stage, t: token } = params;

  const tokenOk = await verifyCallbackToken(siteId, token);
  if (!tokenOk) {
    logger.warn('ruijie_cloud accounting: bad or missing callback token', { siteId });
    return res.status(403).set('Content-Type', 'text/plain').send('Auth: 0');
  }

  if (stage === 'logout' || stage === 'stop') {
    await voucherService.endRuijieCloudSession(siteId, mac || null);
  } else if (mac) {
    await pool.query(
      `UPDATE ruijie_cloud_sessions SET last_seen_at=now() WHERE site_id=$1 AND client_mac=$2 AND status='active'`,
      [siteId, mac]
    );
  }

  res.set('Content-Type', 'text/plain');
  res.send('Auth: 1');
}));

module.exports = router;
