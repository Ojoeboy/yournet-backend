const crypto = require('crypto');

// Hubtel's webhook has no built-in signature scheme (unlike Paystack/
// Flutterwave, whose success is confirmed by us independently calling
// their verify-by-reference API - see gateways/paystackGateway.js and
// flutterwaveGateway.js). That means a Hubtel webhook body is otherwise
// just "whatever POST body arrives at a public URL," which anyone can
// forge - including the person who just called buy-voucher/purchase-
// initialize themselves, since the order reference is handed straight
// back to them in that same response.
//
// Fix: generate a one-time random token when the Hubtel checkout is
// created, embed it in the callback URL as a query param (Hubtel POSTs
// back to whatever callbackUrl we gave it, query string included), and
// store only its hash. The webhook handler then requires the incoming
// token to hash-match before trusting the payload at all - so forging a
// webhook now requires knowing this token, not just the reference that
// was already handed back in the API response.

function generateToken() {
  const raw = crypto.randomBytes(24).toString('hex');
  return { raw, hash: hashToken(raw) };
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Constant-time compare so this check itself can't leak the token via a
// timing side-channel.
function tokensMatch(providedRaw, storedHash) {
  if (!providedRaw || !storedHash) return false;
  const providedHash = hashToken(providedRaw);
  const a = Buffer.from(providedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateToken, hashToken, tokensMatch };
