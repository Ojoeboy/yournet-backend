// TP-Link Omada integration.
//
// Omada actually exposes TWO different APIs you need, for two different jobs:
//
// 1) OPEN API (OAuth) - for management: reading sites, devices, client lists.
//    Enabled at: Global View > Settings > Platform Integration > Open API
//    Requires a self-hosted/hardware Omada Controller (Standard or higher -
//    the free "Essential" cloud tier does NOT support Open API).
//
// 2) EXTERNAL PORTAL API - for actually authorizing a client's internet
//    access after they redeem a voucher. This is the piece that makes
//    "redeem code -> get online" real instead of just a status flag.
//    IMPORTANT: the exact request path/params differ by Controller version
//    (TP-Link publishes separate guides for 2.6-3.2, 4.1-4.4, and 5.0.15+).
//    Check which FAQ matches your Controller version before wiring this up:
//      - Controller 5.0.15+   -> TP-Link FAQ 3231
//      - Controller 4.1.5-4.4 -> TP-Link FAQ 2907
//      - Controller 2.6-3.2   -> TP-Link FAQ 2274
//    The skeleton below matches the 5.0.15+ flow. Adjust paths/params to
//    match your Controller's exact guide if you're on an older version.

const axios = require('axios');

/**
 * Fetch an OAuth access token using Client Credentials mode.
 * (Client mode = system-to-system, no user login needed - what we want
 * for a backend service.)
 */
async function getAccessToken(site) {
  const url = `${site.omada_base_url}/openapi/authorize/token?grant_type=client_credentials`;
  const res = await axios.post(url, {
    omadacId: site.omada_omadac_id,
    client_id: site.omada_client_id,
    client_secret: site.omada_client_secret_decrypted, // decrypt before calling
  }, { headers: { 'Content-Type': 'application/json' } });

  if (res.data?.errorCode !== 0) {
    throw new Error(`Omada auth failed: ${res.data?.msg || 'unknown error'}`);
  }
  return res.data.result.accessToken;
}

/**
 * Management call example: list APs on the site (used for the dashboard's
 * real AP list, replacing the fake random-number cards in the HTML file).
 */
async function listDevices(site) {
  const token = await getAccessToken(site);
  const url = `${site.omada_base_url}/openapi/v1/${site.omada_omadac_id}/sites/${site.omada_site_id}/devices`;
  const res = await axios.get(url, {
    headers: { Authorization: `AccessToken=${token}` },
  });
  return res.data.result || [];
}

/**
 * List currently connected clients on the site (real numbers, not random()).
 */
async function listClients(site) {
  const token = await getAccessToken(site);
  const url = `${site.omada_base_url}/openapi/v1/${site.omada_omadac_id}/sites/${site.omada_site_id}/clients`;
  const res = await axios.get(url, {
    headers: { Authorization: `AccessToken=${token}` },
  });
  return res.data.result?.data || [];
}

/**
 * Authorize a client's internet access after voucher redemption, via the
 * External Portal API. The captive portal page (served by YOUR backend,
 * set as the "External Portal URL" in Omada's portal settings) receives
 * clientMac / apMac / ssidName / radioId / site as query params supplied
 * automatically by the AP/gateway when a device connects. After validating
 * the voucher code, POST back to the Controller to grant access.
 *
 * NOTE: verify the exact path/body against TP-Link FAQ 3231 (or the
 * version-matched FAQ above) for your Controller build before going live -
 * this is where real installs most often need a small tweak.
 */
async function authorizeClient(site, { clientMac, apMac, ssidName, radioId, siteParam }) {
  const url = `${site.omada_base_url}/${site.omada_omadac_id}/api/v2/hotspot/extPortal/auth`;
  const res = await axios.post(url, {
    clientMac,
    apMac,
    ssidName,
    radioId,
    site: siteParam,
    authType: 4,          // external-voucher style auth, per Omada's own voucher authType convention
    time: 0,               // 0 = use the duration configured on the matching hotspot operator/profile
  }, { headers: { 'Content-Type': 'application/json' } });

  return res.data;
}

module.exports = { getAccessToken, listDevices, listClients, authorizeClient };
