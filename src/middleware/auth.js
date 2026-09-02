const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Revocation check backing token_version (see db/schema.sql). A JWT's
// cryptographic validity only proves it was signed with our secret and
// hasn't expired - it says nothing about whether the account owner has
// since reset their password specifically BECAUSE that token (or the
// password protecting it) leaked. Every tenant/agent JWT embeds the
// token_version that was current at issuance (see routes/auth.js and
// routes/agents.js login/reset-password); this compares that embedded
// version against the live DB value and rejects the token if a reset has
// bumped it since. Agents are rows in tenant_users and versioned by their
// own userId; the tenant owner/manager token has no separate row of its
// own yet (there's a single password_hash on tenants itself), so it's
// versioned off tenants.token_version, keyed by tenantId instead.
async function currentTokenVersion(role, tenantId, userId) {
  if (role === 'agent' || role === 'installer') {
    const { rows } = await pool.query('SELECT token_version FROM tenant_users WHERE id=$1', [userId]);
    return rows[0]?.token_version;
  }
  const { rows } = await pool.query('SELECT token_version FROM tenants WHERE id=$1', [tenantId]);
  return rows[0]?.token_version;
}

async function requireAuthAsync(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  let payload;
  try {
    // algorithms pinned explicitly - defense in depth against algorithm-
    // confusion style attacks, even though jsonwebtoken 9.x already
    // rejects an unsigned/`none` token by default.
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Revocation check - see currentTokenVersion above. A missing row (tenant
  // or agent deleted since the token was issued) fails closed the same as
  // a version mismatch.
  const liveVersion = await currentTokenVersion(payload.role, payload.tenantId, payload.userId);
  if (liveVersion === undefined || Number(payload.tv || 0) !== Number(liveVersion)) {
    return res.status(401).json({ error: 'This session is no longer valid - please log in again.' });
  }

  req.tenantId = payload.tenantId;
  req.userId = payload.userId;
  req.role = payload.role;
  // Set only on an agent token AFTER a successful POST /api/agents/verify-secret
  // for this login session (see routes/agents.js) - never present on a
  // freshly-issued login token. Routes that require it (agent self-service
  // voucher generation) check req.secretVerified explicitly; nothing else
  // relies on it.
  req.secretVerified = payload.sq === true;
  next();
}

// requireAuth is now async internally (it queries the DB for the
// revocation check above), but it's wired up all over the app as bare
// `router.use(requireAuth, ...)` / `router.post(path, requireAuth, ...)` -
// never through asyncHandler. Express 4 does NOT catch a rejected promise
// from an async middleware on its own (same gap asyncHandler.js exists to
// close for route handlers); left as `async function requireAuth` directly,
// a DB hiccup here would become an unhandled rejection and hang the
// request instead of producing a clean error response. This thin
// non-async wrapper is the same fix asyncHandler applies, without having
// to touch every call site across the route files.
function requireAuth(req, res, next) {
  requireAuthAsync(req, res, next).catch(next);
}

// Separate from tenant auth entirely - verified against OWNER_JWT_SECRET,
// which only your own /owner/login endpoint ever signs with. A stolen
// tenant token cannot pass this check, and a stolen owner token cannot
// access any tenant's data (there's no tenantId on this payload at all).
function requireOwnerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authorized' });

  try {
    const payload = jwt.verify(token, process.env.OWNER_JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.role !== 'owner') throw new Error('wrong role');
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Not authorized' });
  }
}

// Agents and installers both get a real tenant-scoped JWT (see
// POST /api/agents/login and POST /api/installers/login), but neither
// token should be able to reach owner/manager surfaces - router
// credentials, packages, gateways, dashboard stats, pppoe billing, etc.
// requireAuth alone only proves "this token belongs to tenant X"; this
// adds "and it isn't an agent or installer token" for routes that should
// stay owner/manager-only. Apply as router.use(requireAuth, requireNotAgent)
// on any route file agents/installers shouldn't touch.
//
// Installers get their OWN separate route file (routes/installers.js)
// instead of a scoped exception carved into this list - it does not
// import requireNotAgent, so an installer token can never reach any route
// file below just by virtue of not being 'agent'. Every route file that
// currently guards with requireNotAgent stays exactly as blocked to
// installers as it already is to agents.
function requireNotAgent(req, res, next) {
  if (req.role === 'agent' || req.role === 'installer') {
    return res.status(403).json({ error: 'Not available to agent or installer accounts.' });
  }
  next();
}

module.exports = { requireAuth, requireOwnerAuth, requireNotAgent };
