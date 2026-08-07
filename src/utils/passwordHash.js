const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const stored_ = Buffer.from(hash, 'hex');
  // timingSafeEqual requires equal-length buffers - guard against mismatched
  // lengths throwing instead of just returning false.
  if (check.length !== stored_.length) return false;
  return crypto.timingSafeEqual(check, stored_);
}

module.exports = { hashPassword, verifyPassword };
