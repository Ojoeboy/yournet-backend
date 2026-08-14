const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    // algorithms pinned explicitly - defense in depth against algorithm-
    // confusion style attacks, even though jsonwebtoken 9.x already
    // rejects an unsigned/`none` token by default.
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
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
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
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

// Agents now get a real tenant-scoped JWT (see POST /api/agents/login), but
// that token must NOT be able to reach owner/manager surfaces - router
// credentials, packages, gateways, dashboard stats, pppoe billing, etc.
// requireAuth alone only proves "this token belongs to tenant X"; this
// adds "and it isn't an agent token" for routes that should stay
// owner/manager-only. Apply as router.use(requireAuth, requireNotAgent)
// on any route file agents shouldn't touch.
function requireNotAgent(req, res, next) {
  if (req.role === 'agent') {
    return res.status(403).json({ error: 'Not available to agent accounts.' });
  }
  next();
}

module.exports = { requireAuth, requireOwnerAuth, requireNotAgent };
