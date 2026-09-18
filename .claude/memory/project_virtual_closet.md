---
name: Virtual Closet build
description: Build the Virtual Closet app end to end at low fidelity from the approved wireframes, so it can be tested with a real centre
type: project
domain: community
done_when: On a preview URL, a centre signs up and verifies its email, the operator approves it from the CS dashboard, its closet page is live at /[slug]; a requester submits and verifies a request and it appears on the centre's Home; a sponsor tile goes to Shopify checkout with the centre attached and the paid test order lands in the ledger and moves the bar; the centre sends a funded box and the send/ready emails fire; the service and the dashboard section are deployed on Railway.
---

# Virtual Closet build

Build spec. The programme design lives in `.claude/plans/org-closet-programme.md` (read "Where things stand" first); the brief given to Claude Design and the wireframes it produced are in `.claude/plans/virtual-closet-handover/` (`virtual-closet-design-brief.md`, `wireframes/Virtual Closet Wireframes.dc.html`; the Claude Design project is `https://claude.ai/design/p/8882a56d-9618-4d91-babf-198e06d30173`). The wireframes are the screen-level spec; this file is the system-level spec. Where they disagree, this file wins and says why.

## Scope

"The entire site, low fidelity": every screen and email in the wireframes, working end to end on real data, with wireframe-grade styling (plain HTML, one small stylesheet, no brand pass). The hi-fi pass comes later and only touches templates and CSS.

In scope:
- Public: programme page with sign-up, sign-up confirmation, closet page with the four `?lead=` arrangements and all progress states, request form as its own step with email verification, sent states, sponsor handoff and thank-you, terms and reference pages, requests-paused states, donation-map pin link.
- Centre: create account (step 2 of sign-up), verify email, sign in, forgot and reset password, change email and password, Team (invite, roles, hand over admin, remove), accept invitation, Home (current box, add to the box, requests, words publish, share tools, this-month counts, Pass It On summary), Settings (closet, Pass It On, centre, team, account, leave), Send the box, History, by-hand approval on Home.
- Operator, inside the CS dashboard: Needs attention, Centres list and detail (with "open their Home as them", override settings, pause), Boxes and packing list, All requests with the operator-only detail.
- Emails: all of the wireframes' 1z, 1aa, 1ab, 1ac, 1ad.
- Money: Shopify checkout for sponsorship and add-to-the-box; the 20% discount by hidden single-use code; ledger fed from orders.
- Jobs: ledger reconcile, reminders, monthly statement, needs-attention digest.

Out of scope for this project (parked or later):
- The hi-fi visual pass (stage 2 of the brief).
- Google and Microsoft sign-in buttons doing anything (rendered, disabled, "coming soon").
- The 30-day browser attribution window on the store (needs a theme script; the discount code carries attribution for now).
- "Create store orders" from the packing list (zero-priced store orders per requester). The packing list is built; the button is a stub that says what it will do.
- Automated pre-read of community words.
- Klaviyo profile tagging.

## Architecture

- **Where it lives:** `virtual-closet/` in this repo. Its own Railway service (`railway/virtual-closet.toml`, start `node virtual-closet/server.js`) on a subdomain, working name `closet.rubyshines.com` (CNAME to Railway; the wireframes write `rubyshines.com/closet/[slug]`, which Shopify cannot host, so the public URL is `closet.rubyshines.com/[slug]`). Locally `PORT=3850`.
- **Server:** Express (already a dependency), server-rendered HTML from small template functions in `virtual-closet/views/`, one stylesheet `virtual-closet/public/closet.css`, a few lines of progressive JS (chips, add-item, copy buttons). No build step, no framework.
- **Business logic** in `virtual-closet/lib/*.js`, pure functions over Supabase, so the dashboard, the MCP tools and the jobs call the same code. MCP tools in `customer-service/lib/tools/virtualCloset.js`, spread into `allTools`.
- **Accounts:** own tables and own code, not Supabase Auth, for this cut. Email and password (scrypt via node `crypto`, no new dependency), verification and reset by single-use tokens, sessions as rows in `vc_sessions` referenced by a signed cookie (same HMAC pattern as the dashboard, `SESSION_SECRET`), so removing a member revokes their sessions everywhere. Reason: zero external configuration to test today, same copy control over the emails the wireframes specify, and Google/Microsoft can be added on top later (the dashboard's Google OAuth client already exists).
- **Operator side:** a new page in the CS dashboard, `customer-service/dashboard/public/closets.html` + `closets.js`, served at `/closets` behind the dashboard's existing Google sign-in, with `GET/POST /api/closets/*` routes in `customer-service/dashboard/server.js` that call `virtual-closet/lib/operator.js`. Linked from the dashboard nav. Not a tab inside `app.js`.
- **Money:** never touches the service. A hidden Shopify product "Sponsor a closet" (requires no shipping, not in any collection) with variants for $16, $21, $24, $50, $100, $300 and a "$1 unit" variant used with a quantity for the centre's own add-to-the-box. Cart permalinks `rubyshines.com/cart/<variant>:<qty>?attributes[closet]=<slug>&attributes[box]=<n>` carry the attribution as order note attributes. The order webhook and the daily reconcile write ledger rows from them.
- **20% off:** one Shopify discount "Virtual Closet 20%" (20% off order, one use per code, once per customer, created once by a setup script). "Shop with 20% off" issues a fresh code `VC-<CENTRE>-<random>` through `addCodeToPriceRule`, records it in `vc_discount_codes`, and redirects to `rubyshines.com/discount/<code>?redirect=/collections/all`. Orders carrying a `VC-` code credit 25% of the order subtotal to that centre's open box.
- **Emails:** SendGrid `sendEmail` from care@rubyshines.com, HTML composed in `virtual-closet/lib/emails.js`. Every centre email links into the private view; every requester or sponsor email links to the closet page.
- **Jobs:** `virtual-closet/jobs/daily.js` run as a `daily-sync-all` sub-pipeline: reconcile ledger from `orders` (idempotent on order id), by-hand reminders (7 days) and escalation (14 days), pickup reminders (14 days after delivery), monthly statements (1st of the month, only when something happened), needs-attention digest to the operator.

## Data model (`virtual-closet/schema.sql`, all tables prefixed `vc_`)

- `vc_centres`: id, slug (unique), name, website, logo_url, address jsonb {street, city, region, postal, country}, programmes jsonb {closet, pass_it_on}, sizes text[] (XS..4X), kids_sizes bool, items_per_request int (2), requests_per_year int (2), goal_cents int (30000), approval_mode (automatic|by_hand), ship_to_door bool, requests_paused_at, map_listed bool, map_pin_to_closet bool, pass_it_on_paused_at, statements_email, pickup_note, delivery_note, status (pending|active|paused|left), approved_at, approved_by, paused_reason, left_at, donation_partner_id (fk donation_partners, set when Pass It On is approved), created_at, updated_at.
- `vc_users`: id, email (unique, lower-cased), name, role_title, password_hash, email_verified_at, created_at, last_active_at.
- `vc_memberships`: centre_id, user_id, role (admin|member), created_at; unique (centre_id, user_id).
- `vc_invitations`: id, centre_id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at.
- `vc_tokens`: id, user_id, email, purpose (verify_email|reset_password|change_email|request_verify|approve_request|decline_request), token_hash, payload jsonb, expires_at, used_at.
- `vc_sessions`: id (random), user_id, created_at, expires_at, revoked_at.
- `vc_boxes`: id, centre_id, number, status (open|sent|shipped|delivered), goal_cents, opened_at, sent_at, shipped_at, delivered_at, carrier, tracking_number, fill_mode (auto|chosen), fill_plan jsonb, pickup_note, delivery_note, items_count; unique (centre_id, number).
- `vc_ledger`: id, centre_id, box_id, kind (order_credit|sponsor|centre_add|carry_in|door_shipping|match|carry_out|adjustment), amount_cents (signed), source_type, source_id, detail jsonb, created_at; unique (kind, source_type, source_id) where source_id is not null.
- `vc_requests`: id, centre_id, box_id (null until assigned), email, name, items jsonb [{style, colour, size}], delivery (pickup|ship), address jsonb (ship only), words, words_shareable bool, words_published_at, published_by, status (unverified|needs_answer|approved|declined|waiting|in_box|shipped|ready|collected|ended|cancelled), decided_by, decided_at, decline_counts bool, verified_at, swap jsonb, created_at, updated_at.
- `vc_requester_emails`: email (pk), verified_at.
- `vc_discount_codes`: id, centre_id, code (unique), issued_at, order_id, used_at.
- `vc_visits`: id, centre_id, lead, source (link|map), visited_at.
- `vc_events`: id, centre_id, actor, kind, detail jsonb, created_at. Every operator action and every centre action worth a log line.
- `vc_word_reports`: id, request_id, reported_at, resolved (unpublish|keep), resolved_at.
- `vc_statements`: id, centre_id, month, sent_at, payload jsonb.

Box goal shown = max(centre goal, sum of approved requests at half retail plus $15 per shipped request). Raised = sum of ledger for the box excluding match and carry_out. Funded when raised >= goal. The match is written as a ledger line when the box is sent, never before.

## Flows

**Sign-up.** Programme page form (name, website, programmes, sizes, kids) → step 2 create account (name, role, email with the personal-domain nudge, password) → verify email gate → confirmation page and Home with the "waiting for approval" banner; share tools hidden; settings and team usable. The operator email "a centre signed up" goes only once the email is verified. Approve creates the donation partner row when Pass It On is ticked (geocode via the existing partner creation path, listing on the map), sets status active, sends the welcome email, opens box #1.

**Closet page.** `/:slug` with `?lead=shop|request|sponsor`, default all three equal. Progress module states from wireframe 1f. Products from the five-style menu with store prices; sizes from the centre. Words section only when published words exist. Requests paused: the request card stays, button disabled, one line why; the form URL shows the paused page. Visits counted.

**Request.** `/:slug/request` its own step. Items limited to the centre's sizes and item cap; per-email yearly limit enforced inline. Ship reveals the address. Submit: if the email is not in `vc_requester_emails`, the request is `unverified` and a confirm link is emailed; tapping it verifies and lands on the confirmed page. Verified: automatic mode approves within limits and assigns the open box (or `waiting` if the open box is already funded); by-hand mode sets `needs_answer` and emails the centre with approve and decline links (single-use tokens, no sign-in) and a 7-day reminder. Confirmed and "on the list" emails per 1ac.

**Sponsor.** Tiles are cart permalinks to the sponsorship product with `attributes[closet]` and `attributes[box]`. The order webhook (`webhooks/handlers/shopifyOrders.js`) calls `ledger.recordOrder(payload)` after the upsert; the daily reconcile does the same over `orders`. Thank-you page at `/:slug/thanks` linked from the sponsor thank-you email, showing the bar. "Someone sponsored your closet" email to the centre.

**Shop.** `/:slug/shop` issues a code and redirects to the store discount URL. `order_credit` ledger rows at 25% of subtotal for orders whose discount code is in `vc_discount_codes`.

**Centre Home.** Box summary with sources, Send the box (enabled when funded), add to the box (permalink to the $1 variant with quantity), requests table (published/unpublished words, statuses, approve/decline in by-hand mode), pause requests, share tools (four links, QR as an SVG generated server-side, a ready-made post), this-month counts, Pass It On summary.

**Send the box.** Requested items fixed; fill the rest by choosing a size grid or "let it fill itself" (even spread across the centre's sizes and the five styles within the remaining product value); totals (raised, match, door shipping, items, carry-over); pickup and delivery notes prefilled and saved to the centre; Send closes the box (`sent`), writes `match`, `door_shipping`, `carry_out` rows, opens the next box with `carry_in`, moves waiting requests into it, emails the centre and the requesters per 1af. Operator marks shipped with tracking (emails per 1af) and delivered (pickup-ready emails, sponsor "it arrived").

**Operator.** Needs attention (new centres, boxes to pack, waiting on a centre, reported words, this-week counts, unusual); Centres list; Centre detail with tabs (overview, boxes, requests, team, settings with override, words, log) and "Open their Home as them" (impersonation session flagged in the cookie, banner on every page, every action logged as operator); Boxes with the packing list (print view); All requests with the operator-only detail (email and address together), swap item, cancel.

## Decisions taken from the wireframes (refinements on the brief)

- The legacy programme is called **Pass It On** on every surface (Claude Design's choice; the brief left it open). Internally the donation partner registry is unchanged.
- Requesters verify their email once by link before a request counts; later requests from a verified email go straight in.
- The closet page is one page with four arrangements picked by `?lead=`; the centre's share tools hand out all four.
- Words from the community are unpublished by default and published by a centre admin; the operator can unpublish anything; a visitor can report.
- Declined requests do not use up a turn by default (a checkbox on decline).
- By-hand approvals unanswered for 7 days get a reminder; at 14 days the operator sees it.
- Pickup emails send themselves when the carrier reports delivery, so the pickup note is written at Send the box.
- Team rules: at least one admin at all times; hand over admin is one step; removing someone signs them out everywhere.
- Box terms on screens use "match" as a line item, never "double" or "50%".
- The pickup note and delivery note are per box, prefilled from the last box.

## Answers from Jamie (2026-09-18)

1. "Pass It On" stays as the name.
2. Sizes are the store's: XS, S, M, L, 1X, 2X, 3X, 4X (no XL) plus kids.
3. The 20% is once per customer, new or returning (Shopify `appliesOncePerCustomer`).
4. OK to create the hidden "Sponsor a closet" product and the "Virtual Closet 20%" discount in the live store (`virtual-closet/scripts/setupShopify.js --create`).
5. Jamie applies `virtual-closet/schema.sql` in the Supabase SQL editor (no `SUPABASE_DATABASE_URL` locally).
6. Requesters become store customers on confirmation (name they go by, tagged `virtual-closet` and `closet:<slug>`); the newsletter is an opt-in checkbox on the request form and subscribes through Klaviyo only when ticked.

## Build order

1. Schema, service skeleton, centres and slugs, closet page in all arrangements with a seeded demo centre. Checkpoint: the page renders at `/:slug` locally.
2. Accounts: sign-up steps, verify, sign in, reset, sessions, team, invitations. Checkpoint: two users on one centre, one invited.
3. Requests: form, verification, automatic and by-hand approval, emails. Checkpoint: a request appears on Home.
4. Money: sponsorship product and discount setup script, permalinks, webhook hook, reconcile, ledger, progress states, thank-you. Checkpoint: a test order moves the bar.
5. Send the box, boxes lifecycle, shipped and delivered, emails. Checkpoint: a box goes out and the next opens.
6. Operator pages in the dashboard, MCP tools, jobs. Checkpoint: approve a centre from the dashboard.
7. Tests for every lib function (goal math, ledger idempotency, limits, token flows, box send), Railway toml, deploy, DNS.

## Testing plan

Local: `PORT=3850 node virtual-closet/server.js` from the worktree; dashboard on a non-default port for the operator side. Shareable: ngrok on the reserved pool. Money: a sponsorship test order paid with a one-off 100% discount on the sponsorship product, then a real $16 order refunded. Emails to Jamie's own addresses. A seed script creates a demo centre so the page can be looked at before any sign-up.
