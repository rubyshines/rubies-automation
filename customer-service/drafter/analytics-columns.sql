-- Analytics columns for CS Advisor performance tracking
-- Run in Supabase SQL Editor

-- cs_ai_drafts: store operator steer text + active focus time
ALTER TABLE cs_ai_drafts ADD COLUMN IF NOT EXISTS operator_steer text;
ALTER TABLE cs_ai_drafts ADD COLUMN IF NOT EXISTS focus_time_seconds integer DEFAULT 0;

-- cs_ai_feedback_log: Haiku comparison results
ALTER TABLE cs_ai_feedback_log ADD COLUMN IF NOT EXISTS haiku_category text;
ALTER TABLE cs_ai_feedback_log ADD COLUMN IF NOT EXISTS haiku_summary text;
ALTER TABLE cs_ai_feedback_log ADD COLUMN IF NOT EXISTS haiku_score integer;
