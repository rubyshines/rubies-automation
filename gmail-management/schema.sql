-- Email Intelligence System — Supabase Schema
-- Run in Supabase SQL Editor (one-time setup)

-- ---------------------------------------------------------------------------
-- Gmail sync state (singleton row for incremental sync cursor)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gmail_sync_state (
  id TEXT PRIMARY KEY DEFAULT 'jamie@rubyshines.com',
  last_history_id BIGINT,
  backfill_pass INTEGER DEFAULT 0,  -- 0=not started, 1=pass1 done, 2=complete
  backfill_page_token TEXT,
  backfill_newest_date TIMESTAMPTZ,  -- how far back we've fetched so far
  messages_synced INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Gmail OAuth tokens (same pattern as qbo_oauth_tokens)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gmail_oauth_tokens (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Email messages — every synced email
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_messages (
  gmail_message_id TEXT PRIMARY KEY,
  gmail_thread_id TEXT NOT NULL,
  subject TEXT,
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT[],
  cc_addresses TEXT[],
  date TIMESTAMPTZ NOT NULL,
  body_text TEXT,
  labels TEXT[],
  is_sent BOOLEAN DEFAULT FALSE,
  has_attachments BOOLEAN DEFAULT FALSE,
  attachment_meta JSONB,  -- [{filename, mimeType, size, attachmentId}]
  is_auto_reply BOOLEAN DEFAULT FALSE,
  word_count INTEGER,
  raw_size_bytes INTEGER,
  classification TEXT,
  classification_confidence REAL,
  classified_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  -- Gmail inbox cleanup tracking
  forwarded_to_gorgias_at TIMESTAMPTZ,  -- when CS email was forwarded to Gorgias
  gorgias_ticket_id BIGINT,             -- Gorgias ticket ID created from this email
  archived_at TIMESTAMPTZ,              -- when email was labeled + archived from inbox
  trashed_at TIMESTAMPTZ,               -- when email was moved to Gmail trash by cleanup
  processed_at TIMESTAMPTZ,             -- when email was processed (labeled/routed/archived/skipped)
  -- Reclassification tracking (operator corrected a misclassification)
  reclassified_from TEXT,               -- original wrong classification before operator correction
  reclassified_at TIMESTAMPTZ,          -- when the operator corrected it
  returned_to_inbox_at TIMESTAMPTZ      -- when email was returned from CS to Gmail inbox (guards against re-routing)
);

CREATE INDEX IF NOT EXISTS idx_email_msg_thread ON email_messages (gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_email_msg_from ON email_messages (from_address);
CREATE INDEX IF NOT EXISTS idx_email_msg_date ON email_messages (date DESC);
CREATE INDEX IF NOT EXISTS idx_email_msg_classification ON email_messages (classification);
CREATE INDEX IF NOT EXISTS idx_email_msg_unclassified
  ON email_messages (date DESC) WHERE classification IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_msg_unprocessed
  ON email_messages (classification) WHERE processed_at IS NULL AND is_sent = false AND classification IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Email threads — aggregated thread-level intelligence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_threads (
  gmail_thread_id TEXT PRIMARY KEY,
  subject TEXT,
  classification TEXT,
  participants TEXT[],
  message_count INTEGER DEFAULT 0,
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  last_sender TEXT,
  awaiting_response_from TEXT,  -- 'us' | 'them' | null
  summary TEXT,
  summary_updated_at TIMESTAMPTZ,
  key_decisions TEXT[],
  next_action TEXT,
  next_action_due DATE,
  next_action_owner TEXT,  -- 'us' | contact email
  project_id TEXT,
  contact_id TEXT,
  cs_conversation_id TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_thread_classification ON email_threads (classification);
CREATE INDEX IF NOT EXISTS idx_email_thread_project ON email_threads (project_id);
CREATE INDEX IF NOT EXISTS idx_email_thread_active
  ON email_threads (is_active, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_thread_action_due
  ON email_threads (next_action_due) WHERE next_action_due IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Email contacts — business contact registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_contacts (
  id TEXT PRIMARY KEY,  -- normalized email address
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  organization TEXT,
  domain TEXT,
  role TEXT,  -- 'retailer', 'supplier', 'designer', '3pl', 'accountant', etc.
  business_area TEXT,
  aliases TEXT[],
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  thread_count INTEGER DEFAULT 0,
  notes TEXT,
  is_important BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_contacts_domain ON email_contacts (domain);
CREATE INDEX IF NOT EXISTS idx_email_contacts_area ON email_contacts (business_area);

-- ---------------------------------------------------------------------------
-- Business projects — tracked from email intelligence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_projects (
  id TEXT PRIMARY KEY,  -- slug: 'rd-brooke-v3', 'sales-wild-things'
  name TEXT NOT NULL,
  business_area TEXT NOT NULL,
  status TEXT DEFAULT 'active',  -- 'active', 'paused', 'completed', 'archived'
  stage TEXT,
  stage_entered_at TIMESTAMPTZ,
  description TEXT,
  key_contacts TEXT[],
  thread_count INTEGER DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  next_action TEXT,
  next_action_due DATE,
  next_action_owner TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_biz_projects_area ON business_projects (business_area);
CREATE INDEX IF NOT EXISTS idx_biz_projects_status ON business_projects (status);
CREATE INDEX IF NOT EXISTS idx_biz_projects_action_due
  ON business_projects (next_action_due) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Project dependencies — between threads within a project
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_dependencies (
  id SERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES business_projects(id),
  blocking_thread_id TEXT,
  blocked_thread_id TEXT,
  dependency_type TEXT,  -- 'waiting_for_response', 'waiting_for_delivery', 'waiting_for_approval', 'sequential'
  description TEXT,
  status TEXT DEFAULT 'blocking',  -- 'blocking', 'resolved'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_proj_deps_project ON project_dependencies (project_id);
CREATE INDEX IF NOT EXISTS idx_proj_deps_blocking
  ON project_dependencies (status) WHERE status = 'blocking';

-- ---------------------------------------------------------------------------
-- Email classification cache — amortize AI cost per domain
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_classification_cache (
  sender_domain TEXT PRIMARY KEY,
  classification TEXT NOT NULL,
  confidence REAL,
  sample_count INTEGER DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
