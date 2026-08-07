const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.tenantId = payload.tenantId;
    req.userId = payload.userId;
    req.role = payload.role;
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
    const payload = jwt.verify(token, process.env.OWNER_JWT_SECRET);
    if (payload.role !== 'owner') throw new Error('wrong role');
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Not authorized' });
  }
}

module.exports = { requireAuth, requireOwnerAuth };
