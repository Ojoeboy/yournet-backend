# Portal logo: file upload + "use account saved logo" — added 2026-08-14

Follow-on from the Bucket.pdf conversation. No cloud bucket was needed —
the account logo (`tenants.account_logo`) already proved the pattern of
storing an uploaded image as a base64 `data:` URL directly in a TEXT
column, sidestepping Render's ephemeral disk entirely. This applies the
same pattern to `sites.portal_logo_url`, which was already a plain TEXT
field (previously paste-a-URL-only).

## Backend (`src/routes/sites.js`)
- `POST /api/sites/:id/portal-logo` — multer memory upload (same 1.5MB
  limit + PNG/JPEG/WEBP/GIF filter as the account logo), base64-encodes
  the file into a `data:` URL, and saves it straight to
  `sites.portal_logo_url`. Site ownership is checked before the upload
  is even attempted.
- `logoUrl` added to `CLEARABLE_PORTAL_FIELDS` — the existing PATCH
  `/portal` route uses COALESCE, so it can only ever set a value, never
  blank it back out; this gives the new "Remove" button (and clearing
  the URL field then hitting Save) a way to actually clear it.

## Frontend (`public/admin.html`)
- Portal tab logo field now has: a preview thumbnail, an "Upload logo"
  button, a "Use account saved logo" button (copies
  `tenants.account_logo` via `GET /api/dashboard/profile`, then PATCHes
  it into the site's `portal_logo_url`), a "Remove" button, and the
  original "paste a URL" text input still works underneath.
- Upload and "Use account logo" both save immediately (no separate
  "Save branding" click needed), consistent with how the account logo
  already behaves.

Nothing new to migrate — `portal_logo_url` already existed as a column,
and no new npm dependency was needed (multer was already a dependency,
used by the account logo route).
