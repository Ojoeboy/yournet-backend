const express = require('express');
const { requireAuth, requireNotAgent } = require('../middleware/auth');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const gatewayService = require('../services/paymentGatewayService');

const router = express.Router();
router.use(requireAuth, requireNotAgent);

const SUPPORTED_PROVIDERS = ['paystack', 'hubtel', 'flutterwave'];

// Save/update this tenant's credentials for one provider. Partial updates
// are fine (e.g. re-saving just to fix a typo'd merchant number) - only
// fields actually sent get overwritten, per the COALESCE logic in the
// service layer.
router.post('/', asyncHandler(async (req, res) => {
  const { provider } = req.body;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}` });
  }

  if (provider === 'paystack' && !validate.isNonEmptyString(req.body.paystackSecretKey, 200) && !req.body.paystackPublicKey) {
    return res.status(400).json({ error: 'Paystack secret key is required.' });
  }
  if (provider === 'hubtel' && (!req.body.hubtelClientId || !req.body.hubtelMerchantAccountNumber)) {
    return res.status(400).json({ error: 'Hubtel client ID and merchant account number are required.' });
  }
  if (provider === 'flutterwave' && !validate.isNonEmptyString(req.body.flutterwaveSecretKey, 200)) {
    return res.status(400).json({ error: 'Flutterwave secret key is required.' });
  }

  const saved = await gatewayService.saveGatewayConfig(req.tenantId, provider, req.body);
  res.json(saved);
}));

router.get('/', asyncHandler(async (req, res) => {
  const gateways = await gatewayService.listGateways(req.tenantId);
  res.json(gateways);
}));

router.post('/:provider/activate', asyncHandler(async (req, res) => {
  const { provider } = req.params;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}` });
  }
  const result = await gatewayService.setActiveGateway(req.tenantId, provider);
  if (!result) return res.status(400).json({ error: 'That provider has not been configured yet - save credentials first.' });
  res.json(result);
}));

router.delete('/:provider', asyncHandler(async (req, res) => {
  const { provider } = req.params;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}` });
  }
  const deleted = await gatewayService.deleteGatewayConfig(req.tenantId, provider);
  if (!deleted) return res.status(404).json({ error: 'That provider is not configured.' });
  res.json({ ok: true, provider, wasActive: deleted.is_active });
}));

module.exports = router;
