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

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_deal_id ON transactions(deal_id);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_sale_date ON deals(sale_date);
CREATE INDEX IF NOT EXISTS idx_deals_finance_company ON deals(finance_company);
