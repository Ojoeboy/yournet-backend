-- Equipment inventory: lets a tenant log any hardware (routers, APs,
-- switches, CPEs, power gear, servers) whether or not YourNet has a live
-- API integration for it. This is deliberately a simple record-keeping
-- table, not a monitoring system - it's how a Meiweisi AP or any other
-- unintegrated device gets a home in the dashboard.

CREATE TABLE IF NOT EXISTS equipment (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Nullable: equipment can be logged before it's assigned to a site
  -- (e.g. sitting in storage, or a spare).
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,

  category TEXT NOT NULL CHECK (category IN (
    'router', 'access_point', 'switch', 'cpe', 'power_equipment', 'server', 'other'
  )),

  brand TEXT,
  model TEXT,
  serial_number TEXT,
  mac_address TEXT,

  status TEXT NOT NULL DEFAULT 'in_service' CHECK (status IN (
    'in_service', 'spare', 'faulty', 'retired'
  )),

  purchase_date DATE,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_tenant ON equipment(tenant_id);
CREATE INDEX IF NOT EXISTS idx_equipment_site ON equipment(site_id);
