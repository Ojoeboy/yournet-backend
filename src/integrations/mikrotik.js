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
  const conn = new RouterOSAPI({
    host: site.mk_host,
    user: site.mk_username,
    password: site.mk_password_decrypted, // decrypt before calling this module
    port: site.mk_api_port || 8728,
    timeout: 8,
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
  if (!site.mk_host) {
    return { online: false, error: 'No router IP address is set for this site - fill it in and save the site again.' };
  }
  try {
    const conn = await connect(site);
    const identity = await conn.write('/system/identity/print');
    conn.close();
    return { online: true, identity: identity[0]?.name };
  } catch (err) {
    // Some failure modes from the underlying RouterOS client reject with
    // something other than a proper Error (a bare string, or an object with
    // no .message) - never let that surface as a blank/"unknown" error, since
    // that gives the tenant nothing to act on.
    const reason = (err && err.message) ? err.message : String(err || 'connection failed');
    return { online: false, error: `${reason} - check the router IP, API port, and credentials` };
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

module.exports = { createHotspotUser, removeHotspotUser, ping, listActiveClients };