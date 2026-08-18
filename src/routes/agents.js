const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const voucherService = require('../services/voucherService');
const { checkLicenseLockout } = require('../utils/licenseGate');
const emailService = require('../integrations/emailService');

const router = express.Router();

// Agent self-generation cap - see routes/agents.js POST /me/vouchers/generate.
// A flat daily ceiling per agent, independent of how many separate calls
// they make it in.
const AGENT_DAILY_VOUCHER_CAP = 100;
// Wrong secret-question answers in a row before an agent is locked out of
// generating (and an admin alert is logged) - see POST /verify-secret.
const SECRET_QUESTION_MAX_ATTEMPTS = 3;
const SECRET_QUESTION_LOCKOUT_MINUTES = 15;

// Same brute-force posture as tenant/owner login (see routes/auth.js).
const agentLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const secretQuestionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

// Case/whitespace-insensitive so "Blue" and "blue " hash and compare the
// same way - a secret answer isn't a password, there's no reason to make
// an agent get capitalization exactly right under pressure at a kiosk.
function normalizeSecretAnswer(answer) {
  return String(answer || '').trim().toLowerCase();
}

// PUBLIC - agent self-service login. No requireAuth on this route: an agent
// doesn't have a token yet, that's the point.
//
// tenant_users.email is only unique PER TENANT (UNIQUE(tenant_id, email)),
// not globally, so in the rare case two different tenants both have an
// agent using the same email address, this can't tell them apart safely -
// it refuses rather than guessing which tenant to log into. In practice
// that's very unlikely (it's the agent's own personal email/phone-based
// address), and the fix if it ever happens is simply asking one of the
// affected agents to use a different email.
router.post('/login', agentLoginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const missingError = validate.required(req.body, ['email', 'password']);
  if (missingError) return res.status(400).json({ error: missingError });

  const { rows } = await pool.query(
    `SELECT * FROM tenant_users WHERE email=$1 AND role='agent'`,
    [email]
  );
  if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
  if (rows.length > 1) {
    // Ambiguous across tenants - see comment above. Fail closed rather
    // than picking one at random.
    return res.status(401).json({ error: 'This email is registered with more than one business - ask your manager for a login link instead.' });
  }

  const agent = rows[0];
  const valid = await bcrypt.compare(password, agent.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  // If the tenant (the ISP owner) hasn't paid their own YourNet Control
  // subscription and is past the grace period, agents can't log in either -
  // same rule, same grace window as the owner's own login (see
  // utils/licenseGate.js). Checked after the password so a wrong password
  // never leaks whether the account is in arrears.
  const { rows: tenantRows } = await pool.query('SELECT plan_expires_at FROM tenants WHERE id=$1', [agent.tenant_id]);
  const { locked, error: lockError } = checkLicenseLockout(tenantRows[0] || {});
  if (locked) return res.status(402).json({ error: lockError, locked: true });

  // Embed the agent's CURRENT token_version (see requireAuth in
  // middleware/auth.js) so this token is revoked the moment a subsequent
  // password reset bumps it, without touching still-valid tokens issued
  // before this login.
  const token = jwt.sign(
    { tenantId: agent.tenant_id, userId: agent.id, role: 'agent', tv: agent.token_version },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  res.json({ token, agent: { id: agent.id, name: agent.name, email: agent.email, commissionPct: Number(agent.commission_pct) } });
}));

router.use(requireAuth);

// Everything below requires a tenant-scoped token. Owner/manager tokens can
// use all of it; an agent token may ONLY reach the "my own record" routes
// further down (self-service summary/settlement), enforced per-route below
// rather than with a blanket router.use(requireNotAgent), since agents DO
// need read access to their own numbers.
function ownerOrManagerOnly(req, res, next) {
  if (req.role === 'agent') return res.status(403).json({ error: 'Not available to agent accounts.' });
  next();
}

router.post('/', ownerOrManagerOnly, asyncHandler(async (req, res) => {
  const { name, email, commissionPct, password, secretQuestion, secretAnswer } = req.body;
  if (!validate.isNonEmptyString(name, 100)) return res.status(400).json({ error: 'A valid agent name is required.' });
  if (!validate.isEmail(email)) return res.status(400).json({ error: 'A valid email is required so the agent can log in to their own dashboard.' });
  if (commissionPct !== undefined && (Number(commissionPct) < 0 || Number(commissionPct) > 100)) {
    return res.status(400).json({ error: 'Commission percentage must be between 0 and 100.' });
  }
  // The secret question gates the agent's OWN self-service voucher
  // generation (see POST /me/vouchers/generate) - required at creation so
  // no agent account exists that can generate without one. Set by the
  // owner, not the agent, same reasoning as the comment on the schema
  // columns: keeps it out of reach of a compromised agent login.
  if (!validate.isNonEmptyString(secretQuestion, 200)) return res.status(400).json({ error: 'A secret question is required - it protects the agent\u2019s own voucher-generation access.' });
  if (!validate.isNonEmptyString(secretAnswer, 200)) return res.status(400).json({ error: 'A secret answer is required.' });

  // If the owner doesn't set a password, generate a one-time temp password
  // and hand it back in the response (once, never stored in plaintext) so
  // it can be shared with the agent to log in and change it later.
  const tempPassword = password && password.length >= 8 ? null : crypto.randomBytes(6).toString('base64url');
  const passwordHash = await bcrypt.hash(password && password.length >= 8 ? password : tempPassword, 10);
  const secretAnswerHash = await bcrypt.hash(normalizeSecretAnswer(secretAnswer), 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO tenant_users (tenant_id, name, email, role, password_hash, commission_pct, secret_question, secret_answer_hash)
       VALUES ($1,$2,$3,'agent',$4,$5,$6,$7) RETURNING id, name, email, commission_pct, secret_question`,
      [req.tenantId, name, email, passwordHash, commissionPct !== undefined && commissionPct !== null && commissionPct !== '' ? commissionPct : 10, secretQuestion, secretAnswerHash]
    );

    // Fire-and-forget, same posture as the verification/reset emails in
    // auth.js - a slow or failed send shouldn't block the owner from
    // seeing the account was created (the response below still carries
    // the credentials as a fallback either way).
    const { rows: tenantRows } = await pool.query('SELECT business_name FROM tenants WHERE id=$1', [req.tenantId]);
    emailService.sendAgentWelcomeEmail(email, {
      agentName: name,
      businessName: tenantRows[0]?.business_name || 'your WiFi provider',
      password: password && password.length >= 8 ? password : tempPassword,
      isTempPassword: !(password && password.length >= 8),
      loginUrl: `${process.env.APP_BASE_URL}/agent.html`,
    }).catch(() => {});

    res.json({ ...rows[0], tempPassword: tempPassword || undefined });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An agent with that email already exists.' });
    throw err;
  }
}));

// Owner/manager edits an agent's name, commission, or secret question.
// secretAnswer is only re-hashed if a new one is actually provided -
// otherwise the existing one stays in place (there's no way to show it
// back for confirmation, same as password fields elsewhere in this app).
router.patch('/:id', ownerOrManagerOnly, asyncHandler(async (req, res) => {
  const { rows: existing } = await pool.query(`SELECT id FROM tenant_users WHERE id=$1 AND tenant_id=$2 AND role='agent'`, [req.params.id, req.tenantId]);
  if (!existing.length) return res.status(404).json({ error: 'Agent not found' });

  const { name, commissionPct, secretQuestion, secretAnswer } = req.body;
  if (name !== undefined && !validate.isNonEmptyString(name, 100)) return res.status(400).json({ error: 'A valid agent name is required.' });
  if (commissionPct !== undefined && (Number(commissionPct) < 0 || Number(commissionPct) > 100)) {
    return res.status(400).json({ error: 'Commission percentage must be between 0 and 100.' });
  }
  if (secretQuestion !== undefined && !validate.isNonEmptyString(secretQuestion, 200)) {
    return res.status(400).json({ error: 'Secret question can\u2019t be blank.' });
  }

  const secretAnswerHash = secretAnswer ? await bcrypt.hash(normalizeSecretAnswer(secretAnswer), 10) : null;

  const { rows } = await pool.query(
    `UPDATE tenant_users SET
       name = COALESCE($1, name),
       commission_pct = COALESCE($2, commission_pct),
       secret_question = COALESCE($3, secret_question),
       secret_answer_hash = COALESCE($4, secret_answer_hash)
     WHERE id=$5 AND tenant_id=$6 AND role='agent'
     RETURNING id, name, email, commission_pct, secret_question`,
    [name ?? null, commissionPct ?? null, secretQuestion ?? null, secretAnswerHash, req.params.id, req.tenantId]
  );
  res.json(rows[0]);
}));

router.get('/', ownerOrManagerOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, commission_pct, secret_question, created_at FROM tenant_users
     WHERE tenant_id=$1 AND role='agent' ORDER BY created_at DESC`,
    [req.tenantId]
  );
  res.json(rows.map((r) => ({ ...r, hasSecretQuestion: !!r.secret_question })));
}));

// An agent may reset their own password once logged in; an owner/manager
// may reset any agent's password (e.g. if the agent forgot it).
router.post('/:id/reset-password', asyncHandler(async (req, res) => {
  if (req.role === 'agent' && req.userId !== req.params.id) {
    return res.status(403).json({ error: 'You can only reset your own password.' });
  }
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  // token_version += 1 revokes every token this agent had out before this
  // reset (see requireAuth in middleware/auth.js) - matters most for the
  // owner/manager-triggered branch above ("agent forgot it" / "agent's
  // device was compromised"), where the whole point is to kick out
  // whoever's currently holding that agent's token.
  const { rows } = await pool.query(
    `UPDATE tenant_users SET password_hash=$1, token_version=token_version+1 WHERE id=$2 AND tenant_id=$3 AND role='agent' RETURNING id`,
    [passwordHash, req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ok: true });
}));

// Shared guard for the two self-service report routes below: owner/manager
// can view any agent's numbers, an agent can only view their own.
function canViewAgent(req, res, next) {
  if (req.role === 'agent' && req.userId !== req.params.id) {
    return res.status(403).json({ error: 'You can only view your own reports.' });
  }
  next();
}

// Per-agent sales summary: how many vouchers they've sold (redeemed = paid),
// how much revenue that represents, and what their commission comes to.
router.get('/:id/summary', canViewAgent, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE v.status != 'unused') AS vouchers_sold,
       COALESCE(SUM(p.price) FILTER (WHERE v.status != 'unused'), 0) AS revenue,
       tu.commission_pct
     FROM tenant_users tu
     LEFT JOIN vouchers v ON v.agent_id = tu.id
     LEFT JOIN packages p ON p.id = v.package_id
     WHERE tu.id = $1 AND tu.tenant_id = $2
     GROUP BY tu.commission_pct`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agent not found' });

  const row = rows[0];
  const revenue = Number(row.revenue);
  const commissionOwed = (revenue * Number(row.commission_pct)) / 100;
  res.json({
    vouchersSold: Number(row.vouchers_sold),
    revenue,
    commissionPct: Number(row.commission_pct),
    commissionOwed: Math.round(commissionOwed * 100) / 100,
  });
}));

// Daily settlement sheet: for a given agent and date, breaks down how many
// vouchers of each package they were given vs. actually sold (redeemed),
// the resulting sales total, commission owed, and cash to return. This is
// the reconciliation an agent hands over at the end of a shift.
router.get('/:id/settlement', canViewAgent, asyncHandler(async (req, res) => {
  const { date, batch } = req.query; // date: YYYY-MM-DD (matches created_at day)

  const { rows: agentRows } = await pool.query(
    `SELECT id, name, commission_pct FROM tenant_users WHERE id=$1 AND tenant_id=$2`,
    [req.params.id, req.tenantId]
  );
  if (!agentRows.length) return res.status(404).json({ error: 'Agent not found' });
  const agent = agentRows[0];

  const conditions = ['v.agent_id = $1'];
  const params = [req.params.id];
  if (date) {
    params.push(date);
    conditions.push(`v.created_at::date = $${params.length}`);
  }
  if (batch) {
    params.push(batch);
    conditions.push(`v.batch = $${params.length}`);
  }

  const { rows: lines } = await pool.query(
    `SELECT p.label, p.price,
       COUNT(*) AS given,
       COUNT(*) FILTER (WHERE v.status != 'unused') AS sold
     FROM vouchers v JOIN packages p ON p.id = v.package_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY p.label, p.price
     ORDER BY p.price ASC`,
    params
  );

  let totalSales = 0;
  const items = lines.map((l) => {
    const sales = Number(l.sold) * Number(l.price);
    totalSales += sales;
    return {
      label: l.label,
      price: Number(l.price),
      given: Number(l.given),
      sold: Number(l.sold),
      sales,
    };
  });

  const commissionOwed = Math.round(((totalSales * Number(agent.commission_pct)) / 100) * 100) / 100;
  const cashToReturn = Math.round((totalSales - commissionOwed) * 100) / 100;

  res.json({
    agent: { id: agent.id, name: agent.name, commissionPct: Number(agent.commission_pct) },
    date: date || null,
    batch: batch || null,
    items,
    totalSales,
    commissionOwed,
    cashToReturn,
  });
}));

// Agent self-service: verify the secret question for THIS login session.
// On success, re-issues a token carrying an `sq: true` claim (see
// middleware/auth.js req.secretVerified) with the same expiry as a normal
// login token - that's what "once per login session" means in practice:
// the agent answers once, then every request on that token is trusted
// until it naturally expires or they log in again.
router.post('/verify-secret', secretQuestionLimiter, asyncHandler(async (req, res) => {
  if (req.role !== 'agent') return res.status(403).json({ error: 'Not available to owner/manager accounts.' });

  const { answer } = req.body;
  const missingError = validate.required(req.body, ['answer']);
  if (missingError) return res.status(400).json({ error: missingError });

  const { rows } = await pool.query(
    `SELECT id, name, secret_question, secret_answer_hash, secret_failed_attempts, secret_locked_until, token_version
     FROM tenant_users WHERE id=$1 AND tenant_id=$2 AND role='agent'`,
    [req.userId, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agent not found' });
  const agent = rows[0];

  if (agent.secret_locked_until && new Date(agent.secret_locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(agent.secret_locked_until) - new Date()) / 60000);
    return res.status(423).json({ error: `Too many wrong answers. Try again in about ${minutesLeft} minute(s).` });
  }
  if (!agent.secret_question || !agent.secret_answer_hash) {
    return res.status(400).json({ error: 'No secret question is set on your account yet - ask your manager to add one.' });
  }

  const valid = await bcrypt.compare(normalizeSecretAnswer(answer), agent.secret_answer_hash);
  if (!valid) {
    const attempts = agent.secret_failed_attempts + 1;
    if (attempts >= SECRET_QUESTION_MAX_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + SECRET_QUESTION_LOCKOUT_MINUTES * 60000);
      await pool.query(
        `UPDATE tenant_users SET secret_failed_attempts=0, secret_locked_until=$1 WHERE id=$2`,
        [lockedUntil, agent.id]
      );
      await logAgentActivity(req.tenantId, agent.id, agent.name, 'secret_question_locked', {
        attempts, lockedUntil,
      });
      return res.status(423).json({ error: `Too many wrong answers. Locked for ${SECRET_QUESTION_LOCKOUT_MINUTES} minutes.` });
    }
    await pool.query(`UPDATE tenant_users SET secret_failed_attempts=$1 WHERE id=$2`, [attempts, agent.id]);
    await logAgentActivity(req.tenantId, agent.id, agent.name, 'secret_question_failed', { attempts });
    return res.status(401).json({ error: 'Incorrect answer.' });
  }

  await pool.query(`UPDATE tenant_users SET secret_failed_attempts=0, secret_locked_until=NULL WHERE id=$1`, [agent.id]);

  // Carries the same tv the agent's current session token has (this row
  // was just read fresh, so it's the live value) - re-issuing here must
  // NOT silently drop the version check, or an agent could dodge a pending
  // revocation just by answering their secret question again.
  const token = jwt.sign(
    { tenantId: req.tenantId, userId: agent.id, role: 'agent', sq: true, tv: agent.token_version },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  res.json({ token });
}));

// Active sites/packages for the agent's own generate form. Deliberately a
// separate, narrower endpoint rather than opening up GET /api/sites and
// GET /api/packages to agents (both sit behind requireNotAgent because
// they carry router credentials and full pricing-management fields this
// form has no business exposing) - just the id/name/label/price/duration
// an agent needs to fill out a generate request.
// Agent's own profile - specifically so the Generate tab can display the
// actual secret question text (never the answer) before asking for it.
router.get('/me', asyncHandler(async (req, res) => {
  if (req.role !== 'agent') return res.status(403).json({ error: 'Not available to owner/manager accounts.' });
  const { rows } = await pool.query(
    `SELECT id, name, email, commission_pct, secret_question FROM tenant_users WHERE id=$1 AND tenant_id=$2 AND role='agent'`,
    [req.userId, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agent not found' });
  res.json(rows[0]);
}));

// Same lookup as GET /api/vouchers/print-branding, duplicated here rather
// than shared because that route lives behind requireNotAgent (vouchers.js
// blocks agents from the whole router) - this is the agent-reachable
// equivalent for the Print tab.
router.get('/me/branding', asyncHandler(async (req, res) => {
  if (req.role !== 'agent') return res.status(403).json({ error: 'Not available to owner/manager accounts.' });
  const { rows: tenantRows } = await pool.query('SELECT business_name FROM tenants WHERE id=$1', [req.tenantId]);
  const { rows: logoRows } = await pool.query(
    `SELECT portal_logo_url FROM sites WHERE tenant_id=$1 AND portal_logo_url IS NOT NULL AND portal_logo_url != '' ORDER BY name ASC LIMIT 1`,
    [req.tenantId]
  );
  res.json({
    businessName: tenantRows[0]?.business_name || 'WiFi Vouchers',
    logoUrl: logoRows[0]?.portal_logo_url || null,
  });
}));

router.get('/me/options', asyncHandler(async (req, res) => {
  if (req.role !== 'agent') return res.status(403).json({ error: 'Not available to owner/manager accounts.' });
  const [{ rows: sites }, { rows: packages }] = await Promise.all([
    pool.query(`SELECT id, name FROM sites WHERE tenant_id=$1 AND active=true ORDER BY name ASC`, [req.tenantId]),
    pool.query(`SELECT id, label, price, duration_minutes FROM packages WHERE tenant_id=$1 AND active=true ORDER BY price ASC`, [req.tenantId]),
  ]);
  res.json({ sites, packages });
}));

// How much of the daily cap this agent has used, so the UI can show
// "62 of 100 today" and disable the form before a rejected request.
router.get('/me/vouchers/quota', asyncHandler(async (req, res) => {
  if (req.role !== 'agent') return res.status(403).json({ error: 'Not available to owner/manager accounts.' });
  const usedToday = await agentVouchersUsedToday(req.tenantId, req.userId);
  res.json({ usedToday, cap: AGENT_DAILY_VOUCHER_CAP, remaining: Math.max(0, AGENT_DAILY_VOUCHER_CAP - usedToday) });
}));

// Agent self-service voucher generation. Requires the secret-question
// session claim (req.secretVerified) - a stolen token alone gets an
// attacker read access to the agent's own records, but not generation,
// without also passing the secret question. Vouchers created here are
// valid immediately (no approval step) and tagged agent_id = req.userId,
// so they show up identically to admin-generated-for-this-agent vouchers
// in reports - the two are only distinguished by the activity log this
// writes, which admin-generated vouchers never do.
router.post('/me/vouchers/generate', asyncHandler(async (req, res) => {
  if (req.role !== 'agent') return res.status(403).json({ error: 'Not available to owner/manager accounts.' });
  if (!req.secretVerified) return res.status(403).json({ error: 'secret_question_required' });

  // Re-checked here, not just at login: an agent's token can live for
  // days, so a subscription that lapses mid-session shouldn't let
  // generation keep working until the token happens to expire.
  const { rows: tenantRows } = await pool.query('SELECT plan_expires_at FROM tenants WHERE id=$1', [req.tenantId]);
  const { locked, error: lockError } = checkLicenseLockout(tenantRows[0] || {});
  if (locked) return res.status(402).json({ error: lockError, locked: true });

  const { siteId, packageId, quantity, batch } = req.body;
  const missingError = validate.required(req.body, ['siteId', 'packageId', 'quantity']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isPositiveNumber(quantity)) return res.status(400).json({ error: 'Quantity must be a positive number.' });

  const [{ rows: siteRows }, { rows: pkgRows }] = await Promise.all([
    pool.query(`SELECT id FROM sites WHERE id=$1 AND tenant_id=$2 AND active=true`, [siteId, req.tenantId]),
    pool.query(`SELECT id FROM packages WHERE id=$1 AND tenant_id=$2 AND active=true`, [packageId, req.tenantId]),
  ]);
  if (!siteRows.length) return res.status(400).json({ error: 'That site isn\u2019t available.' });
  if (!pkgRows.length) return res.status(400).json({ error: 'That package isn\u2019t available.' });

  const usedToday = await agentVouchersUsedToday(req.tenantId, req.userId);
  const remaining = AGENT_DAILY_VOUCHER_CAP - usedToday;
  if (remaining <= 0) {
    return res.status(429).json({ error: `You\u2019ve reached today\u2019s limit of ${AGENT_DAILY_VOUCHER_CAP} vouchers. This resets after midnight.` });
  }
  const grantedQty = Math.min(Number(quantity), remaining);

  const { rows: agentRows } = await pool.query(`SELECT name FROM tenant_users WHERE id=$1`, [req.userId]);
  const agentName = agentRows[0]?.name || 'Agent';
  const resolvedBatch = validate.isNonEmptyString(batch, 60) ? batch : `AGENT-${agentName.replace(/\s+/g, '').slice(0, 12)}-${new Date().toISOString().slice(0, 10)}`;

  const vouchers = await voucherService.generateVouchers(req.tenantId, {
    siteId,
    packageId,
    quantity: grantedQty,
    agentId: req.userId,
    batch: resolvedBatch,
  });

  await logAgentActivity(req.tenantId, req.userId, agentName, 'voucher_batch', {
    quantity: grantedQty,
    requestedQuantity: Number(quantity),
    packageId, siteId, batch: resolvedBatch,
  });

  res.json({
    vouchers,
    quantity: grantedQty,
    truncated: grantedQty < Number(quantity),
    remainingToday: AGENT_DAILY_VOUCHER_CAP - usedToday - grantedQty,
  });
}));

// Agent's own vouchers (any source - admin-assigned or self-generated),
// for the Print tab specifically (My Records uses :id/summary and
// :id/settlement below, which stay reachable even during a lockout - see
// the license check here). Same shape as GET /api/vouchers so
// print.html-style rendering can be reused on the agent side.
router.get('/me/vouchers', asyncHandler(async (req, res) => {
  if (req.role !== 'agent') return res.status(403).json({ error: 'Not available to owner/manager accounts.' });

  // Printing (viewing/reprinting codes, which is what actually lets a
  // voucher be handed out) is blocked during a subscription lockout, same
  // as generation - but this route is Print-tab-only, so My Records stays
  // fully visible; an agent can always see their own past sales/commission
  // regardless of the owner's billing status.
  const { rows: tenantRows } = await pool.query('SELECT plan_expires_at FROM tenants WHERE id=$1', [req.tenantId]);
  const { locked, error: lockError } = checkLicenseLockout(tenantRows[0] || {});
  if (locked) return res.status(402).json({ error: lockError, locked: true });

  const { status, batch } = req.query;
  const clauses = ['v.tenant_id=$1', 'v.agent_id=$2'];
  const params = [req.tenantId, req.userId];
  if (status) { params.push(status); clauses.push(`v.status=$${params.length}`); }
  if (batch) { params.push(batch); clauses.push(`v.batch=$${params.length}`); }

  const { rows } = await pool.query(
    `SELECT v.*, p.label AS package_label, p.price AS package_price, p.duration_minutes AS package_duration_minutes,
            t.business_name
     FROM vouchers v
     JOIN packages p ON p.id = v.package_id
     JOIN tenants t ON t.id = v.tenant_id
     WHERE ${clauses.join(' AND ')} ORDER BY v.created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
}));

router.get('/me/vouchers/:id/qrcode', asyncHandler(async (req, res) => {
  if (req.role !== 'agent') return res.status(403).json({ error: 'Not available to owner/manager accounts.' });

  const { rows: tenantRows } = await pool.query('SELECT plan_expires_at FROM tenants WHERE id=$1', [req.tenantId]);
  const { locked } = checkLicenseLockout(tenantRows[0] || {});
  if (locked) return res.status(402).end();

  const { rows } = await pool.query('SELECT code, site_id FROM vouchers WHERE id=$1 AND tenant_id=$2 AND agent_id=$3', [
    req.params.id, req.tenantId, req.userId,
  ]);
  if (!rows.length) return res.status(404).end();
  // Same portal-URL-with-code payload as the owner-side qrcode route in
  // routes/vouchers.js - see the comment there for why.
  const base = process.env.APP_BASE_URL;
  const payload = base
    ? `${base}/p/${rows[0].site_id}?code=${encodeURIComponent(rows[0].code)}`
    : rows[0].code;
  const png = await QRCode.toBuffer(payload, { width: 240, margin: 1 });
  res.type('png').send(png);
}));

// Admin-facing activity feed: every agent-self-generated batch plus every
// failed/locked secret-question attempt, across all agents (or one, via
// ?agentId=) - powers the dashboard's "Activity Log" tab so an owner sees
// this happening rather than only discovering it later in the numbers.
router.get('/activity', ownerOrManagerOnly, asyncHandler(async (req, res) => {
  const { agentId, limit } = req.query;
  const clauses = ['tenant_id=$1'];
  const params = [req.tenantId];
  if (agentId) { params.push(agentId); clauses.push(`agent_id=$${params.length}`); }
  params.push(Math.min(Number(limit) || 100, 300));

  const { rows } = await pool.query(
    `SELECT id, agent_id, agent_name_snapshot, type, detail, created_at
     FROM agent_activity_log WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

async function agentVouchersUsedToday(tenantId, agentId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM vouchers WHERE tenant_id=$1 AND agent_id=$2 AND created_at::date = CURRENT_DATE`,
    [tenantId, agentId]
  );
  return rows[0].n;
}

async function logAgentActivity(tenantId, agentId, agentName, type, detail) {
  await pool.query(
    `INSERT INTO agent_activity_log (tenant_id, agent_id, agent_name_snapshot, type, detail) VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, agentId, agentName, type, detail ? JSON.stringify(detail) : null]
  );
}

module.exports = router;
