-- YourNet Control: multi-tenant schema
-- One "tenant" = one WiFi business owner (e.g. BITTNET). Each tenant can have
-- multiple sites, each site is either a Mikrotik router or an Omada Controller site.
--
-- IMPORTANT: every statement here is written to be safely re-runnable
-- (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, ALTER TABLE ADD
-- COLUMN IF NOT EXISTS). This means `npm run migrate` can be run again any
-- time new tables/columns are added, on a database that already has some or
-- all of this - it will only apply what's missing, never error on what
-- already exists.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_name TEXT NOT NULL,
  owner_email TEXT UNIQUE NOT NULL,
  owner_phone TEXT,
  password_hash TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  plan TEXT NOT NULL DEFAULT 'trial',        -- trial | starter | pro | licensed
  plan_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added after the initial release - safe to re-add on an already-migrated DB.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS verify_token_hash TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS verify_token_expires_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

-- OFF by default (opt-in) - admin/dashboard pages keep the SVG mesh
-- background unless the tenant turns this on.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS admin_use_rotating_backgrounds BOOLEAN NOT NULL DEFAULT false;

-- Monthly platform license/subscription (replaces the old one-time
-- "licensed forever" model). subscription_status drives whether the
-- tenant's own auto-renewal is currently expected to succeed each month:
--   active     - billing_authorization on file, auto-charge will be attempted
--   past_due   - most recent auto-charge failed; plan_expires_at/grace
--                period (see routes/auth.js login) decides lockout, not this
--   manual     - owner-managed (e.g. legacy/offline account), never auto-charged
--   canceled   - tenant is done; no further charge attempts
-- billing_authorization stores the gateway's reusable charge token
-- (Paystack authorization_code) - NOT raw card data, never logged.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_provider TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_authorization TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS next_billing_at TIMESTAMPTZ;

-- Staff/kiosk logins belonging to a tenant (agents who sell vouchers)
CREATE TABLE IF NOT EXISTS tenant_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'agent',        -- owner | manager | agent
  password_hash TEXT NOT NULL,
  commission_pct NUMERIC(5,2) DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, email)
);

-- A physical network location. type determines which integration module is used.
CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mikrotik', 'omada', 'unifi', 'meraki')),

  mk_host TEXT,
  mk_api_port INTEGER DEFAULT 8728,
  mk_username TEXT,
  mk_password_encrypted TEXT,
  mk_hotspot_profile TEXT DEFAULT 'default',
  mk_use_tls BOOLEAN NOT NULL DEFAULT false,

  omada_base_url TEXT,
  omada_client_id TEXT,
  omada_client_secret_encrypted TEXT,
  omada_omadac_id TEXT,
  omada_site_id TEXT,

  unifi_base_url TEXT,
  unifi_username TEXT,
  unifi_password_encrypted TEXT,
  unifi_site TEXT DEFAULT 'default',
  unifi_auth_mode TEXT DEFAULT 'classic', -- 'classic' (self-hosted/Cloud Key) or 'unifios' (UDM/UDM-Pro/UDR API key)
  unifi_api_key_encrypted TEXT, -- only used when unifi_auth_mode = 'unifios'

  meraki_dashboard_api_key_encrypted TEXT,
  meraki_network_id TEXT,

  status TEXT NOT NULL DEFAULT 'unconfigured',
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft-deactivate: mirrors packages.active. A site with vouchers, orders,
  -- or pppoe subscribers referencing it can't be hard-deleted (see
  -- DELETE /:id in routes/sites.js), so this lets it drop out of pickers
  -- without breaking that history.
  active BOOLEAN NOT NULL DEFAULT true,

  -- Portal branding: NULL means "use the default YourNet portal look".
  -- portal_custom_html, if set, is served as the ENTIRE captive portal page
  -- for this site instead of the built-in template - an advanced escape
  -- hatch for installers who want full control. It must still POST to
  -- /portal/:siteId/redeem itself (documented in the admin UI) since that
  -- endpoint doesn't change.
  portal_business_name TEXT,
  portal_logo_url TEXT,
  portal_primary_color TEXT,
  portal_custom_html TEXT,

  -- Extra default-template fields (all optional, NULL = not shown on the
  -- portal page). These only affect the built-in template's rendering -
  -- a tenant using portal_custom_html controls all of this themselves.
  portal_background_image_url TEXT,
  portal_caution_text TEXT,        -- shown as a warning/notice box on the portal page
  portal_whatsapp_number TEXT,     -- shown as a "Need help?" tap-to-chat link, digits only incl. country code
  portal_momo_number TEXT,         -- manual MoMo fallback: number to display for direct transfer
  portal_momo_name TEXT,           -- manual MoMo fallback: registered account name shown alongside the number

  -- ON by default: a tenant with no custom portal_background_image_url gets
  -- a free rotating photo background out of the box, no setup required.
  -- Setting a custom background_image_url takes priority over this
  -- regardless of the flag's value - see routes/portal.js.
  portal_use_rotating_backgrounds BOOLEAN NOT NULL DEFAULT true
);

-- Safe to re-run: adds the portal branding columns above to a sites table
-- that already existed before this feature (CREATE TABLE IF NOT EXISTS
-- alone won't add columns to an existing table).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_business_name TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_logo_url TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_primary_color TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_custom_html TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_background_image_url TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_caution_text TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_whatsapp_number TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_momo_number TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_momo_name TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS portal_use_rotating_backgrounds BOOLEAN NOT NULL DEFAULT true;

-- Safe to re-run: lets a Mikrotik site connect over API-SSL (port 8729,
-- encrypted) instead of the plaintext API (port 8728). Defaults to false so
-- every existing site keeps connecting exactly as before this column
-- existed. RouterOS's API-SSL certs are typically self-signed, so the
-- connection code intentionally doesn't verify the cert chain - see
-- mikrotik.js for that tradeoff.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS mk_use_tls BOOLEAN NOT NULL DEFAULT false;

-- Safe to re-run: adds sites.active to a sites table that already existed
-- before this feature - this was mistakenly written only inside the
-- CREATE TABLE block above, which CREATE TABLE IF NOT EXISTS silently
-- skips for a table that already exists, so any pre-existing deployment
-- never actually got the column despite migrate.js reporting success.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- Same bug, different column: owner_email was declared UNIQUE only inside
-- CREATE TABLE IF NOT EXISTS tenants above, so on a database where tenants
-- already existed, that constraint never actually took effect - nothing
-- has ever stopped two accounts sharing an email at the DB level (the
-- app-level check in src/routes/auth.js /signup is new too, and doesn't
-- help with rows that already got created before it existed).
--
-- Duplicates from before this fix are handled non-destructively: for any
-- owner_email shared by more than one tenant, the oldest row keeps its
-- email untouched (that's the "real" account); every newer duplicate gets
-- its email tagged with +dupN@duplicate.local instead of being deleted, so
-- no data or payment history is lost, but it also means whoever signed up
-- for a tagged row can no longer log in with their original email - if any
-- of the flagged rows in the query below turn out to be real customers
-- rather than test signups, they need a manual look before relying on
-- this running unattended again.
WITH ranked AS (
  SELECT id, owner_email,
         ROW_NUMBER() OVER (PARTITION BY owner_email ORDER BY created_at ASC, id ASC) AS rn
  FROM tenants
)
UPDATE tenants t
SET owner_email = t.owner_email || '+dup' || ranked.rn || '@duplicate.local'
FROM ranked
WHERE t.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_owner_email ON tenants(owner_email);

-- Closes a real hole: Hubtel's webhook has no built-in signature, so
-- without this an order's own `provider_reference` (handed straight back
-- to whoever just called buy-voucher/purchase-initialize) was enough to
-- forge a "payment succeeded" webhook and get a free voucher or license
-- key. See utils/webhookToken.js for the fix - a one-time token embedded
-- in the callback URL, only its hash stored here.
ALTER TABLE voucher_orders ADD COLUMN IF NOT EXISTS webhook_token_hash TEXT;
ALTER TABLE license_purchase_orders ADD COLUMN IF NOT EXISTS webhook_token_hash TEXT;

-- Safe to re-run: adds UniFi support to a sites table that predates it.
-- The type CHECK constraint has to be dropped and recreated to allow the
-- new 'unifi' value - ADD COLUMN IF NOT EXISTS alone can't widen a CHECK.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS unifi_base_url TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS unifi_username TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS unifi_password_encrypted TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS unifi_site TEXT DEFAULT 'default';
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_type_check;
ALTER TABLE sites ADD CONSTRAINT sites_type_check CHECK (type IN ('mikrotik', 'omada', 'unifi', 'meraki'));

-- Safe to re-run: adds UniFi OS Console (API-key) auth mode support to a
-- sites table that predates it. Existing rows default to 'classic' so
-- they keep working unchanged.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS unifi_auth_mode TEXT DEFAULT 'classic';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS unifi_api_key_encrypted TEXT;

-- Safe to re-run: adds Cisco Meraki support to a sites table that predates
-- it. See src/integrations/meraki.js for why this integration only needs
-- a Dashboard API key + network ID, not router-style host/username/password.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS meraki_dashboard_api_key_encrypted TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS meraki_network_id TEXT;

CREATE TABLE IF NOT EXISTS packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  duration_minutes INTEGER NOT NULL,
  rate_limit_down TEXT,
  rate_limit_up TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE packages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS vouchers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID REFERENCES sites(id),
  package_id UUID NOT NULL REFERENCES packages(id),
  agent_id UUID REFERENCES tenant_users(id),
  code TEXT NOT NULL,
  batch TEXT,
  status TEXT NOT NULL DEFAULT 'unused',
  provider_ref TEXT,
  client_mac TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  UNIQUE(tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_vouchers_tenant_status ON vouchers(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(tenant_id, code);

CREATE TABLE IF NOT EXISTS license_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key_code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',
  amount NUMERIC(10,2),
  currency TEXT NOT NULL DEFAULT 'GHS',
  payment_method TEXT,
  payment_reference TEXT,
  buyer_email TEXT,
  buyer_phone TEXT,
  tenant_id UUID REFERENCES tenants(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_license_keys_code ON license_keys(key_code);

-- 'signup' keys create a brand-new tenant (original behavior). 'reactivation'
-- keys instead attach to an EXISTING tenant (found by buyer_email at
-- redemption) and just extend/restart their subscription - used for
-- migrating old one-time-license accounts onto the monthly plan, or for a
-- lapsed subscriber who paid again without their gateway authorization
-- still on file (e.g. they used a different card).
ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS key_type TEXT NOT NULL DEFAULT 'signup';
ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS billing_provider TEXT;
ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS billing_authorization TEXT;

-- Tracks a license purchase from "checkout started" through "key issued",
-- across whichever gateway the buyer picked on /license (Paystack,
-- Flutterwave, or Hubtel). Needed because Hubtel confirms via an async
-- webhook - there's no browser redirect carrying the buyer's details at
-- that point, so they have to be looked up by provider_reference instead.
CREATE TABLE IF NOT EXISTS license_purchase_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider TEXT NOT NULL CHECK (provider IN ('paystack','hubtel','flutterwave')),
  provider_reference TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  buyer_phone TEXT,
  amount NUMERIC(10,2),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  issued_key_id UUID REFERENCES license_keys(id),
  webhook_token_hash TEXT, -- Hubtel orders only, see utils/webhookToken.js
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(provider, provider_reference)
);

CREATE INDEX IF NOT EXISTS idx_license_purchase_orders_ref ON license_purchase_orders(provider, provider_reference);

-- purpose='signup' (default): paying issues a fresh signup key, same as
-- before. purpose='reactivate': this order belongs to an EXISTING tenant
-- (tenant_id set) - on success we extend/restart their subscription
-- directly instead of minting a signup key. billing_authorization/
-- billing_provider capture whatever reusable charge token the gateway
-- returned, so subscriptionBilling.js can auto-charge next month.
ALTER TABLE license_purchase_orders ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'signup';
ALTER TABLE license_purchase_orders ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE license_purchase_orders ADD COLUMN IF NOT EXISTS billing_provider TEXT;
ALTER TABLE license_purchase_orders ADD COLUMN IF NOT EXISTS billing_authorization TEXT;

-- LEGACY - kept only so historical data stays queryable directly in the
-- database if you ever need it. The old direct-MoMo-transfer-with-manual-
-- approval flow (momo-claim / admin/momo-claims routes, momo-admin.html)
-- has been fully removed from the app in favor of the multi-provider
-- checkout above - nothing in the app reads from or writes to this table
-- anymore.
CREATE TABLE IF NOT EXISTS momo_payment_claims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyer_name TEXT,
  buyer_email TEXT NOT NULL,
  buyer_phone TEXT,
  business_name TEXT,
  momo_reference TEXT,
  amount NUMERIC(10,2),
  status TEXT NOT NULL DEFAULT 'pending',
  issued_key_id UUID REFERENCES license_keys(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_momo_claims_status ON momo_payment_claims(status);

-- One row per monthly platform-license charge attempt (first payment at
-- signup/reactivation, plus every automatic renewal after that). provider/
-- provider_reference is the generalized pair used going forward;
-- paystack_reference is kept only so old rows written before this column
-- existed stay valid (it was UNIQUE on its own before - not anymore, since
-- a NULL paystack_reference on every Flutterwave/manual row would otherwise
-- collide under a naive unique constraint).
CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  paystack_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS provider_reference TEXT;
-- kind: 'initial' (first payment, at signup or reactivation) vs 'renewal'
-- (unattended monthly auto-charge) - lets /license-admin distinguish them.
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'initial';
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_provider_ref
  ON subscription_payments(provider, provider_reference) WHERE provider_reference IS NOT NULL;

-- Each tenant links their OWN payment gateway credentials (same pattern as
-- their Mikrotik/Omada site credentials) so customer payments land directly
-- in the tenant's own account, not the platform's. One row per provider per
-- tenant; is_active marks which one is actually used for checkout.
CREATE TABLE IF NOT EXISTS payment_gateways (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('paystack','hubtel','flutterwave')),
  is_active BOOLEAN NOT NULL DEFAULT false,

  paystack_secret_key_encrypted TEXT,
  paystack_public_key TEXT,

  hubtel_client_id TEXT,
  hubtel_client_secret_encrypted TEXT,
  hubtel_merchant_account_number TEXT,

  flutterwave_secret_key_encrypted TEXT,
  flutterwave_public_key TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_payment_gateways_tenant ON payment_gateways(tenant_id);

-- A customer buying a voucher online (not printed/MoMo-manual) - tracks the
-- order from "started checkout" through "paid, voucher issued".
CREATE TABLE IF NOT EXISTS voucher_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id),
  package_id UUID NOT NULL REFERENCES packages(id),
  customer_email TEXT,
  customer_phone TEXT,
  provider TEXT NOT NULL,
  provider_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  voucher_id UUID REFERENCES vouchers(id),
  webhook_token_hash TEXT, -- Hubtel orders only, see utils/webhookToken.js
  customer_note TEXT, -- manual_momo orders only: whatever the customer typed as their MoMo reference, for the owner to eyeball against their own MoMo alert - never trusted as proof on its own, see routes/vouchers.js manual-orders/:id/approve
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(provider, provider_reference)
);

ALTER TABLE voucher_orders ADD COLUMN IF NOT EXISTS customer_note TEXT;

CREATE INDEX IF NOT EXISTS idx_voucher_orders_reference ON voucher_orders(provider, provider_reference);

-- Historical site snapshots, sampled roughly once an hour by the poller in
-- src/server.js (the same loop that already updates sites.status every 5
-- minutes now also writes one row here on its hourly pass). This is what
-- powers the "connected clients over time" and "uptime history" charts on
-- the dashboard - sites/vouchers/packages only ever hold CURRENT state, so
-- without this table there'd be no history to chart at all.
-- Revenue-over-time and voucher-sales-over-time charts do NOT need this
-- table - they're computed directly from vouchers.created_at/redeemed_at,
-- which already carry real timestamps.
CREATE TABLE IF NOT EXISTS site_status_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  online BOOLEAN NOT NULL,
  client_count INTEGER,     -- NULL if the client count call itself failed/errored (online can still be true)
  error TEXT                -- set when online=false, the ping error message (helps "why was it down" later)
);

CREATE INDEX IF NOT EXISTS idx_site_snapshots_site_time ON site_status_snapshots(site_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_site_snapshots_tenant_time ON site_status_snapshots(tenant_id, checked_at);

-- ============================================================================
-- PPPoE subscriber billing (recurring ISP-style accounts, distinct from the
-- one-time hotspot vouchers above). A "plan" is a speed+monthly-price
-- product; a "subscriber" is one customer's recurring account, mirrored as
-- a real /ppp/secret on their site's Mikrotik router (see
-- integrations/mikrotik.js createPppoeSecret/removePppoeSecret/etc).
-- Everything here is tenant-scoped the same way sites/vouchers/packages
-- are - every query in routes/pppoe.js filters on tenant_id, never trusts
-- a client-supplied id alone.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pppoe_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  billing_period_days INTEGER NOT NULL DEFAULT 30,
  -- Either rate_limit (e.g. '5M/10M', applied directly on the /ppp/secret,
  -- validated against a strict pattern in utils/validate.js before it ever
  -- reaches the router) or router_profile (name of an existing /ppp/profile
  -- already configured on the router) - router_profile wins if both are set.
  rate_limit TEXT,
  router_profile TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pppoe_plans_tenant ON pppoe_plans(tenant_id);

CREATE TABLE IF NOT EXISTS pppoe_subscribers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES pppoe_plans(id),
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  -- PPPoE login name, mirrored as the /ppp/secret "name" on the router.
  -- Restricted to a safe charset at the API layer (letters/digits/./_/-)
  -- before ever being used - not just for the router call, but because it
  -- doubles as a real login credential a customer's router will send in
  -- plaintext over PPP, so keeping it unambiguous matters.
  username TEXT NOT NULL,
  -- Same AES-256-GCM envelope as router/gateway credentials elsewhere
  -- (utils/credentialCrypto.js) - the plaintext is only ever generated or
  -- accepted at creation/reset time, returned once, and never stored or
  -- logged in plaintext anywhere.
  ppp_password_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','overdue','cancelled')),
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  next_due_date DATE NOT NULL,
  last_payment_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Uniqueness is per-site (per-router), not per-tenant, since that's what
  -- the router itself enforces on /ppp/secret names.
  UNIQUE(site_id, username)
);

CREATE INDEX IF NOT EXISTS idx_pppoe_subscribers_tenant ON pppoe_subscribers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pppoe_subscribers_site ON pppoe_subscribers(site_id);
-- Powers the renewal/reminder job (next increment): "who's due or overdue".
CREATE INDEX IF NOT EXISTS idx_pppoe_subscribers_due ON pppoe_subscribers(next_due_date) WHERE status IN ('active','overdue');

-- Scaffolded now so the card-service/renewal-billing increment can slot in
-- without another migration. Same provider/provider_reference + webhook
-- token-hash shape as voucher_orders/subscription_payments, since that
-- pattern is what closed the forgeable-webhook hole there - reusing it here
-- means PPPoE payments get that protection from day one, not bolted on later.
CREATE TABLE IF NOT EXISTS pppoe_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscriber_id UUID NOT NULL REFERENCES pppoe_subscribers(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  provider TEXT,
  provider_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  period_start DATE,
  period_end DATE,
  webhook_token_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pppoe_payments_subscriber ON pppoe_payments(subscriber_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pppoe_payments_provider_ref
  ON pppoe_payments(provider, provider_reference) WHERE provider_reference IS NOT NULL;

-- Agent secret question: a lightweight second factor for the agent
-- self-service voucher generation added below. Set by the owner/manager
-- when adding or editing an agent (never by the agent themselves, so a
-- compromised agent login alone can't also rewrite the recovery question).
-- Only the hash is stored, same bcrypt pattern as password_hash.
-- secret_failed_attempts/secret_locked_until back the lockout in
-- routes/agents.js POST /verify-secret - a few wrong guesses in a row
-- locks the agent out of generating for a cooldown window and raises an
-- admin-visible alert (see agent_activity_log below), since repeated wrong
-- answers from a token that otherwise proves tenant+role is one of the
-- stronger signals available that the login itself may be compromised.
ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS secret_question TEXT;
ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS secret_answer_hash TEXT;
ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS secret_failed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS secret_locked_until TIMESTAMPTZ;

-- Feed for the owner's "Activity Log" tab: every agent-self-generated
-- voucher batch, plus every failed/locked secret-question attempt, so an
-- owner can see agent-side activity as it happens rather than only
-- discovering it later in the voucher/commission numbers.
-- agent_name_snapshot is kept alongside agent_id (which sets NULL if the
-- agent is ever deleted) so the log stays readable/historical either way.
CREATE TABLE IF NOT EXISTS agent_activity_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES tenant_users(id) ON DELETE SET NULL,
  agent_name_snapshot TEXT,
  type TEXT NOT NULL, -- 'voucher_batch' | 'secret_question_failed' | 'secret_question_locked'
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_activity_tenant_created ON agent_activity_log(tenant_id, created_at DESC);
