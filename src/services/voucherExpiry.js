// Enforces the actual customer promise: "buy 24 hours, get 24 hours from
// redemption" - wall-clock, regardless of connection gaps. This is
// deliberate and separate from the router's own limit-uptime/session
// timers, which count cumulative CONNECTED time and pause on disconnect -
// on their own they let a customer with connection gaps stay authorized
// well past the wall-clock time they were sold. This job is what actually
// cuts them off on schedule; the router-side limit can stay as a harmless
// backstop.
//
// Same interval-driven pattern as subscriptionBilling.js / pppoeBilling.js
// - runs in this process for now, wired up from server.js.
//
// Coverage by site type:
//   mikrotik - full support: removeHotspotUser both kicks the active
//              session and deletes the router-side user in one call.
//   unifi    - supported when the voucher has a client_mac on file
//              (captured at redeem time); unauthorizeClient ends the
//              current grant. If no client_mac was ever recorded, there's
//              no device to kick, so this still marks the voucher
//              'expired' (the wall-clock promise is over regardless) but
//              logs it, since the customer's device may still be
//              connected until it naturally re-authenticates.
//   omada / meraki - no revoke primitive exists yet in integrations/*.js
//              for either platform. Left alone by this pass (voucher stays
//              'active' past expires_at, logged each pass) rather than
//              marking 'expired' while the customer might still be
//              connected - that status/reality mismatch is exactly what
//              this job exists to close for the types it CAN enforce, so
//              it's not being reintroduced here for the types it can't.
const pool = require('../db/pool');
const mikrotik = require('../integrations/mikrotik');
const unifi = require('../integrations/unifi');
const { decrypt } = require('../utils/credentialCrypto');
const logger = require('../utils/logger');

async function runVoucherExpirySweep() {
  const { rows: due } = await pool.query(
    `SELECT * FROM vouchers WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= now()`
  );
  if (!due.length) return { expired: 0, skipped: 0 };

  // Group by site so each site's router connection is opened once per
  // sweep, not once per voucher.
  const bySite = new Map();
  for (const v of due) {
    if (!v.site_id) continue; // no site on record - nothing to enforce against
    if (!bySite.has(v.site_id)) bySite.set(v.site_id, []);
    bySite.get(v.site_id).push(v);
  }

  let expiredCount = 0;
  let skippedCount = 0;

  for (const [siteId, siteVouchers] of bySite) {
    const { rows: siteRows } = await pool.query('SELECT * FROM sites WHERE id=$1', [siteId]);
    if (!siteRows.length) {
      skippedCount += siteVouchers.length;
      continue;
    }
    const siteRow = siteRows[0];

    if (siteRow.type === 'omada' || siteRow.type === 'meraki') {
      skippedCount += siteVouchers.length;
      logger.warn('Voucher expiry sweep: no revoke support for site type, skipping', {
        site_id: siteId, type: siteRow.type, voucher_count: siteVouchers.length,
      });
      continue;
    }

    let site;
    try {
      if (siteRow.type === 'mikrotik') {
        site = { ...siteRow, mk_password_decrypted: decrypt(siteRow.mk_password_encrypted) };
      } else if (siteRow.type === 'unifi') {
        site = {
          ...siteRow,
          unifi_password_decrypted: decrypt(siteRow.unifi_password_encrypted),
          unifi_api_key_decrypted: decrypt(siteRow.unifi_api_key_encrypted),
        };
      } else {
        skippedCount += siteVouchers.length;
        continue;
      }
    } catch (err) {
      logger.error('Voucher expiry sweep: credential decrypt failed', { site_id: siteId, message: err.message });
      skippedCount += siteVouchers.length;
      continue;
    }

    for (const voucher of siteVouchers) {
      try {
        if (siteRow.type === 'mikrotik' && siteRow.mk_auth_mode === 'radius') {
          // Can't reach this router's API to kick the session - that's the
          // whole reason it's in radius-mode (CGNAT/no public IP). The
          // wall-clock promise still has to be kept in the DB on schedule
          // for billing/reporting, so mark it expired regardless; the
          // customer's live session is left running until the router's own
          // Session-Timeout counts down (see integrations/radius.js's
          // header comment - this is the documented, known trade-off, not
          // an oversight) or they naturally drop off. If they DO
          // re-authenticate after this point, redeemVoucherByRadius's
          // re-auth branch only honors a still-'active', not-yet-expired
          // voucher, so an expired one correctly gets rejected there.
          logger.warn('Voucher expiry sweep: radius-mode site, cannot reach router to kick session - DB-only expiry', {
            site_id: siteId, voucher_id: voucher.id,
          });
        } else if (siteRow.type === 'mikrotik') {
          await mikrotik.removeHotspotUser(site, voucher.code);
        } else if (siteRow.type === 'unifi') {
          if (voucher.client_mac) {
            await unifi.unauthorizeClient(site, voucher.client_mac);
          } else {
            logger.warn('Voucher expiry sweep: no client_mac on file to unauthorize', { voucher_id: voucher.id });
          }
        }
        // One unreachable router / one bad voucher shouldn't stop the rest
        // of the sweep - each voucher's DB update and router call are
        // handled independently, and a failure below leaves this voucher
        // 'active' so the next pass retries it.
        await pool.query(`UPDATE vouchers SET status='expired' WHERE id=$1`, [voucher.id]);
        expiredCount++;
      } catch (err) {
        logger.error('Voucher expiry sweep: failed to expire voucher', {
          voucher_id: voucher.id, site_id: siteId, message: err.message,
        });
        skippedCount++;
      }
    }
  }

  return { expired: expiredCount, skipped: skippedCount };
}

module.exports = { runVoucherExpirySweep };
