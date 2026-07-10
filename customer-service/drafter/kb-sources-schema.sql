-- Staging table for the knowledge corpus harvest (project_corpus_harvest).
-- Raw, source-linked content pulled from Shopify Admin API + rubyshines.com,
-- hashed for change detection. Downstream extraction (Claude Code) turns rows
-- into candidate cs_knowledge_base entries; a weekly cron re-pulls and flags
-- changed rows via content_hash.
-- Run once in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS kb_sources (
  id               text PRIMARY KEY,           -- stable slug: product:<handle> | collection:<handle> | page:<handle> | policy:<type> | website:<path>
  source_type      text NOT NULL,              -- shopify_product | shopify_collection | shopify_page | shopify_policy | website_page
  source_url       text NOT NULL,              -- public URL on rubyshines.com (Jamie's published word — auto-trusted)
  title            text,
  content          text NOT NULL,              -- extracted plain text (staging is raw; cleanup happens at extraction)
  content_hash     text NOT NULL,              -- sha256 of content
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- handle, tags, sizes, price range, etc.
  status           text NOT NULL DEFAULT 'active',      -- active | gone (disappeared upstream; kept for audit)
  extracted_at     timestamptz,                -- when downstream extraction last consumed this row (NULL or < last_changed_at = needs extraction)
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_fetched_at  timestamptz NOT NULL DEFAULT now(),
  last_changed_at  timestamptz NOT NULL DEFAULT now()   -- bumped only when content_hash changes
);

CREATE INDEX IF NOT EXISTS idx_kb_sources_type ON kb_sources (source_type);
CREATE INDEX IF NOT EXISTS idx_kb_sources_status ON kb_sources (status);
