// Ubiquiti UniFi Network integration. Supports two auth modes against the
// same underlying Network application, selected per-site via unifi_auth_mode:
//
//   'classic' - self-hosted controller / Cloud Key software. Session-cookie
//               auth via POST /api/login; calls hit the controller directly
//               at /api/s/{site}/...
//
//   'unifios' - UniFi OS Console (UDM, UDM-Pro, UDR, Cloud Gateway, etc).
//               The Network app runs behind the OS's own gateway, which
//               proxies it at /proxy/network/... and authenticates via a
//               static API key (create one at Settings > Control Plane >
//               Integrations > API Key on the console) sent as an
//               X-API-KEY header. No login step, no session cookie, no
//               CSRF token needed.
//
// Both modes end up hitting the same stamgr cmd + self endpoints; only the
// base path and how the request is authenticated differ.
//
// HONEST LIMITS:
// - Classic mode: same session-per-call and CSRF caveats as before - see
//   below, unchanged.
// - UniFi OS mode: the API key + /proxy/network path unlocks the classic
//   stamgr command set (including authorize-guest), but this path isn't
//   part of Ubiquiti's documented public Integration API (which currently
//   only covers sites/devices/clients, not guest authorization). It works
//   against current UniFi OS builds, but Ubiquiti could change or lock down
//   that proxy path in a future OS update without notice - unlike the
//   classic controller API, which has been stable for years.
// - UniFi OS consoles are somewhat more likely to have a real cert (Ubiquiti
//   can issue one via their cloud DNS for remote-accessible consoles), but
//   plenty are still LAN-only with a self-signed one - so certificate
//   verification stays disabled below for both modes. Remove `httpsAgent`
//   if your console has a trusted cert and you want verification back.

const axios = require('axios');
const https = require('https');

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Classic-mode only: log into the controller and return the session cookie
 * (+ CSRF token if the controller version returns one).
 */
async function login(site) {
  const res = await axios.post(
    `${site.unifi_base_url}/api/login`,
    { username: site.unifi_username, password: site.unifi_password_decrypted },
    {
      httpsAgent: insecureAgent,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true, // handle non-2xx ourselves for a clearer error
    }
  );

  if (res.status !== 200) {
    throw new Error(`UniFi login failed (HTTP ${res.status}): ${res.data?.meta?.msg || 'check base URL / credentials'}`);
  }

  const setCookie = res.headers['set-cookie'];
  if (!setCookie || !setCookie.length) {
    throw new Error('UniFi login succeeded but returned no session cookie - unexpected controller response.');
  }
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const csrfToken = res.headers['x-csrf-token']; // present on newer controller builds, absent on older ones

  return { cookie, csrfToken };
}

/**
 * Resolves the base path prefix and auth headers for this site's auth mode.
 * Classic mode logs in fresh every call (as before); unifios mode is
 * stateless - the API key itself is the credential, no per-call handshake.
 */
async function getAuthContext(site) {
  const authMode = site.unifi_auth_mode || 'classic';

  if (authMode === 'unifios') {
    if (!site.unifi_api_key_decrypted) {
      throw new Error('This site is set to UniFi OS auth mode but has no API key configured - create one under Settings > Control Plane > Integrations on the console and add it to the site.');
    }
    return {
      basePath: '/proxy/network',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': site.unifi_api_key_decrypted,
      },
    };
  }

  if (authMode !== 'classic') {
    throw new Error(`Unknown UniFi auth mode "${authMode}" - expected "classic" or "unifios".`);
  }

  const session = await login(site);
  return {
    basePath: '',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      ...(session.csrfToken ? { 'X-Csrf-Token': session.csrfToken } : {}),
    },
  };
}

/**
 * Authorize a client's internet access after voucher redemption. Mirrors
 * mikrotik.createHotspotUser / omada.authorizeClient - called from
 * voucherService.redeemVoucher once the voucher itself has been validated.
 */
async function authorizeClient(site, { clientMac, durationMinutes, rateLimitKbpsDown, rateLimitKbpsUp }) {
  if (!clientMac) {
    throw new Error('UniFi guest authorization requires the client MAC address - none was provided by the portal redirect.');
  }
  const { basePath, headers } = await getAuthContext(site);
  const unifiSite = site.unifi_site || 'default';

  const body = {
    cmd: 'authorize-guest',
    mac: clientMac.toLowerCase(),
    minutes: durationMinutes,
    ...(rateLimitKbpsDown ? { down: rateLimitKbpsDown } : {}),
    ...(rateLimitKbpsUp ? { up: rateLimitKbpsUp } : {}),
  };

  const res = await axios.post(
    `${site.unifi_base_url}${basePath}/api/s/${unifiSite}/cmd/stamgr`,
    body,
    { httpsAgent: insecureAgent, headers, validateStatus: () => true }
  );

  if (res.status !== 200 || res.data?.meta?.rc !== 'ok') {
    throw new Error(`UniFi guest authorization failed: ${res.data?.meta?.msg || `HTTP ${res.status}`}`);
  }
  return { ok: true, providerRef: clientMac };
}

/**
 * Basic reachability/health check used by the site status poller and the
 * admin "Test connection" button - confirms the base URL + credentials (or
 * API key) actually work, without authorizing anything.
 */
async function ping(site) {
  try {
    const { basePath, headers } = await getAuthContext(site);
    const unifiSite = site.unifi_site || 'default';
    const res = await axios.get(
      `${site.unifi_base_url}${basePath}/api/s/${unifiSite}/self`,
      { httpsAgent: insecureAgent, headers, validateStatus: () => true }
    );
    if (res.status !== 200) {
      return { online: false, error: `Authenticated but site "${unifiSite}" check failed (HTTP ${res.status})` };
    }
    return { online: true, identity: res.data?.data?.[0]?.name || unifiSite };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

/**
 * List currently connected clients on this site. Uses the same stat/sta
 * endpoint the classic controller UI itself calls; works for both auth
 * modes since getAuthContext already resolves the right base path/headers.
 */
async function listClients(site) {
  const { basePath, headers } = await getAuthContext(site);
  const unifiSite = site.unifi_site || 'default';
  const res = await axios.get(
    `${site.unifi_base_url}${basePath}/api/s/${unifiSite}/stat/sta`,
    { httpsAgent: insecureAgent, headers, validateStatus: () => true }
  );
  if (res.status !== 200) {
    throw new Error(`UniFi client list failed (HTTP ${res.status}): ${res.data?.meta?.msg || 'check base URL / credentials'}`);
  }
  return res.data?.data || [];
}

module.exports = { authorizeClient, ping, listClients };
