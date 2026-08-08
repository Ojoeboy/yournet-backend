const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db/pool');
const emailService = require('../integrations/emailService');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');

const router = express.Router();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

router.post('/signup', asyncHandler(async (req, res) => {
  const { businessName, email, phone, password, currency, licenseKey } = req.body;
  const missingError = validate.required(req.body, ['businessName', 'email', 'password', 'licenseKey']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

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

    const passwordHash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const { rows } = await client.query(
      `INSERT INTO tenants (business_name, owner_email, owner_phone, password_hash, currency, plan, plan_expires_at, verify_token_hash)
       VALUES ($1,$2,$3,$4,$5,'licensed', NULL, $6)
       RETURNING id, business_name, owner_email, plan, plan_expires_at`,
      [businessName, email, phone || null, passwordHash, currency || 'GHS', hashToken(verifyToken)]
    );
    const tenant = rows[0];

    await client.query(
      `UPDATE license_keys SET status='activated', tenant_id=$1, activated_at=now() WHERE id=$2`,
      [tenant.id, keyResult.rows[0].id]
    );

    await client.query('COMMIT');

    // Not blocking signup on this - see emailService.js for why this is
    // currently a console log, not a real email, until a provider is wired in.
    emailService.sendVerificationEmail(
      tenant.owner_email,
      `${process.env.APP_BASE_URL}/api/auth/verify-email?token=${verifyToken}`
    ).catch((err) => {
      logger.error('Verification email failed to send', { email: tenant.owner_email, error: err.message });
    });

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

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const missingError = validate.required(req.body, ['email', 'password']);
  if (missingError) return res.status(400).json({ error: missingError });

  const { rows } = await pool.query('SELECT * FROM tenants WHERE owner_email=$1', [email]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

  const tenant = rows[0];
  const valid = await bcrypt.compare(password, tenant.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ tenantId: tenant.id, role: 'owner' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
  res.json({
    token,
    tenant: { id: tenant.id, businessName: tenant.business_name, email: tenant.owner_email, plan: tenant.plan },
  });
}));

router.get('/verify-email', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token.');

  const { rows } = await pool.query(
    `UPDATE tenants SET email_verified=true, verify_token_hash=NULL
     WHERE verify_token_hash=$1 RETURNING id`,
    [hashToken(token)]
  );
  if (!rows.length) return res.status(400).send('Invalid or already-used verification link.');
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
    ).catch((err) => {
      // Never let this reach the response (would leak whether the email
      // exists), but DO log it - otherwise a real delivery failure (bad
      // API key, Resend rejecting an unverified sender, etc.) is invisible
      // even to us, and looks identical to "email just didn't arrive."
      logger.error('Password reset email failed to send', { email, error: err.message });
    });
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