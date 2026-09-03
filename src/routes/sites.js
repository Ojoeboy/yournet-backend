const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireNotAgent } = require('../middleware/auth');
const mikrotik = require('../integrations/mikrotik');
const omada = require('../integrations/omada');
const unifi = require('../integrations/unifi');
const meraki = require('../integrations/meraki');
const ruijie = require('../integrations/ruijie');
const { encrypt, decrypt } = require('../utils/credentialCrypto');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const storage = require('../services/storage');
const { buildMikrotikRsc } = require('../utils/mikrotikConfigGen');

const router = express.Router();
router.use(requireAuth, requireNotAgent);

router.post('/', asyncHandler(async (req, res) => {
  const { name, type, mikrotik: mk, omada: om, unifi: uf, meraki: mr, ruijie: rj } = req.body;
  const missingError = validate.required(req.body, ['name', 'type']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!['mikrotik', 'omada', 'unifi', 'meraki', 'ruijie'].includes(type)) return res.status(400).json({ error: "type must be 'mikrotik', 'omada', 'unifi', 'meraki', or 'ruijie'" });
  if (uf?.authMode && !['classic', 'unifios'].includes(uf.authMode)) {
    return res.status(400).json({ error: "unifi.authMode must be 'classic' or 'unifios'" });
  }

  const { rows } = await pool.query(
    `INSERT INTO sites (tenant_id, name, type, mk_host, mk_api_port, mk_username,
       mk_password_encrypted, mk_hotspot_profile, mk_use_tls, omada_base_url, omada_client_id,
       omada_client_secret_encrypted, omada_omadac_id, omada_site_id,
       unifi_base_url, unifi_username, unifi_password_encrypted, unifi_site,
       unifi_auth_mode, unifi_api_key_encrypted,
       meraki_dashboard_api_key_encrypted, meraki_network_id,
       ruijie_account, ruijie_account_password_encrypted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id, name, type, status`,
    [
      req.tenantId, name, type,
      mk?.host, mk?.port || (mk?.useTls ? 8729 : 8728), mk?.username, encrypt(mk?.password), mk?.hotspotProfile,
      !!mk?.useTls,
      om?.baseUrl, om?.clientId, encrypt(om?.clientSecret), om?.omadacId, om?.siteId,
      uf?.baseUrl, uf?.username, encrypt(uf?.password), uf?.site || 'default',
      uf?.authMode || 'classic', encrypt(uf?.apiKey),
      encrypt(mr?.dashboardApiKey), mr?.networkId,
      // Optional even for type='ruijie' - only needed for the nice-to-have
      // Ruijie Cloud REST sync (integrations/ruijie.js), never for the
      // load-bearing radius/ruijie_cloud access paths.
      rj?.account, encrypt(rj?.accountPassword),
    ]
  );
  res.json(rows[0]);
}));

router.get('/', asyncHandler(async (req, res) => {
  // Mirrors packages: default to active-only (keeps dropdowns clean), the
  // site-management screen passes ?all=true to also see deactivated ones.
  const includeInactive = req.query.all === 'true';
  const { rows } = await pool.query(
    `SELECT id, name, type, status, active, last_checked_at, mk_auth_mode FROM sites
     WHERE tenant_id=$1 ${includeInactive ? '' : 'AND active=true'} ORDER BY name ASC`,
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

  const { name, active, mikrotik: mk, omada: om, unifi: uf, meraki: mr, ruijie: rj } = req.body;
  if (uf?.authMode && !['classic', 'unifios'].includes(uf.authMode)) {
    return res.status(400).json({ error: "unifi.authMode must be 'classic' or 'unifios'" });
  }

  // Only force a re-test (status -> 'unconfigured') when router/controller
  // credentials actually changed. A pure active/inactive toggle (the
  // deactivate button) shouldn't wipe a site's verified connection status.
  const credentialsChanged = !!(mk || om || uf || mr || rj);

  const { rows } = await pool.query(
    `UPDATE sites SET
       name = COALESCE($1, name),
       mk_host = COALESCE($2, mk_host),
       mk_api_port = COALESCE($3, mk_api_port),
       mk_username = COALESCE($4, mk_username),
       mk_password_encrypted = COALESCE($5, mk_password_encrypted),
       mk_hotspot_profile = COALESCE($6, mk_hotspot_profile),
       mk_use_tls = COALESCE($7, mk_use_tls),
       omada_base_url = COALESCE($8, omada_base_url),
       omada_client_id = COALESCE($9, omada_client_id),
       omada_client_secret_encrypted = COALESCE($10, omada_client_secret_encrypted),
       omada_omadac_id = COALESCE($11, omada_omadac_id),
       omada_site_id = COALESCE($12, omada_site_id),
       unifi_base_url = COALESCE($13, unifi_base_url),
       unifi_username = COALESCE($14, unifi_username),
       unifi_password_encrypted = COALESCE($15, unifi_password_encrypted),
       unifi_site = COALESCE($16, unifi_site),
       unifi_auth_mode = COALESCE($17, unifi_auth_mode),
       unifi_api_key_encrypted = COALESCE($18, unifi_api_key_encrypted),
       meraki_dashboard_api_key_encrypted = COALESCE($19, meraki_dashboard_api_key_encrypted),
       meraki_network_id = COALESCE($20, meraki_network_id),
       ruijie_account = COALESCE($25, ruijie_account),
       ruijie_account_password_encrypted = COALESCE($26, ruijie_account_password_encrypted),
       active = COALESCE($21, active),
       status = CASE WHEN $24 THEN 'unconfigured' ELSE status END
     WHERE id=$22 AND tenant_id=$23
     RETURNING id, name, type, status, active`,
    [
      name, mk?.host, mk?.port, mk?.username, encrypt(mk?.password), mk?.hotspotProfile,
      typeof mk?.useTls === 'boolean' ? mk.useTls : null,
      om?.baseUrl, om?.clientId, encrypt(om?.clientSecret), om?.omadacId, om?.siteId,
      uf?.baseUrl, uf?.username, encrypt(uf?.password), uf?.site,
      uf?.authMode, encrypt(uf?.apiKey),
      encrypt(mr?.dashboardApiKey), mr?.networkId,
      typeof active === 'boolean' ? active : null,
      req.params.id, req.tenantId, credentialsChanged || !!rj,
      rj?.account, encrypt(rj?.accountPassword),
    ]
  );
  res.json(rows[0]);
}));

// Sites are only ever hard-deleted if nothing references them yet - mirrors
// the packages.js pattern. vouchers.site_id and voucher_orders.site_id have
// no CASCADE, but pppoe_subscribers.site_id DOES cascade-delete at the DB
// level, which is exactly the case this guard exists to prevent: deleting a
// site that still has recurring PPPoE subscribers would otherwise silently
// wipe their billing records along with it. If the site has been used for
// any of the three, the honest move (and what this returns as guidance) is
// to deactivate it instead.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows: existing } = await pool.query('SELECT id FROM sites WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!existing.length) return res.status(404).json({ error: 'Site not found.' });

  const { rows: usage } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM vouchers WHERE site_id=$1)::int AS voucher_count,
       (SELECT COUNT(*) FROM voucher_orders WHERE site_id=$1)::int AS order_count,
       (SELECT COUNT(*) FROM pppoe_subscribers WHERE site_id=$1)::int AS pppoe_count`,
    [req.params.id]
  );
  const used = usage[0].voucher_count + usage[0].order_count + usage[0].pppoe_count;
  if (used > 0) {
    return res.status(409).json({
      error: `This site has already been used for ${used} voucher(s)/order(s)/PPPoE subscriber(s), so deleting it would break that history. Deactivate it instead - it'll stop appearing for new vouchers but existing ones keep working.`,
      usedCount: used,
    });
  }

  await pool.query('DELETE FROM sites WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
}));

// Fetch hotspot server profiles directly from a Mikrotik router using
// credentials typed into the Router setup form, before the site is even
// saved - lets the "Hotspot profile" field be a real dropdown of what's
// actually configured on the router instead of free text.
router.post('/mikrotik/hotspot-profiles', asyncHandler(async (req, res) => {
  const { host, port, username, password, useTls } = req.body || {};
  const missingError = validate.required(req.body, ['host', 'username', 'password']);
  if (missingError) return res.status(400).json({ error: missingError });

  try {
    const profiles = await mikrotik.listHotspotProfiles({
      mk_host: host,
      mk_api_port: port || undefined,
      mk_username: username,
      mk_password_decrypted: password,
      mk_use_tls: !!useTls,
    });
    res.json({ profiles });
  } catch (err) {
    res.status(400).json({ error: 'Could not connect to the router: ' + err.message });
  }
}));

// Real connectivity test - actually pings the router/controller, no fake data.
router.post('/:id/test', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });
  const site = rows[0];

  try {
    let result;
    if (site.type === 'ruijie') {
      if (site.mk_auth_mode === 'ruijie_cloud' && site.ruijie_account) {
        // A real check IS possible here - unlike the RADIUS-only case
        // below, integrations/ruijie.js's login() can actually confirm the
        // stored Ruijie Cloud account/password work. It does NOT confirm
        // the Auth/Accounting callback itself is reachable or correctly
        // configured in Ruijie Cloud's dashboard - only that these
        // credentials authenticate.
        result = await ruijie.ping({
          ...site,
          ruijie_account_password_decrypted: decrypt(site.ruijie_account_password_encrypted),
        });
      } else {
        // Either plain RADIUS mode, or ruijie_cloud mode with no Ruijie
        // Cloud account/password on file yet (that's optional - only
        // needed for the nice-to-have REST sync, not for the auth callback
        // itself). Either way there's nothing to reach out and ping for
        // the load-bearing path - the only real signal it's working is a
        // RADIUS Access-Request or a Cloud Auth callback actually
        // arriving, visible in server logs, not something checkable here.
        return res.json({
          online: null,
          notApplicable: true,
          message: site.mk_auth_mode === 'radius'
            ? 'Ruijie sites in RADIUS mode have no live connection test. Verify by connecting the gateway and checking that logins are being accepted.'
            : 'Add this site\'s Ruijie Cloud account/password to test connectivity, or verify by checking that Cloud Auth callbacks are arriving in the server logs.',
        });
      }
    } else if (site.type === 'mikrotik') {
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
//     generates a backhaul link per remote AP - the main router broadcasts
//     a private backhaul SSID, and the remote AP must be separately
//     configured (once, on that device) to connect to it as a station. That
//     remote-side setup can't be pushed from here.
//
// HONEST LIMITS, stated plainly rather than glossed over:
//   - Wireless config comes in two syntaxes, chosen via wirelessSyntax:
//       'legacy' - the `/interface wireless` menu, for RouterOS 6 and most
//                  RouterOS 7 devices on older (pre-Wi-Fi 6) wireless chips.
//                  Uses a WDS station-bridge link per remote AP.
//       'wifi6'  - RouterOS 7's newer unified `/interface wifi` package
//                  (Wi-Fi 6/6E chips, e.g. the wifi-qcom driver). Uses
//                  native AP/station-bridge mode instead of WDS. The
//                  property names here (configuration.mode, security.*,
//                  datapath.bridge) are confirmed against MikroTik's own
//                  documentation, not guessed - but this codebase hasn't
//                  run it against real Wi-Fi 6/6E hardware, so treat it as
//                  a strong starting point to review, not a proven
//                  drop-in. If a router only has one built-in radio, only
//                  the first backhaul link can use it directly - more
//                  simultaneous links need a second radio or a virtual AP
//                  interface, which this generator doesn't create.
//     Picking the wrong one for your hardware needs adapting, not
//     copy-paste - if you're not sure which package your router runs,
//     check Winbox/WebFig under Interfaces for a "WiFi" vs "Wireless" menu.
//   - This assumes the ROUTER ITSELF has a wireless radio capable of
//     AP-bridge/station mode. A radio-less model (like a hEX S) cannot do
//     the wireless-backhaul part at all - only the wired-port section
//     applies.
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

  let built;
  try {
    built = buildMikrotikRsc(site, packages, req.body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  res.type('text/plain').attachment(`${built.slug}-mikrotik-config.rsc`).send(built.rsc);
}));

// Portal branding - separate from the router-credentials PATCH above on
// purpose: saving a logo/color shouldn't reset the site's connection
// status to 'unconfigured' the way a credentials change should.
const PORTAL_FIELDS = `id, portal_business_name, portal_logo_url, portal_primary_color, portal_custom_html,
     portal_background_image_url, portal_caution_text, portal_whatsapp_number, portal_help_email, portal_help_phone,
     portal_momo_number, portal_momo_name, portal_use_rotating_backgrounds`;

router.get('/:id/portal', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${PORTAL_FIELDS} FROM sites WHERE id=$1 AND tenant_id=$2`,
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

  const {
    businessName, logoUrl, primaryColor, customHtml,
    backgroundImageUrl, cautionText, whatsappNumber, helpEmail, helpPhone, momoNumber, momoName,
    useRotatingBackgrounds,
  } = req.body;

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
       portal_custom_html = COALESCE($4, portal_custom_html),
       portal_background_image_url = COALESCE($5, portal_background_image_url),
       portal_caution_text = COALESCE($6, portal_caution_text),
       portal_whatsapp_number = COALESCE($7, portal_whatsapp_number),
       portal_help_email = COALESCE($8, portal_help_email),
       portal_help_phone = COALESCE($9, portal_help_phone),
       portal_momo_number = COALESCE($10, portal_momo_number),
       portal_momo_name = COALESCE($11, portal_momo_name),
       portal_use_rotating_backgrounds = COALESCE($12, portal_use_rotating_backgrounds)
     WHERE id=$13 AND tenant_id=$14
     RETURNING ${PORTAL_FIELDS}`,
    [businessName, logoUrl, primaryColor, customHtml,
      backgroundImageUrl, cautionText, whatsappNumber, helpEmail, helpPhone, momoNumber, momoName,
      // COALESCE only substitutes on NULL, not on false, so an explicit
      // `false` here correctly turns the toggle off - only a genuinely
      // missing field (undefined -> null) leaves the existing value alone.
      typeof useRotatingBackgrounds === 'boolean' ? useRotatingBackgrounds : null,
      req.params.id, req.tenantId]
  );
  res.json(rows[0]);
}));

// Portal logo upload - same pattern as the account logo in dashboard.js:
// memory storage only (Render's disk is ephemeral), file is uploaded to R2
// object storage and only the resulting URL is saved into
// sites.portal_logo_url instead of a base64 blob.
const portalLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1.5 * 1024 * 1024 }, // 1.5MB - a portal logo is small/square
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error('Logo must be a PNG, JPEG, WEBP, or GIF image'));
    }
    cb(null, true);
  },
});

router.post('/:id/portal-logo', asyncHandler(async (req, res) => {
  const { rows: existing } = await pool.query('SELECT id, portal_logo_url FROM sites WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!existing.length) return res.status(404).json({ error: 'Site not found' });
  const oldLogoUrl = existing[0].portal_logo_url;

  portalLogoUpload.single('logo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const logoUrl = await storage.uploadLogo(req.file.buffer, req.file.mimetype, 'portal-logos');
    const { rows } = await pool.query(
      'UPDATE sites SET portal_logo_url=$1 WHERE id=$2 AND tenant_id=$3 RETURNING portal_logo_url',
      [logoUrl, req.params.id, req.tenantId]
    );
    // Only actually deletes if nothing else (this tenant's account_logo,
    // or another site) still points at the old URL - see
    // storage.deleteLogoIfUnused. Matters because "Use account saved
    // logo" can leave the account logo and a site's portal logo pointing
    // at the exact same R2 object.
    storage.deleteLogoIfUnused(pool, oldLogoUrl).catch(() => {});
    res.json({ ok: true, logoUrl: rows[0].portal_logo_url });
  });
}));

// "Use account saved logo" - copies tenants.account_logo straight into
// sites.portal_logo_url in one query, entirely server-side. The browser
// only sends the site id, never the base64 image itself, so this can
// never hit a request body size limit no matter how large a logo gets -
// unlike the old approach (GET the account logo, then PATCH it back to
// /portal in a JSON body), which is exactly what produced the "Unexpected
// token '<'" error for this button even after the JSON limit was raised.
router.post('/:id/portal-logo/from-account', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE sites SET portal_logo_url = (SELECT account_logo FROM tenants WHERE id = sites.tenant_id)
     WHERE id=$1 AND tenant_id=$2 RETURNING portal_logo_url`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });
  if (!rows[0].portal_logo_url) return res.status(400).json({ error: 'No account logo saved yet - upload one in Account first.' });
  res.json({ ok: true, logoUrl: rows[0].portal_logo_url });
}));

// "Use account WhatsApp" - same one-query server-side copy pattern as the
// logo button above. The "effective" business WhatsApp number depends on
// the tenant's business_whatsapp_mode: 'account' uses admin_whatsapp,
// 'custom' uses business_whatsapp_custom, 'none' means the business
// doesn't want WhatsApp messages - resolved here with a CASE so the
// browser only ever sends the site id.
router.post('/:id/portal-whatsapp/from-account', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE sites SET portal_whatsapp_number = (
       SELECT CASE t.business_whatsapp_mode
         WHEN 'custom' THEN t.business_whatsapp_custom
         WHEN 'account' THEN t.admin_whatsapp
         ELSE NULL
       END
       FROM tenants t WHERE t.id = sites.tenant_id
     )
     WHERE id=$1 AND tenant_id=$2 RETURNING portal_whatsapp_number`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });
  if (!rows[0].portal_whatsapp_number) return res.status(400).json({ error: 'No business WhatsApp number saved yet - set one in Account first (or it may be set to "none").' });
  res.json({ ok: true, whatsappNumber: rows[0].portal_whatsapp_number });
}));

// Clear a single optional portal field back to "not shown" (NULL) - the
// PATCH above uses COALESCE so it can only set values, never blank one out.
// Body: { field: 'logoUrl' | 'backgroundImageUrl' | 'cautionText' | 'whatsappNumber' | 'helpEmail' | 'helpPhone' | 'momoNumber' | 'momoName' }
const CLEARABLE_PORTAL_FIELDS = {
  logoUrl: 'portal_logo_url',
  backgroundImageUrl: 'portal_background_image_url',
  cautionText: 'portal_caution_text',
  whatsappNumber: 'portal_whatsapp_number',
  helpEmail: 'portal_help_email',
  helpPhone: 'portal_help_phone',
  momoNumber: 'portal_momo_number',
  momoName: 'portal_momo_name',
};
router.post('/:id/portal/clear-field', asyncHandler(async (req, res) => {
  const column = CLEARABLE_PORTAL_FIELDS[req.body.field];
  if (!column) return res.status(400).json({ error: `field must be one of: ${Object.keys(CLEARABLE_PORTAL_FIELDS).join(', ')}` });

  // Only the logo field is an R2-hosted file (backgroundImageUrl etc. are
  // plain pasted URLs) - fetched before the UPDATE below so there's an old
  // value to check/delete after clearing. See storage.deleteLogoIfUnused
  // for why this can't just delete unconditionally.
  let oldLogoUrl = null;
  if (req.body.field === 'logoUrl') {
    const { rows: existing } = await pool.query('SELECT portal_logo_url FROM sites WHERE id=$1 AND tenant_id=$2', [
      req.params.id, req.tenantId,
    ]);
    oldLogoUrl = existing[0]?.portal_logo_url || null;
  }

  const { rows } = await pool.query(
    `UPDATE sites SET ${column} = NULL WHERE id=$1 AND tenant_id=$2 RETURNING ${PORTAL_FIELDS}`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });

  if (oldLogoUrl) storage.deleteLogoIfUnused(pool, oldLogoUrl).catch(() => {});

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

// ---------------------------------------------------------------------------
// Manual client access - admin-triggered "authorize this MAC, no voucher"
// bypass (checklist row 4). Separate concept from vouchers: no code, no
// price, no package. Meraki is deliberately excluded from all three routes
// below - its portal-redirect-only architecture means there is no API call
// that can authorize a MAC the device hasn't already tried to connect
// through, so a "type in a MAC, grant access" screen structurally cannot
// work for it (see the router comparison this feature was scoped from).
// ---------------------------------------------------------------------------

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

async function loadSite(req) {
  const { rows } = await pool.query('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  return rows[0] || null;
}

function decryptedSite(site) {
  return {
    ...site,
    mk_password_decrypted: decrypt(site.mk_password_encrypted),
    omada_client_secret_decrypted: decrypt(site.omada_client_secret_encrypted),
    unifi_password_decrypted: decrypt(site.unifi_password_encrypted),
    unifi_api_key_decrypted: decrypt(site.unifi_api_key_encrypted),
  };
}

// List devices the router/controller has actually seen on this site right
// now - lets the admin pick a MAC off a real list instead of having to know
// it from memory. Shape is normalized across vendors; `authorized` is best-
// effort (Omada's Open API client list doesn't clearly expose this the same
// way MikroTik/UniFi do, so it may come back null there rather than a
// guessed true/false).
router.get('/:id/clients', asyncHandler(async (req, res) => {
  const site = await loadSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (site.type === 'meraki') {
    return res.status(400).json({ error: 'Meraki has no API for listing clients this way - see the Router integrations notes on the Setup page.' });
  }

  const decrypted = decryptedSite(site);
  try {
    if (site.type === 'mikrotik') {
      const hosts = await mikrotik.listHotspotHosts(decrypted);
      return res.json({ clients: hosts.map((h) => ({
        mac: h.macAddress, ip: h.address, authorized: h.authorized, hostname: null,
      })) });
    }
    if (site.type === 'unifi') {
      const clients = await unifi.listClients(decrypted);
      return res.json({ clients: clients.map((c) => ({
        mac: c.mac, ip: c.ip, authorized: c.authorized === true, hostname: c.hostname || c.name || null,
      })) });
    }
    // omada
    // Field names below (mac/ip/name/deviceType) are the conventional
    // Omada client-object shape from the older Web API - not confirmed
    // against the Open API's actual response schema (see the verification
    // caveat on omada.authorizeClientManual). Worst case here is a blank
    // column in the picker, not a wrong action, since this route is
    // read-only.
    const clients = await omada.listClients(decrypted);
    return res.json({ clients: clients.map((c) => ({
      mac: c.mac, ip: c.ip, authorized: null, hostname: c.name || c.deviceType || null,
    })) });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch the client list: ' + err.message });
  }
}));

// Currently-active manual grants for this site (for the admin table + so a
// revoke button has something to call against).
router.get('/:id/manual-authorizations', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, client_mac, duration_minutes, note, status, created_at, expires_at
     FROM manual_client_authorizations
     WHERE tenant_id=$1 AND site_id=$2 AND status='active' ORDER BY created_at DESC`,
    [req.tenantId, req.params.id]
  );
  res.json({ authorizations: rows });
}));

router.post('/:id/authorize-client', asyncHandler(async (req, res) => {
  const site = await loadSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (site.type === 'meraki') {
    return res.status(400).json({ error: 'Meraki cannot pre-authorize a MAC from the dashboard - the device has to attempt connecting and go through the splash flow first. This bypass feature does not work for Meraki sites.' });
  }

  const { clientMac, durationMinutes, note } = req.body || {};
  const missingError = validate.required(req.body || {}, ['clientMac', 'durationMinutes']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!MAC_RE.test(clientMac)) return res.status(400).json({ error: 'clientMac must look like AA:BB:CC:DD:EE:FF' });
  if (!validate.isPositiveNumber(durationMinutes) || durationMinutes > 60 * 24 * 30) {
    return res.status(400).json({ error: 'durationMinutes must be a positive number, up to 30 days (43200 minutes).' });
  }

  const decrypted = decryptedSite(site);
  let routerRef = null;
  try {
    if (site.type === 'mikrotik') {
      // No voucher code exists for a manual grant, but RouterOS hotspot
      // users still need SOME unique name/password - generated here,
      // never shown to anyone, since the device is bound by MAC anyway
      // (see mikrotik.createHotspotUser's mac-address binding) so it
      // never needs to be typed in.
      const generatedCode = `manual-${clientMac.replace(/:/g, '')}-${Date.now()}`;
      const result = await mikrotik.createHotspotUser(decrypted, {
        code: generatedCode, durationMinutes, clientMac,
      });
      routerRef = result.providerRef;
    } else if (site.type === 'unifi') {
      await unifi.authorizeClient(decrypted, { clientMac, durationMinutes });
    } else {
      await omada.authorizeClientManual(decrypted, { clientMac, minutes: durationMinutes });
    }
  } catch (err) {
    return res.status(502).json({ error: 'Router/controller rejected the authorization: ' + err.message });
  }

  const { rows } = await pool.query(
    `INSERT INTO manual_client_authorizations
       (tenant_id, site_id, authorized_by, client_mac, duration_minutes, note, router_ref, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($5::text || ' minutes')::interval)
     RETURNING id, client_mac, duration_minutes, note, status, created_at, expires_at`,
    [req.tenantId, site.id, req.userId, clientMac, durationMinutes, note || null, routerRef]
  );
  res.json(rows[0]);
}));

router.post('/:id/revoke-client', asyncHandler(async (req, res) => {
  const site = await loadSite(req);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const { rows: existing } = await pool.query(
    `SELECT * FROM manual_client_authorizations WHERE id=$1 AND tenant_id=$2 AND site_id=$3 AND status='active'`,
    [req.body?.id, req.tenantId, site.id]
  );
  if (!existing.length) return res.status(404).json({ error: 'Active manual authorization not found.' });
  const auth = existing[0];

  const decrypted = decryptedSite(site);
  try {
    if (site.type === 'mikrotik') {
      await mikrotik.removeHotspotUser(decrypted, auth.router_ref);
    } else if (site.type === 'unifi') {
      await unifi.unauthorizeClient(decrypted, auth.client_mac);
    } else if (site.type === 'omada') {
      // Documented as unimplemented in integrations/omada.js - no
      // verified endpoint exists, so this fails loudly rather than
      // pretending to have revoked something it didn't touch.
      return res.status(501).json({
        error: 'Revoking an Omada manual grant early is not supported - no confirmed Open API endpoint for it exists. It will still expire on its own at the time originally set.',
      });
    } else {
      return res.status(400).json({ error: 'Meraki sites have no manual grants to revoke.' });
    }
  } catch (err) {
    return res.status(502).json({ error: 'Router/controller rejected the revoke: ' + err.message });
  }

  await pool.query(
    `UPDATE manual_client_authorizations SET status='revoked', revoked_at=now() WHERE id=$1`,
    [auth.id]
  );
  res.json({ ok: true });
}));

// --- RADIUS mode (CGNAT-safe voucher redemption) ---------------------------
// See integrations/radius.js's header comment for the full "why". This is
// mikrotik/ruijie-only - Omada/UniFi/Meraki are cloud-controller-driven and
// don't have the RouterOS-API-unreachable-behind-CGNAT problem this solves.
// For a ruijie site specifically, RADIUS is only ONE of two alternative
// modes now - see the ruijie-cloud-mode endpoint further down for the other
// (Ruijie Cloud's own "Cloud Auth" HTTP callback, for Reyee/cloud-only
// gateways that don't support a native RADIUS client at all). Enabling one
// mode on a ruijie site clears the other's fields - see both endpoints.

router.get('/:id/radius-config', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT type, mk_auth_mode, radius_nas_identifier, radius_secret_encrypted FROM sites WHERE id=$1 AND tenant_id=$2`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Site not found.' });
  const site = rows[0];
  if (!['mikrotik', 'ruijie'].includes(site.type)) return res.status(400).json({ error: 'RADIUS mode is only available for Mikrotik or Ruijie sites.' });

  res.json({
    mode: site.mk_auth_mode,
    nasIdentifier: site.radius_nas_identifier,
    // Decrypted and re-shown on request, not hidden after the first view -
    // this secret only protects against something reading our DB, not
    // against the tenant who legitimately owns it and needs to put it into
    // their own router. Losing it with no way to see it again would just
    // force a disable/re-enable (and a router reconfig) for no benefit.
    secret: site.mk_auth_mode === 'radius' ? decrypt(site.radius_secret_encrypted) : null,
    authPort: parseInt(process.env.RADIUS_AUTH_PORT || '1812', 10),
    acctPort: parseInt(process.env.RADIUS_ACCT_PORT || '1813', 10),
    // Where the tenant's router should actually send packets - Render
    // routes inbound UDP to whatever host this backend is deployed at.
    // RADIUS_SERVER_HOST isn't inferrable from the HTTP request (that's
    // Render's HTTP-only edge, not the UDP listener), so it has to be
    // configured explicitly once per deployment.
    serverHost: process.env.RADIUS_SERVER_HOST || null,
  });
}));

router.post('/:id/radius-mode', asyncHandler(async (req, res) => {
  const { enable } = req.body;
  if (typeof enable !== 'boolean') return res.status(400).json({ error: 'enable (boolean) is required.' });

  const { rows } = await pool.query(`SELECT type, mk_auth_mode FROM sites WHERE id=$1 AND tenant_id=$2`, [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Site not found.' });
  const site = rows[0];
  if (!['mikrotik', 'ruijie'].includes(site.type)) return res.status(400).json({ error: 'RADIUS mode is only available for Mikrotik or Ruijie sites.' });

  if (!enable) {
    // Secret + NAS-Identifier are cleared, not just left in place with the
    // mode flipped back - an inactive secret sitting encrypted at rest
    // with no purpose is exactly the kind of thing worth not
    // accumulating. Re-enabling later generates a fresh pair, so the
    // router needs reconfiguring either way - simpler to make that
    // explicit than to pretend the old one might still be valid.
    await pool.query(
      `UPDATE sites SET mk_auth_mode='api', radius_secret_encrypted=NULL, radius_nas_identifier=NULL WHERE id=$1`,
      [req.params.id]
    );
    return res.json({ ok: true, mode: 'api' });
  }

  // Random, URL/RouterOS-safe identifier - short enough to type into
  // RouterOS's nas-identifier field without transcription errors, long
  // enough that guessing another tenant's isn't practical. Collisions are
  // possible in principle (this is why the column has a UNIQUE constraint)
  // but astronomically unlikely at this length; on the rare conflict this
  // will throw and the tenant can just retry.
  const nasIdentifier = 'yn-' + crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');

  const { rows: existingActive } = await pool.query(
    `SELECT count(*)::int AS n FROM vouchers WHERE site_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > now())`,
    [req.params.id]
  );
  const activeCount = existingActive[0].n;

  // ruijie_cloud and radius are mutually exclusive on a ruijie site (a
  // gateway is either RADIUS-capable or it isn't) - clear the other mode's
  // callback token when switching, same reasoning as clearing radius
  // fields on disable above: a stale, unused secret sitting encrypted at
  // rest with no purpose is worth cleaning up, not preserving "just in
  // case". Harmless no-op for mikrotik sites, which never have this set.
  await pool.query(
    `UPDATE sites SET mk_auth_mode='radius', radius_secret_encrypted=$1, radius_nas_identifier=$2,
       ruijie_callback_token_encrypted=NULL WHERE id=$3`,
    [encrypt(secret), nasIdentifier, req.params.id]
  );

  res.json({
    ok: true,
    mode: 'radius',
    nasIdentifier,
    secret, // plaintext, this one time - see the GET endpoint above for later re-viewing
    authPort: parseInt(process.env.RADIUS_AUTH_PORT || '1812', 10),
    acctPort: parseInt(process.env.RADIUS_ACCT_PORT || '1813', 10),
    serverHost: process.env.RADIUS_SERVER_HOST || null,
    // Not a hard block - existing active sessions from the old push flow
    // already have their access granted independently by the router and
    // are completely unaffected by this switch. The thing actually worth
    // flagging is the cutover gap: any NEW voucher redemption attempt on
    // the portal page stops working the instant this switch flips, until
    // the router is reconfigured for RADIUS - see routes/portal.js.
    warning: activeCount > 0
      ? `This site has ${activeCount} voucher(s) with an active session right now - those are unaffected. New redemptions won't work until the router is reconfigured for RADIUS (see the setup instructions).`
      : null,
  });
}));

// --- Ruijie Cloud "Cloud Auth" mode (HTTP callback, no RADIUS needed) -----
// Alternative to radius mode above, for Reyee/cloud-only gateways with no
// native RADIUS client - see routes/ruijieCloudAuth.js and
// integrations/ruijie.js's header for the full picture.

router.get('/:id/ruijie-cloud-config', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT type, mk_auth_mode, ruijie_callback_token_encrypted FROM sites WHERE id=$1 AND tenant_id=$2`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Site not found.' });
  const site = rows[0];
  if (site.type !== 'ruijie') return res.status(400).json({ error: 'Cloud Auth mode is only available for Ruijie sites.' });

  const enabled = site.mk_auth_mode === 'ruijie_cloud';
  const base = process.env.PUBLIC_BASE_URL || null;
  const token = enabled ? decrypt(site.ruijie_callback_token_encrypted) : null;

  res.json({
    mode: site.mk_auth_mode,
    // Re-decrypted and re-shown, same reasoning as the RADIUS secret above -
    // the tenant legitimately needs to see this again to (re)configure
    // Ruijie Cloud's dashboard, and hiding it after the first view would
    // just force a disable/re-enable for no security benefit.
    token,
    authUrl: base && token ? `${base}/api/ruijie/${req.params.id}/auth?t=${token}` : null,
    accountingUrl: base && token ? `${base}/api/ruijie/${req.params.id}/accounting?t=${token}` : null,
  });
}));

router.post('/:id/ruijie-cloud-mode', asyncHandler(async (req, res) => {
  const { enable } = req.body;
  if (typeof enable !== 'boolean') return res.status(400).json({ error: 'enable (boolean) is required.' });

  const { rows } = await pool.query(`SELECT type, mk_auth_mode FROM sites WHERE id=$1 AND tenant_id=$2`, [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Site not found.' });
  const site = rows[0];
  if (site.type !== 'ruijie') return res.status(400).json({ error: 'Cloud Auth mode is only available for Ruijie sites.' });

  if (!enable) {
    await pool.query(`UPDATE sites SET mk_auth_mode='radius', ruijie_callback_token_encrypted=NULL WHERE id=$1`, [
      req.params.id,
    ]);
    return res.json({ ok: true, mode: 'radius' });
  }

  // 32 random bytes -> 43-char base64url token, appended as the `t` query
  // param on the Auth/Accounting URLs - see ruijieCloudAuth.js's
  // verifyCallbackToken. Mutually exclusive with radius mode's NAS secret,
  // same reasoning as clearing it there.
  const token = crypto.randomBytes(32).toString('base64url');

  const { rows: existingActive } = await pool.query(
    `SELECT count(*)::int AS n FROM vouchers WHERE site_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > now())`,
    [req.params.id]
  );
  const activeCount = existingActive[0].n;

  await pool.query(
    `UPDATE sites SET mk_auth_mode='ruijie_cloud', ruijie_callback_token_encrypted=$1,
       radius_secret_encrypted=NULL, radius_nas_identifier=NULL WHERE id=$2`,
    [encrypt(token), req.params.id]
  );

  const base = process.env.PUBLIC_BASE_URL || null;
  res.json({
    ok: true,
    mode: 'ruijie_cloud',
    token,
    authUrl: base ? `${base}/api/ruijie/${req.params.id}/auth?t=${token}` : null,
    accountingUrl: base ? `${base}/api/ruijie/${req.params.id}/accounting?t=${token}` : null,
    warning: activeCount > 0
      ? `This site has ${activeCount} voucher(s) with an active session right now - those are unaffected. New redemptions won't work until Ruijie Cloud's Auth/Accounting Server URLs are set to the values above.`
      : null,
  });
}));

// --- Installer management (owner/manager side) ------------------------
// Everything here is still behind this file's router.use(requireAuth,
// requireNotAgent) above, so an installer token can never reach it - only
// the owner/manager. The installer-facing counterparts to all of this
// live in routes/installers.js, scoped the other way (an installer to
// only their own assigned sites).

// Generates a new invite code an owner can hand to a prospective
// installer for self-registration at /installer. Deliberately no expiry -
// see the schema comment on installer_invite_codes for why - just active/
// revoked. Unambiguous charset (no 0/O/1/I), same reasoning as
// voucherService's code generator.
function randomInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return `INST-${s.slice(0, 4)}-${s.slice(4)}`;
}

router.post('/installer-invites', asyncHandler(async (req, res) => {
  const { label } = req.body || {};
  const code = randomInviteCode();
  const { rows } = await pool.query(
    `INSERT INTO installer_invite_codes (tenant_id, code, label) VALUES ($1,$2,$3)
     RETURNING id, code, label, active, uses_count, created_at`,
    [req.tenantId, code, validate.isNonEmptyString(label, 200) ? label : null]
  );
  res.json(rows[0]);
}));

router.get('/installer-invites', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, code, label, active, uses_count, created_at, revoked_at
     FROM installer_invite_codes WHERE tenant_id=$1 ORDER BY created_at DESC`,
    [req.tenantId]
  );
  res.json(rows);
}));

router.patch('/installer-invites/:id/revoke', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE installer_invite_codes SET active=false, revoked_at=now()
     WHERE id=$1 AND tenant_id=$2 RETURNING id, code, active`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Invite code not found.' });
  res.json(rows[0]);
}));

// Every installer this tenant has, plus every site each has touched and
// that site's current status - powers the owner's "Installations" list.
router.get('/installers', asyncHandler(async (req, res) => {
  const { rows: installerRows } = await pool.query(
    `SELECT id, name, email, created_at FROM tenant_users WHERE tenant_id=$1 AND role='installer' ORDER BY created_at DESC`,
    [req.tenantId]
  );
  const { rows: siteRows } = await pool.query(
    `SELECT si.installer_id, si.site_id, si.status AS install_status, si.updated_at,
            s.name AS site_name, s.status AS connection_status
     FROM site_installers si
     JOIN sites s ON s.id = si.site_id
     WHERE si.tenant_id=$1
     ORDER BY si.updated_at DESC`,
    [req.tenantId]
  );
  const sitesByInstaller = {};
  for (const row of siteRows) {
    (sitesByInstaller[row.installer_id] ||= []).push({
      siteId: row.site_id, siteName: row.site_name, connectionStatus: row.connection_status,
      installStatus: row.install_status, updatedAt: row.updated_at,
    });
  }
  res.json(installerRows.map((i) => ({ ...i, sites: sitesByInstaller[i.id] || [] })));
}));

// Reassigns (or, with installerId omitted, simply removes) which installer
// a site is scoped to - e.g. an installer leaves mid-job and someone else
// finishes it, or the owner wants to take a site off the installer track
// entirely and manage it purely from the regular admin panel from now on.
// Removing this row doesn't touch the site itself - it keeps existing
// under owner control either way.
router.patch('/site-installers/:siteId', asyncHandler(async (req, res) => {
  const { installerId } = req.body || {};
  const { rows: siteRows } = await pool.query('SELECT id FROM sites WHERE id=$1 AND tenant_id=$2', [
    req.params.siteId, req.tenantId,
  ]);
  if (!siteRows.length) return res.status(404).json({ error: 'Site not found.' });

  if (!installerId) {
    await pool.query(`DELETE FROM site_installers WHERE site_id=$1 AND tenant_id=$2`, [req.params.siteId, req.tenantId]);
    return res.json({ ok: true, unassigned: true });
  }

  const { rows: installerRows } = await pool.query(
    `SELECT id FROM tenant_users WHERE id=$1 AND tenant_id=$2 AND role='installer'`,
    [installerId, req.tenantId]
  );
  if (!installerRows.length) return res.status(404).json({ error: 'Installer not found.' });

  const { rows } = await pool.query(
    `INSERT INTO site_installers (tenant_id, site_id, installer_id, status)
     VALUES ($1,$2,$3,'in_progress')
     ON CONFLICT (site_id) DO UPDATE SET installer_id=$3, updated_at=now()
     RETURNING site_id, installer_id, status`,
    [req.tenantId, req.params.siteId, installerId]
  );
  res.json(rows[0]);
}));

// Admin-facing activity feed: every config-changing action an installer
// has taken on an assigned site (edits, RADIUS mode toggles, status
// changes), across all installers (or one, via ?installerId=, or one
// site, via ?siteId=) - same pattern as GET /api/agents/activity, and
// powers the "Installer Activity" list on the Installers tab of
// public/agents.html.
router.get('/installer-activity', asyncHandler(async (req, res) => {
  const { installerId, siteId, limit } = req.query;
  const clauses = ['tenant_id=$1'];
  const params = [req.tenantId];
  if (installerId) { params.push(installerId); clauses.push(`installer_id=$${params.length}`); }
  if (siteId) { params.push(siteId); clauses.push(`site_id=$${params.length}`); }
  params.push(Math.min(Number(limit) || 100, 300));

  const { rows } = await pool.query(
    `SELECT id, installer_id, installer_name_snapshot, site_id, site_name_snapshot, type, detail, created_at
     FROM installer_activity_log WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

module.exports = router;
