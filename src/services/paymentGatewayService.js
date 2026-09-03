const pool = require('../db/pool');
const { encrypt, decrypt } = require('../utils/credentialCrypto');
const paystackGateway = require('../integrations/gateways/paystackGateway');
const hubtelGateway = require('../integrations/gateways/hubtelGateway');
const flutterwaveGateway = require('../integrations/gateways/flutterwaveGateway');
const stripeGateway = require('../integrations/gateways/stripeGateway');

/**
 * Save (or update) a tenant's credentials for one provider. Secrets are
 * encrypted before storage, same as router/API credentials elsewhere.
 */
async function saveGatewayConfig(tenantId, provider, config) {
  const encrypted = {
    paystackSecretKeyEncrypted: encrypt(config.paystackSecretKey),
    hubtelClientSecretEncrypted: encrypt(config.hubtelClientSecret),
    flutterwaveSecretKeyEncrypted: encrypt(config.flutterwaveSecretKey),
    stripeSecretKeyEncrypted: encrypt(config.stripeSecretKey),
    stripeWebhookSecretEncrypted: encrypt(config.stripeWebhookSecret),
  };

  const { rows } = await pool.query(
    `INSERT INTO payment_gateways (
       tenant_id, provider,
       paystack_secret_key_encrypted, paystack_public_key,
       hubtel_client_id, hubtel_client_secret_encrypted, hubtel_merchant_account_number,
       flutterwave_secret_key_encrypted, flutterwave_public_key, contact_email,
       stripe_secret_key_encrypted, stripe_publishable_key, stripe_webhook_secret_encrypted
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET
       paystack_secret_key_encrypted = COALESCE(EXCLUDED.paystack_secret_key_encrypted, payment_gateways.paystack_secret_key_encrypted),
       paystack_public_key = COALESCE(EXCLUDED.paystack_public_key, payment_gateways.paystack_public_key),
       hubtel_client_id = COALESCE(EXCLUDED.hubtel_client_id, payment_gateways.hubtel_client_id),
       hubtel_client_secret_encrypted = COALESCE(EXCLUDED.hubtel_client_secret_encrypted, payment_gateways.hubtel_client_secret_encrypted),
       hubtel_merchant_account_number = COALESCE(EXCLUDED.hubtel_merchant_account_number, payment_gateways.hubtel_merchant_account_number),
       flutterwave_secret_key_encrypted = COALESCE(EXCLUDED.flutterwave_secret_key_encrypted, payment_gateways.flutterwave_secret_key_encrypted),
       flutterwave_public_key = COALESCE(EXCLUDED.flutterwave_public_key, payment_gateways.flutterwave_public_key),
       contact_email = COALESCE(EXCLUDED.contact_email, payment_gateways.contact_email),
       stripe_secret_key_encrypted = COALESCE(EXCLUDED.stripe_secret_key_encrypted, payment_gateways.stripe_secret_key_encrypted),
       stripe_publishable_key = COALESCE(EXCLUDED.stripe_publishable_key, payment_gateways.stripe_publishable_key),
       stripe_webhook_secret_encrypted = COALESCE(EXCLUDED.stripe_webhook_secret_encrypted, payment_gateways.stripe_webhook_secret_encrypted),
       updated_at = now()
     RETURNING id, provider, is_active`,
    [
      tenantId, provider,
      encrypted.paystackSecretKeyEncrypted, config.paystackPublicKey || null,
      config.hubtelClientId || null, encrypted.hubtelClientSecretEncrypted, config.hubtelMerchantAccountNumber || null,
      encrypted.flutterwaveSecretKeyEncrypted, config.flutterwavePublicKey || null, config.contactEmail || null,
      encrypted.stripeSecretKeyEncrypted, config.stripePublishableKey || null, encrypted.stripeWebhookSecretEncrypted,
    ]
  );
  return rows[0];
}

/**
 * Mark one provider as the active checkout gateway for this tenant,
 * deactivating any other configured providers.
 */
async function setActiveGateway(tenantId, provider) {
  await pool.query('UPDATE payment_gateways SET is_active=false WHERE tenant_id=$1', [tenantId]);
  const { rows } = await pool.query(
    `UPDATE payment_gateways SET is_active=true WHERE tenant_id=$1 AND provider=$2 RETURNING id, provider, is_active`,
    [tenantId, provider]
  );
  return rows[0] || null;
}

/**
 * List configured providers for a tenant, WITHOUT exposing raw secrets -
 * only enough to show "Paystack: configured, active" in a UI.
 */
async function listGateways(tenantId) {
  const { rows } = await pool.query(
    `SELECT provider, is_active,
       (paystack_secret_key_encrypted IS NOT NULL) AS paystack_configured,
       (hubtel_client_secret_encrypted IS NOT NULL) AS hubtel_configured,
       (flutterwave_secret_key_encrypted IS NOT NULL) AS flutterwave_configured,
       (stripe_secret_key_encrypted IS NOT NULL) AS stripe_configured,
       hubtel_client_id, hubtel_merchant_account_number,
       paystack_public_key, flutterwave_public_key, stripe_publishable_key, contact_email
     FROM payment_gateways WHERE tenant_id=$1`,
    [tenantId]
  );
  return rows;
}

/**
 * Remove a tenant's saved credentials for one provider entirely (not just
 * deactivate). If that provider was the active gateway, checkout is left
 * with none active - callers should make this clear to the tenant, since
 * their portal's "buy voucher" flow stops working until they activate
 * another configured provider.
 */
async function deleteGatewayConfig(tenantId, provider) {
  // Guard: if a customer's payment is still pending verification through
  // this provider, deleting the credentials now would strand them - the
  // return/verify call looks the gateway row back up by provider and would
  // fail with "Gateway not configured", leaving a paid customer with no
  // voucher and no automatic retry. Block until those orders resolve.
  const { rows: pending } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM voucher_orders WHERE tenant_id=$1 AND provider=$2 AND status='pending'`,
    [tenantId, provider]
  );
  if (pending[0].count > 0) {
    const err = new Error(
      `${pending[0].count} order(s) are still pending payment through ${provider}. ` +
      `Wait for them to complete or fail before removing these credentials.`
    );
    err.status = 409;
    throw err;
  }

  const { rows } = await pool.query(
    `DELETE FROM payment_gateways WHERE tenant_id=$1 AND provider=$2 RETURNING id, provider, is_active`,
    [tenantId, provider]
  );
  return rows[0] || null;
}

async function getActiveGateway(tenantId) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_gateways WHERE tenant_id=$1 AND is_active=true LIMIT 1`,
    [tenantId]
  );
  return rows[0] || null;
}

/**
 * Start a checkout using whichever gateway the tenant has activated.
 * Returns { checkoutUrl, reference, provider } regardless of which
 * provider actually handled it - callers don't need to branch on provider.
 */
// currency: the TENANT's chosen currency (tenants.currency), passed through
// to whichever gateway supports it. Hubtel has no currency parameter in its
// API at all (it's implicitly GHS-only), so a tenant on Hubtel with a
// non-GHS currency selected will still be charged in GHS - that's a real
// Hubtel limitation, not something this layer can paper over. Paystack and
// Flutterwave both get it passed through; each will error at their end if
// the merchant's account doesn't have that currency enabled.
async function initializeCheckout(tenantId, { amountGHS, currency, email, phone, reference, callbackUrl, returnUrl, description }) {
  const gw = await getActiveGateway(tenantId);
  if (!gw) throw new Error('This WiFi provider has not set up online payment yet.');

  if (gw.provider === 'paystack') {
    const result = await paystackGateway.initializePayment({
      secretKey: decrypt(gw.paystack_secret_key_encrypted),
      email, amountGHS, currency, reference, callbackUrl,
    });
    return { ...result, provider: 'paystack' };
  }

  if (gw.provider === 'hubtel') {
    const result = await hubtelGateway.initializePayment({
      clientId: gw.hubtel_client_id,
      clientSecret: decrypt(gw.hubtel_client_secret_encrypted),
      merchantAccountNumber: gw.hubtel_merchant_account_number,
      amountGHS, reference, callbackUrl, returnUrl, description,
    });
    return { ...result, provider: 'hubtel' };
  }

  if (gw.provider === 'flutterwave') {
    const result = await flutterwaveGateway.initializePayment({
      secretKey: decrypt(gw.flutterwave_secret_key_encrypted),
      email, phone, amountGHS, currency, reference, redirectUrl: callbackUrl, title: description,
    });
    return { ...result, provider: 'flutterwave' };
  }

  if (gw.provider === 'stripe') {
    // Stripe's Checkout Session model needs separate success/cancel URLs
    // rather than one shared callbackUrl - callers (portal.js) pass
    // returnUrl through as success_url here; cancel just sends the
    // customer back to the same page with no special handling, since a
    // cancelled Stripe session isn't a failure worth its own order state
    // (no charge occurred, so the order simply stays 'pending' until the
    // customer tries again or it's cleaned up like any other abandoned order).
    const result = await stripeGateway.createCheckoutSession({
      secretKey: decrypt(gw.stripe_secret_key_encrypted),
      amount: amountGHS, // NOTE: still the tenant's package price in their own currency, NOT converted to/from GHS - see note on the route about currency handling
      currency,
      reference,
      email,
      successUrl: returnUrl,
      cancelUrl: returnUrl,
      description,
    });
    return { ...result, provider: 'stripe' };
  }

  throw new Error(`Unsupported provider: ${gw.provider}`);
}

/**
 * Verify a payment after the fact. For Paystack/Flutterwave this makes a
 * real API call to confirm status. For Hubtel, verification instead comes
 * through the webhook itself (see hubtelGateway.interpretWebhook) - this
 * function isn't used on that path.
 */
async function verifyCheckout(tenantId, provider, reference) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_gateways WHERE tenant_id=$1 AND provider=$2 LIMIT 1`,
    [tenantId, provider]
  );
  const gw = rows[0];
  if (!gw) throw new Error('Gateway not configured for this tenant.');

  if (provider === 'paystack') {
    return paystackGateway.verifyPayment({ secretKey: decrypt(gw.paystack_secret_key_encrypted), reference });
  }
  if (provider === 'flutterwave') {
    return flutterwaveGateway.verifyPayment({ secretKey: decrypt(gw.flutterwave_secret_key_encrypted), transactionId: reference });
  }
  if (provider === 'stripe') {
    // `reference` here is actually the Stripe session_id - see the stripe
    // branch in routes/portal.js's /gateway-callback/:provider handler.
    return stripeGateway.verifyCheckoutSession({ secretKey: decrypt(gw.stripe_secret_key_encrypted), sessionId: reference });
  }
  throw new Error(`verifyCheckout not applicable for provider: ${provider}`);
}

/**
 * Decrypted Paystack secret key for one tenant. Used by portal.js's
 * Paystack webhook to check the x-paystack-signature header for a given
 * tenant BEFORE trusting anything else in that request - same secret
 * verifyCheckout above already uses to independently re-verify the
 * payment itself afterward. Returns null if this tenant has no Paystack
 * credentials saved at all (as opposed to configured-but-inactive, which
 * still returns the key - a tenant can receive a webhook for an order
 * placed while Paystack was their active gateway even if they've since
 * switched to a different one).
 */
async function getPaystackSecretKey(tenantId) {
  const { rows } = await pool.query(
    `SELECT paystack_secret_key_encrypted FROM payment_gateways WHERE tenant_id=$1 AND provider='paystack' LIMIT 1`,
    [tenantId]
  );
  const encrypted = rows[0]?.paystack_secret_key_encrypted;
  return encrypted ? decrypt(encrypted) : null;
}

/**
 * Decrypted Stripe secret + webhook signing secret for one tenant. Used by
 * portal.js's Stripe webhook the same way getPaystackSecretKey is used for
 * Paystack's - checking the Stripe-Signature header BEFORE trusting
 * anything else in the request. Returns nulls if this tenant has no
 * Stripe credentials saved (as opposed to configured-but-inactive, same
 * reasoning as getPaystackSecretKey above).
 */
async function getStripeCredentials(tenantId) {
  const { rows } = await pool.query(
    `SELECT stripe_secret_key_encrypted, stripe_webhook_secret_encrypted FROM payment_gateways WHERE tenant_id=$1 AND provider='stripe' LIMIT 1`,
    [tenantId]
  );
  const row = rows[0];
  if (!row) return { secretKey: null, webhookSecret: null };
  return {
    secretKey: row.stripe_secret_key_encrypted ? decrypt(row.stripe_secret_key_encrypted) : null,
    webhookSecret: row.stripe_webhook_secret_encrypted ? decrypt(row.stripe_webhook_secret_encrypted) : null,
  };
}

module.exports = {
  saveGatewayConfig, setActiveGateway, deleteGatewayConfig, listGateways,
  getActiveGateway, initializeCheckout, verifyCheckout, getPaystackSecretKey,
  getStripeCredentials,
};
