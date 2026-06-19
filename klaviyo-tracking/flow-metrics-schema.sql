-- klaviyo_flow_metrics — per-flow performance for a time window.
-- One row per (flow, channel, period). Periods are stored at month granularity
-- by the backfill; any range (e.g. a quarter) is the sum of its months.
-- Populated by klaviyo-tracking/flow-metrics.js from Klaviyo's flow-values-reports.

CREATE TABLE IF NOT EXISTS klaviyo_flow_metrics (
  flow_id           text NOT NULL,
  flow_name         text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT '',
  channel           text NOT NULL DEFAULT 'email',
  period_start      date NOT NULL,
  period_end        date NOT NULL,           -- exclusive upper bound
  recipients        integer NOT NULL DEFAULT 0,
  delivered         integer NOT NULL DEFAULT 0,
  opens             integer NOT NULL DEFAULT 0,
  clicks            integer NOT NULL DEFAULT 0,
  conversions       integer NOT NULL DEFAULT 0,
  conversion_value  numeric NOT NULL DEFAULT 0,
  open_rate         numeric NOT NULL DEFAULT 0,
  click_rate        numeric NOT NULL DEFAULT 0,
  conversion_rate   numeric NOT NULL DEFAULT 0,
  unsubscribe_rate  numeric NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, channel, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_flow_metrics_period
  ON klaviyo_flow_metrics (period_start, period_end);

ALTER TABLE klaviyo_flow_metrics ENABLE ROW LEVEL SECURITY;
