# Fixes applied to yournet-backend — 2026-08-10

All 6 previously-logged shortfalls are now addressed. Summary of changes:

## 1. Agent login — built for real (chosen: full self-service portal)
- `POST /api/agents/login` — new public endpoint, tenant_users role='agent'.
- Agent JWTs (`role:'agent'`) are now blocked from every owner/manager route
  (sites, packages, dashboard, gateways, pppoe, voucher management) via a
  new `requireNotAgent` middleware — previously any valid tenant JWT could
  reach anything, regardless of role.
- New page `public/agent.html`: agent logs in, sees their own lifetime
  summary + settlement (date/batch filter), can change their own password.
- Owner's "Add agent" form (dashboard.html) now collects email + optional
  password; if left blank, a one-time temp password is generated and shown
  once so the owner can hand it to the agent.
- `POST /api/agents` now requires a valid email (was optional/unused).

## 2. Voucher generation can now attach to an agent/batch
- Step 4 form (admin.html) gained an "Agent" dropdown (optional) and a
  "Batch label" text field, both now sent through to
  `POST /api/vouchers/generate`, which already supported them.

## 3. Printed vouchers now show price + duration
- `GET /api/vouchers` now joins `packages` (was `SELECT *` on vouchers
  only) — returns label/price/duration_minutes.
- `print.html` card template now renders both, using the same
  duration-formatting helper as the packages screen.

## 4. Compact print mode
- print.html has a new "Compact" checkbox — switches to a slim-strip card
  layout (4 columns per A4 row instead of 2 credit-card-sized ones),
  reflected in both the on-screen and `@media print` styles.

## 5. Sites can now be deactivated or deleted
- Schema: added `sites.active` (default true), mirroring `packages.active`.
- `GET /api/sites` defaults to active-only; `?all=true` for management view.
- `PATCH /api/sites/:id` accepts `active`; no longer forces a credential
  re-test when only toggling active/inactive.
- `DELETE /api/sites/:id` — safe delete: blocked (409) if the site has any
  vouchers, voucher_orders, OR pppoe_subscribers referencing it (the last
  one matters because pppoe_subscribers.site_id cascades on delete at the
  DB level — a naive delete would have silently wiped billing subscribers).
- admin.html gained a "Manage sites" table (Deactivate/Activate + Delete),
  same pattern as the existing packages table.

## 6. Tenant currency now respected (chosen: full multi-currency wiring)
- `tenants.currency` is now threaded through: Paystack + Flutterwave
  gateway calls, `paymentGatewayService.initializeCheckout`, and
  `portal.js` (`/config` + `/buy-voucher`) — customers now see and pay in
  the tenant's actual chosen currency, not a hardcoded "GHS".
- portal.html, admin.html, dashboard.html, settlement.html, print.html all
  now read/display the tenant's real currency (stored client-side at
  login) instead of a hardcoded "GHS" string.
- **Deliberately left as GHS-fixed:** YourNet's own SaaS subscription
  billing (`billing.js`, `license.js` signup/renewal, `subscriptionBilling.js`
  auto-renewal charge). Those charge YourNet's own fixed GHS price list
  (e.g. "150" = 150 GHS) to the WiFi business owner — converting the
  *label* without converting the *amount* would misprice the charge, and
  real currency conversion needs FX rates, which is a materially bigger
  feature than the "wire the string through" fix this shortfall needed.
  If you do want SaaS billing itself to support other currencies, flag it
  separately — it's a different scope of work.
- Not touched: `pppoe.html`'s hardcoded "GHS" (PPPoE recurring billing
  module) — this wasn't one of the 6 originally logged shortfalls; noting
  it here as a related follow-up if you want it included later.

---
Nothing above required new npm dependencies. Run your normal migration
(`npm run migrate`) to pick up the new `sites.active` column — the
schema.sql statement is idempotent like the rest of the file.
