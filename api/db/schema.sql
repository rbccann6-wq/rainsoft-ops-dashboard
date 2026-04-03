-- RainSoft Business Finance Database Schema
-- PostgreSQL 16

-- ─── Transactions ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transactions (
  id              SERIAL PRIMARY KEY,
  date            DATE NOT NULL,
  description     TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,  -- positive=income, negative=expense
  category        TEXT,
  subcategory     TEXT,
  type            TEXT NOT NULL,           -- income | expense | transfer
  source          TEXT,                    -- tiller | manual | funding_sheet
  account         TEXT,
  deal_id         INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Deals ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deals (
  id                  SERIAL PRIMARY KEY,
  customer_name       TEXT NOT NULL,
  customer_address    TEXT,
  customer_phone      TEXT,
  sale_amount         NUMERIC(12,2),
  deal_source         TEXT,               -- lowes | homedepot | direct | ispc
  source_fee_pct      NUMERIC(5,2),       -- e.g. 12.00 for 12% HD fee (variable per deal)
  source_fee_amount   NUMERIC(12,2),      -- calculated: sale_amount * source_fee_pct / 100
  net_revenue         NUMERIC(12,2),      -- sale_amount - source_fee_amount
  finance_company     TEXT,               -- ispc | foundation | synchrony | homedepot | lowes
  finance_amount      NUMERIC(12,2),
  approval_status     TEXT,               -- approved | pending | denied
  approval_rate       NUMERIC(5,2),       -- % of requested amount approved
  credit_score_range  TEXT,               -- from ISPC call
  bid_rate_reason     TEXT,               -- from ISPC call if <100%
  status              TEXT DEFAULT 'sold', -- sold | financed | docs_sent | docs_complete | funded | deposited | verified
  sales_rep           TEXT,
  sale_date           DATE,
  expected_funding_date DATE,
  actual_funding_date DATE,
  expected_deposit    NUMERIC(12,2),
  actual_deposit      NUMERIC(12,2),
  deposit_verified    BOOLEAN DEFAULT FALSE,
  deposit_date        DATE,
  salesforce_id       TEXT,
  crm_id              TEXT,               -- Lovable CRM (May 2026+)
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Funding Sheets ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS funding_sheets (
  id              SERIAL PRIMARY KEY,
  received_date   DATE NOT NULL,
  finance_company TEXT NOT NULL,
  email_id        TEXT,                   -- M365 message ID
  total_amount    NUMERIC(12,2),
  deal_count      INTEGER,
  raw_text        TEXT,
  processed       BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS funding_sheet_items (
  id                SERIAL PRIMARY KEY,
  funding_sheet_id  INTEGER REFERENCES funding_sheets(id),
  deal_id           INTEGER REFERENCES deals(id),
  customer_name     TEXT,
  amount            NUMERIC(12,2),
  expected_deposit_date DATE,
  matched           BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Categories ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  group_name  TEXT NOT NULL,             -- Revenue | COGS | Payroll | Marketing | Operations | Financial
  type        TEXT NOT NULL,             -- income | expense
  tax_relevant BOOLEAN DEFAULT TRUE,
  sort_order  INTEGER DEFAULT 0
);

-- Business categories
INSERT INTO categories (name, group_name, type, sort_order) VALUES
  -- Revenue
  ('Direct Sales Revenue',        'Revenue', 'income', 10),
  ('Lowe''s Deal Revenue (Net)',   'Revenue', 'income', 11),
  ('Home Depot Deal Revenue (Net)','Revenue', 'income', 12),
  ('ISPC Finance Payout',         'Revenue', 'income', 13),
  ('Foundation Finance Payout',   'Revenue', 'income', 14),
  ('Synchrony Finance Payout',    'Revenue', 'income', 15),
  ('Other Income',                'Revenue', 'income', 19),
  -- Cost of Goods
  ('Pentair Equipment',           'COGS', 'expense', 20),
  ('Installation Supplies',       'COGS', 'expense', 21),
  ('Lowe''s Fee (12%)',           'COGS', 'expense', 22),
  ('Home Depot Fee',              'COGS', 'expense', 23),
  -- Lead Costs
  ('SmartMail Leads',             'Marketing', 'expense', 30),
  ('Lowe''s Lead Fees',           'Marketing', 'expense', 31),
  ('Home Depot Lead Fees',        'Marketing', 'expense', 32),
  ('Google Ads',                  'Marketing', 'expense', 33),
  ('Facebook/Instagram Ads',      'Marketing', 'expense', 34),
  -- Payroll
  ('Sales Rep Commission',        'Payroll', 'expense', 40),
  ('Employee Wages',              'Payroll', 'expense', 41),
  ('Payroll Taxes',               'Payroll', 'expense', 42),
  -- Operations
  ('Dialpad (Phone)',             'Operations', 'expense', 50),
  ('Salesforce CRM',              'Operations', 'expense', 51),
  ('Rippling (HR/Payroll)',       'Operations', 'expense', 52),
  ('Software Subscriptions',      'Operations', 'expense', 53),
  ('Office Supplies',             'Operations', 'expense', 54),
  ('Vehicle & Fuel',              'Operations', 'expense', 55),
  ('Insurance',                   'Operations', 'expense', 56),
  ('Rent/Utilities',              'Operations', 'expense', 57),
  -- Financial
  ('Bank Fees',                   'Financial', 'expense', 60),
  ('Loan Payments',               'Financial', 'expense', 61),
  ('Taxes',                       'Financial', 'expense', 62)
ON CONFLICT (name) DO NOTHING;

-- ─── Batch Deposits ──────────────────────────────────────────────────────────
-- ISPC often combines multiple deals into one bank deposit.
-- This table links a single bank deposit to multiple deals.

CREATE TABLE IF NOT EXISTS batch_deposits (
  id                SERIAL PRIMARY KEY,
  finance_company   TEXT NOT NULL,
  deposit_date      DATE,
  deposit_amount    NUMERIC(12,2) NOT NULL,   -- what actually hit the bank
  expected_amount   NUMERIC(12,2),             -- sum of all deals in this batch
  variance          NUMERIC(12,2),             -- deposit_amount - expected_amount
  verified          BOOLEAN DEFAULT FALSE,
  bank_reference    TEXT,                      -- bank transaction reference if available
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Links each deal to the batch deposit it was paid in
CREATE TABLE IF NOT EXISTS batch_deposit_deals (
  id                SERIAL PRIMARY KEY,
  batch_deposit_id  INTEGER REFERENCES batch_deposits(id) ON DELETE CASCADE,
  deal_id           INTEGER REFERENCES deals(id),
  expected_amount   NUMERIC(12,2),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(batch_deposit_id, deal_id)
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_deal_id ON transactions(deal_id);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_sale_date ON deals(sale_date);
CREATE INDEX IF NOT EXISTS idx_deals_finance_company ON deals(finance_company);
CREATE INDEX IF NOT EXISTS idx_batch_deposits_company ON batch_deposits(finance_company);
CREATE INDEX IF NOT EXISTS idx_batch_deposits_date ON batch_deposits(deposit_date);
CREATE INDEX IF NOT EXISTS idx_batch_deposit_deals_batch ON batch_deposit_deals(batch_deposit_id);

-- ─── Salesforce Migration Tables ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_accounts (
  id                    SERIAL PRIMARY KEY,
  sf_id                 TEXT UNIQUE NOT NULL,
  customer_number       TEXT,
  first_name            TEXT,
  middle_name           TEXT,
  last_name             TEXT,
  full_name             TEXT,
  email                 TEXT,
  phone                 TEXT,
  all_phones            TEXT,
  street                TEXT,
  city                  TEXT,
  state                 TEXT,
  zip                   TEXT,
  country               TEXT,
  lat                   NUMERIC,
  lng                   NUMERIC,
  lead_source           TEXT,
  account_source        TEXT,
  status                TEXT,
  lead_status           TEXT,
  sales_rep             TEXT,
  is_hd_deal            BOOLEAN,
  region                TEXT,
  water_source          TEXT,
  water_conditions      TEXT,
  water_filters         TEXT,
  hardness_level        NUMERIC,
  tds_level             NUMERIC,
  homeowner             TEXT,
  type_of_home          TEXT,
  house_value           NUMERIC,
  no_in_household       NUMERIC,
  bottled_water         TEXT,
  mr_job                TEXT,
  mrs_job               TEXT,
  kids_other            TEXT,
  appointment_date      DATE,
  gift                  TEXT,
  install_pic           TEXT,
  customer_info         TEXT,
  created_date          TIMESTAMPTZ,
  last_modified_date    TIMESTAMPTZ,
  last_activity_date    DATE,
  migrated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration_log (
  id            SERIAL PRIMARY KEY,
  phase         TEXT NOT NULL,
  object_type   TEXT NOT NULL,
  total_records INTEGER,
  migrated      INTEGER DEFAULT 0,
  failed        INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'pending',  -- pending | running | done | error
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  last_sf_id    TEXT,
  error_msg     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sf_accounts_sf_id ON sf_accounts(sf_id);
CREATE INDEX IF NOT EXISTS idx_sf_accounts_last_name ON sf_accounts(last_name);
CREATE INDEX IF NOT EXISTS idx_sf_accounts_phone ON sf_accounts(phone);

-- ─── Pentair Orders & Inventory ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pentair_orders (
  id                SERIAL PRIMARY KEY,
  order_number      TEXT UNIQUE NOT NULL,
  order_date        DATE,
  desired_ship_date DATE,
  status            TEXT DEFAULT 'ordered',
  customer_name     TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pentair_order_items (
  id                SERIAL PRIMARY KEY,
  order_id          INTEGER REFERENCES pentair_orders(id),
  part_id           TEXT NOT NULL,
  description       TEXT,
  quantity_ordered  INTEGER,
  quantity_shipped  INTEGER DEFAULT 0,
  unit_price        NUMERIC(12,2),
  line_total        NUMERIC(12,2),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pentair_shipments (
  id                SERIAL PRIMARY KEY,
  order_id          INTEGER REFERENCES pentair_orders(id),
  packlist_number   TEXT,
  tracking_number   TEXT,
  carrier           TEXT,
  ship_date         DATE,
  email_id          TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pentair_invoices (
  id                  SERIAL PRIMARY KEY,
  invoice_number      TEXT UNIQUE NOT NULL,
  order_id            INTEGER REFERENCES pentair_orders(id),
  sales_order         TEXT,
  invoice_date        DATE,
  due_date            DATE,
  subtotal            NUMERIC(12,2),
  freight             NUMERIC(12,2) DEFAULT 0,
  tax                 NUMERIC(12,2) DEFAULT 0,
  total_due           NUMERIC(12,2),
  discount_2pct       NUMERIC(12,2),
  net_after_discount  NUMERIC(12,2),
  payment_terms       TEXT DEFAULT '2% 10 days, Net 30',
  is_credit           BOOLEAN DEFAULT false,
  is_warranty         BOOLEAN DEFAULT false,
  email_id            TEXT,
  pdf_content         BYTEA,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pentair_payments (
  id              SERIAL PRIMARY KEY,
  invoice_id      INTEGER REFERENCES pentair_invoices(id),
  order_id        INTEGER REFERENCES pentair_orders(id),
  sales_order     TEXT,
  amount          NUMERIC(12,2),
  payment_date    DATE,
  creation_date   DATE,
  status          TEXT DEFAULT 'initiated',
  is_bulk         BOOLEAN DEFAULT false,
  memo            TEXT,
  email_id        TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pentair_orders_order_number ON pentair_orders(order_number);
CREATE INDEX IF NOT EXISTS idx_pentair_orders_status ON pentair_orders(status);
CREATE INDEX IF NOT EXISTS idx_pentair_orders_order_date ON pentair_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_pentair_order_items_order_id ON pentair_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_pentair_shipments_order_id ON pentair_shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_pentair_invoices_order_id ON pentair_invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_pentair_invoices_sales_order ON pentair_invoices(sales_order);
CREATE INDEX IF NOT EXISTS idx_pentair_payments_invoice_id ON pentair_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_pentair_payments_sales_order ON pentair_payments(sales_order);

-- ─── Finance Monitor (Portal Deal Tracking) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS finance_monitor_deals (
  deal_id             TEXT NOT NULL,
  portal              TEXT NOT NULL,
  customer_name       TEXT NOT NULL,
  coapplicant         TEXT,
  submitted_date      TEXT,
  assigned_user       TEXT,
  decision            TEXT,
  discount            NUMERIC(5,2),
  funding_requirements TEXT,
  status              TEXT NOT NULL,
  last_status         TEXT,
  status_changed_at   TIMESTAMPTZ,
  docs_requested_at   TIMESTAMPTZ,
  last_checked_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  finance_amount      NUMERIC(10,2),
  buy_rate            NUMERIC(5,2),
  tier                INTEGER,
  reference_number    TEXT,
  option_code         TEXT,
  exp_date            TEXT,
  funding_date        TEXT,
  rescind_date        TEXT,
  state               TEXT,
  address             TEXT,
  PRIMARY KEY (deal_id, portal)
);

CREATE TABLE IF NOT EXISTS finance_monitor_history (
  id          SERIAL PRIMARY KEY,
  deal_id     TEXT NOT NULL,
  portal      TEXT NOT NULL,
  old_status  TEXT,
  new_status  TEXT NOT NULL,
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fm_deals_portal ON finance_monitor_deals(portal);
CREATE INDEX IF NOT EXISTS idx_fm_deals_status ON finance_monitor_deals(status);
CREATE INDEX IF NOT EXISTS idx_fm_deals_customer ON finance_monitor_deals(customer_name);
CREATE INDEX IF NOT EXISTS idx_fm_history_deal ON finance_monitor_history(deal_id, portal);

-- Finance email watcher log
CREATE TABLE IF NOT EXISTS finance_email_log (
  id              SERIAL PRIMARY KEY,
  email_id        TEXT UNIQUE NOT NULL,
  from_domain     TEXT,
  subject         TEXT,
  customer_name   TEXT,
  sf_lead_id      TEXT,
  approval_status TEXT,  -- approved | declined | unknown
  amount          NUMERIC,
  pdfs_attached   JSONB DEFAULT '[]',
  processed_at    TIMESTAMPTZ DEFAULT NOW(),
  error           TEXT
);

-- Migration: Add phone/city/zip/email to finance_monitor_deals
ALTER TABLE finance_monitor_deals ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE finance_monitor_deals ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE finance_monitor_deals ADD COLUMN IF NOT EXISTS zip TEXT;
ALTER TABLE finance_monitor_deals ADD COLUMN IF NOT EXISTS email TEXT;
