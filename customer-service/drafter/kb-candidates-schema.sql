-- Candidate KB entries extracted from kb_sources (project_corpus_harvest, step 2).
-- Zero-API extraction: Claude Code sessions follow
-- customer-service/import/kb-extraction-protocol.md and load results with
-- customer-service/import/loadKbCandidates.js. Step 4 promotes candidates into
-- the rebuilt cs_knowledge_base; step 3 (reply-corpus mining) dedupes against
-- this table. Live cs_knowledge_base consumers are untouched until the flip.
-- Run once in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS kb_candidates (
  id           text PRIMARY KEY,            -- <kb_sources.id>#<topic-slug>, stable across re-extraction
  source_id    text NOT NULL,               -- kb_sources.id this was extracted from
  source_url   text NOT NULL,
  title        text NOT NULL,
  category     text NOT NULL,               -- product | sizing | shipping | policy | program | community | wholesale | company | faq
  content      text NOT NULL,               -- self-contained markdown, durable facts only
  trust        text NOT NULL DEFAULT 'published',  -- published (Jamie's word, auto-trusted) | reply_corpus (step 3, review-gated)
  status       text NOT NULL DEFAULT 'candidate',  -- candidate | promoted | dropped
  source_hash  text NOT NULL,               -- kb_sources.content_hash at extraction time (refresh: re-extract when it drifts)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_candidates_source ON kb_candidates (source_id);
CREATE INDEX IF NOT EXISTS idx_kb_candidates_status ON kb_candidates (status);
