# /marketing-weekly — the weekly content/SEO loop

You are running the RUBIES weekly marketing loop. The deliverable is an **approval package
for the creative director** — you never publish anything yourself. Work through ALL steps in
order.

## Step 1 — Orient
1. Read `.claude/memory/domain_marketing.md` and `.claude/memory/initiative_seo_content.md`.
2. Check `.claude/plans/rubies-ai-operations-plan.md` for any marketing-loop notes from the
   current sprint (style guide status, length specs, prior week's decisions).
3. List the 5 most recent published posts via the `list_blog_posts` MCP tool so you don't
   propose a topic that's already covered.

## Step 2 — Gather evidence (all three sources, every week)
1. **Search data:** `seo_report` + `seo_keywords` MCP tools — what's ranking, what's close
   (positions 5-20), what queries are rising.
2. **Customer language:** `blog_search_emails` + `blog_topic_ideas` MCP tools — real questions
   from tickets/emails this month, in customers' own words.
3. **Seasonal:** what's coming in the next 6-8 weeks (swim season, Pride (March-June),
   back-to-school (August), year-end (Nov-Dec), product launches in flight).

## Step 3 — Propose 2-3 topic candidates
For each candidate, one paragraph of EVIDENCE: the search queries it targets (with volume/
position data where available), the customer questions it answers (cite how many times asked),
and the seasonal hook if any. Each candidate must pass the test: **"would this be the best
answer on the internet for this question?"** If you can't argue that, drop the candidate.

## Step 4 — Draft the best one
- Length calibration (the creative director's standing note: drafts run too long):
  buying/sizing guides 800-1,200 words; question-answer posts 500-800; announcements 300-500.
  State the target at the top of the draft and hit it.
- Voice: playful, supportive, never political/righteous/judgmental. No em dashes. Plain
  language — write like Jamie answering a customer, not like a content marketer.
- Ground every factual claim (sizes, products, policies) in MCP tool lookups
  (`search_products`, `get_product_catalog`, `shipping_info`) — never from memory.
- Include suggested meta title + description (use `seo_meta_draft` for the format).

## Step 5 — Image briefs (NOT image generation)
For 1-2 illustration slots, write a brief in the RUBIES house style: flat vector, duotone
figures, cobalt/lime/magenta palette, joyful and body-diverse, never sexualized,
age-appropriate. Reference the style-guide asset if it exists in the repo; if not, note that
the brief needs the style guide (see sprint plan, Creative domain). Generation and approval
happen in the creative director's pass, not here.

## Step 6 — Package and STOP
Assemble: topic candidates with evidence → chosen topic rationale → full draft → meta →
image briefs → suggested publish date. Present it as one document for the creative director.

**HARD RULES:**
- Do NOT call `register_blog_post` or publish anything. Publishing happens only after the
  creative director approves, in a separate explicit step.
- Do NOT send any emails.
- If the evidence this week is thin (no good candidates pass the best-answer test), say so
  and stop — a skipped week beats a filler post.
