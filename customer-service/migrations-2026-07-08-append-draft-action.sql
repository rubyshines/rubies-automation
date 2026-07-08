-- Atomic append to cs_ai_drafts.actions[].
--
-- The holdReconcile sweep and the dashboard operator path both appended via
-- read-modify-write ([...(d.actions || []), entry]) — two concurrent writers
-- could each read the same snapshot and one entry would be silently lost.
-- This RPC makes the append a single UPDATE so interleaves can't drop entries.
--
-- Idempotent: CREATE OR REPLACE. Apply via Supabase SQL Editor or the pg
-- client when SUPABASE_DATABASE_URL is set (see domain_tech.md).

CREATE OR REPLACE FUNCTION append_draft_action(p_draft_id bigint, p_action jsonb)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE cs_ai_drafts
  SET actions = COALESCE(actions, '[]'::jsonb) || jsonb_build_array(p_action)
  WHERE id = p_draft_id;
$$;
