// PPPoE subscriber billing - recurring ISP-style accounts on top of a
// tenant's own Mikrotik router, distinct from the one-time hotspot vouchers
// in routes/vouchers.js. Every query here filters on tenant_id (never trusts
// a client-supplied id alone), every router-facing input is validated
// against a strict pattern before it reaches integrations/mikrotik.js, and
// PPP account passwords are never stored or returned in plaintext except
// once, at the moment they're generated or reset.
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const mikrotik = require('../integrations/mikrotik');
const { encrypt, decrypt } = require('../utils/credentialCrypto');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');

const router = express.Router();
router.use(requireAuth);

// ---- helpers ----------------------------------------------------------

// Loads a site scoped to this tenant AND confirms it's a Mikrotik site
// (PPPoE, as built, only speaks to /ppp/secret on Mikrotik - Omada/UniFi/
// Meraki sites can't accept a PPPoE subscriber through this endpoint).
async function loadTenantMikrotikSite(tenantId, siteId) {
  const { rows } = await pool.query('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2', [siteId, tenantId]);
  if (!rows.length) return { error: 'Site not found.', status: 404 };
  if (rows[0].type !== 'mikrotik') return { error: 'PPPoE is only supported on Mikrotik sites.', status: 400 };
  return { site: { ...rows[0], mk_password_decrypted: decrypt(rows[0].mk_password_encrypted) } };
}

async function loadTenantPlan(tenantId, planId) {
  const { rows } = await pool.query('SELECT * FROM pppoe_plans WHERE id=$1 AND tenant_id=$2', [planId, tenantId]);
  return rows[0] || null;
}

async function loadTenantSubscriber(tenantId, subscriberId) {
  const { rows } = await pool.query('SELECT * FROM pppoe_subscribers WHERE id=$1 AND tenant_id=$2', [subscriberId, tenantId]);
  return rows[0] || null;
}

// 20-char random password from an unambiguous alphabet (no 0/O/1/l/I) -
// generated server-side with crypto.randomBytes, never accepted verbatim
// from the client as the "default" path. Rejection sampling avoids modulo
// bias against the 62-ish-character alphabet.
function generateSecurePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const max = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < 20) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < max) out += alphabet[byte % alphabet.length];
  }
  return out;
}

// Strips fields that should never leave the server in a list/detail
// response - the encrypted blob is meaningless to a client anyway, but
// omitting it outright (rather than trusting every call site to remember
// not to send it) is the safer default.
function toPublicSubscriber(row) {
  const { ppp_password_encrypted, ...rest } = row;
  return { ...rest, hasPassword: !!ppp_password_encrypted };
}

// Postgres unique_violation
function isUniqueViolation(err) {
  return err && err.code === '23505';
}

// ---- plans --------------------------------------------------------------

router.post('/plans', asyncHandler(async (req, res) => {
  const { label, price, billingPeriodDays, rateLimit, routerProfile } = req.body;
  const missingError = validate.required(req.body, ['label', 'price']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isNonEmptyString(label, 100)) return res.status(400).json({ error: 'Label must be text, up to 100 characters.' });
  if (!validate.isPositiveNumber(price)) return res.status(400).json({ error: 'Price must be a positive number.' });
  if (billingPeriodDays !== undefined && !validate.isPositiveNumber(billingPeriodDays)) {
    return res.status(400).json({ error: 'Billing period must be a positive number of days.' });
  }
  if (rateLimit && !validate.isSafeRateLimit(rateLimit)) {
    return res.status(400).json({ error: "rateLimit must look like '5M/10M' (down/up)." });
  }
  if (routerProfile && !validate.isSafeRouterIdentifier(routerProfile)) {
    return res.status(400).json({ error: 'routerProfile contains characters not allowed in a RouterOS profile name.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO pppoe_plans (tenant_id, label, price, billing_period_days, rate_limit, router_profile)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.tenantId, label, price, billingPeriodDays || 30, rateLimit || null, routerProfile || null]
  );
  res.status(201).json(rows[0]);
}));

router.get('/plans', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM pppoe_plans WHERE tenant_id=$1 ORDER BY price ASC`,
    [req.tenantId]
  );
  res.json(rows);
}));

router.patch('/plans/:id', asyncHandler(async (req, res) => {
  const plan = await loadTenantPlan(req.tenantId, req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });

  const { label, price, billingPeriodDays, rateLimit, routerProfile, active } = req.body;
  if (label !== undefined && !validate.isNonEmptyString(label, 100)) return res.status(400).json({ error: 'Label must be text, up to 100 characters.' });
  if (price !== undefined && !validate.isPositiveNumber(price)) return res.status(400).json({ error: 'Price must be a positive number.' });
  if (billingPeriodDays !== undefined && !validate.isPositiveNumber(billingPeriodDays)) return res.status(400).json({ error: 'Billing period must be a positive number of days.' });
  if (rateLimit !== undefined && rateLimit !== null && !validate.isSafeRateLimit(rateLimit)) return res.status(400).json({ error: "rateLimit must look like '5M/10M' (down/up)." });
  if (routerProfile !== undefined && routerProfile !== null && !validate.isSafeRouterIdentifier(routerProfile)) return res.status(400).json({ error: 'routerProfile contains characters not allowed in a RouterOS profile name.' });

  const { rows } = await pool.query(
    `UPDATE pppoe_plans SET
       label = COALESCE($1, label),
       price = COALESCE($2, price),
       billing_period_days = COALESCE($3, billing_period_days),
       rate_limit = CASE WHEN $4::boolean THEN $5 ELSE rate_limit END,
       router_profile = CASE WHEN $6::boolean THEN $7 ELSE router_profile END,
       active = COALESCE($8, active)
     WHERE id=$9 AND tenant_id=$10 RETURNING *`,
    [
      label ?? null, price ?? null, billingPeriodDays ?? null,
      rateLimit !== undefined, rateLimit ?? null,
      routerProfile !== undefined, routerProfile ?? null,
      active ?? null, req.params.id, req.tenantId,
    ]
  );
  res.json(rows[0]);
}));

// ---- subscribers ----------------------------------------------------------

router.post('/subscribers', asyncHandler(async (req, res) => {
  const { siteId, planId, fullName, phone, email, username, password, startDate } = req.body;
  const missingError = validate.required(req.body, ['siteId', 'planId', 'fullName', 'username']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isNonEmptyString(fullName, 150)) return res.status(400).json({ error: 'fullName must be text, up to 150 characters.' });
  if (!validate.isSafeUsername(username)) return res.status(400).json({ error: 'username must be 3-64 characters: letters, numbers, dot, underscore, or hyphen only.' });
  if (phone && !validate.isNonEmptyString(phone, 30)) return res.status(400).json({ error: 'phone must be text, up to 30 characters.' });
  if (email && !validate.isEmail(email)) return res.status(400).json({ error: 'email is not a valid address.' });
  if (password !== undefined && !validate.isStrongEnoughPassword(password)) {
    return res.status(400).json({ error: 'password must be 8-64 characters with no control characters. Leave it out to auto-generate a strong one.' });
  }

  const plan = await loadTenantPlan(req.tenantId, planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  if (!plan.active) return res.status(400).json({ error: 'This plan is no longer active.' });

  const siteResult = await loadTenantMikrotikSite(req.tenantId, siteId);
  if (siteResult.error) return res.status(siteResult.status).json({ error: siteResult.error });
  const { site } = siteResult;

  const finalPassword = password || generateSecurePassword();
  const start = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : new Date().toISOString().slice(0, 10);

  // Router first, DB second: if the router rejects the account (duplicate
  // name on-router, unreachable, bad profile), nothing gets written to the
  // database at all.
  try {
    await mikrotik.createPppoeSecret(site, {
      username,
      password: finalPassword,
      profile: plan.router_profile,
      rateLimit: plan.rate_limit,
      comment: `tenant:${req.tenantId}`,
    });
  } catch (err) {
    logger.error('PPPoE secret creation failed', { site_id: siteId, message: err.message });
    return res.status(502).json({ error: 'Could not create the account on the router: ' + err.message });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO pppoe_subscribers
         (tenant_id, site_id, plan_id, full_name, phone, email, username, ppp_password_encrypted, start_date, next_due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ($9::date + ($10 || ' days')::interval))
       RETURNING *`,
      [req.tenantId, siteId, planId, fullName, phone || null, email || null, username, encrypt(finalPassword), start, plan.billing_period_days]
    );
    // Password is returned exactly once, here - it is never retrievable
    // again (only reset, which generates a brand new one and kicks the
    // active session so the old one stops working immediately).
    res.status(201).json({ ...toPublicSubscriber(rows[0]), password: finalPassword });
  } catch (err) {
    // DB insert failed after the router secret was already created (most
    // likely a duplicate username on this site) - remove the orphaned
    // router account rather than leaving an account that exists on the
    // router but nowhere in the system that's supposed to manage it.
    await mikrotik.removePppoeSecret(site, username).catch((cleanupErr) =>
      logger.error('Failed to roll back orphaned PPPoE secret', { site_id: siteId, username, message: cleanupErr.message })
    );
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'That username is already in use on this site.' });
    throw err;
  }
}));

router.get('/subscribers', asyncHandler(async (req, res) => {
  const { status, siteId } = req.query;
  const clauses = ['tenant_id=$1'];
  const params = [req.tenantId];
  if (status) { params.push(status); clauses.push(`status=$${params.length}`); }
  if (siteId) { params.push(siteId); clauses.push(`site_id=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM pppoe_subscribers WHERE ${clauses.join(' AND ')} ORDER BY next_due_date ASC LIMIT 500`,
    params
  );
  res.json(rows.map(toPublicSubscriber));
}));

router.get('/subscribers/:id', asyncHandler(async (req, res) => {
  const sub = await loadTenantSubscriber(req.tenantId, req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
  res.json(toPublicSubscriber(sub));
}));

router.get('/subscribers/:id/session', asyncHandler(async (req, res) => {
  const sub = await loadTenantSubscriber(req.tenantId, req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
  const siteResult = await loadTenantMikrotikSite(req.tenantId, sub.site_id);
  if (siteResult.error) return res.status(siteResult.status).json({ error: siteResult.error });
  try {
    const status = await mikrotik.getPppoeSessionStatus(siteResult.site, sub.username);
    res.json(status);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the router: ' + err.message });
  }
}));

router.patch('/subscribers/:id/suspend', asyncHandler(async (req, res) => {
  const sub = await loadTenantSubscriber(req.tenantId, req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
  const siteResult = await loadTenantMikrotikSite(req.tenantId, sub.site_id);
  if (siteResult.error) return res.status(siteResult.status).json({ error: siteResult.error });

  try {
    await mikrotik.setPppoeSecretEnabled(siteResult.site, sub.username, false);
  } catch (err) {
    return res.status(502).json({ error: 'Could not suspend the account on the router: ' + err.message });
  }
  const { rows } = await pool.query(
    `UPDATE pppoe_subscribers SET status='suspended', updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, req.tenantId]
  );
  res.json(toPublicSubscriber(rows[0]));
}));

router.patch('/subscribers/:id/reactivate', asyncHandler(async (req, res) => {
  const sub = await loadTenantSubscriber(req.tenantId, req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
  if (sub.status === 'cancelled') return res.status(400).json({ error: 'This subscriber was cancelled - create a new subscriber instead of reactivating.' });
  const siteResult = await loadTenantMikrotikSite(req.tenantId, sub.site_id);
  if (siteResult.error) return res.status(siteResult.status).json({ error: siteResult.error });

  try {
    await mikrotik.setPppoeSecretEnabled(siteResult.site, sub.username, true);
  } catch (err) {
    return res.status(502).json({ error: 'Could not reactivate the account on the router: ' + err.message });
  }
  const { rows } = await pool.query(
    `UPDATE pppoe_subscribers SET status='active', updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, req.tenantId]
  );
  res.json(toPublicSubscriber(rows[0]));
}));

router.post('/subscribers/:id/reset-password', asyncHandler(async (req, res) => {
  const sub = await loadTenantSubscriber(req.tenantId, req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
  const siteResult = await loadTenantMikrotikSite(req.tenantId, sub.site_id);
  if (siteResult.error) return res.status(siteResult.status).json({ error: siteResult.error });

  const newPassword = generateSecurePassword();
  try {
    await mikrotik.changePppoeSecretPassword(siteResult.site, sub.username, newPassword);
  } catch (err) {
    return res.status(502).json({ error: 'Could not reset the password on the router: ' + err.message });
  }
  await pool.query(
    `UPDATE pppoe_subscribers SET ppp_password_encrypted=$1, updated_at=now() WHERE id=$2 AND tenant_id=$3`,
    [encrypt(newPassword), req.params.id, req.tenantId]
  );
  // Same one-time-only rule as at creation.
  res.json({ id: sub.id, username: sub.username, password: newPassword });
}));

// Cancel (not a hard delete) - the router account is removed immediately so
// access actually stops, but the row stays for billing/audit history, the
// same way voided vouchers aren't deleted outright elsewhere in this app.
router.delete('/subscribers/:id', asyncHandler(async (req, res) => {
  const sub = await loadTenantSubscriber(req.tenantId, req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
  const siteResult = await loadTenantMikrotikSite(req.tenantId, sub.site_id);
  if (siteResult.error) return res.status(siteResult.status).json({ error: siteResult.error });

  try {
    await mikrotik.removePppoeSecret(siteResult.site, sub.username);
  } catch (err) {
    return res.status(502).json({ error: 'Could not remove the account from the router: ' + err.message });
  }
  const { rows } = await pool.query(
    `UPDATE pppoe_subscribers SET status='cancelled', updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, req.tenantId]
  );
  res.json(toPublicSubscriber(rows[0]));
}));

router.post('/subscribers/:id/record-payment', asyncHandler(async (req, res) => {
  const sub = await loadTenantSubscriber(req.tenantId, req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
  if (sub.status === 'cancelled') return res.status(400).json({ error: 'This subscriber was cancelled - create a new subscriber instead.' });

  const { amount, method, reference, periodDays } = req.body;
  const missingError = validate.required(req.body, ['amount']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isPositiveNumber(amount)) return res.status(400).json({ error: 'amount must be a positive number.' });
  if (method !== undefined && !['cash', 'momo', 'bank', 'other'].includes(method)) {
    return res.status(400).json({ error: "method must be one of 'cash', 'momo', 'bank', or 'other'." });
  }
  if (reference !== undefined && !validate.isNonEmptyString(reference, 100)) {
    return res.status(400).json({ error: 'reference must be text, up to 100 characters.' });
  }
  if (periodDays !== undefined && !validate.isPositiveNumber(periodDays)) {
    return res.status(400).json({ error: 'periodDays must be a positive number.' });
  }

  const plan = await loadTenantPlan(req.tenantId, sub.plan_id);
  const days = periodDays || plan?.billing_period_days || 30;

  // If the subscriber is caught up (or ahead), a renewal extends from their
  // CURRENT due date, so the customer keeps whatever paid time they had left
  // rather than losing it. If they're overdue, extend from today instead -
  // renewing an overdue account shouldn't backdate the new period into the
  // time they were already lapsed.
  const { rows } = await pool.query(
    `UPDATE pppoe_subscribers SET
       next_due_date = GREATEST(next_due_date, CURRENT_DATE) + ($1 || ' days')::interval,
       last_payment_at = now(),
       updated_at = now()
     WHERE id=$2 AND tenant_id=$3
     RETURNING *`,
    [days, req.params.id, req.tenantId]
  );
  const updated = rows[0];

  await pool.query(
    `INSERT INTO pppoe_payments (tenant_id, subscriber_id, amount, provider, provider_reference, status, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5,'paid',CURRENT_DATE,$6)`,
    [req.tenantId, req.params.id, amount, method || 'manual', reference || null, updated.next_due_date]
  );

  // A suspended/overdue account that just paid should reconnect right
  // away, not wait for the next billing pass to notice.
  if (sub.status === 'suspended' || sub.status === 'overdue') {
    const siteResult = await loadTenantMikrotikSite(req.tenantId, sub.site_id);
    if (!siteResult.error) {
      try {
        await mikrotik.setPppoeSecretEnabled(siteResult.site, sub.username, true);
      } catch (err) {
        logger.error('Could not re-enable PPPoE secret after payment', { subscriber_id: sub.id, message: err.message });
      }
    }
    const { rows: reactivated } = await pool.query(
      `UPDATE pppoe_subscribers SET status='active', updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, req.tenantId]
    );
    return res.json(toPublicSubscriber(reactivated[0]));
  }

  res.json(toPublicSubscriber(updated));
}));

router.get('/subscribers/:id/payments', asyncHandler(async (req, res) => {
  const sub = await loadTenantSubscriber(req.tenantId, req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
  const { rows } = await pool.query(
    `SELECT * FROM pppoe_payments WHERE subscriber_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 200`,
    [req.params.id, req.tenantId]
  );
  res.json(rows);
}));

module.exports = router;
