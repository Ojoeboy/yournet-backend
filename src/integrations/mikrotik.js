// Real Mikrotik RouterOS integration using the RouterOS API (port 8728/8729).
// This actually creates/removes hotspot users on the router, which is what
// grants or revokes internet access - the piece the front-end HTML file
// could never do on its own (browsers can't open raw API sockets).

const { RouterOSAPI } = require('node-routeros');

/**
 * Open a connection to a tenant's Mikrotik router.
 * @param {object} site - row from `sites` table (type = 'mikrotik')
 */
async function connect(site) {
  const useTls = !!site.mk_use_tls;
  const conn = new RouterOSAPI({
    host: site.mk_host,
    user: site.mk_username,
    password: site.mk_password_decrypted, // decrypt before calling this module
    // If the site hasn't set a port explicitly, default to the port that
    // matches whichever mode (plain/TLS) it's using - 8728 for the
    // plaintext API, 8729 for API-SSL - rather than always falling back
    // to the plain-API default even when TLS is on.
    port: site.mk_api_port || (useTls ? 8729 : 8728),
    timeout: 8,
    // RouterOS's API-SSL service almost always presents a self-signed
    // cert (there's no CA-issued cert workflow for it), so verifying the
    // chain would break the common case. rejectUnauthorized: false still
    // gets you encryption-in-transit, just not identity verification -
    // the same tradeoff most self-hosted RouterOS tooling makes.
    ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
  });
  await conn.connect();
  return conn;
}

/**
 * Create a hotspot user on the router for a redeemed voucher.
 * duration_minutes -> RouterOS "limit-uptime" (e.g. 360m for 6 hours)
 * rate limits -> RouterOS "limit-bytes-in/out" style rate-limit string e.g. "4M/10M"
 *
 * IP/MAC BINDING: if clientMac is provided, the hotspot user account is
 * locked to that one device's MAC address on the router itself (RouterOS's
 * own "mac-address" field on a hotspot user). This is enforced by the
 * router, not just our database - so even if a customer texts their code
 * to a friend, it will not work on the friend's phone. If clientMac isn't
 * available for some reason, the voucher still works but isn't locked.
 */
async function createHotspotUser(site, { code, profile, durationMinutes, rateLimit, clientMac }) {
  const conn = await connect(site);
  try {
    const limitUptime = `${durationMinutes}m`;
    await conn.write('/ip/hotspot/user/add', [
      `=name=${code}`,
      `=password=${code}`,
      `=profile=${profile || site.mk_hotspot_profile || 'default'}`,
      `=limit-uptime=${limitUptime}`,
      ...(rateLimit ? [`=limit-bytes-total=0`, `=rate-limit=${rateLimit}`] : []),
      ...(clientMac ? [`=mac-address=${clientMac}`] : []),
    ]);
    return { ok: true, providerRef: code, boundMac: clientMac || null };
  } finally {
    conn.close();
  }
}

/**
 * Kick + remove a hotspot user (voucher expired/void).
 */
async function removeHotspotUser(site, code) {
  const conn = await connect(site);
  try {
    const found = await conn.write('/ip/hotspot/user/print', [`?name=${code}`]);
    if (found.length) {
      await conn.write('/ip/hotspot/user/remove', [`=.id=${found[0]['.id']}`]);
    }
    // also drop any active session for this user
    const active = await conn.write('/ip/hotspot/active/print', [`?user=${code}`]);
    for (const session of active) {
      await conn.write('/ip/hotspot/active/remove', [`=.id=${session['.id']}`]);
    }
    return { ok: true };
  } finally {
    conn.close();
  }
}

/**
 * Basic reachability/health check used by the site status poller.
 */
async function ping(site) {
  try {
    const conn = await connect(site);
    const identity = await conn.write('/system/identity/print');
    conn.close();
    return { online: true, identity: identity[0]?.name };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

/**
 * List currently active clients (for dashboard's "live clients" view).
 */
async function listActiveClients(site) {
  const conn = await connect(site);
  try {
    const active = await conn.write('/ip/hotspot/active/print');
    return active.map((c) => ({
      user: c.user,
      address: c.address,
      macAddress: c['mac-address'],
      uptime: c.uptime,
      bytesIn: c['bytes-in'],
      bytesOut: c['bytes-out'],
    }));
  } finally {
    conn.close();
  }
}

/**
 * List CAPsMAN-managed access points.
 *
 * IMPORTANT CAVEAT: this only returns anything if the router is running as
 * a CAPsMAN *manager* with real Mikrotik CAP-capable devices (e.g. cAP,
 * wAP, hAP with "CAP" mode enabled) provisioned under it. A generic/
 * third-party AP that's just bridged to this router in normal AP mode -
 * which is most setups, and works fine for clients/vouchers - has no
 * CAPsMAN relationship whatsoever and will never appear here. That's
 * expected, not a bug: RouterOS simply has no visibility into a dumb
 * bridged AP the same way it does into hotspot clients.
 *
 * Returns { supported: false, accessPoints: [] } rather than throwing when
 * CAPsMAN isn't configured/enabled on this router, since that's a normal,
 * common setup, not an error condition.
 *
 * FIELD NAMES: verified against MikroTik's own documentation and real
 * `remote-cap print` output captured from live routers (not guessed):
 *   - RouterOS 6.x legacy CAPsMAN (`/caps-man/remote-cap/print`): columns
 *     are ADDRESS, IDENT, STATE, RADIOS - API property names are
 *     `address`, `identity`, `state`, `radios`. No board/version columns
 *     exist at all on this path, so those two always come back null here.
 *     (One older 6.49.x capture showed a NAME column instead of IDENT for
 *     the same field - `identity` is tried first since it matches current
 *     documentation, with `name` as a fallback for that older build.)
 *   - RouterOS 7's unified wifi package
 *     (`/interface/wifi/capsman/remote-cap/print`): columns are ADDRESS,
 *     IDENTITY, STATE, BOARD-NAME, VERSION, CONNECTED-TIME - API property
 *     names are `address`, `identity`, `state`, `board-name`, `version`,
 *     `connected-time`.
 * This is meaningfully more solid than a guess, but still hasn't been run
 * against a router in this codebase's own test suite - worth a smoke test
 * against your actual CAPsMAN manager before depending on it.
 */
async function listAccessPoints(site) {
  const conn = await connect(site);
  try {
    let caps;
    let path = '/caps-man/remote-cap/print';
    try {
      caps = await conn.write(path);
    } catch (err) {
      path = '/interface/wifi/capsman/remote-cap/print';
      try {
        caps = await conn.write(path);
      } catch (err2) {
        // CAPsMAN package not enabled, no manager configured, or this
        // RouterOS version uses a different menu than either guess above.
        return { supported: false, accessPoints: [] };
      }
    }
    return {
      supported: true,
      accessPoints: caps.map((c) => ({
        identity: c.identity || c.name || c.ident || null,
        address: c.address || null,
        macAddress: c['mac-address'] || c['radio-mac'] || null,
        state: c.state || null,
        boardName: c['board-name'] || c.board || null,
        version: c.version || null,
        connectedTime: c['connected-time'] || null,
      })),
    };
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// PPPoE subscriber management (/ppp/secret, /ppp/active) - recurring
// ISP-style accounts, distinct from the one-time /ip/hotspot/user vouchers
// above. Every function here re-validates its identifier/rate-limit inputs
// with the same patterns routes/pppoe.js already enforces before calling in
// - defense in depth, so this module is safe to call from anywhere later
// without silently trusting whatever the caller passed.
// ---------------------------------------------------------------------------

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_ROUTER_IDENTIFIER = /^[A-Za-z0-9_.\- ]{1,64}$/;
const SAFE_RATE_LIMIT = /^[0-9]{1,5}[kKmMgG]?\/[0-9]{1,5}[kKmMgG]?$/;
const NO_CONTROL_CHARS = /^[^\x00-\x1F\x7F]*$/;

function assertSafe(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Refusing to send unsafe ${label} to router.`);
  }
}

/**
 * Create a PPPoE subscriber account (/ppp/secret) on the router.
 * `profile` (an existing /ppp/profile name) takes priority over `rateLimit`
 * (a direct rate-limit string on the secret itself) if both are given -
 * mirrors how routes/pppoe.js resolves a plan's router_profile vs rate_limit.
 */
async function createPppoeSecret(site, { username, password, profile, rateLimit, comment }) {
  assertSafe(username, SAFE_IDENTIFIER, 'PPPoE username');
  if (typeof password !== 'string' || !NO_CONTROL_CHARS.test(password) || password.length < 8) {
    throw new Error('Refusing to send unsafe/weak PPPoE password to router.');
  }
  if (profile) assertSafe(profile, SAFE_ROUTER_IDENTIFIER, 'PPP profile name');
  if (rateLimit) assertSafe(rateLimit, SAFE_RATE_LIMIT, 'rate-limit string');
  if (comment && !NO_CONTROL_CHARS.test(comment)) throw new Error('Refusing to send unsafe comment to router.');

  const conn = await connect(site);
  try {
    await conn.write('/ppp/secret/add', [
      `=name=${username}`,
      `=password=${password}`,
      `=service=pppoe`,
      `=profile=${profile || 'default'}`,
      ...(!profile && rateLimit ? [`=rate-limit=${rateLimit}`] : []),
      ...(comment ? [`=comment=${comment}`] : []),
    ]);
    return { ok: true };
  } finally {
    conn.close();
  }
}

/**
 * Remove a PPPoE subscriber account and kick any active session for it.
 */
async function removePppoeSecret(site, username) {
  assertSafe(username, SAFE_IDENTIFIER, 'PPPoE username');
  const conn = await connect(site);
  try {
    const found = await conn.write('/ppp/secret/print', [`?name=${username}`]);
    if (found.length) {
      await conn.write('/ppp/secret/remove', [`=.id=${found[0]['.id']}`]);
    }
    await disconnectActiveInternal(conn, username);
    return { ok: true };
  } finally {
    conn.close();
  }
}

/**
 * Enable/disable a PPPoE subscriber without deleting their account - used
 * for suspend (overdue/non-payment) vs reactivate, so the plan/history
 * stays intact. Disabling alone doesn't drop an already-connected session,
 * so this also kicks any active session when disabling.
 */
async function setPppoeSecretEnabled(site, username, enabled) {
  assertSafe(username, SAFE_IDENTIFIER, 'PPPoE username');
  const conn = await connect(site);
  try {
    const found = await conn.write('/ppp/secret/print', [`?name=${username}`]);
    if (!found.length) throw new Error('PPPoE secret not found on router.');
    await conn.write('/ppp/secret/set', [`=.id=${found[0]['.id']}`, `=disabled=${enabled ? 'no' : 'yes'}`]);
    if (!enabled) await disconnectActiveInternal(conn, username);
    return { ok: true };
  } finally {
    conn.close();
  }
}

/**
 * Change a PPPoE subscriber's password (used by the reset-password
 * endpoint) - kicks their active session too, since RouterOS doesn't
 * re-validate an already-connected PPP session against the new password.
 */
async function changePppoeSecretPassword(site, username, newPassword) {
  assertSafe(username, SAFE_IDENTIFIER, 'PPPoE username');
  if (typeof newPassword !== 'string' || !NO_CONTROL_CHARS.test(newPassword) || newPassword.length < 8) {
    throw new Error('Refusing to send unsafe/weak PPPoE password to router.');
  }
  const conn = await connect(site);
  try {
    const found = await conn.write('/ppp/secret/print', [`?name=${username}`]);
    if (!found.length) throw new Error('PPPoE secret not found on router.');
    await conn.write('/ppp/secret/set', [`=.id=${found[0]['.id']}`, `=password=${newPassword}`]);
    await disconnectActiveInternal(conn, username);
    return { ok: true };
  } finally {
    conn.close();
  }
}

/**
 * Kick a specific subscriber's active PPP session (does not touch the
 * /ppp/secret account itself - use setPppoeSecretEnabled to actually block
 * future reconnects).
 */
async function disconnectPppoeSession(site, username) {
  assertSafe(username, SAFE_IDENTIFIER, 'PPPoE username');
  const conn = await connect(site);
  try {
    await disconnectActiveInternal(conn, username);
    return { ok: true };
  } finally {
    conn.close();
  }
}

async function disconnectActiveInternal(conn, username) {
  const active = await conn.write('/ppp/active/print', [`?name=${username}`]);
  for (const session of active) {
    await conn.write('/ppp/active/remove', [`=.id=${session['.id']}`]);
  }
}

/**
 * Live status for one subscriber - used by the admin UI to show
 * connected/idle plus current session stats without listing every session
 * on the router.
 */
async function getPppoeSessionStatus(site, username) {
  assertSafe(username, SAFE_IDENTIFIER, 'PPPoE username');
  const conn = await connect(site);
  try {
    const active = await conn.write('/ppp/active/print', [`?name=${username}`]);
    if (!active.length) return { connected: false };
    const s = active[0];
    return {
      connected: true,
      address: s.address,
      uptime: s.uptime,
      callerId: s['caller-id'],
      service: s.service,
    };
  } finally {
    conn.close();
  }
}

/**
 * List every active PPP session on a site (admin overview, not
 * per-subscriber) - separate from listActiveClients, which is hotspot-only.
 */
async function listActivePppoeSessions(site) {
  const conn = await connect(site);
  try {
    const active = await conn.write('/ppp/active/print');
    return active.map((s) => ({
      name: s.name,
      address: s.address,
      uptime: s.uptime,
      callerId: s['caller-id'],
      service: s.service,
    }));
  } finally {
    conn.close();
  }
}

module.exports = {
  createHotspotUser,
  removeHotspotUser,
  ping,
  listActiveClients,
  listAccessPoints,
  createPppoeSecret,
  removePppoeSecret,
  setPppoeSecretEnabled,
  changePppoeSecretPassword,
  disconnectPppoeSession,
  getPppoeSessionStatus,
  listActivePppoeSessions,
};
