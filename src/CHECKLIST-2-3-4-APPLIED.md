# Checklist rows 2, 3, 4 - applied 2026-08-13

Follows on from FIXES-APPLIED.md. Covers the 3 items confirmed "Not built"
in the restated checklist (row 1+ was found to already work and needed no
change - see the chat that scoped this).

## 2. Centered page header (logo + title, 8 pages)
- `public/shell.css`: new `.page-header` block (centered logo + h1 + sub).
- `public/shell.js`: `renderPageHeader()` auto-wraps each page's existing
  `<h1>` (+ its immediately-following `.sub`, if any) in that block - no
  per-page markup changes needed on 6 of 7 shell pages (admin, agents,
  billing, dashboard, plan-overview, pppoe).
- `public/print.html` got a hand-added header instead, since its existing
  `.print-head` (title + live status side-by-side) doesn't fit the generic
  h1-wrapping approach - also hidden in `@media print` alongside the rest
  of the chrome.
- Note: only 7 pages actually use the `#app-sidebar` shell (not 8) - see
  the discrepancy noted when this row was scoped.

## 3. PWA install ("Add to Home Screen") - admin side
- `public/manifest.json`, `public/sw.js` - static YourNet branding, separate
  from the existing per-site tenant-branded portal PWA
  (`/p/:siteId/manifest.json` + `sw.js`, rendered dynamically in
  `portalRenderer.js` - untouched, already worked).
- `public/shell.js`: injects manifest link + meta tags, registers the
  service worker, and shows an "Install app" button (topbar + mobile
  drawer) when the browser fires `beforeinstallprompt`. No button appears
  on Safari/iOS - there's no programmatic install prompt there; Add to
  Home Screen stays a manual Share-sheet action, same as anywhere else.

## 4. Manual MAC/IP authorize, no voucher
- `src/db/schema.sql`: new `manual_client_authorizations` table - kept
  separate from `vouchers` so a comped/manual grant never shows up in
  voucher print runs, settlement sheets, or agent commissions.
- `src/integrations/mikrotik.js`: `listHotspotHosts()` (all seen hosts,
  authorized or not, via `/ip/hotspot/host/print`). Authorize/revoke reuse
  the existing `createHotspotUser`/`removeHotspotUser` - both already
  generic enough.
- `src/integrations/unifi.js`: `unauthorizeClient()` and
  `setClientBlocked()`, alongside the existing `authorizeClient()`.
- `src/integrations/omada.js`: `authorizeClientManual()` - **verification
  caveat, read the comment above the function before relying on this one**.
  The endpoint (`/openapi/v1/{omadacId}/sites/{siteId}/hotspot/clients/{clientMac}/auth`)
  comes from a single unofficial forum report, not TP-Link's own Open API
  docs - the request body shape is an educated guess, not confirmed. No
  revoke/block-by-MAC endpoint could be found or confirmed at all for
  Omada, so that direction is deliberately left unimplemented rather than
  guessed - `POST /:id/revoke-client` returns a clear 501 for Omada sites
  instead of silently failing.
- `src/routes/sites.js`: `GET /:id/clients`, `GET /:id/manual-authorizations`,
  `POST /:id/authorize-client`, `POST /:id/revoke-client`. Meraki is
  rejected with a clear 400 on all of these - structurally can't support
  this pattern (see the router-comparison table this feature was scoped
  from).
- `public/admin.html`: new "Manual access" tab - site picker, a live
  "seen on the network" device picker (falls back to typing a MAC by
  hand), duration, optional note, and a table of active grants with
  per-row Revoke.

### Still needed before this is production-ready
- The Omada manual-authorize endpoint needs a real smoke test against an
  actual controller (ideally each supported version range) before
  depending on it - see the caveat in `omada.js`.
- `npm run migrate` picks up the new `manual_client_authorizations` table
  automatically (idempotent, like the rest of `schema.sql`) - no manual
  migration step needed.
