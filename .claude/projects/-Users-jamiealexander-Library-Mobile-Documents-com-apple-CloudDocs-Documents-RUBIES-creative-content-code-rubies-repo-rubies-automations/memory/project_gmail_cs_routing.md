---
name: Gmail CS routing + inbox cleanup
description: Gmail customer_support emails route to Gorgias, spam/newsletters/auto-replies archived. Classification labels on all emails. Pub/Sub webhook for real-time.
type: project
---

Gmail inbox cleanup system built and deployed (2026-04-10/11).

**Architecture:** Gmail push (Pub/Sub webhook) + daily sync backup → classify (Sonnet) → processGmailCs.js routes by classification:
- `customer_support` → create Gorgias ticket (tagged `gmail-import`), full thread history included
- `spam` → marked as spam in Gmail (trains Google's filter)
- `auto_reply`, `newsletter`, `skip` → labeled + archived
- Everything else → labeled with `R/` prefix, left in inbox

**Directory renamed:** `email-intelligence/` → `gmail-management/` (2026-04-11)

**File renames (same session):**
- `hybridAdvisor.js` → `aiAdvisor.js`
- `actionRouter.js` → `operatorAgent.js`
- `csConfig.js` → `sizingEngine.js`
- `conversationTester.js` → `advisorTester.js`
- `exchangeAdvisor.js` + `responseComposer.js` deleted

**Key decisions:**
- Funnel into Gorgias (not parallel path) — zero changes to advisor/dashboard/follow-up
- Removed domain classification cache (Tier 2) — AI-first, $1.50/month not worth frozen classifications
- Cleaned SKIP_DOMAINS — only pure SaaS (Shopify, GitHub, Stripe, etc.), no hack entries
- Advisor adds channel-switch note for gmail-import tickets
- Dashboard shows "via email" badge (source column on cs_tickets)
- Labels use `R/` prefix (e.g., `R/Customer Support`, `R/B2B`, `R/3PL`)
- `R/Wholesale` renamed to `R/B2B`
- Spam emails marked as spam in Gmail (trains Google's filter) not just labeled
- Per-message classification is correct even in mixed threads — labels per message, not per thread

**Classifications (13):** customer_support, wholesale (labeled R/B2B), lgbtq_org, product_rd, production_orders, email_marketing, 3pl_fulfillment, finance_legal, internal, newsletter, auto_reply, spam, skip

**Pub/Sub setup:**
- GCP project: `rubies-lgbt-resources`
- Topic: `projects/rubies-lgbt-resources/topics/gmail-notifications`
- Push subscription: `gmail-push` → `https://rubies-automation-production.up.railway.app/webhooks/gmail`
- Publisher: `gmail-api-push@system.gserviceaccount.com`
- Watch expires every 7 days, renewed daily via `daily-sync-all.js`
- Railway env vars: GMAIL_PUSH_TOPIC, GMAIL_CREDENTIALS_JSON, GMAIL_TOKEN_JSON

**Known issues to monitor:**
- Some emails not getting labeled — was caused by Anthropic rate limit crash, now fixed. Monitor for 24h.
- Sync gaps — some emails not picked up by daily sync (e.g., Sadie "topic idea"). Webhook should cover these going forward.
- Phased rollout: GMAIL_CS_ARCHIVE still false (label-only mode). Enable after confirming labels are correct.

**Open items for next session:**
- Thread history for CS forwarding — prompt saved for follow-up
- Monitor webhook reliability for 24h
- Enable archive mode once labels verified
- Consider: daily sync query may have gaps (needs investigation if emails still missing)
