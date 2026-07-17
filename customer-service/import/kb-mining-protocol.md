# Reply-Corpus Mining Protocol (corpus harvest, step 3)

How a Claude Code session mines 6 years of sent CS replies for factual
assertions, dedupes them against the published KB, and produces the conflict
sheet Jamie reviews. Zero Anthropic-API cost: mining runs in Claude Code
(session or subagents), never through `callClaude`.

## Pipeline

1. **Export**: `node customer-service/import/exportReplyCorpus.js <outDir>`
   → newest-first `batch-NNN.json` files (deduped, most-recent exemplar wins,
   `times_sent` + `first_sent` retained).
2. **Mine** (subagents, one per batch): read a batch, output assertion JSONL.
3. **Consolidate** (session or one subagent): merge assertion files, apply the
   recency rule, dedupe against `kb_candidates` (published tier) and active
   `advisor_facts`, classify survivors, emit the conflict sheet.
4. **Review**: Jamie reviews ONLY conflicts and unpublished knowledge.
   Everything already published drops silently.

## Recency rule (Jamie, 2026-07-10)

A statement made two years ago may have been superseded. Therefore:

- Every assertion carries the `date` of the reply it came from (plus
  `times_sent`/`first_sent` when the same reply was templated).
- When two mined assertions state the same fact differently, the NEWER one is
  the live candidate; the older one is recorded as superseded (kept in the
  sheet only if the supersession itself is worth Jamie seeing, e.g. a policy
  that changed silently).
- When a mined assertion conflicts with current website content
  (`kb_candidates`), the website wins by default; the assertion appears on the
  conflict sheet with its date so Jamie can decide whether the site or the old
  reply is right.
- Mining runs newest-first, so later (older) batches mostly confirm or lose to
  what is already mined.

## Mining output format (per batch)

One JSON object per line (JSONL), only for messages that contain at least one
durable assertion — silent skip for the rest:

```json
{"message_id": "gorgias:12345", "date": "2026-05-02T14:11:00+00:00", "times_sent": 3,
 "assertions": [
   {"fact": "RUBIES ships to PO boxes via USPS only", "category": "shipping", "quote": "we can ship to a PO box as long as..."}
 ]}
```

- `fact`: one self-contained sentence stating the durable business fact.
- `category`: `product | sizing | shipping | policy | program | community | wholesale | company | faq`
- `quote`: short verbatim snippet from the reply supporting the fact.

## What is a durable assertion (KEEP)

Statements that would be true for the NEXT customer who asks:
- Policy/process facts: how exchanges work, return windows, who pays shipping,
  how donations are routed, gift card rules.
- Product facts: fit behavior, fabric, care, sizing quirks ("the X runs small"),
  product comparisons and recommendations.
- Shipping/logistics rules: carriers, customs/duties behavior by country,
  PO boxes, delivery expectations stated as policy.
- Program terms: free swimwear, LGBTQ+ discounts/donations, wholesale terms.
- Company facts: who RUBIES is, guarantee terms, contact channels.

## What is NOT an assertion (SKIP)

- Order-specific facts: this order's status, this tracking number, this refund
  amount, this customer's size recommendation (unless it states a general
  sizing rule).
- Anything the advisor must tool-fetch live: current inventory, current
  delivery times, current prices (prices in old replies are stale by
  definition — never mine them).
- Empathy/tone content, apologies, greetings, signatures.
- Facts already visibly perishable at source: sale windows, restock ETAs,
  "we're launching X next month".

## Consolidation & conflict sheet

The consolidator merges all batch outputs and buckets every unique fact:

1. **Already published** — semantically matches a `kb_candidates` row or an
   active `advisor_facts` row → drop silently (count reported).
2. **Unpublished knowledge** — stated to customers, nowhere on the site → the
   most valuable slice. Goes on the sheet with date + times seen, grouped by
   category, newest first.
3. **Conflict** — contradicts a `kb_candidates` row, an `advisor_facts` row, or
   a newer mined assertion → goes on the sheet with both sides + dates.

## Triage before founder review (Jamie, 2026-07-17)

Unpublished facts do NOT all go to Jamie — that made phase 1's sheet tediously
long. A tool-verifying triage pass (Claude Code subagents) buckets them first:

- **A — look-up-able → drop.** Anything derivable from live systems the
  advisor queries with tools: product catalog (colors, size runs, prices,
  materials), garment measurements / size charts / grading deltas (graded
  specs), shipping zones / duties / delivery times, donation-partner registry
  (names, addresses), inventory. Jamie's rule of thumb: "you should be able
  to look this up." Never ask him to confirm these.
- **B — auto-accept.** Durable, non-derivable, and verified with reasoning +
  tools (no contradiction vs the published KB, advisor facts, or live data).
  Loads straight to `kb_candidates` at `trust='reply_corpus'` with the
  verification note in meta. Reversible with a status flip.
- **C — founder review.** Program eligibility/terms, money/goodwill promises,
  one-off-kindness vs standing-policy ambiguity, contradictions, anything
  failing verification. Only this pile reaches the review sheet.

Phase-1 calibration: 230 unpublished → A 46 / B 153 / C 31.

Review happens in the shared Google Sheet (`KB_REVIEW_SHEET_ID`) via
`publishReviewSheets.js` — free-text decision columns, one row per conflict
topic; see that script's header. After the first publish, republish ONLY the
tab you're refreshing (`--tabs=facts`) — a full publish overwrites founder
decisions on every tab. Approved/curated facts load via `--apply-file`
(`loadKbCandidates.js --trust` remains for extraction-shaped output).

## Resume state

Batches are newest-first and deterministic for the historical tail. Progress
(last batch mined, output locations) is recorded in the project file
(`.claude/memory/project_corpus_harvest.md`) at each session close. Assertion
JSONL and batch files live in `temp-analysis-data/kb-mine/` (local, untracked).
