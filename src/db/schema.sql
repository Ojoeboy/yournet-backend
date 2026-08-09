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
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

-- OFF by default (opt-in) - admin/dashboard pages keep the SVG mesh
-- background unless the tenant turns this on.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS admin_use_rotating_backgrounds BOOLEAN NOT NULL DEFAULT false;

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
  active BOOLEAN NOT NULL DEFAULT true
);

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

CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  paystack_reference TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(provider, provider_reference)
);

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
