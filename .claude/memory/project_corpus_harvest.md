---
name: Knowledge Corpus Harvest & KB Rebuild
description: Comprehensive advisor knowledge - harvest website + 2yr reply corpus into a source-linked KB behind a search tool, with the facts loop as the promotion mechanism
type: project
domain: cs
done_when: advisor answers a product/policy question from KB search in a pinned scenario; conflict sheet reviewed by Jamie; stale 63-article KB retired; advisor search tool flipped on AFTER the 2026-07-23 measurement window with the judge watching
---
## Why (approved by Jamie 2026-07-10)

The 2026-07-09 accuracy sweep found ~37% of draft↔sent divergences were facts only Jamie knows. The advisor_facts loop (PR #76) fixes this *reactively* — facts enter only after a failure. Jamie wants comprehensive coverage without (a) huge always-loaded token cost or (b) a giant manual review burden. Design answer: two tiers + trust-scoped review.

## Architecture (locked in conversation, 2026-07-09/10)

**Tier 1 — inline operator facts (exists, PR #76):** `advisor_facts` table, injected verbatim into the static prompt. Cap ~50-75 facts. Entry bar: caused a real miss (judge-proposed) or Jamie taught it manually. THE PROMOTION MECHANISM: when a Tier 2 fact gets missed (advisor didn't search) and Jamie corrects the draft, the judge proposes it → approval moves it inline. Frequency finds the right tier empirically.

**Tier 2 — comprehensive KB behind search (this project):** rebuild `cs_knowledge_base` from fresh sources with embeddings (Voyage, same infra as the current 63 articles). Advisor gets a `search_knowledge` tool (reuse/adapt the existing `cs_search_faq` plumbing — tool #14 in the advisor TOOLS array). Cost: ~150 tokens/call for the tool def; one extra tool round (~$0.25-0.35) only on drafts that search (~20% est → ~+$0.06/draft blended). Precedence rule in prompt: live data tools > OPERATOR FACTS > KB search; never guess — if not covered, search before answering.

## Sources & trust levels (drives review burden — Jamie reviews ~40-80 items, not 500)

1. **Website/Shopify (auto-trusted, zero review):** products, pages, policies via Shopify Admin API (cleaner than scraping; complement with rubyshines.com pages not in Shopify: how-it-works, FAQ, size guides). Source-linked (URL per entry), refreshed on a schedule (cron re-pull + re-embed on content hash change). Jamie's published word needs no approval.
2. **Historical sent replies (2+ years, conflict-review only):** mine cs_tickets/Gorgias/Gmail sent bodies for factual assertions (zero-API method: Claude Code subagents, same as the sweep). Dedupe against website content. Surface for Jamie's review ONLY: (a) conflicts (email says X, site says Y), (b) unpublished knowledge (told customers, nowhere on site — the most valuable slice). Everything else drops.
3. **Judge-extracted (existing pending queue):** unchanged.

## Calibration from Jamie's first facts review (2026-07-10, 14/36 rejected)

He rejects one-off judgment calls and perishable logistics. So: garment measurements → NOT KB prose, they belong in graded-specs data (consider exposing get_graded_specs to the advisor as part of this project); stockists/partner addresses → source-linked KB entries with refresh (he rejected them as frozen facts, the BAGLY address WAS stale); program windows → KB with refresh or expiry.

## Build order

1. Shopify Admin pull + page fetch → staging table `kb_sources` (raw, hashed).
2. Extraction/chunking → candidate KB entries (source_url, content, category). Zero-API via Claude Code session/subagents.
3. Reply-corpus mine → assertions → dedupe vs KB → conflict sheet (markdown, like tone-samples-2026-07-proposed.md) for Jamie.
4. Rebuild cs_knowledge_base (new rows source-linked; retire the 63 stale articles — parked item "CS knowledge base — stale/wrong articles" is subsumed).
5. Embed (Voyage, pennies). Refresh cron (weekly re-pull, re-embed changed).
6. Advisor tool + precedence prompt rule + pinned scenario. **DO NOT DEPLOY the advisor-side tool before 2026-07-23** (measurement window for PR #74/#76 changes must stay clean). Steps 1-5 are offline-safe anytime.

## Progress

- Step 1 complete (PR #79, 2026-07-10): kb_sources schema applied, harvester live (`customer-service/import/harvestKbSources.js`) — 110 sources staged (products, collections, pages, policies, rendered website pages), idempotent re-run verified.
- Step 2 extraction complete (PR #80, 2026-07-10): zero-API extraction via 5 Claude Code subagents following `customer-service/import/kb-extraction-protocol.md` — 110 sources → 74 candidates (37 dropped: dupes, listing/landing pages, free-gift twins, size-chart tables left to graded-specs). Loader `loadKbCandidates.js` validates + upserts + stamps extracted_at. Schema applied + 74 candidates loaded live 2026-07-10.
- Step 3 phase 1 complete (PR #82, 2026-07-11): reply-corpus mine per `customer-service/import/kb-mining-protocol.md` (RECENCY RULE locked: newer statements supersede older; every assertion dated). 12,285 unique replies exported to 65 newest-first batches (`exportReplyCorpus.js`); mined batches 1-15 (2026 era) + 63-65 (hand-written 2020-2025) = 1,304 assertions → consolidated to 33 conflicts + 230 unpublished + 95 published + 149 dropped. REVIEW SHEETS awaiting Jamie: `customer-service/drafter/reply-corpus-2026-07-proposed.md` (263 items; 33 conflicts + 68 high-signal are the core ~100) and `customer-service/drafter/voice-rules-2026-07-proposed.md` (20 conditional voice rules from 4 era profiles; profiles in `temp-analysis-data/kb-mine/voice/`). Review runs in the founder Google Sheet (KB_REVIEW_SHEET_ID, v2: one row per conflict topic, free-text rulings).
- Conflicts resolved (2026-07-17): all 27 topics ruled by Jamie → 12 ruling-facts loaded to kb_candidates, advisor fact #22 softened (primarily USPS), Skipping Stone partner address fixed in registry + republished to site, returns pages verified clean. Open: 3PL customs-invoice answer; free-swimwear age-limit site edit (Jamie).
- Unpublished facts triaged (2026-07-17, per Jamie: "use your own reasoning and tools"): 230 → 46 look-up-able dropped / 153 tool-verified auto-accepted (loaded, trust=reply_corpus; 165 reply-corpus candidates total) / 31 to Jamie (republished as the New Facts tab). Triage rule now permanent in kb-mining-protocol.md. Facts review complete (2026-07-17): 31 calls interpreted → 18 loaded (discretion-gated ones marked FOUNDER DISCRETION inline), 13 dropped/handled (MOASH never a partner; ValidUSA address update is Jamie's separate task; boundary-size dup of conflict ruling). 195 reply-corpus candidates total. Voice rules decided (2026-07-17, blank=agree convention): 17 adopted (6 modified incl. urgency-gated executive decisions, first-order-full-only retention line, our-for-facilities possessives), 3 rejected (empathy-sorry, signature warming, radical transparency). All 17 folded into the advisor prompt; pinned scenarios noApologyForThirdParty + retentionLineGating added (3/3 green incl. noApologyForFit). Step 3 phase 1 FULLY REVIEWED. RESUME STATE: batches 16-62 (2025 advisor era) unmined — re-run miners per protocol, verdicts/assertions in `temp-analysis-data/kb-mine/`. Related ship: apologies fault-scoped in advisor prompt (PR #81 + pinned scenario), quantified by voice analysis (16/262 fit apologies in 2026 era).

## Constraints

- Zero Anthropic-API cost for extraction/eval (Claude Code only) — Jamie's standing instruction.
- Fail-soft + loud-warn on every advisor-side fetch (tone-fetch lesson: silent empty = months of dead subsystem).
- cs_get_knowledge consumers on other surfaces keep working through the rebuild.
