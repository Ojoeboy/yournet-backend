// PPPoE recurring-billing enforcement. Runs on a timer from server.js,
// same pattern as subscriptionBilling.js's monthly platform-license job -
// but there's a real difference in what it can do: subscriptionBilling
// auto-charges a saved Paystack authorization, while individual PPPoE
// subscribers (as built so far) have no saved card on file, so this job
// can't charge anyone automatically yet. What it DOES do:
//
//   1. Flip 'active' subscribers past their due date to 'overdue' (still
//      connected - this is the grace period) and SMS them a reminder.
//   2. After PPPOE_GRACE_DAYS beyond the due date, actually suspend them
//      on the router (kills the account, not just the flag) and set
//      status='suspended'.
//
// Reactivation happens through routes/pppoe.js's record-payment endpoint
// (an admin logs a cash/MoMo payment they collected) - a real online
// checkout + auto-charge for PPPoE is a future increment, same shape as
// the voucher online-payment flow in routes/portal.js.
const pool = require('../db/pool');
const mikrotik = require('../integrations/mikrotik');
const { decrypt } = require('../utils/credentialCrypto');
const sms = require('../integrations/smsService');
const logger = require('../utils/logger');

const GRACE_DAYS = Number(process.env.PPPOE_GRACE_DAYS || 3);

async function runPppoeBillingPass() {
  const flaggedOverdue = await flagNewlyOverdue();
  const suspended = await suspendPastGrace();
  return { flaggedOverdue, suspended };
}

// Step 1: active -> overdue, the moment next_due_date has passed. Doesn't
// touch the router at all - the subscriber keeps their connection through
// the grace period, this just changes what the admin dashboard shows and
// fires one reminder SMS.
async function flagNewlyOverdue() {
  const { rows } = await pool.query(
    `UPDATE pppoe_subscribers
     SET status='overdue', updated_at=now()
     WHERE status='active' AND next_due_date < CURRENT_DATE
     RETURNING id, phone, full_name, next_due_date`
  );
  for (const sub of rows) {
    if (sub.phone) {
      sms.sendSms(
        sub.phone,
        `Hi ${sub.full_name}, your internet subscription is overdue. Please renew within ${GRACE_DAYS} days to avoid disconnection.`
      ).catch(() => {});
    }
  }
  return rows.length;
}

// Step 2: overdue subscribers who are now past the grace window get
// actually cut off - disabled on the router (kills any live session too,
// see mikrotik.setPppoeSecretEnabled) and marked 'suspended'. Each
// subscriber is handled independently so one unreachable router doesn't
// stop the rest of the pass.
async function suspendPastGrace() {
  const { rows: candidates } = await pool.query(
    `SELECT * FROM pppoe_subscribers
     WHERE status='overdue' AND next_due_date < CURRENT_DATE - ($1 || ' days')::interval`,
    [GRACE_DAYS]
  );

  let suspendedCount = 0;
  for (const sub of candidates) {
    try {
      const { rows: siteRows } = await pool.query('SELECT * FROM sites WHERE id=$1', [sub.site_id]);
      if (!siteRows.length || siteRows[0].type !== 'mikrotik') continue;
      const site = { ...siteRows[0], mk_password_decrypted: decrypt(siteRows[0].mk_password_encrypted) };

      await mikrotik.setPppoeSecretEnabled(site, sub.username, false);
      await pool.query(
        `UPDATE pppoe_subscribers SET status='suspended', updated_at=now() WHERE id=$1`,
        [sub.id]
      );
      suspendedCount++;
      if (sub.phone) {
        sms.sendSms(sub.phone, `Hi ${sub.full_name}, your internet has been suspended due to non-payment. Please contact us to renew.`).catch(() => {});
      }
    } catch (err) {
      logger.error('PPPoE auto-suspend failed', { subscriber_id: sub.id, message: err.message });
    }
  }
  return suspendedCount;
}

module.exports = { runPppoeBillingPass };
