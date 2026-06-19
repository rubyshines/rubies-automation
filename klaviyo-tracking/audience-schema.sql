-- klaviyo_audience_daily — daily feed of list growth, forms, and list-size
-- snapshots (klaviyo-tracking/sync-audience.js). Read by the email report.
CREATE TABLE IF NOT EXISTS klaviyo_audience_daily (
  date                 date PRIMARY KEY,
  email_subscribed     integer NOT NULL DEFAULT 0,
  email_unsubscribed   integer NOT NULL DEFAULT 0,
  sms_subscribed       integer NOT NULL DEFAULT 0,
  sms_unsubscribed     integer NOT NULL DEFAULT 0,
  form_viewed          integer NOT NULL DEFAULT 0,
  form_submitted       integer NOT NULL DEFAULT 0,
  email_list_size      integer,
  sms_list_size        integer,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE klaviyo_audience_daily ENABLE ROW LEVEL SECURITY;
