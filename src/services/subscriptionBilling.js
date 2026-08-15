const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const paystackGateway = require('../integrations/gateways/paystackGateway');
const brevo = require('../integrations/brevo');
const logger = require('../utils/logger');

const LICENSE_REACTIVATION_PRICE_GHS = Number(process.env.LICENSE_REACTIVATION_PRICE_GHS || 50);
const LICENSE_GRACE_DAYS = Number(process.env.LICENSE_GRACE_DAYS || 2);

// Runs on a timer from server.js. Finds every tenant whose next monthly
// charge is due, auto-charges their saved Paystack authorization, and
// either extends their subscription 30 more days or marks it past_due.
//
// FIX (previously broken): `FOR UPDATE SKIP LOCKED` only holds its lock for
// the lifetime of the surrounding transaction. The old code ran the SELECT
// as a single client.query() with no explicit BEGIN, so under node-postgres/
// Postgres autocommit the row lock was released the instant that SELECT
// returned - before a single tenant was actually charged. Two overlapping
// passes (the exact "slow previous run" scenario this comment used to
// describe) could both select the same due tenant and both charge their
// card. Fixed by keeping each tenant's SELECT FOR UPDATE, charge, and
// status update inside ONE transaction on ONE held connection, so the lock
// is genuinely in effect while chargeTenant is talking to Paystack. A
// second overlapping pass then really does get SKIP LOCKED'd on that row
// instead of sailing through.
async function runMonthlyBilling() {
  const idClient = await pool.connect();
  let dueIds;
  try {
    // Cheap, lock-free pass just to find candidate ids. The real lock is
    // taken per-tenant below, immediately before charging.
    const result = await idClient.query(
      `SELECT id FROM tenants
       WHERE subscription_status = 'active'
         AND billing_provider = 'paystack'
         AND billing_authorization IS NOT NULL
         AND next_billing_at IS NOT NULL
         AND next_billing_at <= now()`
    );
    dueIds = result.rows.map((r) => r.id);
  } finally {
    idClient.release();
  }

  let attempted = 0;
  for (const tenantId of dueIds) {
    const outcome = await chargeTenantById(tenantId).catch((err) => {
      logger.error('Monthly billing charge threw', { tenant_id: tenantId, message: err.message });
      return null;
    });
    if (outcome !== null) attempted++;
  }

  return { attempted };
}

// Holds the row lock for the ENTIRE charge attempt - from picking the
// tenant up through recording the outcome - on a single dedicated
// connection/transaction, so a concurrent pass hitting the same tenant
// genuinely gets skipped by SKIP LOCKED instead of racing in behind an
// already-released lock. Returns null (not false) if this pass didn't get
// the row at all (locked by another in-flight pass, or no longer due),
// distinct from `false` meaning "we got it and the charge was declined" -
// callers use that to decide whether to count the attempt.
async function chargeTenantById(tenantId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM tenants
       WHERE id = $1
         AND subscription_status = 'active'
         AND billing_provider = 'paystack'
         AND billing_authorization IS NOT NULL
         AND next_billing_at IS NOT NULL
         AND next_billing_at <= now()
       FOR UPDATE SKIP LOCKED`,
      [tenantId]
    );

    if (!rows.length) {
      // Either another pass is holding this row right now, or it was
      // already billed (next_billing_at moved) since the id was picked up
      // above - either way, not this call's job.
      await client.query('ROLLBACK');
      return null;
    }

    const tenant = rows[0];
    const reference = `RENEW-${uuidv4().slice(0, 12)}`;

    let result;
    try {
      result = await paystackGateway.chargeAuthorization({
        secretKey: process.env.PAYSTACK_SECRET_KEY,
        email: tenant.owner_email,
        amountGHS: LICENSE_REACTIVATION_PRICE_GHS,
        authorizationCode: tenant.billing_authorization,
        reference,
      });
    } catch (err) {
      // Paystack call itself failed (network, bad authorization, etc) - treat
      // the same as a declined charge rather than crashing the billing pass.
      result = { success: false };
    }

    if (result.success) {
      const nextBillingAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await client.query(
        `UPDATE tenants SET plan_expires_at=$1, next_billing_at=$1, subscription_status='active' WHERE id=$2`,
        [nextBillingAt, tenant.id]
      );
      await client.query(
        `INSERT INTO subscription_payments (tenant_id, amount, currency, provider, provider_reference, status, kind)
         VALUES ($1,$2,'GHS','paystack',$3,'paid','renewal')`,
        [tenant.id, LICENSE_REACTIVATION_PRICE_GHS, reference]
      );
      await client.query('COMMIT');
      return true;
    }

    // Charge failed - don't touch plan_expires_at. It's still the source of
    // truth for the login-time grace-period lockout in routes/auth.js, so
    // the tenant gets LICENSE_GRACE_DAYS from whenever their PREVIOUS period
    // actually ends, not from this failed attempt. Push next_billing_at out a
    // day so we retry daily instead of hammering the card every few hours.
    await client.query(
      `UPDATE tenants SET subscription_status='past_due', next_billing_at = now() + interval '1 day' WHERE id=$1`,
      [tenant.id]
    );
    await client.query(
      `INSERT INTO subscription_payments (tenant_id, amount, currency, provider, provider_reference, status, kind)
       VALUES ($1,$2,'GHS','paystack',$3,'failed','renewal')`,
      [tenant.id, LICENSE_REACTIVATION_PRICE_GHS, reference]
    );
    await client.query('COMMIT');
    // Fire-and-forget, outside the transaction - a slow/failed email send
    // shouldn't hold the row lock or roll back the billing outcome.
    brevo.sendRenewalFailedEmail(tenant.owner_email, LICENSE_GRACE_DAYS).catch(() => {});
    return false;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Kept for direct/manual invocation (e.g. an admin "retry this tenant now"
// action) - same locked, transactional charge path as the scheduled pass.
async function chargeTenant(tenant) {
  const outcome = await chargeTenantById(tenant.id);
  return outcome === true;
}

module.exports = { runMonthlyBilling, chargeTenant };
