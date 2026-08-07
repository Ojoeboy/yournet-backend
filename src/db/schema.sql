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
  type TEXT NOT NULL CHECK (type IN ('mikrotik', 'omada')),

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

  status TEXT NOT NULL DEFAULT 'unconfigured',
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
