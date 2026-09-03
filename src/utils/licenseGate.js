const LICENSE_GRACE_DAYS = Number(process.env.LICENSE_GRACE_DAYS || 2);

// Single source of truth for "is this tenant's subscription too far
// lapsed to keep working" - originally lived only in routes/auth.js (owner
// login), pulled out here so routes/agents.js can apply the EXACT same
// rule to agent login/generation. Deliberately the same grace window for
// both: an agent losing access harsher/faster than the owner themselves
// would be a confusing, inconsistent policy for no real benefit - the
// owner is already the one responsible for renewing.
//
// plan_expires_at being NULL means "never had a monthly cycle start"
// (manual/legacy accounts) - treated as not-locked, not as expired.
function checkLicenseLockout(tenant) {
  if (!tenant.plan_expires_at) return { locked: false, graceDaysRemaining: null };

  const lockoutAt = new Date(new Date(tenant.plan_expires_at).getTime() + LICENSE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();

  if (now > lockoutAt) {
    return {
      locked: true,
      error: 'The account\u2019s YourNet Control subscription has expired and the grace period has ended. Ask your manager to renew at /license to restore access.',
    };
  }

  let graceDaysRemaining = null;
  if (now > new Date(tenant.plan_expires_at)) {
    graceDaysRemaining = Math.ceil((lockoutAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  }
  return { locked: false, graceDaysRemaining };
}

module.exports = { checkLicenseLockout, LICENSE_GRACE_DAYS };
