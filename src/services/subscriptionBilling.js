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
// `FOR UPDATE SKIP LOCKED` matters here even though this runs inside a
// single process today: if the interval ever fires again before a slow
// previous run finishes (or this moves to multiple worker processes later),
// two passes could otherwise both grab the same tenant and charge them
// twice. Locked/in-flight rows are just skipped and picked up next pass.
async function runMonthlyBilling() {
  const client = await pool.connect();
  let tenants;
  try {
    const result = await client.query(
      `SELECT * FROM tenants
       WHERE subscription_status = 'active'
         AND billing_provider = 'paystack'
         AND billing_authorization IS NOT NULL
         AND next_billing_at IS NOT NULL
         AND next_billing_at <= now()
       FOR UPDATE SKIP LOCKED`
    );
    tenants = result.rows;
  } finally {
    client.release();
  }

  for (const tenant of tenants) {
    await chargeTenant(tenant).catch((err) => {
      logger.error('Monthly billing charge threw', { tenant_id: tenant.id, message: err.message });
    });
  }

  return { attempted: tenants.length };
}

async function chargeTenant(tenant) {
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
    await pool.query(
      `UPDATE tenants SET plan_expires_at=$1, next_billing_at=$1, subscription_status='active' WHERE id=$2`,
      [nextBillingAt, tenant.id]
    );
    await pool.query(
      `INSERT INTO subscription_payments (tenant_id, amount, currency, provider, provider_reference, status, kind)
       VALUES ($1,$2,'GHS','paystack',$3,'paid','renewal')`,
      [tenant.id, LICENSE_REACTIVATION_PRICE_GHS, reference]
    );
    return true;
  }

  // Charge failed - don't touch plan_expires_at. It's still the source of
  // truth for the login-time grace-period lockout in routes/auth.js, so
  // the tenant gets LICENSE_GRACE_DAYS from whenever their PREVIOUS period
  // actually ends, not from this failed attempt. Push next_billing_at out a
  // day so we retry daily instead of hammering the card every few hours.
  await pool.query(
    `UPDATE tenants SET subscription_status='past_due', next_billing_at = now() + interval '1 day' WHERE id=$1`,
    [tenant.id]
  );
  await pool.query(
    `INSERT INTO subscription_payments (tenant_id, amount, currency, provider, provider_reference, status, kind)
     VALUES ($1,$2,'GHS','paystack',$3,'failed','renewal')`,
    [tenant.id, LICENSE_REACTIVATION_PRICE_GHS, reference]
  );
  brevo.sendRenewalFailedEmail(tenant.owner_email, LICENSE_GRACE_DAYS).catch(() => {});
  return false;
}

module.exports = { runMonthlyBilling, chargeTenant };
