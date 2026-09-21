---
name: Virtual Closet, the minimal cut
description: Turn the built Virtual Closet into a link-only programme for the pilot: a page with one shop button and four sponsor tiles, a balance that accrues from orders, and an email to the centre on days with activity. No accounts, no requests, no boxes.
type: project
domain: community
done_when: On the Railway service, a centre enrolled by `vc_enrol_centre` (seeded from a donation partner row) has a live page at /[slug] showing only the shop button, the four sponsor tiles, the styles and the running total; its welcome email arrives with a QR that scans to the page; one real order placed through its Shop button and one real $10 sponsor order both land on its ledger; the next daily run sends the centre a single digest naming both; `vc_redeem` debits the balance and `vc_centre` shows the new balance; the full suite is green and the change is on main.
---

# Virtual Closet, the minimal cut

Build spec. The full app (accounts, requests, boxes, operator pages) was built and merged 2026-09-18 to 21 (PRs #212 to #219) and runs at the Railway domain. On 2026-09-21 Jamie cut the pilot back to an affiliate-shaped programme because the risk is execution, for the centre and for RUBIES, not build cost. The programme record with every decision is `.claude/plans/org-closet-programme.md`, section "The minimal cut". This file says how the code changes.

**The principle:** the full app stays in the codebase behind a per-centre mode. Nothing is deleted. Every centre enrolled from now on is in `link` mode; no centre is in `closet` mode and nothing links to closet-mode surfaces, but the code and tests for them stay green.

## What the centre experiences

1. Jamie enrols them. They get one email: their link, a QR code, a ready-made post, four lines of terms, Jamie's contact.
2. They share the link or the QR. That is their whole job.
3. A shopper who opens the link sees one page: shop with 20% off (a hidden single-use code, minted per click), four sponsor tiles, the five styles, the running total.
4. On any day with activity the centre gets one email: what came in, and the balance.
5. When they want product they email Jamie an order (partner terms: 50% off any order whose retail value before the discount is $600 or more, five styles). Jamie places it and deducts the balance by tool. No top-up mechanism, no box, no goal.

## Terms and wording (locked 2026-09-21)

- Shopper: 20% off one order per customer, existing customers included, applied automatically. No code shown.
- Centre credit: 25% of what the buyer paid (post-discount subtotal, as `money.orderCreditCents` does today) plus every sponsor dollar at face value.
- The match: credit is spent at partner pricing (half retail), which is the match. No separate mechanism.
- Buyer line: "A quarter of your order goes to [Centre]'s Virtual Closet, and RUBIES matches it."
- Total line: "$88 raised so far. RUBIES matches it: $176 of underwear and swimwear for the closet." Lifetime raised, never net of redemptions; the public number only goes up.
- Sponsor tiles: $10, $25, $50, $100, plain, no line of their own.
- The digit "25%" appears only in the centre's terms (the welcome email). "Match" appears exactly once, on the page's total line; the emails do not use it (Jamie, 2026-09-21).
- The product name is "Virtual Closet", capitalised, in titles and subjects: "[Centre] Virtual Closet" on the page, "[Centre]'s Virtual Closet" in sentences.
- Never: discount, wholesale, doubled, box, shipment, goal, on any public surface. "50% off" and "$600 retail" are said plainly in the centre's welcome email, and nowhere public. Never em dashes. Plus sizes 1X to 4X.

## Schema (`virtual-closet/schema-link-mode.sql`, Jamie applies in the SQL editor)

```sql
alter table vc_centres add column if not exists mode text not null default 'closet' check (mode in ('link','closet'));
alter table vc_centres add column if not exists digest_through timestamptz;   -- activity emailed up to here
alter table vc_ledger drop constraint if exists vc_ledger_kind_check;
alter table vc_ledger add constraint vc_ledger_kind_check check (kind in ('order_credit','sponsor','centre_add','carry_in','adjustment','match','door_shipping','carry_out','redemption'));
```

`redemption` rows are negative, `source_type = 'wholesale_order'`, `source_id` = the order number, so the unique source index makes a repeated tool call a no-op. `box_id` is null for every link-mode row. Existing closet-mode rows are untouched.

## Code changes, by file

### `virtual-closet/lib/centres.js`
- `isLink(centre)` helper (`centre.mode === 'link'`).
- `enrol({ name, slug, notify_email, website, logo_url, city, region, country, donation_partner_id, actor })`: creates the row with `mode: 'link'`, `status: 'active'`, `approved_at: now`, `approved_by: actor`, `statements_email: notify_email`, `programmes: { closet: true, pass_it_on: !!donation_partner_id }`, `donation_partner_id`, address `{city, region, country}`. Slug via `uniqueSlug(name)` unless given. Logs `centre.enrolled`. Does not send email (the tool does, so the tool can preview first).

### `virtual-closet/lib/ledger.js`
- `balance(centre)`: one query over `vc_ledger` for the centre; returns `{ raisedCents, redeemedCents, balanceCents, orders, sponsors, lastActivityAt }`. `raised` = sum of positive rows of kind `order_credit`, `sponsor`, `centre_add`, `adjustment`; `redeemed` = sum of negative `redemption` and `adjustment` rows, as a positive number; `balance = raised - redeemed`. Counts are rows of `order_credit` and `sponsor`.
- `recordOrder`: when the centre is link mode, `box = null` (no `openBoxFor`). `notify`: for link-mode centres send only `sponsorThanks` (link copy); skip `sponsored` and `boxFunded`. Order-credit rows email nobody live; the digest covers them.
- `redeem({ centre, amountCents, orderNumber, note, actor, kind = 'redemption' })`: refuses when `amountCents > balance` or `amountCents <= 0`; inserts `redemption` with `-amountCents`; logs `ledger.redemption`. Returns the new balance. `kind: 'adjustment'` is a hand correction (a refunded order, say), positive or negative, with a required note and no balance check.
- `reconcile` unchanged.
- `digestActivity(centre, { since })`: the `order_credit` and `sponsor` rows after `since` (or all, when `since` is null), grouped for the email, plus `maxCreatedAt`.

### `virtual-closet/lib/catalog.js`
- `SPONSOR_TILES` becomes `[{key:'ten',cents:1000,label:'$10'},{key:'twentyfive',cents:2500,label:'$25'},{key:'fifty',cents:5000,label:'$50'},{key:'hundred',cents:10000,label:'$100'}]`, no `sub`. Closet-mode templates that read `sub` render without it (check `sponsorFirst` and `allEqual`).

### `virtual-closet/lib/sponsorship.js`
- `checkoutUrl`: every tile uses the `unit` variant with `qty = cents / 100`. The per-item variants on the hidden Shopify product stay unused; no store change. In link mode the `Box` attribute is omitted. `readLineItem` and `readOrderAttributes` unchanged (the unit variant is already known, kind stays `sponsor`).

### `virtual-closet/views/closet.js`
- New arrangement `linkOnly(ctx)`, chosen when `centre.mode === 'link'` regardless of `?lead`. No nav links. Sections, in order:
  1. Hero: title "[Centre] Virtual Closet" on the left; on the right "RUBIES × [centre logo]" (the RUBIES wordmark, a multiplication sign, the centre's logo as enrolled). Sample centre in the design: The Attic Youth Center. (Jamie, 2026-09-21.)
  2. One sentence and the button: "Shop RUBIES with 20% off. A quarter of your order goes to [Centre]'s Virtual Closet, and RUBIES matches it." Button "Shop with 20% off" → `/[slug]/shop`. No fine print, no size guide link under it (Jamie, 2026-09-21).
  3. Total: "$88 raised so far. RUBIES matches it: $176 of underwear and swimwear for the closet." with "from 9 orders and 3 sponsors". At zero: "Nothing raised yet. Be the first." No bar, no number sign, no goal.
  4. Sponsor row: heading "Not shopping? Put money in the closet.", four tiles → `/[slug]/sponsor/[key]`. Nothing under them.
  5. The styles: `productGrid(ctx, { discounted: true })` as the shop-first arrangement draws it.
  6. How it works, three lines: "Shop, and 20% comes off at checkout." "A quarter of every order and every sponsor dollar goes to the closet, and RUBIES matches it." "RUBIES sends [Centre] underwear and swimwear from what is raised."
  7. `aboutSection()` and the footer as today.
- `render` takes `balance` in ctx for link mode; `progress`, `wordsSection`, request buttons are not called.

### `virtual-closet/server.js`
- `closetContext(centre)`: for link mode, compute `ledger.balance` and skip boxes, words, paused.
- `/:slug/sponsor/:tile`: no `getOpenBox` in link mode.
- `/:slug/thanks`: link copy: "Your $25 went to [Centre]'s Virtual Closet. Thanks for your support." then the total line, "Back to [Centre]'s Virtual Closet". No "Share the closet" link.
- New public `GET /:slug/qr.png` and `/:slug/qr.svg`: the page URL encoded with the `qrcode` package (pure JS, add to `dependencies`, pin exact). Active link-mode centres only; 404 otherwise.
- `routes/requests.js`: every handler 404s for a link-mode centre (one guard at the top of the router).
- `routes/centre.js` (the signed-in view): a link-mode centre has no users, so nothing changes; the existing `/share/qr.svg` placeholder now calls the same encoder.

### `virtual-closet/views/programme.js`
- The sign-up section and its two CTAs are replaced with "Talk to Jamie" (mailto with subject "Virtual Closet") and one line: "Jamie sets your closet up on a call or by email. Nothing to fill in." The `/signup` routes stay mounted but nothing links to them. The "how it starts" list drops "Sign up. Five minutes."

### `virtual-closet/lib/emails.js` and `shared/sendgridClient.js`
- `welcome` link variant (branch on `centre.mode`), **sent from jamie@rubyshines.com** so replies and orders come to Jamie (Jamie, 2026-09-21). Subject "Your RUBIES Virtual Closet is ready." Body, editorialised from Jamie's brief: "Congratulations, [Centre]'s Virtual Closet is ready." The link, then the CTA: share it on your socials, website and newsletter; anyone who opens it gets 20% off a RUBIES order, and every order and every sponsor dollar adds to your closet; a ready-made post (the existing `share.post` text). The QR attached as `closet-qr.png` and linked at `/[slug]/qr.png`. (A printable QR poster and fact sheet come later; the email does not mention them.) "Your Virtual Closet earns 25% of what shoppers pay through your link, plus every sponsor dollar." Ordering: "When you're ready to order, email me your order and I'll apply what your closet has earned. Partner pricing stays as it is: 50% off any order where the retail value before the discount is $600 or more." Sign-off from Jamie. No match line (Jamie's brief has none; the 50% says it), no private view link, no settings line.
- New `activity({ centre, to, orders, sponsors, orderCents, sponsorCents, balanceCents, raisedCents })`, from jamie@rubyshines.com: subject "[Centre]'s Virtual Closet activity today". Lines: "[3] orders through your link put $[24.60] in." "[1] sponsor put $[25] in." "Your balance is $[112.40]." Then "Raised so far: $[188]", then the same sharing instructions as the welcome (the link, share it on your socials, website and newsletter, the one-line offer, the ready-made post), then "To order, email me." No buttons, no match line.
- `sponsorThanks` link variant, from care@: "Your $25 went to [Centre]'s Virtual Closet. Thanks for your support." plus the total line and the closet link. No match line, no shipment number.
- `deliver` gains optional `attachments`; `sendEmail` in `shared/sendgridClient.js` does not pass attachments today, so add an `attachments` pass-through (`[{content (base64), filename, type, disposition}]`) there. Console mode prints the filename.

### `virtual-closet/jobs/daily.js`
- New step, first after reconcile: for each active link-mode centre, `ledger.digestActivity(centre, { since: centre.digest_through })`; if any rows, send `activity` to `statements_email`, then set `digest_through = maxCreatedAt`. The timestamp advances only after a successful send, so a failed send retries tomorrow and a re-run sends nothing twice. Dry run (`live: false`) computes and reports without sending or advancing.
- Statements, by-hand reminders, pickup reminders: filter to closet-mode centres (they already find nothing for link mode, but be explicit).
- `operator.attentionEmailItems`: link-mode centres are never "new centres to review".

### `virtual-closet/lib/operator.js` and the dashboard
- `listCentres` and `centreDetail` include `mode` and, for link mode, `balance` (from `ledger.balance`) in place of `box`. The dashboard page (`closets.html`/`closets.js`) must render a link-mode centre without erroring: show "link" and the balance where the box column is. No other dashboard work.

### `customer-service/lib/tools/virtualCloset.js`
- New `vc_enrol_centre`: inputs `name`, `notify_email` (required), `slug`, `website`, `logo_url`, `city`, `region`, `country` (default US), `donation_partner_id`, `confirmed` (default false). With `donation_partner_id`, seed name, website, logo, city, region, country from the partner row; explicit inputs override. Preview mode prints the row it would create and the welcome email's recipient; `confirmed: true` creates the centre and sends the welcome email. Same two-step as `donation_partner_create_from_survey`.
- New `vc_redeem`: inputs `centre_id`, `amount_cents`, `order_number`, `note`, `kind` (`redemption` default, or `adjustment`). Prints the balance before and after. Refuses over-redemption with the balance in the message.
- `vc_centres` and `vc_centre`: print mode; for link mode print balance, raised, redeemed, orders, sponsors, codes issued and used, visits (90d), last activity, and the ledger lines with dates instead of boxes.
- Already spread into `allTools`; only new entries.

## Tests (`customer-service/test/virtualCloset.test.js`, plus a new `virtualClosetLink.test.js` if it grows)
- `balance` math: raised, redeemed and balance from a mixed ledger; a `redemption` never changes raised.
- `redeem` refuses over-balance and zero; a repeated call with the same order number inserts nothing (stub the client to raise the duplicate error).
- Tiles map to the unit variant with the right quantity; the cart URL carries `Closet` and `Kind=sponsor` and no `Box` in link mode.
- `linkOnly` renders at zero and with money, without `undefined`, without any banned word (extend the brand test's word list with "box", "shipment", "goal", "request" for the link arrangement).
- `digestActivity` groups only rows after `since`; the daily step advances `digest_through` only when `live` and sends once per centre per run.
- `enrol` from a partner row copies the fields and links `donation_partner_id`; explicit inputs override.
- `welcome`, `activity` and `sponsorThanks` compose in link mode without `undefined`, with the locked sentences, and from the right sender (Jamie for the centre's two, care@ for the sponsor's).
- `/:slug/qr.png` returns a PNG (signature and non-trivial size); the SVG contains the page URL's modules (the package's own `toString` is deterministic, so compare against a freshly encoded string).
- The dashboard handler scan and lazy-require tests stay green.

## Smoke (`virtual-closet/scripts/smoke.js`)
- Add a link-mode pass: enrol a centre in console email mode, fetch the page, follow `/shop` (expects the store discount URL when live, the store when not), call `recordOrder` with a fake paid order carrying a `VC-` code and one with a sponsor line, run the daily job dry, then live, expect one activity email, `redeem` $20, assert the balance.

## Rollout
1. Jamie applies the SQL. Push to main; Railway redeploys the closet service and the webhook server; `npm install` picks up `qrcode`.
2. Enrol a test centre with Jamie's own email (preview, then confirmed). Open the page on a phone from the QR in the welcome email.
3. Place a real $10 sponsor order and a real order through the Shop button (refund both after). Confirm both ledger rows via `vc_centre`.
4. Next day: one digest arrives naming both. `vc_redeem` $5 against the test centre; `vc_centre` shows the balance.
5. Enrol the first centre from their partner row where one exists: The Attic Youth Center (Philadelphia) is the first likely to sign up and is not in the registry, so its fields go in directly; Uniting Pride is in the registry. Retire the test centre with status `left` (existing `setStatus`).

## Out of scope, parked or later
- The 30-day browser attribution window on the store (parked already).
- The store-side closet bar and cart line (`.claude/plans/virtual-closet-theme.md`), not started.
- Any self-serve sign-up. Jamie enrols.
- Any centre-facing view. The email is the view.
- Refund reversal on the ledger: by hand through `vc_redeem` with `kind: 'adjustment'`.
- A subdomain for the service (parked).
