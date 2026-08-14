const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const emailService = require('../integrations/emailService');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { checkLicenseLockout, LICENSE_GRACE_DAYS } = require('../utils/licenseGate');

const router = express.Router();

// Tenant login is as realistic a brute-force target as owner login (it's
// the same kind of "email + password" guessable credential), but it was
// only ever covered by the general apiLimiter shared with ordinary
// dashboard traffic (120 req/min). Give it its own strict limiter, matching
// the one already used for owner login in server.js.
const tenantLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

router.post('/signup', asyncHandler(async (req, res) => {
  const { businessName, email, phone, password, currency, licenseKey } = req.body;
  const missingError = validate.required(req.body, ['businessName', 'email', 'password', 'licenseKey']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  // owner_email is *meant* to be UNIQUE at the DB level (see schema.sql),
  // but that constraint was only ever declared inside CREATE TABLE IF NOT
  // EXISTS, so it silently never applied to a database where tenants
  // already existed - same bug class as the sites.active fix. Check here
  // so signups fail with a clear message even before the schema fix behind
  // it is deployed, and duplicate accounts stop being possible today.
  const existing = await pool.query('SELECT id FROM tenants WHERE owner_email=$1', [email]);
  if (existing.rows.length) {
    return res.status(400).json({ error: 'An account with that email already exists. Try logging in instead.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the key row so two simultaneous signups can't both succeed with
    // the same key - this is the actual anti-sharing mechanism.
    const keyResult = await client.query(
      `SELECT * FROM license_keys WHERE key_code=$1 FOR UPDATE`,
      [licenseKey.trim().toUpperCase()]
    );
    if (!keyResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That license key was not found.' });
    }
    if (keyResult.rows[0].status !== 'unused') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That license key has already been used or is no longer valid.' });
    }
    // A 'reactivation' key belongs to an EXISTING account (see
    // /api/auth/reactivate below) - it can't be used to create a new one.
    if (keyResult.rows[0].key_type === 'reactivation') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That key is a reactivation key for an existing account - use it from the login page instead.' });
    }

    const licenseKeyRow = keyResult.rows[0];
    const passwordHash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const nextBillingAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const subscriptionStatus = licenseKeyRow.billing_authorization ? 'active' : 'manual';
    const { rows } = await client.query(
      `INSERT INTO tenants (business_name, owner_email, owner_phone, password_hash, currency, plan, plan_expires_at,
                             verify_token_hash, verify_token_expires_at, subscription_status, billing_provider, billing_authorization, next_billing_at, plan_started_at)
       VALUES ($1,$2,$3,$4,$5,'licensed',$6,$7,now() + interval '24 hours',$8,$9,$10,$6,now())
       RETURNING id, business_name, owner_email, plan, plan_expires_at, currency`,
      [businessName, email, phone || null, passwordHash, currency || 'GHS', nextBillingAt,
       hashToken(verifyToken), subscriptionStatus, licenseKeyRow.billing_provider || null, licenseKeyRow.billing_authorization || null]
    );
    const tenant = rows[0];

    await client.query(
      `UPDATE license_keys SET status='activated', tenant_id=$1, activated_at=now() WHERE id=$2`,
      [tenant.id, licenseKeyRow.id]
    );

    await client.query('COMMIT');

    // Not blocking signup on this - see emailService.js for why this is
    // currently a console log, not a real email, until a provider is wired in.
    emailService.sendVerificationEmail(
      tenant.owner_email,
      `${process.env.APP_BASE_URL}/api/auth/verify-email?token=${verifyToken}`
    ).catch(() => {});

    const token = jwt.sign({ tenantId: tenant.id, role: 'owner' }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
    res.json({ token, tenant });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}));

router.post('/login', tenantLoginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const missingError = validate.required(req.body, ['email', 'password']);
  if (missingError) return res.status(400).json({ error: missingError });

  const { rows } = await pool.query('SELECT * FROM tenants WHERE owner_email=$1', [email]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

  const tenant = rows[0];
  const valid = await bcrypt.compare(password, tenant.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  // Monthly license lockout - deliberately checked AFTER the password is
  // confirmed correct, and blocks the dashboard even so. See
  // utils/licenseGate.js - the same check is applied to agent login/
  // generation so a lapsed subscription locks everyone out consistently.
  const { locked, error, graceDaysRemaining } = checkLicenseLockout(tenant);
  if (locked) return res.status(402).json({ error, locked: true });

  const token = jwt.sign({ tenantId: tenant.id, role: 'owner' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
  res.json({
    token,
    tenant: { id: tenant.id, businessName: tenant.business_name, email: tenant.owner_email, plan: tenant.plan, currency: tenant.currency },
    // Present only while in the grace window - lets the dashboard show
    // "renew within N day(s)" instead of the tenant finding out by being
    // locked out with no warning.
    graceDaysRemaining,
  });
}));

// PUBLIC: redeem a 'reactivation' key (owner-issued, e.g. for migrating an
// old one-time-license account, or an offline renewal) against an EXISTING
// account. Distinct from /signup, which only accepts 'signup' keys and
// creates a brand-new tenant.
//
// Requires the account password, same as /login - previously email + a
// valid unused reactivation key was enough on its own, which meant anyone
// who intercepted or guessed a distributed key (SMS, email, printed slip)
// could reactivate/change billing state on someone else's account without
// proving they own it. This ties the reactivation to the same credential
// that already gates the dashboard.
router.post('/reactivate', tenantLoginLimiter, asyncHandler(async (req, res) => {
  const { email, password, licenseKey } = req.body;
  const missingError = validate.required(req.body, ['email', 'password', 'licenseKey']);
  if (missingError) return res.status(400).json({ error: missingError });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenantResult = await client.query('SELECT id, password_hash FROM tenants WHERE owner_email=$1', [email]);
    if (!tenantResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No account found with that email.' });
    }
    const validPassword = await bcrypt.compare(password, tenantResult.rows[0].password_hash);
    if (!validPassword) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const keyResult = await client.query(`SELECT * FROM license_keys WHERE key_code=$1 FOR UPDATE`, [licenseKey.trim().toUpperCase()]);
    if (!keyResult.rows.length || keyResult.rows[0].status !== 'unused' || keyResult.rows[0].key_type !== 'reactivation') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That reactivation key was not found, already used, or is not a reactivation key.' });
    }
    const tenantId = tenantResult.rows[0].id;
    const key = keyResult.rows[0];
    const nextBillingAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const subscriptionStatus = key.billing_authorization ? 'active' : 'manual';

    await client.query(
      `UPDATE tenants SET plan='licensed', plan_expires_at=$1, next_billing_at=$1,
              subscription_status=$2, billing_provider=$3, billing_authorization=$4, plan_started_at=now()
       WHERE id=$5`,
      [nextBillingAt, subscriptionStatus, key.billing_provider || null, key.billing_authorization || null, tenantId]
    );
    await client.query(`UPDATE license_keys SET status='activated', tenant_id=$1, activated_at=now() WHERE id=$2`, [tenantId, key.id]);
    await client.query('COMMIT');
    res.json({ ok: true, planExpiresAt: nextBillingAt });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}));

router.get('/verify-email', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token.');

  const { rows } = await pool.query(
    `UPDATE tenants SET email_verified=true, verify_token_hash=NULL, verify_token_expires_at=NULL
     WHERE verify_token_hash=$1 AND verify_token_expires_at > now() RETURNING id`,
    [hashToken(token)]
  );
  if (!rows.length) return res.status(400).send('Invalid, expired, or already-used verification link.');
  res.send('Email verified. You can close this page.');
}));

// Deliberately responds the same way whether or not the email exists, so
// this endpoint can't be used to check which emails have accounts.
router.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = req.body;
  const missingError = validate.required(req.body, ['email']);
  if (missingError) return res.status(400).json({ error: missingError });

  const { rows } = await pool.query('SELECT id FROM tenants WHERE owner_email=$1', [email]);
  if (rows.length) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `UPDATE tenants SET reset_token_hash=$1, reset_token_expires_at=now() + interval '30 minutes' WHERE id=$2`,
      [hashToken(resetToken), rows[0].id]
    );
    emailService.sendPasswordResetEmail(
      email,
      `${process.env.APP_BASE_URL}/reset-password?token=${resetToken}`
    ).catch(() => {});
  }

  res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  const missingError = validate.required(req.body, ['token', 'newPassword']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const { rows } = await pool.query(
    `SELECT id FROM tenants WHERE reset_token_hash=$1 AND reset_token_expires_at > now()`,
    [hashToken(token)]
  );
  if (!rows.length) return res.status(400).json({ error: 'That reset link is invalid or has expired.' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await pool.query(
    `UPDATE tenants SET password_hash=$1, reset_token_hash=NULL, reset_token_expires_at=NULL WHERE id=$2`,
    [passwordHash, rows[0].id]
  );
  res.json({ ok: true, message: 'Password updated - you can log in now.' });
}));

module.exports = router;
