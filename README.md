# YourNet Control - Backend

Real backend for the YourNet Control front-end: multi-tenant, with actual
Mikrotik RouterOS and TP-Link Omada integrations (not simulated data).

## What this replaces from the old HTML-only app
| Before (browser-only) | Now |
|---|---|
| Fake AP stats via `Math.random()` | Real connected-client counts pulled from the RouterOS/Omada/UniFi/Meraki APIs. Mikrotik sites can also show real access-point status via CAPsMAN, using field names confirmed against MikroTik's own docs and live router captures - but only for actual Mikrotik CAP devices under a CAPsMAN manager; a generic/third-party AP just bridged to the router works fine for clients but won't appear in that list. |
| Voucher "redeemed" = a status flag in localStorage | Redeeming a voucher creates a real hotspot user on Mikrotik, or authorizes the client via Omada's External Portal API |
| One device, one browser, no sharing | Postgres database, multi-tenant, any device can log in |
| Anyone could edit vouchers by editing localStorage | JWT-authenticated API, server-side validation |

## Setup

```bash
npm install
cp .env.example .env   # fill in real values
npm run migrate        # creates tables
npm run dev
```

Requires a Postgres database (local, or a managed one - Neon/Supabase both
have free tiers good enough to start).

## Where to run this
- **A Raspberry Pi at your main site** works for a single-operator setup
  (BITTNET) but is a bad idea for a multi-tenant product - if your Pi's
  power/internet drops, every customer's portal goes down.
- **A small VPS** (DigitalOcean, Hetzner, or a Ghanaian/African provider)
  is the right home for the multi-tenant version, with your own or your
  tenants' routers reaching out to it over the internet.

## Per-tenant setup checklist (what a new customer configures)
1. Sign up (`POST /api/auth/signup`)
2. Add a site (`POST /api/sites`) - either:
   - **Mikrotik**: router IP reachable from this backend (port-forward the
     API port, or put both on the same VPN), API username/password with
     `api` permission enabled. Works over the plain API (port 8728,
     default) or API-SSL (port 8729) if you enable "Connect over API-SSL"
     on the site - note the connection trusts the router's self-signed
     API-SSL cert rather than verifying it, since RouterOS doesn't have a
     CA-issued cert workflow for this service.
   - **Omada**: enable Open API in Global View settings, create a Client
     Credentials application, note the Client ID/Secret and Omadac ID.
     Note: this requires a self-hosted Omada Controller (software or
     hardware) - the free cloud-only "Essential" tier doesn't support it.
3. Set the External Portal URL (Omada) or hotspot login page (Mikrotik) to
   point at `{APP_BASE_URL}/portal/{siteId}` so customers see YOUR portal
   page when they connect.
4. Create packages, generate vouchers, print/sell them.

## Device binding (anti-sharing)
When a voucher is redeemed on Mikrotik, the hotspot user account created on
the router is locked to that device's MAC address (`mac-address` field on
the RouterOS hotspot user). This is enforced by the router itself, not just
the app - so a code texted to a friend on another phone will be rejected at
login, even though the code still shows as "active" and unexpired in the
database. If `clientMac` isn't available at redemption time, the voucher
still works but won't be locked - this can happen on some devices/browsers
that don't expose MAC in the portal redirect, worth testing on your actual
Mikrotik + captive portal setup.

## Licensing (one-time purchase, enforced at signup)
Nobody can create a tenant account without a valid, unused license key -
`POST /api/auth/signup` rejects the request without one. A key is
permanently consumed the moment it activates a tenant (locked with a
row-level `FOR UPDATE` to prevent two people racing to use the same key),
so a single purchase cannot be shared across multiple WiFi businesses.

Keys are issued in one of two ways:
1. **Online checkout** (`/license` page) - the buyer picks whichever
   gateway is configured: **Paystack** (card or Mobile Money), **Flutterwave**,
   or **Hubtel**. The dropdown only ever shows providers that actually have
   credentials set in `.env` (`PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`,
   or the `HUBTEL_*` trio) - see `.env.example`. Payment is verified
   server-side (Paystack/Flutterwave via a browser-redirect callback,
   Hubtel via an async webhook + a polling status page, since Hubtel
   confirms server-to-server rather than on redirect) before a real key is
   generated and shown to the buyer, with a Copy button.
2. **Manual issue** - the platform owner can issue a key by hand from
   `/license-admin` (after logging in at `/owner-login`) for a sale made
   outside the three gateways above. Every key issued this way or online is
   listed on that same page.

These platform-level gateway credentials are separate from the per-tenant
ones each WiFi business links from their own `/admin` (see
`routes/paymentGateways.js`) to receive their *own* customers' voucher
payments.

Price is set via `LICENSE_PRICE_GHS` in `.env` - change it to whatever
you're actually charging.

**Note on the old direct-MoMo-transfer flow:** an earlier version of this
app let a buyer submit a claim after a manual peer-to-peer MoMo transfer,
which the owner then approved by hand against their own MoMo transaction
history. That flow (and its `/license-admin` review page) has been removed
now that Paystack/Flutterwave/Hubtel cover Mobile Money automatically -
the old claims data is still sitting in the `momo_payment_claims` table if
you ever need to look back at it, but nothing in the app queries it anymore.


**Security note on a prototype you may have seen elsewhere:** an earlier
version of this idea generated and checked license keys entirely in
browser JavaScript, with an admin password typed directly into the page's
source. Both are readable by anyone via "view page source" or browser dev
tools, which means anyone could generate a free key or open the admin
panel without paying. Everything above is enforced server-side instead,
where the logic and secrets are never sent to the browser.

## Owner login (you, not a tenant)
`/owner-login` is a real login form - username plus a password that's
**hashed with a salt, never stored in plain text** (see
`src/utils/passwordHash.js`, built on Node's own `crypto` module, no extra
dependency). It issues a short-lived (4-hour) token signed with its own
separate secret (`OWNER_JWT_SECRET`), completely independent from
tenant auth (`JWT_SECRET`) - a leaked tenant token can never be used to
access owner-only pages, and vice versa. This replaces an earlier,
weaker design that used one shared static secret pasted into every request.

To set your own owner password:
```
node -e "console.log(require('./src/utils/passwordHash').hashPassword('yourNewPassword'))"
```
Put the printed value in `.env` as `OWNER_PASSWORD_HASH` - never commit the
real password or hash to `.env.example` or git, only your private `.env`.

## Credential encryption
Router passwords and Omada API secrets are encrypted at rest with
AES-256-GCM (`src/utils/credentialCrypto.js`), using a server-side key you
generate yourself (`CREDENTIAL_ENCRYPTION_KEY` in `.env`). Generate one with:
```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
**If you saved a site's Mikrotik password before this encryption existed**,
that old value is stored as plain text and will fail to decrypt now. Use
`PATCH /api/sites/:id` (re-enter the same credentials) to fix it in place
without losing the site's id or any vouchers already linked to it.

## Automated tests
A real, running test suite exists for the pure logic that doesn't need a
database - password hashing, credential encryption round-trips, and voucher
code / license key formats (`test/`, using Node's built-in test runner, zero
extra dependencies). Run with:
```
npm test
```
**Honest limit**: this does not yet cover the database-dependent logic
(voucher redemption races, license key consumption atomicity, the Mikrotik
API calls themselves) - that needs a real test database and is a good next
step, not something included tonight.

## Backups
No automated backup is configured yet. Until one is:
- If hosting on Railway or a similar platform with managed Postgres, check
  whether automatic backups are included in your plan tier - often they
  are, but verify rather than assume.
- For a self-managed Postgres, a simple scheduled `pg_dump` (cron on Linux,
  Task Scheduler on Windows) to a separate location is the minimum viable
  approach - not glamorous, but real data safety beats none.

## Email (Gmail SMTP)
Password reset and account verification emails send for real, via Gmail
SMTP (through `nodemailer`) - free, and no domain purchase required. Set
`GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env` (see `.env.example` for
how to generate an app password).

**Real limits to know before relying on this**: emails send from a Gmail
address (e.g. `yournet.control@gmail.com`), not a branded
`no-reply@yourdomain.com` - less polished, but works for real customers
today, unlike the domain-gated alternative. Gmail's free sending cap is
roughly 500/day, which is plenty for testing and early real usage but
won't scale indefinitely.

If `GMAIL_USER` / `GMAIL_APP_PASSWORD` aren't set, the app falls back to
logging the email content to the console instead of crashing - useful
while developing locally, not something to rely on once real people are
signing up.

When there's revenue to justify it, swapping to Resend (or similar) + a
purchased/verified domain (~$10-15/year) gets you branded sending
addresses - `emailService.js` is written so that swap doesn't require
touching any other file.

## Honest gaps / what still needs attention
**Fixed since the last review:**
- ~~No real email sending~~ - now uses Gmail SMTP (see above); sends from
  a Gmail address rather than a branded domain, which is a cosmetic
  limit, not a delivery one - real customers receive real emails today
**Fixed since the last review:**
- ~~Plaintext router/API credentials~~ - now encrypted (see above)
- ~~Static shared secret for owner actions~~ - now a real login (see above)
- ~~No password reset~~ - `POST /api/auth/forgot-password` and
  `/reset-password` exist, with a 30-minute expiring token
- ~~No automated site health polling~~ - now runs every 5 minutes
  (see `server.js`, bottom)
- ~~Voucher generation aborts on a rare code collision~~ - now retries
  automatically instead of failing the whole batch
- ~~Migrations aren't safely re-runnable~~ - `schema.sql` now uses
  `IF NOT EXISTS` everywhere, safe to run again on a partially-migrated DB

**Still genuinely open:**
- **Email sends from a Gmail address, not a branded domain** - works for
  real customers today (see above), purely a polish/scale item for later.
- **Omada External Portal endpoint** is still unverified against a real
  Controller - TP-Link's exact request path/params differ by firmware
  version (see comments in `omada.js`).
- **No multi-tenant billing enforcement** - a tenant's `/billing`
  subscription can lapse without anything currently blocking their portal.
- **Database-level test coverage** is still missing, as noted above.

## Suggested build order from here
1. Get Mikrotik redemption working end-to-end against your own BITTNET
   router first - it's the simpler, non-version-fragmented integration.
2. Verify the Omada flow against your real Controller version.
3. Add plan-expiry enforcement for tenant subscriptions.
4. Once there's revenue, buy a real domain and swap to Resend for branded
   email sending (see "Email" above) - not blocking before then.
5. Only then think about onboarding other WiFi owners as paying tenants.
