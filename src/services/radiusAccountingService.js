// Business logic for RADIUS accounting events (Start/Interim-Update/Stop),
// called from integrations/radius.js's Accounting-Request listener. Kept
// separate from voucherService.js: that file owns voucher *lifecycle*
// (issue/redeem/expire); this one owns *session telemetry* for radius-mode
// sites - what dashboard.js's live-clients endpoint and usage stats read.
//
// Every write here is an idempotent upsert keyed on (site_id,
// acct_session_id) - see the UNIQUE constraint on radius_sessions in
// schema.sql - because RADIUS accounting is at-least-once delivery by
// design (integrations/radius.js withholds the Accounting-Response on any
// internal error specifically so the NAS retries), so a duplicate Start or
// Interim-Update for the same session has to be a safe no-op/overwrite,
// never a duplicate row or a thrown unique-violation.
const pool = require('../db/pool');
const logger = require('../utils/logger');
const { ACCT_STATUS_TYPE } = require('../integrations/radius');

async function findRadiusSite(nasIdentifier) {
  const { rows } = await pool.query(
    `SELECT id, tenant_id FROM sites WHERE radius_nas_identifier = $1 AND mk_auth_mode = 'radius' AND active = true`,
    [nasIdentifier]
  );
  return rows[0] || null;
}

async function handleAccountingEvent(nasIdentifier, event) {
  const { acctStatusType, username, acctSessionId, callingStationId, sessionTimeSeconds, inputOctets, outputOctets, terminateCause } = event;

  const site = await findRadiusSite(nasIdentifier);
  if (!site) {
    logger.warn('RADIUS accounting: no active radius-mode site for NAS-Identifier', { nasIdentifier });
    return;
  }

  // Accounting-On/Off (RouterOS sends these when its RADIUS client itself
  // starts/stops, e.g. on reboot) aren't about one session - there's
  // nothing per-session to write. Logged for visibility since a wave of
  // these unexpectedly could mean a tenant's router is rebooting a lot.
  if (acctStatusType === ACCT_STATUS_TYPE.ACCOUNTING_ON || acctStatusType === ACCT_STATUS_TYPE.ACCOUNTING_OFF) {
    logger.info('RADIUS accounting: Accounting-On/Off from NAS', { nasIdentifier, siteId: site.id, acctStatusType });
    return;
  }

  if (!acctSessionId) {
    logger.warn('RADIUS accounting: missing Acct-Session-Id, dropping', { nasIdentifier, username });
    return;
  }

  // The voucher code IS the RADIUS username (see integrations/radius.js).
  // Linking it here is best-effort - a session for a code we don't
  // recognize (e.g. the voucher was later deleted) is still recorded with
  // voucher_id left null, so it's visible on the dashboard as "unlinked"
  // rather than silently dropped.
  let voucherId = null;
  if (username) {
    const { rows } = await pool.query(
      `SELECT id FROM vouchers WHERE tenant_id=$1 AND site_id=$2 AND code=$3`,
      [site.tenant_id, site.id, username]
    );
    voucherId = rows[0]?.id || null;
  }

  if (acctStatusType === ACCT_STATUS_TYPE.START) {
    await pool.query(
      `INSERT INTO radius_sessions (site_id, voucher_id, acct_session_id, client_mac, status, started_at, last_seen_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())
       ON CONFLICT (site_id, acct_session_id) DO UPDATE SET
         status = 'active', client_mac = COALESCE(EXCLUDED.client_mac, radius_sessions.client_mac), last_seen_at = now()`,
      [site.id, voucherId, acctSessionId, callingStationId || null]
    );
    return;
  }

  if (acctStatusType === ACCT_STATUS_TYPE.INTERIM_UPDATE) {
    // Insert-or-update rather than a plain UPDATE: a Start packet can be
    // lost (UDP) or arrive after a server restart missed it entirely - an
    // Interim-Update is still real usage data worth keeping even if we
    // never saw that session begin.
    await pool.query(
      `INSERT INTO radius_sessions (site_id, voucher_id, acct_session_id, client_mac, status, bytes_in, bytes_out, session_time_seconds, started_at, last_seen_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, now(), now())
       ON CONFLICT (site_id, acct_session_id) DO UPDATE SET
         bytes_in = $5, bytes_out = $6, session_time_seconds = $7, last_seen_at = now(),
         client_mac = COALESCE(EXCLUDED.client_mac, radius_sessions.client_mac)`,
      [site.id, voucherId, acctSessionId, callingStationId || null, inputOctets ?? null, outputOctets ?? null, sessionTimeSeconds ?? null]
    );
    return;
  }

  if (acctStatusType === ACCT_STATUS_TYPE.STOP) {
    await pool.query(
      `INSERT INTO radius_sessions (site_id, voucher_id, acct_session_id, client_mac, status, bytes_in, bytes_out, session_time_seconds, terminate_cause, started_at, last_seen_at, stopped_at)
       VALUES ($1, $2, $3, $4, 'stopped', $5, $6, $7, $8, now(), now(), now())
       ON CONFLICT (site_id, acct_session_id) DO UPDATE SET
         status = 'stopped', bytes_in = $5, bytes_out = $6, session_time_seconds = $7,
         terminate_cause = $8, last_seen_at = now(), stopped_at = now(),
         client_mac = COALESCE(EXCLUDED.client_mac, radius_sessions.client_mac)`,
      [site.id, voucherId, acctSessionId, callingStationId || null, inputOctets ?? null, outputOctets ?? null, sessionTimeSeconds ?? null, terminateCause ?? null]
    );
    // Deliberately NOT touching vouchers.status here. A Stop just means
    // this one connection ended (Wi-Fi drop, idle-timeout, the router's
    // own Session-Timeout countdown finishing) - it says nothing about
    // whether the customer's PAID wall-clock time is up. That's still
    // voucherExpiry.js's job, and voucherService.redeemVoucherByRadius
    // already allows a fresh Access-Request to resume an 'active',
    // not-yet-expired voucher, so the customer can just log back in.
    return;
  }

  logger.warn('RADIUS accounting: unrecognized Acct-Status-Type, ignoring', { nasIdentifier, acctStatusType });
}

module.exports = { handleAccountingEvent };
