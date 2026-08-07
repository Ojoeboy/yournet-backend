# YourNet Control - Backend

Real backend for the YourNet Control front-end: multi-tenant, with actual
Mikrotik RouterOS and TP-Link Omada integrations (not simulated data).

## What this replaces from the old HTML-only app
| Before (browser-only) | Now |
|---|---|
| Fake AP stats via `Math.random()` | Real client/device counts pulled from RouterOS API or Omada Open API |
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
     `api` permission enabled.
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

Two ways a key gets issued:
1. **Paystack** (`/license` page, "Pay with Paystack") - fully automatic.
   Payment is verified server-side before a key is generated and shown to
   the buyer.
2. **Direct MoMo transfer** to the number shown on `/license` - the buyer
   submits a claim (name, email, phone, MoMo reference) right on that page,
   which lands in a real pending queue. You review it against your actual
   MoMo transaction history at `/license-admin` after logging in at
   `/owner-login` (real username/password, hashed - not a shared secret
   pasted into every request) and click Approve to generate a real key, or
   Reject if nothing matches. This is deliberately manual - raw peer-to-peer
   MoMo transfers can't be verified via API without a paid aggregator - but
   it's now a proper queue instead of a WhatsApp message you might lose.

Price is set via `LICENSE_PRICE_GHS` in `.env` - change it to whatever
you're actually charging.

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

## Email (Resend)
Password reset and account verification emails now send for real, via
[Resend](https://resend.com) (free for 3,000 emails/month, 100/day). Set
`RESEND_API_KEY` in `.env` after signing up.

**Real limit to know before relying on this**: sending to actual customers
(not just the email you signed up to Resend with) requires verifying a
domain you own in Resend's dashboard - a couple of DNS records they give
you. Without a verified domain, Resend will only deliver to your own
account email, which is fine for testing but not for real users.

If `RESEND_API_KEY` isn't set, the app falls back to logging the email
content to the console instead of crashing - useful while developing
locally, not something to rely on once real people are signing up.

## Honest gaps / what still needs attention
**Fixed since the last review:**
- ~~No real email sending~~ - now uses Resend (see above); still needs a
  verified domain before it can reach real customers, not just your own
  Resend account email
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
- **Real email delivery to actual customers still needs a verified domain**
  in Resend (see above) - works today for testing, not yet for strangers.
- **Omada External Portal endpoint** is still unverified against a real
  Controller - TP-Link's exact request path/params differ by firmware
  version (see comments in `omada.js`).
- **No multi-tenant billing enforcement** - a tenant's `/billing`
  subscription can lapse without anything currently blocking their portal.
- **Database-level test coverage** is still missing, as noted above.

## Suggested build order from here
1. Get Mikrotik redemption working end-to-end against your own BITTNET
   router first - it's the simpler, non-version-fragmented integration.
2. Verify a domain in Resend so real customers (not just you) can receive
   password resets and verification emails.
3. Verify the Omada flow against your real Controller version.
4. Add plan-expiry enforcement for tenant subscriptions.
5. Only then think about onboarding other WiFi owners as paying tenants.
