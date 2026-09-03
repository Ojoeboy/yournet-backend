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

// PPPoE username -> becomes a real /ppp/secret "name" on the router, and is
// also what a customer's router will send in plaintext PPP negotiation.
// Deliberately restrictive (conventional login-name charset only) since
// there's no legitimate reason for it to contain anything else, and this
// closes off any weirdness from special characters reaching the router API.
function isSafeUsername(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{3,64}$/.test(value);
}

// General guard for any value that ends up embedded in a RouterOS API call
// (passwords, comments, profile names) - blocks control characters
// (including NUL, which can truncate a string mid-buffer) without
// restricting the character set otherwise, since e.g. a password is
// allowed to contain punctuation.
function hasNoControlChars(value) {
  return typeof value === 'string' && !/[\x00-\x1F\x7F]/.test(value);
}

function isStrongEnoughPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 64 && hasNoControlChars(value);
}

// RouterOS rate-limit string, e.g. "5M/10M" or "512k/2M" - up-rate/down-rate
// only, validated against a strict pattern before it's ever concatenated
// into a router command.
function isSafeRateLimit(value) {
  return typeof value === 'string' && /^[0-9]{1,5}[kKmMgG]?\/[0-9]{1,5}[kKmMgG]?$/.test(value);
}

// RouterOS object name (e.g. an existing /ppp/profile to reuse) - same
// conventional charset as isSafeUsername, slightly more permissive length.
function isSafeRouterIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.\- ]{1,64}$/.test(value);
}

module.exports = {
  required,
  isEmail,
  isPositiveNumber,
  isNonEmptyString,
  isSafeUsername,
  hasNoControlChars,
  isStrongEnoughPassword,
  isSafeRateLimit,
  isSafeRouterIdentifier,
};
