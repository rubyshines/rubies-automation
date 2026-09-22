# Virtual Closet on rubyshines.com: the store-side plan

- **Domains:** community, marketing, tech
- **Initiative:** Virtual Closet
- **Status:** DISCUSSED 2026-09-19, revised 2026-09-22 for the minimal cut and Jamie's decisions that day. Not started. Decisions are marked; open questions at the end.
- **Companion:** `.claude/memory/initiative_virtual_closet.md`. The programme record is `.claude/plans/org-closet-programme.md`.

## Why the store has to know anything

The closet page lives on closet.rubyshines.com; the shopper buys on rubyshines.com. Today the store knows nothing about the closet: the 20% rides in Shopify's cart as a hidden code, the cart shows that raw code, and the ledger only learns which centre an order belongs to by reading the code off the finished order. Four jobs for the store side:

1. **Tell the shopper** they are shopping for a centre, and what that does (the closet bar).
2. **Carry the centre onto the order** when there is no code (attribution), so the centre is credited on the orders that matter most: the person who came back later, and the returning customer whose one 20% is used up.
3. **Be honest on the cart** about the discount, including when it is already used, and about what the centre gets.
4. **Say it again in the order confirmation email**: what went to the centre.

## What already exists (as of 2026-09-22)

- One Shopify discount, "Virtual Closet 20%", once per customer. Every tap on Shop or on a style mints a code on it (`VC-<SLUG>-<hex>`) and redirects to the store's discount URL, landing on the product when a style was tapped.
- The Shop route sets a cookie `vc_shop=<slug>|<code>`, 30 days, script-readable, on `.rubyshines.com` once the service answers there. A second tap on the same device reuses the code while it is unused. **This cookie is the store's only signal that a shopper came from a closet link.**
- The orders webhook credits the centre a quarter of the post-discount subtotal when the order carries a `VC-` code, and a sponsor line's face value when it carries one.
- The hidden "Sponsor a closet" product; tiles are cart permalinks with `Closet` and `Kind` cart attributes.

## Prerequisite: closet.rubyshines.com

The cookie is only readable by the store when it is set on `.rubyshines.com`, which needs the closet service answering on the subdomain (custom domain on Railway, DNS at domain.com; `reference_deployment.md` has the state). Until then nothing here can be tested end to end.

## Rule one: nothing shows unless they came from a closet link (Jamie, 2026-09-22)

Every surface below is gated on the `vc_shop` cookie or a closet cart attribute. A shopper who typed rubyshines.com sees the store exactly as today: no bar, no cart line, no message. The cookie is read only by the theme script; Liquid cannot see cookies, so the script writes what Liquid needs into cart attributes (below), and the cart snippets key on those.

## The closet bar

**Decisions.** A slim bar under the announcement bar, every page, filled by script from the cookie. Dismissible with an x for the session; it returns on the next visit while the cookie lives. It names the centre the ledger will credit for this cart.

| Scenario | What the store knows | Bar copy |
|---|---|---|
| A. Arrived from the link, code in the cart | cookie, `VC-` discount in the cart | "You're shopping for [Centre]'s Virtual Closet. 20% off is applied at checkout, and a quarter of your order goes to the closet." |
| B. Came back within 30 days, no code in the cart | cookie only | "Still shopping for [Centre]'s Virtual Closet. A quarter of your order goes to the closet." (Open: whether to offer "Get your 20% off" here.) |
| D. Their 20% is already used (see below) | cookie plus a used signal | "Your Virtual Closet 20% was used on an earlier order. A quarter of this order still goes to [Centre]'s closet." |
| E. Sponsoring (a sponsor line in the cart) | `Closet` and `Kind=sponsor` attributes | "Sponsoring [Centre]'s Virtual Closet." |
| F. No cookie, no closet attribute | | Nothing. The store as today. |

The customer-year variant (C) from the 2026-09-19 draft is dropped from this table; see the open question on the year.

**Centre names.** The cookie carries the slug and the code; the name comes from a small `closets.json` asset the daily sync publishes on the theme (slug, name, active), the way it publishes `wholesale-pricing.json`, republished on enrol, rename and leave. (Alternative: put the name in the cookie too and skip the asset. Decide at build; the asset is also what the confirmation email needs.)

## The cart drawer and cart page

Shopify already lists the discount by title and code in both. Two changes and one new line, all gated on rule one.

- **The discount line.** When the code starts with `VC-`, show "20% off, shopping for [Centre]'s Virtual Closet" instead of the raw code.
- **The closet line**, under the totals: "A quarter of this order, $X, goes to [Centre]'s Virtual Closet, and RUBIES matches it." X is a quarter of the cart total after the discount, excluding sponsor lines, which mirrors the ledger. A Liquid snippet over `cart.attributes`, so Dawn's cart re-render keeps it current. If the cart holds only sponsor items: "$Y goes to [Centre]'s Virtual Closet, and RUBIES matches it."
- **The used-discount message** (Jamie, 2026-09-22: on the cart, never by email). Shopify only checks once-per-customer at checkout, after it knows the email, and the theme cannot strip a code from the cart, so we explain rather than remove. Three cases, all showing the same line as bar variant D:
  1. **Same device.** The cookie's code was used (the webhook set `order_id` on its row). The script asks the closet service `GET /api/code/<code>` and gets `{ used: true }`.
  2. **Signed-in customer, any device.** When an order with a `VC-` code lands, the orders webhook tags the Shopify customer `closet-discount-used`. The cart snippet reads `customer.tags`; no script call.
  3. **Guest who typed their email at checkout, then came back to the cart.** The storefront never sees a checkout's email, but Shopify's `checkouts/create` and `checkouts/update` webhooks carry `email`, `cart_token` and the discount codes. New handler on the webhook server: when a checkout carries a `VC-` code, look up whether that email already has a credited closet order, and record `(cart_token, used)` on the closet service. The script reads the cart token from `/cart.js` and asks `GET /api/cart/<token>` the same way as case 1. Verify at build that the checkout webhook's `cart_token` matches the Ajax cart's `token`, and how long the webhook lags the email step.
  Until any of these fire, a guest carrying a code sees the plain hedge on the closet line: "One per customer; checkout will say if you've used yours."

## Attribution plumbing (settled 2026-09-19, revised 2026-09-22)

1. **Cookie.** `vc_shop=<slug>|<code>` set by the Shop route (done). Add the tap timestamp as a third field so the 30-day window is measured from the tap, not from whenever the store next sees the cookie.
2. **Theme script** (`assets/global-custom.js`): read the cookie; whenever a cart exists or changes (Dawn's cart-update event), write cart attributes `Closet: <slug>` and `Closet since: <timestamp>` if not already set. Attributes land on the order as note attributes. This is what makes "a quarter still goes to the closet" true when Shopify strips a used code: without it, an order with a rejected code carries nothing and the ledger credits nothing.
3. **Ledger, code-less orders:** if the order has a closet note attribute, no `VC-` code and no sponsor lines, and the timestamp is within 30 days, credit a quarter of the subtotal. Precedence per order, one credit only: code, then note within 30 days, else nothing.
4. **Reconcile:** the order mirror has no note attributes, so the daily reconcile fetches them by GraphQL only for code-less orders from the last two days.
5. **Copy back on:** the 30-day line returns to the welcome email and the page.

## The order confirmation email (Jamie, 2026-09-22)

Shopify's Order confirmation notification is a Liquid template that can read the order's discount codes and note attributes. When the order carries a `VC-` code or a `Closet` attribute, add one line after the totals: "RUBIES donated $X to [Centre]'s Virtual Closet." X is a quarter of the discounted subtotal, computed in Liquid; for a sponsor-only order, "$Y went to [Centre]'s Virtual Closet." The centre's name needs to be on the order or in a shop-level lookup, since the template cannot fetch: the simplest is a third cart attribute `Closet name`, written by the theme script from `closets.json` (or from the cookie if the name goes in it). Edit the template in Shopify Admin (Settings, Notifications, Order confirmation); keep a copy of the added block in `rubies-ecom-v4` so it is not lost when the template is next touched.

## Scenarios, end to end

| The shopper | Bar | Cart | Credit |
|---|---|---|---|
| Taps Shop or a style, buys now | A | 20% applied, closet line | Code. |
| Taps, leaves, buys 10 days later on the same device via Google | B | Closet line, no 20% | Note attribute. |
| Taps on a phone, buys on a laptop with the same email, first time | F | Nothing | Nothing on that order. Accepted. |
| Used the 20% before, taps again, same device | D | Used message, closet line | Note attribute after Shopify strips the code. |
| Used the 20% before, signed in, any device | D | Used message, closet line | Note attribute. |
| Used the 20% before, guest, new device: types email at checkout, comes back | D once the checkout webhook has landed | Used message | Note attribute. |
| Sponsor tile | E | Sponsor line | Sponsor line item, as today. |
| Typed rubyshines.com, no cookie | F | The store as today | Nothing. |

## Where it lives

- Theme (`rubies-ecom-v4`, Dawn-derived): `sections/closet-bar.liquid` (new, under the announcement bar in `header-group.json`); `assets/global-custom.js` (cookie read, cart attribute write, bar fill, dismiss, the two used-code lookups); `snippets/closet-cart-line.liquid` (new, rendered in `snippets/cart-drawer.liquid` and the cart page totals); the discount-line override in the same two places; `locales/en.default.json`; `assets/closets.json` published from rubies-automations.
- Closet service: `GET /api/code/:code` and `GET /api/cart/:token` (CORS for rubyshines.com, no secrets, answers `{ used }` only); the checkout-token table.
- rubies-automations: `checkouts/*` webhook subscription and handler; customer tag on a credited order in `webhooks/handlers/shopifyOrders.js`; note-attribute path in `virtual-closet/lib/ledger.js`; `closets.json` publish step beside the wholesale pricing page.
- Shopify Admin: the Order confirmation template block.

## Build order

0. Subdomain answers on https (in progress, DNS).
1. Closet service: timestamp in the cookie; `closets.json` publish; the two lookup endpoints; checkout-token table. Small.
2. rubies-automations: note-attribute path and reconcile window; customer tag on credit; checkouts webhook handler. Half a day.
3. Theme: script, bar, cart snippet, discount-line override, locale strings, on a preview theme. About a day, most of it testing that the attribute survives the discount redirect and checkout.
4. Order confirmation template block.
5. Real-browser tests: Safari and Chrome, a guest and a signed-in customer, one real order per row of the scenarios table, then reconcile.

## Open questions for Jamie

- The customer year (a year of code-less credit after a first closet order, with customer tags and a year table) was in the 2026-09-19 draft and is not in the terms locked on 2026-09-21. Recommendation: drop it for the pilot; the 30-day window is the whole story.
- Bar variant B: offer "Get your 20% off" even though we cannot tell whether they have used it, or leave that to the closet page?
- Dismiss the bar for the session, or for the day?
- Rename the discount title from "Virtual Closet 20%" to "Closet 20%" so the fallback line reads well?
