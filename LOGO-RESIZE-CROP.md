# Logo auto-resize + manual crop — added 2026-08-14

Client-side only, using the plan you approved: auto-resize by default,
with a simple manual crop as an override. Applies to both the account
logo (Setup > Account) and the portal logo (Setup > Customize Portal),
since they share the same upload flow.

## New file: `public/logo-editor.js`
Loaded on `admin.html` before `shell.js`. Exposes `window.LogoEditor`:

- `LogoEditor.open(file, { onConfirm, onCancel })` — opens a modal showing
  the picked image with a draggable/resizable square box (no zoom, as
  discussed — the simple version). Two ways out:
  - **"Use whole image"** — auto path: scales the full image down to fit
    inside a square canvas (`contain`, not `cover`), with transparent
    padding on the short side. Nothing gets cropped out.
  - **"Use this crop"** — takes whatever square the admin dragged/resized
    over the image and uses that instead.
- Either path re-encodes the result: PNG first (keeps transparent padding
  crisp); if that's still over 1.5MB it flattens onto white and steps
  down JPEG quality (90% → 40%) until it fits. Output is capped at
  512x512, which is far more than the 64px display size ever needs.
- `LogoEditor.processImage(file, cropRect)` is the underlying function if
  either editor path is ever needed programmatically.

## Changed: `public/admin.html`
- Added `<script src="/logo-editor.js"></script>`.
- Both file inputs (`acctLogoFile`, `portalLogoFile`) now call
  `onAccountLogoFileSelected(event)` / `onPortalLogoFileSelected(event)`
  on change, instead of uploading immediately.
- Those new functions open the `LogoEditor` modal; on confirm, the
  *processed* file (already resized/cropped and under the size limit) is
  handed to `uploadAccountLogo(file)` / `uploadPortalLogo(file)` — same
  functions as before, just now taking the processed file as an argument
  instead of reading `fileInput.files[0]` directly.
- The 1.5MB rejection check is still there as a safety net (kept
  server-side too, in the multer config — untouched), but in practice the
  editor's own encode step should always land under it.

## Not touched
- `src/routes/dashboard.js` and `src/routes/sites.js` — no backend
  changes were needed. The endpoints already accept any image under
  1.5MB via multer memory storage; they have no idea the file passed
  through a canvas first.
- Portal rendering, favicon/PWA icons, sidebar/nav — unrelated to this
  feature, left as-is.

## Known limits (same tradeoffs discussed earlier)
- No zoom in the manual cropper — just move/resize the square. Covers
  most real logos; a fuller pinch-to-zoom version would be a separate
  follow-up if it's ever needed.
- A very detailed or non-square source logo will still look better if
  the business supplies a cleaner square version themselves — this only
  guarantees the upload fits and isn't rejected, not that it looks great
  at 64px.
