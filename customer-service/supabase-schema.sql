-- =============================================================================
-- RUBIES Customer Service AI — Supabase Schema
-- =============================================================================
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Requires pgvector extension for embedding storage + similarity search
-- =============================================================================

-- Enable pgvector (run once per database)
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- cs_conversations — Normalized conversation storage (Gorgias, Tidio, Claude Code)
-- =============================================================================
CREATE TABLE IF NOT EXISTS cs_conversations (
  id text PRIMARY KEY,                        -- source:original_id (e.g. "gorgias:12345")
  source text NOT NULL,                       -- 'gorgias' | 'tidio' | 'claude_code'
  source_id text NOT NULL,                    -- original ID in source system
  customer_email text,
  customer_name text,
  subject text,
  status text,                                -- 'open', 'closed', 'resolved'
  channel text,                               -- 'email', 'chat', 'social'
  category text,                              -- primary category (see taxonomy below)
  subcategories text[],                       -- secondary categories
  tags text[],                                -- original tags from source + auto-generated
  sentiment text,                             -- 'positive', 'neutral', 'negative'
  resolution_successful boolean,              -- did the customer seem satisfied?
  resolution_type text,                       -- 'exchange', 'refund', 'info_provided', 'no_action', etc.
  order_numbers text[],                       -- referenced Shopify order numbers
  products_mentioned text[],                  -- product names mentioned
  summary text,                               -- AI-generated conversation summary
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  response_time_minutes integer,              -- first response time
  message_count integer DEFAULT 0,
  embedding vector(512),                     -- Voyage AI embedding for semantic search
  imported_at timestamptz DEFAULT now()
);

-- Category taxonomy:
-- sizing_fit, exchange_return, order_status, wholesale, shipping,
-- product_info, payment, general

CREATE INDEX IF NOT EXISTS idx_cs_conv_source ON cs_conversations (source);
CREATE INDEX IF NOT EXISTS idx_cs_conv_email ON cs_conversations (customer_email);
CREATE INDEX IF NOT EXISTS idx_cs_conv_category ON cs_conversations (category);
CREATE INDEX IF NOT EXISTS idx_cs_conv_created ON cs_conversations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cs_conv_resolution ON cs_conversations (resolution_successful);

-- pgvector cosine similarity index (IVFFlat, 50 lists — good up to ~10K rows)
-- NOTE: This index requires at least ~100 rows to be effective.
-- Run this AFTER importing conversations:
-- CREATE INDEX IF NOT EXISTS idx_cs_conv_embedding ON cs_conversations
--   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- =============================================================================
-- cs_messages — Individual messages within conversations
-- =============================================================================
CREATE TABLE IF NOT EXISTS cs_messages (
  id text PRIMARY KEY,                        -- source:message_id
  conversation_id text NOT NULL REFERENCES cs_conversations(id) ON DELETE CASCADE,
  source text NOT NULL,
  sender_type text NOT NULL,                  -- 'customer', 'agent', 'system'
  sender_name text,
  body_text text NOT NULL,                    -- plain text content
  body_html text,                             -- original HTML if available
  created_at timestamptz NOT NULL,
  attachments jsonb,                          -- [{filename, url, type}]
  is_internal boolean DEFAULT false           -- internal notes
);

CREATE INDEX IF NOT EXISTS idx_cs_msg_conv ON cs_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_cs_msg_created ON cs_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_cs_msg_sender ON cs_messages (sender_type);

-- =============================================================================
-- cs_knowledge_base — Curated articles, policies, FAQ entries
-- =============================================================================
CREATE TABLE IF NOT EXISTS cs_knowledge_base (
  id text PRIMARY KEY,                        -- slug: 'sizing-guide', 'return-policy', etc.
  title text NOT NULL,
  category text NOT NULL,                     -- 'sizing', 'policy', 'faq', 'product', 'shipping'
  subcategory text,
  content text NOT NULL,                      -- markdown content
  source text,                                -- 'manual', 'extracted', 'website', 'klaviyo', 'gorgias_macro'
  tags text[],
  embedding vector(512),                     -- Voyage AI embedding
  priority integer DEFAULT 0,                 -- higher = more important (macros/policies > extracted)
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cs_kb_category ON cs_knowledge_base (category);

-- =============================================================================
-- cs_faq_patterns — Auto-extracted Q&A patterns from conversation clusters
-- =============================================================================
CREATE TABLE IF NOT EXISTS cs_faq_patterns (
  id serial PRIMARY KEY,
  question_pattern text NOT NULL,             -- canonical question
  category text NOT NULL,
  best_answer text NOT NULL,                  -- best agent response found
  frequency integer DEFAULT 1,               -- how many times this pattern appeared
  example_conversation_ids text[],            -- source conversations
  success_rate decimal,                       -- % of times resolution was successful
  embedding vector(512),                     -- Voyage AI embedding
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cs_faq_category ON cs_faq_patterns (category);
CREATE INDEX IF NOT EXISTS idx_cs_faq_frequency ON cs_faq_patterns (frequency DESC);

-- =============================================================================
-- cs_import_progress — Tracks import pipeline state (dedup + resume)
-- =============================================================================
CREATE TABLE IF NOT EXISTS cs_import_progress (
  id text PRIMARY KEY,                        -- 'gorgias:tickets', 'tidio:file:export.csv'
  source text NOT NULL,
  status text DEFAULT 'pending',              -- 'pending', 'processing', 'complete', 'error'
  last_cursor text,                           -- pagination cursor for Gorgias API
  records_processed integer DEFAULT 0,
  error_message text,
  updated_at timestamptz DEFAULT now()
);

-- =============================================================================
-- Helper function: cosine similarity search for conversations
-- =============================================================================
CREATE OR REPLACE FUNCTION cs_search_conversations(
  query_embedding vector(512),
  match_count integer DEFAULT 5,
  filter_category text DEFAULT NULL,
  filter_successful boolean DEFAULT NULL
)
RETURNS TABLE (
  id text,
  source text,
  customer_email text,
  customer_name text,
  subject text,
  category text,
  summary text,
  resolution_type text,
  resolution_successful boolean,
  created_at timestamptz,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id, c.source, c.customer_email, c.customer_name, c.subject,
    c.category, c.summary, c.resolution_type, c.resolution_successful,
    c.created_at,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM cs_conversations c
  WHERE c.embedding IS NOT NULL
    AND (filter_category IS NULL OR c.category = filter_category)
    AND (filter_successful IS NULL OR c.resolution_successful = filter_successful)
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- =============================================================================
-- Helper function: cosine similarity search for knowledge base
-- =============================================================================
CREATE OR REPLACE FUNCTION cs_search_knowledge(
  query_embedding vector(512),
  match_count integer DEFAULT 3,
  filter_category text DEFAULT NULL
)
RETURNS TABLE (
  id text,
  title text,
  category text,
  content text,
  priority integer,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    k.id, k.title, k.category, k.content, k.priority,
    1 - (k.embedding <=> query_embedding) AS similarity
  FROM cs_knowledge_base k
  WHERE k.embedding IS NOT NULL
    AND (filter_category IS NULL OR k.category = filter_category)
  ORDER BY k.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- =============================================================================
-- Helper function: cosine similarity search for FAQ patterns
-- =============================================================================
CREATE OR REPLACE FUNCTION cs_search_faqs(
  query_embedding vector(512),
  match_count integer DEFAULT 3,
  filter_category text DEFAULT NULL
)
RETURNS TABLE (
  id integer,
  question_pattern text,
  category text,
  best_answer text,
  frequency integer,
  success_rate decimal,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    f.id, f.question_pattern, f.category, f.best_answer,
    f.frequency, f.success_rate,
    1 - (f.embedding <=> query_embedding) AS similarity
  FROM cs_faq_patterns f
  WHERE f.embedding IS NOT NULL
    AND (filter_category IS NULL OR f.category = filter_category)
  ORDER BY f.embedding <=> query_embedding
  LIMIT match_count;
$$;
