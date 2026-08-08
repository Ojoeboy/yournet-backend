// Cisco Meraki integration (MR access points / MX security appliances using
// the cloud-managed Dashboard, NOT on-prem Cisco WLC/ISE gear - that would
// need a different integration entirely).
//
// HOW THIS WORKS - and why it's structurally different from mikrotik.js /
// omada.js / unifi.js:
//
// Those three integrations authorize a client by having OUR BACKEND call
// the router/controller directly ("hey controller, let MAC xx:xx go
// online"). Meraki's guest-access grant does NOT work that way. Per Cisco's
// own Click-through/EXCAP documentation, granting access means redirecting
// THE CLIENT DEVICE'S OWN BROWSER to a one-time "grant URL" that Meraki's
// cloud supplies on every splash redirect (as a `base_grant_url` query
// param) - the cloud ties that grant to the IP address making the request.
// If our backend calls that URL server-side, it authorizes OUR SERVER's
// IP, not the customer's phone - so authorizeClient() below does NOT make
// any network call. It just validates and hands back the URL the
// customer's browser needs to be redirected to; the actual grant happens
// when THEIR browser requests it, driven by public/portal.html.
//
// Set up on Meraki's side: Wireless/Security & SD-WAN > Configure > Splash
// page > "Custom splash URL", pointed at this tenant's portal URL
// (/p/{siteId}). Also set "Where should users go after the splash page" to
// "The URL they were trying to fetch" - continue_url only works with that
// option enabled.
//
// HONEST LIMITS:
// - The grant URL Meraki sends (base_grant_url) is per-request and DYNAMIC
//   (e.g. https://n143.network-auth.com/splash/grant) - never hardcode or
//   cache it. It must come fresh off each splash redirect's query string.
// - Per Cisco's docs, param order in the assembled grant URL should be
//   continue_url then duration - but there's at least one reported case
//   (Cisco community forum) where a longer `duration` was ignored unless
//   duration came FIRST. If your custom grant duration isn't sticking,
//   that's the first thing to try swapping.
// - The `duration` param only takes effect up to whatever "Splash
//   frequency" is set to in the Dashboard for that SSID/network - if they
//   don't match, the SHORTER of the two wins. A voucher good for 24 hours
//   won't actually last 24 hours if Splash frequency is set to "4 hours".
// - ping() below uses the Dashboard API (org-wide API key, generated under
//   your Cisco Meraki profile) purely to confirm the network ID is valid
//   and reachable - it is a completely separate credential/API from the
//   grant-URL flow above, which needs no API key at all.

const axios = require('axios');

const DASHBOARD_BASE = 'https://api.meraki.com/api/v1';

/**
 * Builds the URL the CLIENT'S browser must be redirected to in order to
 * actually complete the grant. Does not call it - see file header.
 */
function buildGrantUrl({ baseGrantUrl, continueUrl, durationSeconds }) {
  if (!baseGrantUrl) {
    throw new Error('Meraki authorization requires base_grant_url - it must come from the splash page redirect query string, not be configured ahead of time.');
  }
  const url = new URL(baseGrantUrl);
  if (continueUrl) url.searchParams.set('continue_url', continueUrl);
  if (durationSeconds) url.searchParams.set('duration', String(Math.round(durationSeconds)));
  return url.toString();
}

/**
 * "Authorizes" a client after voucher redemption. Mirrors the shape of
 * mikrotik.createHotspotUser / omada.authorizeClient / unifi.authorizeClient
 * so voucherService can call it the same way, but the result is a
 * redirectUrl for the CLIENT to follow, not a completed authorization -
 * see the HOW THIS WORKS note at the top of this file.
 */
async function authorizeClient(site, { baseGrantUrl, continueUrl, durationSeconds }) {
  const redirectUrl = buildGrantUrl({ baseGrantUrl, continueUrl, durationSeconds });
  return { ok: true, pendingClientRedirect: true, redirectUrl };
}

/**
 * Basic reachability/health check used by the site status poller and the
 * admin "Test connection" button - confirms the Dashboard API key can see
 * the configured network. Uses the Dashboard API, which is entirely
 * separate from the grant-URL flow (see file header).
 */
async function ping(site) {
  if (!site.meraki_network_id) {
    return { online: false, error: 'No Meraki network ID configured for this site.' };
  }
  try {
    const res = await axios.get(
      `${DASHBOARD_BASE}/networks/${site.meraki_network_id}`,
      {
        headers: { Authorization: `Bearer ${site.meraki_dashboard_api_key_decrypted}` },
        validateStatus: () => true,
      }
    );
    if (res.status === 404) {
      return { online: false, error: `Dashboard API key is valid but network ID "${site.meraki_network_id}" was not found - check it's copied correctly (looks like N_1234...).` };
    }
    if (res.status === 401) {
      return { online: false, error: 'Meraki Dashboard API key was rejected (HTTP 401) - check the key and that Dashboard API access is enabled on this org.' };
    }
    if (res.status !== 200) {
      return { online: false, error: `Meraki Dashboard API returned HTTP ${res.status}` };
    }
    return { online: true, identity: res.data?.name || site.meraki_network_id };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

module.exports = { authorizeClient, ping, buildGrantUrl };
