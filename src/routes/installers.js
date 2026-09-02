const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const mikrotik = require('../integrations/mikrotik');
const { encrypt, decrypt } = require('../utils/credentialCrypto');
const { buildMikrotikRsc } = require('../utils/mikrotikConfigGen');
const { checkLicenseLockout } = require('../utils/licenseGate');

const router = express.Router();

// Same brute-force posture as agent/tenant login (see routes/agents.js,
// routes/auth.js).
const installerLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const installerRegisterLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// ---------------------------------------------------------------------
// PUBLIC - self-registration via an owner-issued invite code (see
// POST /api/sites/installer-invites in routes/sites.js for how the owner
// generates one). No requireAuth on this route: an installer doesn't have
// a tenant_id, let alone a token, until this succeeds - the code IS what
// proves which tenant they belong to.
router.post('/register', installerRegisterLimiter, asyncHandler(async (req, res) => {
  const { code, name, email, password } = req.body || {};
  const missingError = validate.required(req.body || {}, ['code', 'name', 'email', 'password']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isNonEmptyString(name, 100)) return res.status(400).json({ error: 'A valid name is required.' });
  if (!validate.isEmail(email)) return res.status(400).json({ error: 'A valid email is required so you can log back in.' });
  if (!validate.isStrongEnoughPassword(password)) return res.status(400).json({ error: 'Password must be 8-64 characters.' });

  const { rows: codeRows } = await pool.query(
    `SELECT * FROM installer_invite_codes WHERE code=$1 AND active=true`,
    [String(code).trim()]
  );
  if (!codeRows.length) return res.status(400).json({ error: 'That invite code is invalid or has been revoked - ask your manager for a current one.' });
  const invite = codeRows[0];

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO tenant_users (tenant_id, name, email, role, password_hash)
       VALUES ($1,$2,$3,'installer',$4) RETURNING id, name, email, token_version`,
      [invite.tenant_id, name, email, passwordHash]
    );
    await pool.query(`UPDATE installer_invite_codes SET uses_count = uses_count + 1 WHERE id=$1`, [invite.id]);

    const installer = rows[0];
    const token = jwt.sign(
      { tenantId: invite.tenant_id, userId: installer.id, role: 'installer', tv: installer.token_version },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    res.json({ token, installer: { id: installer.id, name: installer.name, email: installer.email } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That email is already registered for this business.' });
    throw err;
  }
}));

// PUBLIC - installer self-service login. Same ambiguous-email fail-closed
// behavior as routes/agents.js POST /login, for the same reason (email is
// only unique PER TENANT).
router.post('/login', installerLoginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const missingError = validate.required(req.body || {}, ['email', 'password']);
  if (missingError) return res.status(400).json({ error: missingError });

  const { rows } = await pool.query(`SELECT * FROM tenant_users WHERE email=$1 AND role='installer'`, [email]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
  if (rows.length > 1) {
    return res.status(401).json({ error: 'This email is registered with more than one business - ask your manager for a login link instead.' });
  }
  const installer = rows[0];
  const valid = await bcrypt.compare(password, installer.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const { rows: tenantRows } = await pool.query('SELECT plan_expires_at FROM tenants WHERE id=$1', [installer.tenant_id]);
  const { locked, error: lockError } = checkLicenseLockout(tenantRows[0] || {});
  if (locked) return res.status(402).json({ error: lockError, locked: true });

  const token = jwt.sign(
    { tenantId: installer.tenant_id, userId: installer.id, role: 'installer', tv: installer.token_version },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  res.json({ token, installer: { id: installer.id, name: installer.name, email: installer.email } });
}));

// Everything below requires a tenant-scoped token AND that token must
// actually be an installer's - an owner/manager or agent token gets
// bounced here the same way an installer token gets bounced out of
// sites.js/packages.js/etc (see requireNotAgent in middleware/auth.js).
router.use(requireAuth);
function requireInstaller(req, res, next) {
  if (req.role !== 'installer') return res.status(403).json({ error: 'Installer accounts only.' });
  next();
}
router.use(requireInstaller);

// Loads a site ONLY if it's both in this tenant AND assigned to THIS
// installer (via site_installers) - the scoping boundary every route
// below relies on. Returns null (caller 404s) otherwise, rather than
// distinguishing "doesn't exist" from "not yours" - an installer has no
// legitimate reason to learn the difference.
async function loadAssignedSite(req) {
  const { rows } = await pool.query(
    `SELECT s.*, si.status AS install_status
     FROM sites s
     JOIN site_installers si ON si.site_id = s.id
     WHERE s.id=$1 AND s.tenant_id=$2 AND si.installer_id=$3`,
    [req.params.id, req.tenantId, req.userId]
  );
  return rows[0] || null;
}

function decryptedMk(site) {
  return { ...site, mk_password_decrypted: decrypt(site.mk_password_encrypted) };
}

router.get('/me', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, created_at FROM tenant_users WHERE id=$1', [req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Installer not found' });
  res.json(rows[0]);
}));

// Every site this installer has started, most-recently-touched first -
// powers the "pick a job or start a new one" landing screen on
// public/installer.html.
router.get('/me/sites', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.status AS connection_status, s.last_checked_at, si.status AS install_status, si.updated_at
     FROM sites s
     JOIN site_installers si ON si.site_id = s.id
     WHERE s.tenant_id=$1 AND si.installer_id=$2
     ORDER BY si.updated_at DESC`,
    [req.tenantId, req.userId]
  );
  res.json(rows);
}));

router.get('/me/sites/:id', asyncHandler(async (req, res) => {
  const site = await loadAssignedSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  // Never hand back the encrypted blob itself - same posture as the
  // owner-side GET /api/sites list, just at the single-record level.
  const { mk_password_encrypted, radius_secret_encrypted, ...safe } = site;
  res.json(safe);
}));

// Deliberately MikroTik-only, per the scope this role was built for - an
// installer picks packages/network shape, not controller type. If a
// tenant runs Omada/UniFi/Meraki, that setup still goes through the owner
// admin panel as before.
router.post('/me/sites', asyncHandler(async (req, res) => {
  const { name, host, port, username, password, hotspotProfile, useTls } = req.body || {};
  const missingError = validate.required(req.body || {}, ['name']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isNonEmptyString(name, 100)) return res.status(400).json({ error: 'A valid site name is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: siteRows } = await client.query(
      `INSERT INTO sites (tenant_id, name, type, mk_host, mk_api_port, mk_username, mk_password_encrypted, mk_hotspot_profile, mk_use_tls)
       VALUES ($1,$2,'mikrotik',$3,$4,$5,$6,$7,$8) RETURNING id, name, type, status`,
      [req.tenantId, name, host, port || (useTls ? 8729 : 8728), username, encrypt(password), hotspotProfile, !!useTls]
    );
    const site = siteRows[0];
    await client.query(
      `INSERT INTO site_installers (tenant_id, site_id, installer_id, status) VALUES ($1,$2,$3,'in_progress')`,
      [req.tenantId, site.id, req.userId]
    );
    await client.query('COMMIT');
    res.json({ ...site, install_status: 'in_progress' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Per the design Q&A: installers can always edit their assigned sites,
// even after marking one 'live' - this isn't gated on install_status.
router.patch('/me/sites/:id', asyncHandler(async (req, res) => {
  const site = await loadAssignedSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const { name, host, port, username, password, hotspotProfile, useTls } = req.body || {};
  const credentialsChanged = !!(host || username || password || hotspotProfile || typeof useTls === 'boolean' || port);

  const { rows } = await pool.query(
    `UPDATE sites SET
       name = COALESCE($1, name),
       mk_host = COALESCE($2, mk_host),
       mk_api_port = COALESCE($3, mk_api_port),
       mk_username = COALESCE($4, mk_username),
       mk_password_encrypted = COALESCE($5, mk_password_encrypted),
       mk_hotspot_profile = COALESCE($6, mk_hotspot_profile),
       mk_use_tls = COALESCE($7, mk_use_tls),
       status = CASE WHEN $9 THEN 'unconfigured' ELSE status END
     WHERE id=$8
     RETURNING id, name, type, status`,
    [name, host, port, username, password ? encrypt(password) : null, hotspotProfile,
      typeof useTls === 'boolean' ? useTls : null, site.id, credentialsChanged]
  );
  res.json(rows[0]);
}));

// Same live pre-save profile fetch the owner's site-creation form gets
// (see POST /api/sites/mikrotik/hotspot-profiles) - lets the installer's
// "Hotspot profile" field be a real dropdown too, using whatever
// credentials are currently typed into the wizard, before the site is
// even saved.
router.post('/me/mikrotik/hotspot-profiles', asyncHandler(async (req, res) => {
  const { host, port, username, password, useTls } = req.body || {};
  const missingError = validate.required(req.body || {}, ['host', 'username', 'password']);
  if (missingError) return res.status(400).json({ error: missingError });
  try {
    const profiles = await mikrotik.listHotspotProfiles({
      mk_host: host,
      mk_api_port: port || undefined,
      mk_username: username,
      mk_password_decrypted: password,
      mk_use_tls: !!useTls,
    });
    res.json({ profiles });
  } catch (err) {
    res.status(400).json({ error: 'Could not connect to the router: ' + err.message });
  }
}));

// Real connectivity test against the actual router - same
// {online, error} shape mikrotik.ping() returns everywhere else in the
// app (this is the field-name mismatch that was caught and fixed).
router.post('/me/sites/:id/test', asyncHandler(async (req, res) => {
  const site = await loadAssignedSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const result = await mikrotik.ping(decryptedMk(site));
  await pool.query('UPDATE sites SET status=$1, last_checked_at=now() WHERE id=$2', [
    result.online ? 'online' : 'error', site.id,
  ]);
  res.json(result);
}));

// Same generator the owner wizard uses (src/utils/mikrotikConfigGen.js) -
// an installer-built config and an owner-built config for the same site
// can never drift apart, because there's only one code path.
router.post('/me/sites/:id/rsc-config', asyncHandler(async (req, res) => {
  const site = await loadAssignedSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const { rows: packages } = await pool.query(
    `SELECT * FROM packages WHERE tenant_id=$1 AND active=true ORDER BY price ASC`,
    [req.tenantId]
  );

  let built;
  try {
    built = buildMikrotikRsc(site, packages, req.body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  res.type('text/plain').attachment(`${built.slug}-mikrotik-config.rsc`).send(built.rsc);
}));

// --- RADIUS mode - mirrors POST/GET /api/sites/:id/radius-mode and
// /radius-config in routes/sites.js exactly, just re-scoped to an
// assigned site instead of requireNotAgent's owner/manager check. Two
// copies exist (not pulled into a shared module like the .rsc builder)
// because this one is deliberately mikrotik-only by construction - every
// site an installer can reach already IS type='mikrotik' - while the
// owner-side version still has to guard against being called on a
// non-mikrotik site.
router.get('/me/sites/:id/radius-config', asyncHandler(async (req, res) => {
  const site = await loadAssignedSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  res.json({
    mode: site.mk_auth_mode,
    nasIdentifier: site.radius_nas_identifier,
    secret: site.mk_auth_mode === 'radius' ? decrypt(site.radius_secret_encrypted) : null,
    authPort: parseInt(process.env.RADIUS_AUTH_PORT || '1812', 10),
    acctPort: parseInt(process.env.RADIUS_ACCT_PORT || '1813', 10),
    serverHost: process.env.RADIUS_SERVER_HOST || null,
  });
}));

router.post('/me/sites/:id/radius-mode', asyncHandler(async (req, res) => {
  const site = await loadAssignedSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const { enable } = req.body || {};
  if (typeof enable !== 'boolean') return res.status(400).json({ error: 'enable (boolean) is required.' });

  if (!enable) {
    await pool.query(
      `UPDATE sites SET mk_auth_mode='api', radius_secret_encrypted=NULL, radius_nas_identifier=NULL WHERE id=$1`,
      [site.id]
    );
    return res.json({ ok: true, mode: 'api' });
  }

  const nasIdentifier = 'yn-' + crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  await pool.query(
    `UPDATE sites SET mk_auth_mode='radius', radius_secret_encrypted=$1, radius_nas_identifier=$2 WHERE id=$3`,
    [encrypt(secret), nasIdentifier, site.id]
  );
  res.json({
    ok: true,
    mode: 'radius',
    nasIdentifier,
    secret,
    authPort: parseInt(process.env.RADIUS_AUTH_PORT || '1812', 10),
    acctPort: parseInt(process.env.RADIUS_ACCT_PORT || '1813', 10),
    serverHost: process.env.RADIUS_SERVER_HOST || null,
  });
}));

// Advances (or reopens) the wizard status shown on the owner's
// Installations list - does not gate anything else (see the PATCH note
// above about editing after 'live').
router.post('/me/sites/:id/status', asyncHandler(async (req, res) => {
  const site = await loadAssignedSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const { status } = req.body || {};
  if (!['in_progress', 'testing', 'live'].includes(status)) {
    return res.status(400).json({ error: "status must be 'in_progress', 'testing', or 'live'." });
  }
  await pool.query(`UPDATE site_installers SET status=$1, updated_at=now() WHERE site_id=$2`, [status, site.id]);
  res.json({ ok: true, status });
}));

module.exports = router;
