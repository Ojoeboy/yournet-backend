// Ruijie Cloud Open API integration (Reyee EG/AP gateways managed via
// cloud-eu.ruijienetworks.com or another regional Ruijie Cloud instance).
//
// HOW RUIJIE FITS IN, AND WHY THIS FILE IS DELIBERATELY THIN:
// Unlike mikrotik.js/omada.js/unifi.js, this module does NOT grant network
// access - it never appears in voucherService.redeemVoucher's provider
// dispatch. A ruijie-type site gets online access through one of two
// separate paths instead, chosen per-site via sites.mk_auth_mode:
//
//   'radius'       - EG-series gateways with native RADIUS client support
//                     talk to integrations/radius.js directly. Zero code
//                     here is involved; this is the same CGNAT-safe path
//                     mikrotik sites can use, and was already fully working
//                     before this file existed.
//   'ruijie_cloud'  - Reyee/cloud-only gateways without RADIUS support
//                     instead have their Ruijie Cloud "Cloud Auth / External
//                     Portal" Auth Server URL pointed at
//                     routes/ruijieCloudAuth.js. Ruijie Cloud's own
//                     dashboard calls OUR endpoint - see that file for the
//                     actual grant logic. This file has nothing to do with
//                     that flow either.
//
// So what IS this file for? The Open API surface below (login, network
// list, current-client list) is the lower-priority "nice to have" from the
// original integration plan - pulling a customer's site list in during
// onboarding and showing live online-client counts on the dashboard. It is
// NOT load-bearing for granting access, which is intentional: unlike
// RouterOS's API or UniFi's API (which are things Ruijie/Reyee's own
// support and community have documented and can be relied on), this Open
// API surface is built against an UNOFFICIAL RECONSTRUCTION of Ruijie's
// docs (the real ones are gated behind emailing service_rj@ruijienetworks.com
// as an SI/VAD and receiving PDFs). If a field name here turns out wrong
// once tested against a real account, the worst case is a broken "sync
// sites" button - never a stranded paying customer, because nothing that
// actually grants access depends on this file.
//
// CREDENTIALS: appid/secret are issued to YOUR PLATFORM by Ruijie (one pair
// for the whole SaaS, not per-site) - set as RUIJIE_APPID/RUIJIE_SECRET/
// RUIJIE_CLOUD_PREFIX env vars. Each site additionally stores the
// CUSTOMER's own Ruijie Cloud account email + password (encrypted, see
// credentialCrypto.js) - login() authenticates as the customer using the
// platform's appid/secret, exactly like the onboarding flow in the original
// plan. tenantId/groupId returned by login() are what get stored per-site
// for later calls.

const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 15000;

function requirePlatformCreds() {
  const cloudPrefix = process.env.RUIJIE_CLOUD_PREFIX;
  const appId = process.env.RUIJIE_APPID;
  const secret = process.env.RUIJIE_SECRET;
  if (!cloudPrefix || !appId || !secret) {
    throw new Error('RUIJIE_CLOUD_PREFIX / RUIJIE_APPID / RUIJIE_SECRET are not configured on this deployment - Ruijie Cloud sync is unavailable until they are.');
  }
  return { cloudPrefix: cloudPrefix.replace(/\/$/, ''), appId, secret };
}

/**
 * Logs into Ruijie Cloud AS THE CUSTOMER, using the platform's appid/secret
 * plus the customer's own account/password stored on the site. Returns the
 * raw login payload (access_token, tenantId, tenantName, groupId) - callers
 * decide what to persist.
 */
async function login(site) {
  const { cloudPrefix, appId, secret } = requirePlatformCreds();
  if (!site.ruijie_account || !site.ruijie_account_password_decrypted) {
    throw new Error('This site has no Ruijie Cloud account/password configured - add the customer\'s Ruijie Cloud login under the site\'s Ruijie settings first.');
  }
  const { data } = await axios.get(`${cloudPrefix}/service/api/login`, {
    params: { appid: appId, secret, account: site.ruijie_account, password: site.ruijie_account_password_decrypted },
    timeout: DEFAULT_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (data?.code !== 0) {
    throw new Error(`Ruijie Cloud login failed (code=${data?.code}): ${data?.msg || 'check the account/password stored for this site'}`);
  }
  return data;
}

/**
 * Network/building group list for the tenant - used during onboarding to
 * populate this site's list of physical locations. Reconstructed endpoint
 * (2.2.1 in the cheatsheet) - not confirmed against a real account.
 */
async function getNetworks(accessToken, rootGroupId) {
  const { cloudPrefix } = requirePlatformCreds();
  const { data } = await axios.post(
    `${cloudPrefix}/service/api/maint/network/list`,
    { groupId: String(rootGroupId) },
    { params: { access_token: accessToken, page: 1, per_page: 100 }, timeout: DEFAULT_TIMEOUT_MS, validateStatus: () => true }
  );
  if (data?.code !== 0) {
    throw new Error(`Ruijie network list failed (code=${data?.code}): ${data?.msg || 'unexpected response'}`);
  }
  return data.dataList || [];
}

/**
 * Basic reachability/health check for the admin "Test connection" button -
 * confirms the stored Ruijie Cloud account/password actually authenticate.
 * Does NOT confirm the auth callback or RADIUS path are working - those are
 * exercised by real traffic, not this call. See routes/sites.js's /:id/test
 * for how this is combined with that caveat for ruijie-type sites.
 */
async function ping(site) {
  try {
    const data = await login(site);
    return { online: true, identity: data.tenantName || site.ruijie_account };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

/**
 * Currently-online client count/list, best-effort, for the dashboard. Uses
 * the reconstructed vague current-users endpoint - wrapped so a failure
 * here degrades to "unknown" rather than breaking the dashboard.
 */
async function listClients(site) {
  const { cloudPrefix } = requirePlatformCreds();
  const login_ = await login(site);
  const { data } = await axios.get(`${cloudPrefix}/logbizagent/logbiz/api/sta/current_users/vague`, {
    params: { access_token: login_.access_token, tenantId: login_.tenantId },
    timeout: DEFAULT_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (data?.code !== 0) {
    throw new Error(`Ruijie client list failed (code=${data?.code}): ${data?.msg || 'unexpected response'}`);
  }
  return data.dataList || [];
}

module.exports = { login, getNetworks, ping, listClients };
