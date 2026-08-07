// Shared validation helpers. Each function returns null if valid, or a
// short human-readable error string if not - so a route can do:
//   const err = validate.required(req.body, ['email', 'password']);
//   if (err) return res.status(400).json({ error: err });

function required(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) return `Missing required field(s): ${missing.join(', ')}`;
  return null;
}

function isEmail(value) {
  // Deliberately simple - good enough to catch obvious typos ("no @ sign
  // at all") without the false-negative risk of an overly strict regex
  // rejecting a real, unusual-but-valid address.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function isPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function isNonEmptyString(value, maxLength = 500) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

module.exports = { required, isEmail, isPositiveNumber, isNonEmptyString };
