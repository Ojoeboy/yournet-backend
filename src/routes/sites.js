const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const mikrotik = require('../integrations/mikrotik');
const omada = require('../integrations/omada');
const unifi = require('../integrations/unifi');
const meraki = require('../integrations/meraki');
const { encrypt, decrypt } = require('../utils/credentialCrypto');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.post('/', asyncHandler(async (req, res) => {
  const { name, type, mikrotik: mk, omada: om, unifi: uf, meraki: mr } = req.body;
  const missingError = validate.required(req.body, ['name', 'type']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!['mikrotik', 'omada', 'unifi', 'meraki'].includes(type)) return res.status(400).json({ error: "type must be 'mikrotik', 'omada', 'unifi', or 'meraki'" });
  if (uf?.authMode && !['classic', 'unifios'].includes(uf.authMode)) {
    return res.status(400).json({ error: "unifi.authMode must be 'classic' or 'unifios'" });
  }

  const { rows } = await pool.query(
    `INSERT INTO sites (tenant_id, name, type, mk_host, mk_api_port, mk_username,
       mk_password_encrypted, mk_hotspot_profile, omada_base_url, omada_client_id,
       omada_client_secret_encrypted, omada_omadac_id, omada_site_id,
       unifi_base_url, unifi_username, unifi_password_encrypted, unifi_site,
       unifi_auth_mode, unifi_api_key_encrypted,
       meraki_dashboard_api_key_encrypted, meraki_network_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id, name, type, status`,
    [
      req.tenantId, name, type,
      mk?.host, mk?.port || 8728, mk?.username, encrypt(mk?.password), mk?.hotspotProfile,
      om?.baseUrl, om?.clientId, encrypt(om?.clientSecret), om?.omadacId, om?.siteId,
      uf?.baseUrl, uf?.username, encrypt(uf?.password), uf?.site || 'default',
      uf?.authMode || 'classic', encrypt(uf?.apiKey),
      encrypt(mr?.dashboardApiKey), mr?.networkId,
    ]
  );
  res.json(rows[0]);
}));

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, type, status, last_checked_at FROM sites WHERE tenant_id=$1`,
    [req.tenantId]
  );
  res.json(rows);
}));

// Update an existing site's credentials - re-encrypts on save. This exists
// specifically so a site created before encryption was wired in (or one
// whose router password changed) can be fixed in place, without deleting
// the site and orphaning any vouchers already linked to it.
router.patch('/:id', asyncHandler(async (req, res) => {
  const { rows: existing } = await pool.query('SELECT id FROM sites WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!existing.length) return res.status(404).json({ error: 'Site not found' });

  const { name, mikrotik: mk, omada: om, unifi: uf, meraki: mr } = req.body;
  if (uf?.authMode && !['classic', 'unifios'].includes(uf.authMode)) {
    return res.status(400).json({ error: "unifi.authMode must be 'classic' or 'unifios'" });
  }

  const { rows } = await pool.query(
    `UPDATE sites SET
       name = COALESCE($1, name),
       mk_host = COALESCE($2, mk_host),
       mk_api_port = COALESCE($3, mk_api_port),
       mk_username = COALESCE($4, mk_username),
       mk_password_encrypted = COALESCE($5, mk_password_encrypted),
       mk_hotspot_profile = COALESCE($6, mk_hotspot_profile),
       omada_base_url = COALESCE($7, omada_base_url),
       omada_client_id = COALESCE($8, omada_client_id),
       omada_client_secret_encrypted = COALESCE($9, omada_client_secret_encrypted),
       omada_omadac_id = COALESCE($10, omada_omadac_id),
       omada_site_id = COALESCE($11, omada_site_id),
       unifi_base_url = COALESCE($12, unifi_base_url),
       unifi_username = COALESCE($13, unifi_username),
       unifi_password_encrypted = COALESCE($14, unifi_password_encrypted),
       unifi_site = COALESCE($15, unifi_site),
       unifi_auth_mode = COALESCE($16, unifi_auth_mode),
       unifi_api_key_encrypted = COALESCE($17, unifi_api_key_encrypted),
       meraki_dashboard_api_key_encrypted = COALESCE($18, meraki_dashboard_api_key_encrypted),
       meraki_network_id = COALESCE($19, meraki_network_id),
       status = 'unconfigured'
     WHERE id=$20 AND tenant_id=$21
     RETURNING id, name, type, status`,
    [
      name, mk?.host, mk?.port, mk?.username, encrypt(mk?.password), mk?.hotspotProfile,
      om?.baseUrl, om?.clientId, encrypt(om?.clientSecret), om?.omadacId, om?.siteId,
      uf?.baseUrl, uf?.username, encrypt(uf?.password), uf?.site,
      uf?.authMode, encrypt(uf?.apiKey),
      encrypt(mr?.dashboardApiKey), mr?.networkId,
      req.params.id, req.tenantId,
    ]
  );
  res.json(rows[0]);
}));

// Real connectivity test - actually pings the router/controller, no fake data.
router.post('/:id/test', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });
  const site = rows[0];

  try {
    let result;
    if (site.type === 'mikrotik') {
      result = await mikrotik.ping({ ...site, mk_password_decrypted: decrypt(site.mk_password_encrypted) });
    } else if (site.type === 'unifi') {
      result = await unifi.ping({
        ...site,
        unifi_password_decrypted: decrypt(site.unifi_password_encrypted),
        unifi_api_key_decrypted: decrypt(site.unifi_api_key_encrypted),
      });
    } else if (site.type === 'meraki') {
      result = await meraki.ping({
        ...site,
        meraki_dashboard_api_key_decrypted: decrypt(site.meraki_dashboard_api_key_encrypted),
      });
    } else {
      const token = await omada.getAccessToken({ ...site, omada_client_secret_decrypted: decrypt(site.omada_client_secret_encrypted) });
      result = { online: !!token };
    }
    await pool.query('UPDATE sites SET status=$1, last_checked_at=now() WHERE id=$2', [
      result.online ? 'online' : 'error', site.id,
    ]);
    res.json(result);
  } catch (err) {
    await pool.query('UPDATE sites SET status=$1, last_checked_at=now() WHERE id=$2', ['error', site.id]);
    res.status(502).json({ online: false, error: err.message });
  }
}));

// Generates a downloadable RouterOS .rsc starting config for this site,
// built from the tenant's REAL packages plus the network shape they
// describe in the wizard (see public/rsc-wizard.html). This branches on:
//
//   - WAN type: DHCP / static IP / PPPoE (fiber, DSL, some 4G setups)
//   - Wired AP ports: any number of ethernet ports, not a fixed ether2-5
//   - Wireless backhaul links: for APs too far to run a cable to, this
//     generates a WDS station-bridge link per remote AP - the main router
//     broadcasts a private backhaul SSID, and the remote AP must be
//     separately configured (once, on that device) to connect to it as a
//     WDS station. That remote-side setup can't be pushed from here.
//
// HONEST LIMITS, stated plainly rather than glossed over:
//   - Wireless config uses the legacy `/interface wireless` syntax, which
//     covers most RouterOS 6 devices and many RouterOS 7 devices on
//     older wireless chips. Newer Wi-Fi 6/6E hardware on RouterOS 7 often
//     uses the newer `/interface wifi` (wifiwave2) syntax instead - if
//     your router uses that, this section needs adapting, not copy-paste.
//   - This assumes the ROUTER ITSELF has a wireless radio capable of
//     WDS/AP-bridge mode. A radio-less model (like a hEX S) cannot do the
//     wireless-backhaul part at all - only the wired-port section applies.
router.post('/:id/rsc-config', asyncHandler(async (req, res) => {
  const { rows: siteRows } = await pool.query('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!siteRows.length) return res.status(404).json({ error: 'Site not found' });
  const site = siteRows[0];

  const { rows: packages } = await pool.query(
    `SELECT * FROM packages WHERE tenant_id=$1 AND active=true ORDER BY price ASC`,
    [req.tenantId]
  );

  const {
    wanType = 'dhcp',            // 'dhcp' | 'static' | 'pppoe'
    wanInterface = 'ether1',
    staticAddress, staticGateway, // used when wanType === 'static'
    pppoeUsername, pppoePassword, // used when wanType === 'pppoe'
    wiredPorts = [2, 3, 4, 5],    // ether port numbers for the wired AP bridge
    routerHasWifi = false,
    wirelessLinks = [],           // [{ name, ssid, password }] - one per remote wireless AP
  } = req.body || {};

  const slug = site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'yournet';
  const hotspotProfile = site.mk_hotspot_profile || 'default';
  const bridgeName = `bridge-${slug}`;

  const profileLines = packages.map((p) => {
    const rate = p.rate_limit_up && p.rate_limit_down ? `${p.rate_limit_up}/${p.rate_limit_down}` : '';
    return `/ip hotspot user profile add name="${slug}-${p.label.toLowerCase().replace(/\s+/g, '-')}"` +
      (rate ? ` rate-limit="${rate}"` : '') +
      ` session-timeout=${p.duration_minutes}m`;
  });

  // --- WAN section, branches by type ---
  let wanSection;
  if (wanType === 'static') {
    wanSection = `# Static WAN IP
/ip address add address=${staticAddress || '<FILL-IN-YOUR-STATIC-IP>/24'} interface=${wanInterface}
/ip route add gateway=${staticGateway || '<FILL-IN-YOUR-GATEWAY>'}`;
  } else if (wanType === 'pppoe') {
    wanSection = `# PPPoE WAN (fiber/DSL-style connections)
/interface pppoe-client add interface=${wanInterface} user="${pppoeUsername || '<FILL-IN-PPPOE-USERNAME>'}" password="${pppoePassword || '<FILL-IN-PPPOE-PASSWORD>'}" name=pppoe-out1 add-default-route=yes disabled=no`;
  } else {
    wanSection = `# DHCP client WAN (typical for Starlink-style Ethernet-in setups)
/ip dhcp-client add interface=${wanInterface} disabled=no`;
  }
  const natOutInterface = wanType === 'pppoe' ? 'pppoe-out1' : wanInterface;

  // --- Wired AP bridge ports ---
  const wiredPortLines = wiredPorts.map((n) => `/interface bridge port add bridge=${bridgeName} interface=ether${n}`);

  // --- Wireless backhaul links to remote APs (only if this router has its own radio) ---
  let wirelessSection = '';
  if (routerHasWifi && wirelessLinks.length) {
    wirelessSection = `\n# Wireless backhaul links - one WDS station-bridge per remote AP.
# IMPORTANT: each remote AP must ALSO be configured (once, on that device)
# as a WDS station connecting to the matching SSID below - this file only
# configures THIS router's side of each link.
${wirelessLinks.map((link, i) => {
  const ifaceName = `wlan-link${i + 1}`;
  return `/interface wireless add name=${ifaceName} mode=ap-bridge ssid="${link.ssid || `${slug}-link${i + 1}`}" wds-mode=dynamic wds-default-bridge=${bridgeName} disabled=no comment="Backhaul to: ${link.name || 'remote AP ' + (i + 1)}"
/interface wireless security-profiles add name=${ifaceName}-sec mode=dynamic-keys authentication-types=wpa2-psk wpa2-pre-shared-key="${link.password || '<SET-A-STRONG-PASSWORD>'}"
/interface wireless set ${ifaceName} security-profile=${ifaceName}-sec`;
}).join('\n')}`;
  }

  const rsc = `# YourNet Control - RouterOS starting config for site: ${site.name}
# Generated from your actual packages and network shape - REVIEW before importing.
# See comments above the wireless section (if present) for real limitations.

${wanSection}

/interface bridge add name=${bridgeName}
${wiredPortLines.join('\n') || '# No wired AP ports specified'}
${wirelessSection}

/ip pool add name=${slug}-pool ranges=10.5.0.10-10.5.0.254
/ip address add address=10.5.0.1/24 interface=${bridgeName}

/ip firewall nat add chain=srcnat out-interface=${natOutInterface} action=masquerade comment="${site.name} internet uplink"

/ip hotspot profile add name="${hotspotProfile}" hotspot-address=10.5.0.1 login-by=http-chap

/ip hotspot add name="${slug}-hotspot" interface=${bridgeName} address-pool=${slug}-pool profile="${hotspotProfile}"

# One profile per package, with the actual limits set in your app:
${profileLines.join('\n') || '# No active packages yet - create some in /admin first.'}
`;

  res.type('text/plain').attachment(`${slug}-mikrotik-config.rsc`).send(rsc);
}));

// Portal branding - separate from the router-credentials PATCH above on
// purpose: saving a logo/color shouldn't reset the site's connection
// status to 'unconfigured' the way a credentials change should.
router.get('/:id/portal', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, portal_business_name, portal_logo_url, portal_primary_color, portal_custom_html
     FROM sites WHERE id=$1 AND tenant_id=$2`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });
  res.json(rows[0]);
}));

router.patch('/:id/portal', asyncHandler(async (req, res) => {
  const { rows: existing } = await pool.query('SELECT id FROM sites WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!existing.length) return res.status(404).json({ error: 'Site not found' });

  const { businessName, logoUrl, primaryColor, customHtml } = req.body;

  // Basic sanity check on the color so a typo doesn't silently break the
  // portal page's CSS - not full validation, just catches the obvious case.
  if (primaryColor && !/^#[0-9A-Fa-f]{6}$/.test(primaryColor)) {
    return res.status(400).json({ error: 'primaryColor must be a hex code like #2EC4B6' });
  }

  const { rows } = await pool.query(
    `UPDATE sites SET
       portal_business_name = COALESCE($1, portal_business_name),
       portal_logo_url = COALESCE($2, portal_logo_url),
       portal_primary_color = COALESCE($3, portal_primary_color),
       portal_custom_html = COALESCE($4, portal_custom_html)
     WHERE id=$5 AND tenant_id=$6
     RETURNING id, portal_business_name, portal_logo_url, portal_primary_color, portal_custom_html`,
    [businessName, logoUrl, primaryColor, customHtml, req.params.id, req.tenantId]
  );
  res.json(rows[0]);
}));

// Revert from a custom HTML portal back to the built-in default template.
router.delete('/:id/portal/custom-html', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE sites SET portal_custom_html = NULL WHERE id=$1 AND tenant_id=$2 RETURNING id`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });
  res.json({ ok: true });
}));

module.exports = router;
