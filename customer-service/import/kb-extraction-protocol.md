# KB Extraction Protocol (corpus harvest, step 2)

How a Claude Code session turns `kb_sources` rows into `kb_candidates` entries.
Zero Anthropic-API cost: extraction runs in Claude Code (session or subagents),
never through `callClaude`. Re-run this protocol for any source whose
`content_hash` no longer matches its candidates' `source_hash` (weekly refresh),
then load with `customer-service/import/loadKbCandidates.js`.

## Inputs

Active `kb_sources` rows: `id, source_type, source_url, title, content, content_hash, meta`.
Export them with `node customer-service/import/exportKbSources.js <outDir>` (writes
one JSON file per source_type; hand each file to one extraction subagent).

## Output format

One JSON object per source (JSONL, one line each):

```json
{"source_id": "page:size-guide", "source_hash": "<content_hash>", "decision": "extracted", "candidates": [
  {"slug": "main", "title": "RUBIES Size Guide", "category": "sizing", "content": "..."}
]}
{"source_id": "website:/pages/shop-adults", "source_hash": "<content_hash>", "decision": "dropped", "reason": "product listing page — duplicates product entries"}
```

- `slug`: short kebab topic slug, stable across re-extractions (`main` for
  single-candidate sources). Candidate id becomes `<source_id>#<slug>`.
- `category`: `product | sizing | shipping | policy | program | community | wholesale | company | faq`
- Every input source MUST appear exactly once (extracted or dropped with a
  reason) — the loader stamps `kb_sources.extracted_at` from this file, so a
  missing source stays flagged as never-extracted.

## Extraction rules

**Content:**
- Self-contained markdown a CS advisor can quote from: each candidate makes
  sense with no other page in view. Factual, neutral prose — condense marketing
  copy to the facts it carries; drop pure fluff.
- One candidate per coherent topic. Split multi-topic sources (e.g. a returns
  page covering exchanges AND refunds AND donations = up to 3 candidates).
  Most sources yield exactly one. Content length 40–8000 chars.
- Merge near-duplicate sources: extract from the richer one, drop the other
  with a reason pointing at the survivor.

**Keep (durable business facts):**
- Product facts: what it does, how the shaping tech works, fabric, fit notes,
  available sizes/colors, price as published (source-linked; weekly refresh
  catches drift).
- Policies, shipping rules, program terms (free swimwear, LGBTQ+ discounts &
  donations, rewards, wholesale).
- How-to-measure INSTRUCTIONS (how to take body measurements).
- Partner/stockist names and addresses (source-linked, refreshable — do not
  treat as frozen facts).

**Drop (with reason):**
- Garment measurement tables / size-chart numbers — graded-specs data owns
  those (`get_graded_specs` / `cs_get_sizing_guide`), not KB prose.
- Live state the advisor must tool-fetch: inventory, order status, current
  delivery times.
- Expired one-time events, past campaign pages, page-chrome remnants,
  product-listing pages that only duplicate per-product entries.
- Anything that is a judgment call rather than a stated fact.

**Voice guardrails carry over:** no em dashes in content, they/them defaults,
no political framing (content may be quoted verbatim in customer replies).

## Loading

```
node customer-service/import/loadKbCandidates.js <file.jsonl> [more.jsonl ...] [--dry-run]
```

Validates shape + category enum + hash freshness, upserts by candidate id,
marks candidates missing from a re-extracted source as `dropped`, and stamps
`kb_sources.extracted_at`.
