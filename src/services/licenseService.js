const crypto = require('crypto');
const pool = require('../db/pool');

/**
 * Generates a real, hard-to-guess license key. Format: YNET-XXXX-XXXX-XXXX
 * Deliberately longer/more random than voucher codes since this protects
 * an actual paid purchase, not a few hours of WiFi.
 *
 * Uses crypto.randomInt (CSPRNG) rather than Math.random(), which is not
 * designed to resist prediction and shouldn't be used for anything that
 * protects a real purchase.
 */
function generateKeyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `YNET-${group()}-${group()}-${group()}`;
}

/**
 * Create a license key record. Called either after a verified Paystack
 * payment, or manually by the platform owner after confirming a direct
 * MoMo transfer.
 */
async function issueKey({ amount, paymentMethod, paymentReference, buyerEmail, buyerPhone, notes, keyType, billingProvider, billingAuthorization }) {
  const keyCode = generateKeyCode();
  const { rows } = await pool.query(
    `INSERT INTO license_keys (key_code, amount, payment_method, payment_reference, buyer_email, buyer_phone, notes, key_type, billing_provider, billing_authorization)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [keyCode, amount, paymentMethod, paymentReference || null, buyerEmail || null, buyerPhone || null, notes || null, keyType || 'signup', billingProvider || null, billingAuthorization || null]
  );
  return rows[0];
}

/**
 * Consume a key at tenant signup. This is an atomic check-and-mark so two
 * simultaneous signups can't both succeed with the same key (the row lock
 * from the UPDATE...WHERE status='unused' handles that race condition).
 */
async function consumeKey(keyCode, tenantId) {
  const { rows } = await pool.query(
    `UPDATE license_keys SET status='activated', tenant_id=$1, activated_at=now()
     WHERE key_code=$2 AND status='unused' RETURNING *`,
    [tenantId, keyCode]
  );
  return rows[0] || null; // null means key was invalid, already used, or revoked
}

module.exports = { generateKeyCode, issueKey, consumeKey };
