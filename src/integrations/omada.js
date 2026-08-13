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

/**
 * Manually authorize a client by MAC via the OPEN API's own client
 * endpoint - NOT the External Portal API above. This is what a "browse
 * connected devices, authorize a MAC, no voucher" admin screen needs,
 * since authorizeClient() only fires as part of the voucher-redemption
 * redirect flow and requires apMac/ssidName/radioId the redirect
 * supplies automatically - none of which exist for a device an admin is
 * authorizing cold from a dashboard.
 *
 * VERIFICATION STATUS - weaker than the rest of this file: TP-Link's own
 * Open API reference docs (https://use1-omada-northbound.tplinkcloud.com,
 * a Knife4j-generated portal) do not appear to publicly document a
 * client-authorize-by-MAC endpoint. The path and method below come from a
 * single independent report on TP-Link's own community forum (a user who
 * says they found it by inspection, not from the docs):
 *   POST /openapi/v1/{omadacId}/sites/{siteId}/hotspot/clients/{clientMac}/auth
 * The request body shape (in particular whether a custom duration is
 * honored, and under what key) is NOT confirmed from any source - `time`
 * below is a guess based on the External Portal API's own field naming,
 * not a verified Open API parameter. Treat this function as a starting
 * point that needs a real smoke test against your controller version
 * before depending on it, not a confirmed-working integration like
 * listClients/listDevices above.
 */
async function authorizeClientManual(site, { clientMac, minutes }) {
  const token = await getAccessToken(site);
  const url = `${site.omada_base_url}/openapi/v1/${site.omada_omadac_id}/sites/${site.omada_site_id}/hotspot/clients/${clientMac}/auth`;
  const res = await axios.post(url, {
    time: minutes,
  }, { headers: { Authorization: `AccessToken=${token}`, 'Content-Type': 'application/json' } });

  if (res.data?.errorCode !== 0) {
    throw new Error(`Omada manual authorize failed: ${res.data?.msg || 'unknown error'} - this endpoint is unverified against official docs, see comment above authorizeClientManual().`);
  }
  return { ok: true };
}

// No unauthorize/block-by-MAC Open API endpoint could be found or confirmed
// from any source (official docs or otherwise) while building this. Rather
// than guess at a path with zero corroboration, this is intentionally left
// unimplemented - a revoke request for an Omada site should surface a
// clear "not supported" error rather than silently failing or, worse,
// calling a made-up endpoint. See routes/sites.js's revoke-client handler.

module.exports = { getAccessToken, listDevices, listClients, authorizeClient, authorizeClientManual };
