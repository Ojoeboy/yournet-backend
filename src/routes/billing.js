const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const billing = require('../integrations/billing');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Authenticated: tenant clicks "Pay" in the app, we ask Paystack to start
// a transaction and hand back a URL for the browser to redirect to.
router.post('/initialize', requireAuth, asyncHandler(async (req, res) => {
  const { planCode } = req.body;
  const plan = billing.PLANS[planCode];
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });

  const { rows } = await pool.query('SELECT owner_email FROM tenants WHERE id=$1', [req.tenantId]);
  if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });

  try {
    const result = await billing.initializePayment({
      email: rows[0].owner_email,
      amountGHS: plan.priceGHS,
      tenantId: req.tenantId,
      planCode,
    });

    await pool.query(
      `INSERT INTO subscription_payments (tenant_id, amount, currency, paystack_reference, status)
       VALUES ($1,$2,'GHS',$3,'pending')`,
      [req.tenantId, plan.priceGHS, result.reference]
    );

    res.json({ authorizationUrl: result.authorization_url, reference: result.reference });
  } catch (err) {
    // Most likely cause during setup: placeholder Paystack keys still in .env
    res.status(502).json({ error: 'Could not start payment. Check Paystack API keys are configured.', detail: err.message });
  }
}));

// Public: Paystack redirects the customer's browser here after they pay
// (success or cancel). We verify server-side rather than trusting the
// redirect alone, since a URL can be faked but a verified API call can't.
router.get('/callback', asyncHandler(async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).send('Missing payment reference.');

  try {
    const result = await billing.verifyPayment(reference);
    const success = result.status === 'success';
    const { tenantId, planCode } = result.metadata || {};
    const plan = billing.PLANS[planCode];

    await pool.query(
      `UPDATE subscription_payments SET status=$1 WHERE paystack_reference=$2`,
      [success ? 'success' : 'failed', reference]
    );

    if (success && tenantId && plan) {
      // Two fixes combined here:
      // (1) COLLISION FIX: next_billing_at is now set to the SAME value as
      //     plan_expires_at. Previously this update only touched
      //     plan_expires_at, so the /license auto-renewal cron (which
      //     watches next_billing_at) never learned a Starter/Pro payment
      //     happened here - it would charge on its own old schedule and
      //     reset plan_expires_at back down, silently erasing whatever
      //     Pro/Starter time was just paid for.
      // (2) EARLY-PAYMENT FIX: extends from GREATEST(now(), current
      //     plan_expires_at) instead of always from now(). Previously,
      //     paying a few days before expiry actually LOST those remaining
      //     days (new expiry was always "today + plan.days", even if today
      //     was before the old expiry). Now an early payment always adds
      //     the full plan.days on top of whatever time is left.
      await pool.query(
        `UPDATE tenants
         SET plan=$1,
             plan_expires_at = GREATEST(now(), COALESCE(plan_expires_at, now())) + ($2 || ' days')::interval,
             next_billing_at = GREATEST(now(), COALESCE(plan_expires_at, now())) + ($2 || ' days')::interval,
             plan_started_at = now()
         WHERE id=$3`,
        [planCode, plan.days, tenantId]
      );
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d1a1e;color:#e8f0f1">
        <h1>${success ? '✅ Payment successful' : '❌ Payment failed'}</h1>
        <p>${success ? 'Your plan has been updated.' : 'No changes were made to your account.'}</p>
        <p><a href="/admin" style="color:#2ec4b6">Return to dashboard</a></p>
      </body></html>
    `);
  } catch (err) {
    res.status(502).send('Could not verify payment: ' + err.message);
  }
}));

module.exports = router;
