const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const mikrotik = require('../integrations/mikrotik');
const omada = require('../integrations/omada');
const unifi = require('../integrations/unifi');
const meraki = require('../integrations/meraki');
const sms = require('../integrations/smsService');
const { decrypt } = require('../utils/credentialCrypto');

// CSPRNG (crypto.randomInt), not Math.random() - Math.random() isn't
// designed to resist prediction, and while a guessed voucher code is a
// small loss on its own, there's no reason to use a weaker generator here
// than the one already used for license keys.
function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// Package rate limits are stored as RouterOS-style strings like "4M" or
// "512k" (matching what the Mikrotik rsc-wizard/admin form use). UniFi's
// API instead wants a plain number in kbps, so this converts one to the
// other. Returns null (no limit applied) if the value is missing or not
// parseable, rather than guessing.
function parseRateToKbps(rateStr) {
  if (!rateStr) return null;
  const match = String(rateStr).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgG]?)/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'g') return Math.round(num * 1000000);
  if (unit === 'm') return Math.round(num * 1000);
  if (unit === 'k') return Math.round(num);
  return Math.round(num); // no unit - assume already kbps
}

/**
 * Generate N vouchers in the DB. Does NOT touch the router yet - hotspot
 * users are only created on the router at redemption time (this keeps the
 * router's user table small and avoids pre-loading thousands of unused
 * accounts onto a Mikrotik with limited memory).
 */
async function generateVouchers(tenantId, { packageId, siteId, agentId, quantity, batch }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (let i = 0; i < quantity; i++) {
      // Extremely unlikely (32^8 possibilities per tenant), but if a
      // duplicate code is ever generated, retry with a fresh one instead
      // of aborting the entire batch over one collision.
      let inserted = null;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const code = randomCode();
        try {
          const { rows } = await client.query(
            `INSERT INTO vouchers (id, tenant_id, site_id, package_id, agent_id, code, batch)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [uuidv4(), tenantId, siteId, packageId, agentId, code, batch]
          );
          inserted = rows[0];
        } catch (err) {
          if (err.code !== '23505') throw err; // anything other than "duplicate code" is a real error
          // 23505 = unique_violation on (tenant_id, code) - loop and try again
        }
      }
      if (!inserted) throw new Error('Could not generate a unique voucher code after 5 attempts.');
      created.push(inserted);
    }
    await client.query('COMMIT');
    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Redeem a voucher: validates it, then actually calls the right router
 * integration to grant network access. This replaces the old front-end
 * behaviour of just flipping a status flag in localStorage.
 */
async function redeemVoucher(tenantId, code, redeemContext = {}) {
  // Claim the voucher atomically FIRST, before reading anything else or
  // touching a router. Two devices redeeming the same code at once used to
  // both pass a SELECT-then-check on 'unused' and both get network access
  // for one paid voucher - this UPDATE...WHERE status='unused' is the same
  // row-lock pattern already used for license keys in /signup, and only
  // one concurrent caller can ever win it.
  const claim = await pool.query(
    `UPDATE vouchers SET status='redeeming' WHERE tenant_id=$1 AND code=$2 AND status='unused' RETURNING id`,
    [tenantId, code]
  );

  if (!claim.rows.length) {
    const { rows: existing } = await pool.query(
      `SELECT status FROM vouchers WHERE tenant_id=$1 AND code=$2`,
      [tenantId, code]
    );
    if (!existing.length) return { ok: false, reason: 'not_found' };
    // Covers both "someone else already redeemed it" and "someone else's
    // redemption is in flight right now" - both correctly read as
    // already/being used rather than available.
    return { ok: false, reason: 'already_used', status: existing[0].status === 'redeeming' ? 'unused' : existing[0].status };
  }

  const voucherId = claim.rows[0].id;

  const { rows } = await pool.query(
    `SELECT
       v.id AS voucher_id, v.code, v.site_id,
       p.duration_minutes, p.rate_limit_down, p.rate_limit_up,
       s.id AS site_id_full, s.type AS site_type,
       s.mk_host, s.mk_api_port, s.mk_username, s.mk_password_encrypted, s.mk_hotspot_profile,
       s.omada_base_url, s.omada_client_id, s.omada_client_secret_encrypted,
       s.omada_omadac_id, s.omada_site_id,
       s.unifi_base_url, s.unifi_username, s.unifi_password_encrypted, s.unifi_site,
       s.unifi_auth_mode, s.unifi_api_key_encrypted,
       s.meraki_dashboard_api_key_encrypted, s.meraki_network_id
     FROM vouchers v
     JOIN packages p ON p.id = v.package_id
     JOIN sites s ON s.id = v.site_id
     WHERE v.id = $1`,
    [voucherId]
  );
  const v = rows[0];

  // Mikrotik/Omada integration modules expect decrypted credential fields -
  // map them here in one place (credentials are stored AES-256-GCM
  // encrypted; see utils/credentialCrypto.js).
  const site = {
    ...v,
    mk_password_decrypted: decrypt(v.mk_password_encrypted),
    omada_client_secret_decrypted: decrypt(v.omada_client_secret_encrypted),
    unifi_password_decrypted: decrypt(v.unifi_password_encrypted),
    unifi_api_key_decrypted: decrypt(v.unifi_api_key_encrypted),
    meraki_dashboard_api_key_decrypted: decrypt(v.meraki_dashboard_api_key_encrypted),
  };

  // Releases a voucher that was claimed above ('redeeming') back to
  // 'unused' - used on any path below that ends without actually granting
  // access, so a failed/aborted redemption doesn't permanently strand the
  // voucher in limbo and leave the customer's paid code unusable.
  const releaseClaim = () => pool.query(
    `UPDATE vouchers SET status='unused' WHERE id=$1 AND status='redeeming'`,
    [voucherId]
  );

  let providerResult;
  try {
    if (v.site_type === 'mikrotik') {
      providerResult = await mikrotik.createHotspotUser(site, {
        code: v.code,
        profile: v.mk_hotspot_profile,
        durationMinutes: v.duration_minutes,
        rateLimit: v.rate_limit_up && v.rate_limit_down ? `${v.rate_limit_up}/${v.rate_limit_down}` : null,
        clientMac: redeemContext.clientMac || null,
      });
    } else if (v.site_type === 'omada') {
      providerResult = await omada.authorizeClient(site, {
        clientMac: redeemContext.clientMac,
        apMac: redeemContext.apMac,
        ssidName: redeemContext.ssidName,
        radioId: redeemContext.radioId,
        siteParam: v.omada_site_id,
      });
    } else if (v.site_type === 'unifi') {
      providerResult = await unifi.authorizeClient(site, {
        clientMac: redeemContext.clientMac,
        durationMinutes: v.duration_minutes,
        // RouterOS-style rate limit strings are e.g. "4M/10M" (up/down) -
        // UniFi's API wants separate up/down values in kbps, so these are
        // parsed from the package's own rate limit fields rather than reused
        // as-is. "4M" -> 4000 kbps; a bare number is assumed to already be kbps.
        rateLimitKbpsDown: parseRateToKbps(v.rate_limit_down),
        rateLimitKbpsUp: parseRateToKbps(v.rate_limit_up),
      });
    } else if (v.site_type === 'meraki') {
      if (!redeemContext.baseGrantUrl) {
        // This isn't a credentials/network problem - it means the customer's
        // device didn't arrive via a real Meraki splash redirect (no
        // base_grant_url in the query string), so there is nothing to grant
        // access to. Surfaced as its own reason so the portal page can show
        // something more useful than a generic network error.
        await releaseClaim();
        return { ok: false, reason: 'missing_meraki_grant_url' };
      }
      providerResult = await meraki.authorizeClient(site, {
        baseGrantUrl: redeemContext.baseGrantUrl,
        continueUrl: redeemContext.continueUrl,
        durationSeconds: v.duration_minutes * 60,
      });
    } else {
      await releaseClaim();
      return { ok: false, reason: 'unsupported_site_type' };
    }
  } catch (err) {
    // The router/controller call failed (offline, bad creds, timeout,
    // etc.) - release the claim rather than leaving a paid voucher stuck
    // in 'redeeming' forever, then let the caller's error handling take it
    // from here.
    await releaseClaim();
    throw err;
  }

  const expiresAt = new Date(Date.now() + v.duration_minutes * 60000);
  const finalize = await pool.query(
    `UPDATE vouchers SET status='active', redeemed_at=now(), expires_at=$1,
     client_mac=$2, provider_ref=$3 WHERE id=$4 AND status='redeeming' RETURNING id`,
    [expiresAt, redeemContext.clientMac || null, JSON.stringify(providerResult).slice(0, 250), voucherId]
  );

  if (!finalize.rows.length) {
    // Should not happen (only this call holds the claim), but if the row
    // vanished or changed underneath us, don't report success for a
    // voucher we can't confirm was actually finalized.
    return { ok: false, reason: 'redemption_conflict' };
  }

  return { ok: true, expiresAt, redirectUrl: providerResult.redirectUrl || null };
}

/**
 * Shared fulfillment for any paid voucher_orders row, regardless of how it
 * got confirmed - a gateway webhook/callback (automatic), or an owner
 * manually approving a MoMo-to-personal-number claim (routes/vouchers.js).
 * Generates the actual voucher, marks the order paid, and SMS's the code
 * to the customer if we have their phone.
 */
async function fulfillOrder(order) {
  const vouchers = await generateVouchers(order.tenant_id, {
    packageId: order.package_id,
    siteId: order.site_id,
    quantity: 1,
  });
  const voucher = vouchers[0];

  await pool.query(
    `UPDATE voucher_orders SET status='paid', voucher_id=$1, completed_at=now() WHERE id=$2`,
    [voucher.id, order.id]
  );

  if (order.customer_phone) {
    sms.sendSms(order.customer_phone, `Your YourNet WiFi voucher code: ${voucher.code}`).catch(() => {});
  }

  return voucher;
}

module.exports = { generateVouchers, redeemVoucher, randomCode, fulfillOrder };
