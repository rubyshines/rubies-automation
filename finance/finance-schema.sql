-- ============================================================================
-- RUBIES Finance — QuickBooks Online Integration
-- Run in Supabase SQL Editor to create all tables and RPCs.
-- ============================================================================

-- OAuth token storage (single row, upserted)
CREATE TABLE IF NOT EXISTS qbo_oauth_tokens (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  realm_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chart of Accounts
CREATE TABLE IF NOT EXISTS qbo_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  full_name TEXT,
  account_type TEXT NOT NULL,
  account_sub_type TEXT,
  classification TEXT,
  current_balance NUMERIC,
  currency_ref TEXT DEFAULT 'USD',
  active BOOLEAN DEFAULT TRUE,
  parent_id TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions (all types, incremental sync)
CREATE TABLE IF NOT EXISTS qbo_transactions (
  id TEXT NOT NULL,
  txn_type TEXT NOT NULL,
  txn_date DATE NOT NULL,
  doc_number TEXT,
  total_amount NUMERIC,
  currency_code TEXT DEFAULT 'USD',
  account_id TEXT,
  entity_name TEXT,
  entity_id TEXT,
  memo TEXT,
  line_items JSONB,
  raw_json JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id, txn_type)
);

CREATE INDEX IF NOT EXISTS idx_qbo_txn_date ON qbo_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_qbo_txn_type ON qbo_transactions(txn_type);
CREATE INDEX IF NOT EXISTS idx_qbo_txn_account ON qbo_transactions(account_id);

-- Monthly report snapshots (P&L, Balance Sheet, Cash Flow)
CREATE TABLE IF NOT EXISTS qbo_report_snapshots (
  report_type TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  accounting_method TEXT DEFAULT 'Accrual',
  report_data JSONB NOT NULL,
  summary JSONB,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (report_type, period_start, period_end)
);

-- Sync progress tracking (high-water marks)
CREATE TABLE IF NOT EXISTS qbo_sync_progress (
  sync_type TEXT PRIMARY KEY,
  last_sync_at TIMESTAMPTZ,
  last_txn_updated_at TIMESTAMPTZ,
  rows_synced INTEGER DEFAULT 0,
  status TEXT DEFAULT 'idle',
  error TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Weekly alert state
CREATE TABLE IF NOT EXISTS qbo_alert_state (
  alert_type TEXT PRIMARY KEY,
  last_sent_at TIMESTAMPTZ,
  last_data JSONB
);

-- ============================================================================
-- RPC Functions
-- ============================================================================

-- Get report snapshot for a period
CREATE OR REPLACE FUNCTION get_financial_summary(p_report_type TEXT, p_start DATE, p_end DATE)
RETURNS JSONB AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
      'report_type', report_type,
      'period_start', period_start,
      'period_end', period_end,
      'report_data', report_data,
      'summary', summary,
      'generated_at', generated_at
    ) FROM qbo_report_snapshots
     WHERE report_type = p_report_type
       AND period_start = p_start AND period_end = p_end
     LIMIT 1),
    '{}'::JSONB
  );
$$ LANGUAGE sql;

-- Get monthly trend for an account (by name, fuzzy)
CREATE OR REPLACE FUNCTION get_account_trend(p_account_name TEXT, p_months INTEGER DEFAULT 12)
RETURNS TABLE(month DATE, total NUMERIC, txn_count BIGINT) AS $$
  SELECT date_trunc('month', t.txn_date)::DATE AS month,
         SUM(t.total_amount) AS total,
         COUNT(*) AS txn_count
  FROM qbo_transactions t
  JOIN qbo_accounts a ON t.account_id = a.id
  WHERE a.name ILIKE '%' || p_account_name || '%'
    AND t.txn_date >= (CURRENT_DATE - (p_months || ' months')::INTERVAL)
  GROUP BY 1
  ORDER BY 1;
$$ LANGUAGE sql;

-- Get all account balances by classification
CREATE OR REPLACE FUNCTION get_account_balances_by_type(p_classification TEXT DEFAULT NULL)
RETURNS TABLE(id TEXT, name TEXT, account_type TEXT, classification TEXT, current_balance NUMERIC) AS $$
  SELECT a.id, a.name, a.account_type, a.classification, a.current_balance
  FROM qbo_accounts a
  WHERE a.active = TRUE
    AND (p_classification IS NULL OR a.classification = p_classification)
  ORDER BY a.classification, a.account_type, a.name;
$$ LANGUAGE sql;

-- Get transaction totals by account for a date range
CREATE OR REPLACE FUNCTION get_account_totals(p_start DATE, p_end DATE)
RETURNS TABLE(account_id TEXT, account_name TEXT, account_type TEXT, classification TEXT, total NUMERIC, txn_count BIGINT) AS $$
  SELECT t.account_id, a.name AS account_name, a.account_type, a.classification,
         SUM(t.total_amount) AS total,
         COUNT(*) AS txn_count
  FROM qbo_transactions t
  JOIN qbo_accounts a ON t.account_id = a.id
  WHERE t.txn_date >= p_start AND t.txn_date <= p_end
  GROUP BY t.account_id, a.name, a.account_type, a.classification
  ORDER BY a.classification, ABS(SUM(t.total_amount)) DESC;
$$ LANGUAGE sql;
