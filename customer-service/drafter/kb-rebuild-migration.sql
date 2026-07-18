-- Corpus harvest step 4: cs_knowledge_base gains source linkage + trust tier
-- so rebuilt rows carry their provenance (project_corpus_harvest).
-- Run once in Supabase SQL Editor BEFORE running rebuildKnowledgeBase.js.

ALTER TABLE cs_knowledge_base ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE cs_knowledge_base ADD COLUMN IF NOT EXISTS trust text;  -- published | reply_corpus (NULL on legacy rows)
