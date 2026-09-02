-- B2B Outreach Engine schema (Design #3 + #6 of b2b-outreach-system.md)
-- Run once in Supabase SQL Editor. All additive.

-- ---------------------------------------------------------------------------
-- b2b_companies additions — outreach state on the existing CRM spine
-- ---------------------------------------------------------------------------
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS entity_type TEXT DEFAULT 'company';      -- 'company' | 'individual'
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS general_email TEXT;                      -- info@/hello@ front door (contact_unknown fallback)
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS relationship_state TEXT;                 -- 'in_contact' | 'active' | 'dormant' | 'lost' (Design #1)
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS program_flags JSONB DEFAULT '{}'::jsonb; -- org layer-2: {donation_closet, event_donations, purchases, affiliate}
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS next_action_date DATE;                   -- cadence pre-filter (Trigger 3)
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS snoozed_until DATE;                      -- operator snooze; sweep skips until past
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS last_outbound_at TIMESTAMPTZ;
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS contact_unknown BOOLEAN DEFAULT FALSE;   -- bounce / "no longer with" — pause + re-intro via general_email
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS pending_demand_skus TEXT[];              -- restock interest → reorder_nudge enrichment (Trigger 4)
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS samples_shopify_order_id TEXT;
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS samples_shipped_at TIMESTAMPTZ;
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS samples_delivered_at TIMESTAMPTZ;

-- Rolling relationship summary — the recap + suggested next step the old Google
-- Sheet carried per company, rebuilt on b2b_messages. Distinct from the sheet-era
-- ai_summary / next_action columns above, which are a frozen pre-migration
-- snapshot and are never written again: for companies whose history the engine
-- never imported, that text is the only relationship knowledge we hold.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS relationship_summary TEXT;
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS relationship_next_step TEXT;              -- advisory only; cadence.js still owns what is due
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS relationship_next_step_owner TEXT;        -- 'us' | 'them'
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS relationship_summary_at TIMESTAMPTZ;
-- Watermark + count together, not a bare timestamp: history arrives BACKWARDS in
-- this system (discoverCompanyThreads imports old threads long after the fact), so
-- a message can land below the generation time and would never be noticed by a
-- `date > summary_updated_at` test. The count catches those inserts.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS relationship_summary_through TIMESTAMPTZ; -- sent_at of the newest message included
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS relationship_summary_msg_count INTEGER;
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS relationship_summary_claimed_at TIMESTAMPTZ;

-- When we last searched Gmail for this company's history. Thread discovery used
-- to run ONLY when an operator opened a company, so a company nobody had clicked
-- had zero b2b_messages and the cadence reasoned from an empty record — which is
-- indistinguishable from "never contacted" and produces a plausible, wrong tier.
-- The nightly sweep needs this stamp to back off: without it, the ~120 companies
-- that genuinely have no history would be re-searched against Gmail every night
-- forever.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS threads_discovered_at TIMESTAMPTZ;

-- "Do not chase this one" — deliberately NOT a relationship_state value.
-- `lost` means they went away or said no; this is OUR decision (a market we are
-- not working this year, a partner who does not want regular contact), and it is
-- reversible. Folding it into relationship_state would destroy the fact we would
-- need to resume: The Bra Room is a real `in_contact` retailer that happens to be
-- in a country we are not pursuing right now. Orthogonal columns keep both facts.
-- The reason is the part that matters in six months.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS outreach_paused_at TIMESTAMPTZ;
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS outreach_paused_reason TEXT;
-- WHEN the snooze was set, as opposed to snoozed_until which is when it lifts.
-- Deferring outreach has to be able to clear a stale "waiting on us" (you just
-- spoke to them, so the 72-day-old email is not really outstanding) without ever
-- hiding a reply that lands afterwards. That comparison needs the set-time.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS snoozed_at TIMESTAMPTZ;

-- "I owe this one an answer, just not right now." The third deferral, and the
-- only one that means the work is still LIVE — pause and snooze both say we are
-- not working the relationship, so both supersede the pending draft. This one
-- keeps it, because that draft is exactly what you want in front of you when you
-- come back. It exists so the queue can stay a list of things doable today
-- without the ones you have claimed silently becoming things nobody is doing.
-- A bare stamp and nothing else. It briefly carried a note typed at claim time;
-- what the claim is ABOUT is answered better by relationship_next_step, which is
-- derived from the conversation and rebuilt as messages land, where a note is
-- written once and then decays.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS on_me_at TIMESTAMPTZ;

-- Who set the deferral: the operator, or the cadence.
--
-- The follow-up ladder ends by RETIRING a lead (an indefinite outreach pause —
-- never relationship_state='lost', which would claim they said no) or, for a
-- live relationship, by HANDING IT OVER: an active partner that ignored a
-- check-in and two chases is not a dead lead, it is a partner going quiet, and
-- that has to be visible now rather than next season.
--
-- These columns keep machine decisions distinguishable from Jamie's own, so the
-- On Me list can badge engine hand-offs and an auto-retired cohort can be
-- reviewed or reversed in bulk without string-matching a reason.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS outreach_paused_source TEXT;  -- 'operator' | 'cadence'
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS on_me_source TEXT;            -- 'operator' | 'cadence'
-- An OPERATOR claim stays a bare stamp (see above). A CADENCE claim carries a
-- note, because the reasoning that removed the note was about friction in front
-- of a one-click decision, which does not apply to a machine that already knows
-- why. It holds only the durable fact — a count and a date, true forever — while
-- what to DO about it keeps coming from relationship_next_step.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS on_me_note TEXT;

-- Scheduled auto-send. The draft pass stamps the moment the follow-up should
-- land in the recipient's own business hours; the send pass picks it up once it
-- passes. Nullable: an operator-composed or Tier-1 draft has no schedule and is
-- sent by hand, exactly as before.
ALTER TABLE b2b_drafts ADD COLUMN IF NOT EXISTS scheduled_send_at TIMESTAMPTZ;
ALTER TABLE b2b_drafts ADD COLUMN IF NOT EXISTS schedule_reason TEXT;
-- The send pass polls this every 15 minutes, so it must not be a seq scan.
CREATE INDEX IF NOT EXISTS idx_b2b_drafts_scheduled ON b2b_drafts (scheduled_send_at)
  WHERE status = 'pending' AND scheduled_send_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_b2b_companies_next_action ON b2b_companies (next_action_date)
  WHERE next_action_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_b2b_companies_rel_state ON b2b_companies (relationship_state);

-- ---------------------------------------------------------------------------
-- b2b_threads — one row per email conversation topic with a company
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS b2b_threads (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       TEXT REFERENCES b2b_companies(id) NOT NULL,
  thread_type      TEXT NOT NULL,            -- 'intro' | 'order' | 'program' | 'support' | 'other'
  subject          TEXT,
  gmail_thread_id  TEXT,                     -- null until first send/receive correlates
  status           TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  last_message_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_b2b_threads_company ON b2b_threads (company_id);
CREATE INDEX IF NOT EXISTS idx_b2b_threads_gmail ON b2b_threads (gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;

-- One row per (company, gmail thread), NOT one per gmail thread (2026-08-13).
-- Gmail threads on subject, so one conversation regularly contains two orgs —
-- 13 of ours do. A bare UNIQUE(gmail_thread_id) makes that unrepresentable: the
-- second org's messages either hang off the first org's thread row (105 messages,
-- 8.9% of the corpus, were in that state) or, worse, the discovery upsert's
-- onConflict='gmail_thread_id' REWRITES the first org's row to point at the
-- second company, silently handing one org's whole conversation to another.
-- Two orgs in one Gmail thread are two relationships and get two rows, each with
-- its own status so Close/Reopen means something per company.
-- Dropped by lookup rather than by name: the old constraint came from an inline
-- column-level UNIQUE, so its generated name is not guaranteed across environments.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'b2b_threads'::regclass AND contype = 'u'
     AND pg_get_constraintdef(oid) LIKE '%(gmail_thread_id)%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE b2b_threads DROP CONSTRAINT %I', c); END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_threads_company_gmail
  ON b2b_threads (company_id, gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- b2b_messages — one row per email, both directions.
-- HARD RULE (Design #6, from historical findings): outbound rows are written
-- ONLY by the send tool at send time — never synced from the Gmail Sent
-- folder (auto-save draft checkpoints masquerade as sends and poison
-- reply-rate/A-B data). Inbound rows come from Pub/Sub correlation, idempotent
-- on gmail_message_id (at-least-once delivery).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS b2b_messages (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id         BIGINT REFERENCES b2b_threads(id) NOT NULL,
  company_id        TEXT REFERENCES b2b_companies(id) NOT NULL,
  direction         TEXT NOT NULL,            -- 'outbound' | 'inbound'
  message_type      TEXT,                     -- catalog type for outbound; classifier intent for inbound
  variant_id        TEXT,                     -- A/B variant (locked #15); null for inbound
  gmail_message_id  TEXT UNIQUE,              -- idempotency key
  gmail_thread_id   TEXT,
  in_reply_to       TEXT,
  from_email        TEXT,
  to_email          TEXT,
  cc_email          TEXT,                    -- comma-joined, same shape as to_email
  body_text         TEXT,
  sent_at           TIMESTAMPTZ,
  source            TEXT NOT NULL DEFAULT 'send_tool',  -- 'send_tool' | 'pubsub' | 'manual_send' (reconciled placeholder)
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b2b_messages_thread ON b2b_messages (thread_id);
CREATE INDEX IF NOT EXISTS idx_b2b_messages_company ON b2b_messages (company_id);
CREATE INDEX IF NOT EXISTS idx_b2b_messages_type ON b2b_messages (message_type, variant_id);

-- ---------------------------------------------------------------------------
-- b2b_drafts — one ACTIVE draft per company (Design #3). New trigger while a
-- draft is pending → regenerate and replace, never two competing drafts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS b2b_drafts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       TEXT REFERENCES b2b_companies(id) NOT NULL,
  thread_id        BIGINT REFERENCES b2b_threads(id),
  message_type     TEXT NOT NULL,
  variant_id       TEXT,
  subject          TEXT,
  body             TEXT NOT NULL,
  structured       JSONB,                    -- advisor structured output (open_commitments etc.)
  queue_tier       INTEGER,                  -- 1-6 (locked #6)
  queue_reason     TEXT,                     -- human-readable ("replied 2h ago", "90d since last order")
  advisor          TEXT,                     -- 'b2b_sales_advisor' | 'b2b_community_advisor'
  status           TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'dismissed' | 'superseded'
  operator_edited  BOOLEAN DEFAULT FALSE,
  -- What actually went out, stamped at send time. `subject`/`body` above stay
  -- the AI's originals, so the pair on this row IS the edit: what the advisor
  -- wrote vs what Jamie sent. Mirrors cs_ai_drafts.draft_response/sent_response.
  -- The boolean above only says THAT it changed; these say HOW, which is what
  -- a later accuracy pass needs. Null on an unsent draft.
  sent_subject     TEXT,
  sent_body        TEXT,
  operator_steer   TEXT,
  generated_at     TIMESTAMPTZ DEFAULT NOW(),
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
-- one active draft per company, enforced
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_drafts_one_pending
  ON b2b_drafts (company_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_b2b_drafts_status ON b2b_drafts (status);
CREATE INDEX IF NOT EXISTS idx_b2b_drafts_tier ON b2b_drafts (queue_tier) WHERE status = 'pending';
