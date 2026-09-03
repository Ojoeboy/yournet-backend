const express = require('express');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { requireAuth, requireNotAgent } = require('../middleware/auth');
const voucherService = require('../services/voucherService');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireNotAgent);

router.post('/generate', asyncHandler(async (req, res) => {
  const { packageId, siteId, agentId, quantity, batch } = req.body;
  const missingError = validate.required(req.body, ['packageId', 'siteId', 'quantity']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isPositiveNumber(quantity)) return res.status(400).json({ error: 'Quantity must be a positive number.' });

  try {
    const vouchers = await voucherService.generateVouchers(req.tenantId, {
      packageId, siteId, agentId, quantity: Math.min(quantity, 500), batch,
    });
    res.json({ count: vouchers.length, vouchers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// What print.html needs once per page load, not per card: the tenant's
// business name (always set, used as the printed company name) and a
// logo to show alongside it. There's no tenant-level logo field - only
// per-site portal branding - so this picks the first site that has one
// configured. Good enough for the common case of one look across a
// tenant's sites; a tenant branding multiple sites differently can still
// filter the print list to one site/batch at a time.
router.get('/print-branding', asyncHandler(async (req, res) => {
  const { rows: tenantRows } = await pool.query('SELECT business_name FROM tenants WHERE id=$1', [req.tenantId]);
  const { rows: logoRows } = await pool.query(
    `SELECT portal_logo_url FROM sites WHERE tenant_id=$1 AND portal_logo_url IS NOT NULL AND portal_logo_url != '' ORDER BY name ASC LIMIT 1`,
    [req.tenantId]
  );
  res.json({
    businessName: tenantRows[0]?.business_name || 'WiFi Vouchers',
    logoUrl: logoRows[0]?.portal_logo_url || null,
  });
}));

// Batch summary for print.html's "browse by batch" panel - one row per
// distinct batch name (plus one row for batch IS NULL, covering vouchers
// generated before a batch label was typed in), with unused/total counts
// so the panel can show "12 unused - 50 total" without a second call per
// tile. site_id is included so a tenant running multiple sites can tell
// two same-named batches apart.
// Search vouchers by code (partial match) for the "look up a code" search
// box on print.html - returns status plus, for a redeemed voucher, when
// and from which device. Only MAC is available here, not IP: nothing in
// this system captures Framed-IP-Address anywhere (radius_sessions only
// ever stores client_mac - see radiusAccountingService.js), so there is
// no IP to show even for an active session.
router.get('/search', asyncHandler(async (req, res) => {
  const term = (req.query.code || '').trim();
  if (!term) return res.json([]);

  const { rows } = await pool.query(
    `SELECT v.id, v.code, v.status, v.created_at, v.redeemed_at, v.expires_at, v.client_mac,
            p.label AS package_label,
            s.name AS site_name,
            rs.status AS session_status, rs.started_at AS session_started_at,
            rs.last_seen_at AS session_last_seen_at, rs.stopped_at AS session_stopped_at
     FROM vouchers v
     JOIN packages p ON p.id = v.package_id
     JOIN sites s ON s.id = v.site_id
     -- Most recent session for this voucher, if any - a voucher can only
     -- ever be redeemed by one device (see "Limit: 1" on the printed
     -- card), but LATERAL + LIMIT 1 keeps this correct even if a device
     -- reconnected and produced more than one radius_sessions row.
     LEFT JOIN LATERAL (
       SELECT * FROM radius_sessions rs WHERE rs.voucher_id = v.id ORDER BY rs.started_at DESC LIMIT 1
     ) rs ON true
     WHERE v.tenant_id=$1 AND v.code ILIKE $2
     ORDER BY v.created_at DESC
     LIMIT 20`,
    [req.tenantId, `%${term}%`]
  );

  res.json(rows.map((v) => ({
    id: v.id,
    code: v.code,
    status: v.status,
    packageLabel: v.package_label,
    siteName: v.site_name,
    createdAt: v.created_at,
    redeemedAt: v.redeemed_at,
    expiresAt: v.expires_at,
    clientMac: v.client_mac,
    // Whether the device is connected RIGHT NOW (not just "was redeemed
    // at some point") - session_status='active' plus a recent last_seen_at
    // is the closest this system has to "currently online", since RADIUS
    // interim-updates (last_seen_at) stop arriving once a device
    // disconnects but the session isn't always cleanly Stop'd right away.
    sessionStatus: v.session_status,
    sessionStartedAt: v.session_started_at,
    sessionLastSeenAt: v.session_last_seen_at,
    sessionStoppedAt: v.session_stopped_at,
  })));
}));

router.get('/batches', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.batch, v.site_id, s.name AS site_name,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE v.status='unused')::int AS unused,
            MAX(v.created_at) AS last_created
     FROM vouchers v
     JOIN sites s ON s.id = v.site_id
     WHERE v.tenant_id=$1
     GROUP BY v.batch, v.site_id, s.name
     ORDER BY last_created DESC`,
    [req.tenantId]
  );
  res.json(rows);
}));

// Bulk delete across several batch groups at once (the "Delete Selected"
// action for the batch tiles' checkboxes). Applies the exact same
// per-voucher safety rule as the single DELETE /:id route below -
// 'redeeming' and live 'active' sessions are never touched - just fanned
// out across every batch in the request instead of one voucher at a
// time. Reports back what actually happened per batch (deleted vs. kept
// because in use) rather than a single opaque success/fail, since a
// batch that's "mostly redeemed" is a very different outcome from one
// that's "fully cleared" and the admin should be able to tell which.
router.post('/batches/bulk-delete', asyncHandler(async (req, res) => {
  const { batches } = req.body;
  if (!Array.isArray(batches) || !batches.length) {
    return res.status(400).json({ error: 'No batches specified.' });
  }
  if (batches.length > 100) {
    return res.status(400).json({ error: 'Too many batches in one request (max 100).' });
  }

  const results = [];
  for (const b of batches) {
    const siteId = b && b.siteId;
    if (!siteId) { results.push({ batch: b?.batch ?? null, siteId: null, deleted: 0, kept: 0, error: 'Missing siteId' }); continue; }
    const batchVal = b.batch === '__none__' || b.batch == null ? null : b.batch;
    const batchClause = batchVal === null ? 'v.batch IS NULL' : 'v.batch=$3';
    const baseParams = batchVal === null ? [req.tenantId, siteId] : [req.tenantId, siteId, batchVal];

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM vouchers v WHERE v.tenant_id=$1 AND v.site_id=$2 AND ${batchClause}`,
      baseParams
    );
    const { rows: deletedRows } = await pool.query(
      `DELETE FROM vouchers v
       WHERE v.tenant_id=$1 AND v.site_id=$2 AND ${batchClause}
         AND v.status != 'redeeming'
         AND NOT (v.status='active' AND (v.expires_at IS NULL OR v.expires_at > NOW()))
       RETURNING v.id`,
      baseParams
    );
    results.push({
      batch: batchVal,
      siteId,
      deleted: deletedRows.length,
      kept: totalRows[0].total - deletedRows.length,
    });
  }

  res.json({ results });
}));

// CSV export for one or more selected batch groups - same voucher rows
// print.html would render, flattened to a spreadsheet-friendly format
// instead of cards. Kept simple/universal (no vendor-specific columns)
// since this is meant to open cleanly in Excel/Sheets/Numbers alike.
router.post('/batches/export', asyncHandler(async (req, res) => {
  const { batches } = req.body;
  if (!Array.isArray(batches) || !batches.length) {
    return res.status(400).json({ error: 'No batches specified.' });
  }

  const orClauses = [];
  const params = [req.tenantId];
  batches.forEach((b) => {
    const siteId = b && b.siteId;
    if (!siteId) return;
    const batchVal = b.batch === '__none__' || b.batch == null ? null : b.batch;
    if (batchVal === null) {
      params.push(siteId);
      orClauses.push(`(v.site_id=$${params.length} AND v.batch IS NULL)`);
    } else {
      params.push(siteId, batchVal);
      orClauses.push(`(v.site_id=$${params.length - 1} AND v.batch=$${params.length})`);
    }
  });
  if (!orClauses.length) return res.status(400).json({ error: 'No valid batches specified.' });

  const { rows } = await pool.query(
    `SELECT v.code, v.batch, v.status, v.created_at, v.redeemed_at, v.expires_at,
            p.label AS package_label, p.price AS package_price, s.name AS site_name
     FROM vouchers v
     JOIN packages p ON p.id = v.package_id
     JOIN sites s ON s.id = v.site_id
     WHERE v.tenant_id=$1 AND (${orClauses.join(' OR ')})
     ORDER BY v.batch, v.created_at DESC
     LIMIT 5000`,
    params
  );

  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = ['Code', 'Batch', 'Site', 'Package', 'Price', 'Status', 'Created', 'Redeemed', 'Expires'];
  const lines = [header.join(',')];
  rows.forEach((v) => {
    lines.push([
      v.code, v.batch || '(no batch)', v.site_name, v.package_label, v.package_price,
      v.status, v.created_at?.toISOString() || '', v.redeemed_at?.toISOString() || '', v.expires_at?.toISOString() || '',
    ].map(escape).join(','));
  });

  res.type('text/csv').attachment('vouchers-export.csv').send(lines.join('\n'));
}));

router.get('/', asyncHandler(async (req, res) => {
  const { status, batch, agentId, siteId } = req.query;
  const clauses = ['v.tenant_id=$1'];
  const params = [req.tenantId];
  if (status) { params.push(status); clauses.push(`v.status=$${params.length}`); }
  // '__none__' is the sentinel print.html sends for the "Ungrouped" tile
  // (vouchers with no batch typed in at generation time) - can't pass NULL
  // through a query string, and a real batch name could theoretically be
  // any string, so this keeps "no batch" unambiguous from "no filter".
  if (batch === '__none__') { clauses.push('v.batch IS NULL'); }
  else if (batch) { params.push(batch); clauses.push(`v.batch=$${params.length}`); }
  // Optional - needed when the caller is disambiguating two same-named
  // batches on different sites (see the comment on /batches above the
  // one that generates this label pairing). Omitted, this just filters
  // by batch name alone like it always has.
  if (siteId) { params.push(siteId); clauses.push(`v.site_id=$${params.length}`); }
  if (agentId === 'none') {
    clauses.push('v.agent_id IS NULL');
  } else if (agentId) {
    params.push(agentId);
    clauses.push(`v.agent_id=$${params.length}`);
  }
  // Joined to packages (label/price/duration_minutes - what print.html
  // needs on the card), tenants (business_name - the printed company
  // name), and tenant_users (the assigned agent's name, if any), so the
  // print page can render everything from one call instead of stitching
  // together several round trips itself.
  const { rows } = await pool.query(
    `SELECT v.*, p.label AS package_label, p.price AS package_price, p.duration_minutes AS package_duration_minutes,
            t.business_name, a.name AS agent_name
     FROM vouchers v
     JOIN packages p ON p.id = v.package_id
     JOIN tenants t ON t.id = v.tenant_id
     LEFT JOIN tenant_users a ON a.id = v.agent_id
     WHERE ${clauses.join(' AND ')} ORDER BY v.created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
}));

router.get('/:id/qrcode', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT code, site_id FROM vouchers WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).end();

  // Encodes the portal URL with the code embedded (?code=XXXX-XXXX), not
  // just the bare code. A generic QR scanner opens straight to the
  // customer's portal page with the code pre-filled and auto-submitted
  // (see portal.html) - a real "scan to connect" instead of "scan to read
  // the code, then still have to type it in". Falls back to encoding the
  // plain code if APP_BASE_URL isn't configured, so this never produces a
  // broken/unusable QR in an environment that's missing it.
  const base = process.env.APP_BASE_URL;
  const payload = base
    ? `${base}/p/${rows[0].site_id}?code=${encodeURIComponent(rows[0].code)}`
    : rows[0].code;
  const png = await QRCode.toBuffer(payload, { width: 240, margin: 1 });
  res.type('png').send(png);
}));

// Delete a single voucher - but only when doing so can't strand or cut off
// a real customer:
//   - 'unused'                              -> safe, never touched anyone.
//   - 'redeeming' (mid-flight right now)     -> blocked; let it finish first,
//                                               it'll land on 'active' or
//                                               get released back to 'unused'.
//   - 'active' with expires_at still ahead   -> blocked; this is a LIVE
//                                               session - deleting the row
//                                               doesn't disconnect the
//                                               customer (the router grants
//                                               access independently), it
//                                               just destroys the record
//                                               while they're still using it.
//   - 'active' with expires_at already past  -> safe; there's a schema quirk
//                                               worth knowing - nothing ever
//                                               flips status to 'expired',
//                                               so a lapsed session still
//                                               reads as 'active' in the DB.
//                                               expires_at, not status, is
//                                               what actually tells you the
//                                               session is over.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, status, expires_at FROM vouchers WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Voucher not found.' });
  const v = rows[0];

  if (v.status === 'redeeming') {
    return res.status(409).json({ error: 'This voucher is mid-redemption right now. Try again in a moment.' });
  }
  if (v.status === 'active' && (!v.expires_at || new Date(v.expires_at) > new Date())) {
    return res.status(409).json({ error: 'This voucher has an active session and can\u2019t be deleted while in use. It can be deleted once the session expires.' });
  }

  await pool.query('DELETE FROM vouchers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
}));

// Pending manual-MoMo voucher claims - customers who said they'd pay the
// owner's personal MoMo number directly (no gateway configured). Nothing
// here has been verified against any payment API; this is what the owner
// checks against their own MoMo alert before approving.
router.get('/manual-orders', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const { rows } = await pool.query(
    `SELECT vo.id, vo.customer_phone, vo.customer_note, vo.status, vo.created_at, vo.completed_at,
            p.label AS package_label, p.price AS package_price, s.name AS site_name
     FROM voucher_orders vo
     JOIN packages p ON p.id = vo.package_id
     JOIN sites s ON s.id = vo.site_id
     WHERE vo.tenant_id=$1 AND vo.provider='manual_momo' AND vo.status = $2
     ORDER BY vo.created_at DESC LIMIT 200`,
    [req.tenantId, status === 'paid' || status === 'failed' ? status : 'pending']
  );
  res.json(rows);
}));

// Owner confirms they actually received the MoMo transfer (checked against
// their own phone's MoMo alert, outside this app) - THIS click is the real
// verification step, since there's no API to confirm a P2P transfer for
// us. Issues the voucher and SMS's it to the phone number the customer
// gave, same as an automatic gateway order.
router.post('/manual-orders/:id/approve', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM voucher_orders WHERE id=$1 AND tenant_id=$2 AND provider='manual_momo'`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
  const order = rows[0];
  if (order.status !== 'pending') return res.status(409).json({ error: `This order is already ${order.status}.` });

  try {
    // fulfillOrder does its own atomic pending->fulfilling claim, so the
    // status check above is just for a fast, friendly error message - it's
    // not what actually prevents a double-approve race.
    const voucher = await voucherService.fulfillOrder(order);
    if (!voucher) return res.status(409).json({ error: 'This order was already resolved.' });
    res.json({ ok: true, voucher });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Owner declines a claim (no MoMo alert found, wrong amount, etc.) - no
// voucher is ever created for it.
router.post('/manual-orders/:id/reject', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE voucher_orders SET status='failed', completed_at=now()
     WHERE id=$1 AND tenant_id=$2 AND provider='manual_momo' AND status='pending' RETURNING id`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found or already resolved.' });
  res.json({ ok: true });
}));

module.exports = router;
