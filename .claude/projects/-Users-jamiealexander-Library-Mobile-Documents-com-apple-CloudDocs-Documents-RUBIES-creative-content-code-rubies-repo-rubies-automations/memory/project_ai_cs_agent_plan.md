---
name: AI Customer Service Agent — Architecture Plan
description: Three-layer architecture for AI-powered CS agent using conversations, structured sizing data, and mined decision patterns
type: project
---

## Goal
Build an AI agent that can handle RUBIES customer service with the same nuance as Jamie, especially for sizing/exchange conversations.

## Three-Layer Architecture

### Layer 1 — Structured/Deterministic Data (sizing math)
- Size grading is consistent across product classifications
- Bottoms, youth sizes (4-16): +1" (2.5cm) per size step
- Bottoms, adult sizes (XS-4X): +2" per size step
- Tops: TBD (Jamie to confirm)
- One-pieces: have "Tall" variants, waist-to-height considerations (TBD)
- Swimwear uses ODD sizes (7, 9, 11, 13) where 11=XXS+, 13=XS+
- Underwear/activewear uses EVEN sizes (4, 6, 8, 10, 12, 14, 16)
- When customer outside North America → use cm (2.5cm) not inches
- This data should be a structured lookup, NOT from conversation search
- Shopify metafields classify each product: product_category (Tops/Bottoms/One-pieces), product_collection (Swimwear/Underwear/Activewear), product_age (Kids/Adults)

### Layer 2 — Decision Logic (mined from conversations, codified as rules)
- "If sizing complaint + multiple items same size → ask about ALL items"
- "If off by 1 size → recommend next size, state exact inch difference"
- "If off by 2+ sizes or wrong size system → ask for waist measurements"
- "If one-piece + proportions don't fit → suggest alternative products"
- These rules get extracted by analyzing 50-100 exchange conversations with Claude, then written explicitly as agent instructions

### Layer 3 — Conversation Style (from conversation history search)
- Tone, framing, when to be proactive
- Edge case handling
- The "soft" stuff — embeddings + semantic search

## Key Insight from Jamie
The AI needs to cross-reference the customer's ORDER (what product, what size) with their complaint. Customer says "it's too tight" — AI must pull up the order, see they bought AJ size 12 + Ruby size 12 + Charlie size 12, and proactively flag that if one doesn't fit, they all might need resizing. This is NOT a search problem — it's deterministic logic + order data.

## Current Pipeline Status (2026-03-12)
- Gorgias: 1,696 conversations — 1,691 categorized + embedded ✓
- Tidio: 1,670 conversations imported ✓ — categorization in progress (~50 done, ~1,620 remaining)
- Knowledge base: 60 articles (5 manual, 24 Shopify, 31 website)
- Gorgias macros DELETED from KB (were canned/stale, don't reflect Jamie's actual style)
- FAQ patterns: 0 — script to auto-generate not built yet
- Embedding: 512 dims (voyage-3-lite) — confirmed consistent across schema, API, and stored data

## Next Steps
1. Move products to Supabase (products + product_variants tables with metafields)
2. Build structured sizing rules tool using product metafields
3. Mine exchange conversations for Layer 2 decision rules
4. Build FAQ/pattern generator from all categorized conversations
5. Test end-to-end with real customer scenarios
