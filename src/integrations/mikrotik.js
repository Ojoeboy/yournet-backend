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

module.exports = { createHotspotUser, removeHotspotUser, ping, listActiveClients, listAccessPoints };
