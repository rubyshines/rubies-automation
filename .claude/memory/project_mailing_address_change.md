---
name: Mailing Address Change
domain: cross-cutting (tech, marketing, logistics, finance, b2b_sales)
done_when: Every checklist item below is checked [x] or explicitly marked N/A, and both old addresses no longer appear in any system.
created: 2026-09-01
---

# Mailing Address Change — Tracking

Jamie is making these changes manually. This file is the checklist.

## The addresses

**NEW (use everywhere):**
> RUBIES
> c/o The Fashion Zone
> 44 Gerrard Street East
> Toronto, ON M5B 1W7

**OLD addresses to hunt down (two in circulation):**
1. `175 Robina Ave, Toronto, ON M6C 3Y9` — home address; currently in Shopify
2. `110 Bond St, Toronto, ON M5B 1X8` — old Fashion Zone location; currently in Klaviyo footer + an inactive Shopify location

When checking any system, search for **both**.

## Already verified clean (2026-09-01 audit)

- [x] Shopify legal policies (privacy, refund, terms, shipping, contact) — no address present
- [x] Shopify pages — no address present
- [x] Website theme — no address hardcoded
- [x] Automations codebase — no RUBIES address hardcoded anywhere (returns route to donation-partner addresses, never ours)

## Shopify

- [ ] **Store address** — Settings → General. Currently `175 Robina Ave`. Feeds order confirmations, packing slips, and invoices, so this one change fixes several surfaces at once.
- [ ] **Location "Downtown Toronto"** — inactive location still holding `110 Bond St`. Update or delete (Settings → Locations).
- [ ] **Billing address** — Settings → Billing (separate from store address).
- [ ] **Shopify Payments business details** — Settings → Payments → Manage. Business address on file for payouts/KYC.
- [ ] **Tax registrations** — Settings → Taxes (GST/HST registration address if listed).
- [ ] **Notification templates** — Settings → Notifications. Most use the shop-address variable (auto-fixes with store address), but scan any customized templates for a hardcoded address.
- [ ] **Markets / Managed Markets legal entity info** — if international paperwork pulls a merchant address from Shopify.

## Email & customer-facing

- [ ] **Klaviyo account contact address** — currently `110 Bond St, M5B 1X8`. This is the CASL/CAN-SPAM footer on every marketing email. Settings → Organization → Contact information. Also search Klaviyo templates for any hardcoded footer address (search "Bond").
- [ ] **Klaviyo signup forms / flows** — any that display the address (rare, but scan).
- [ ] **Gmail signatures** — jamie@, care@, support@rubyshines.com. Also any saved canned replies.
- [ ] **Gorgias** — signatures, macros/templates, auto-replies.
- [ ] **SendGrid verified sender identity** — dashboard → Sender Authentication. Physical address is required on the verified sender.
- [ ] **CS knowledge base entry** — "The RUBIES Toronto studio is near Dupont and Davenport." Decide: is the studio location also changing to The Fashion Zone? Update or retire the entry either way (it's already stale — the newer reference says Oakwood & St Clair).

## Logistics

- [ ] **Warehance/Nitro** — (a) billing/account address, (b) **return-to address printed on outbound shipping labels** — confirm with Nitro what return address labels carry and where undeliverable domestic packages go.
- [ ] **Passport** — importer/merchant address for international shipments and undeliverable-mail returns.
- [ ] **Suppliers** — ship-to for samples/documents and billing address on production orders: Kali, Pigeons & Thread, Wumes, Harry (CLH Express/SG International), QC inspector Joyce. Next production-order email should carry the new address.
- [ ] **Canada Post mail forwarding** — set up forwarding from 175 Robina Ave (and confirm nothing still routes to 110 Bond St).

## Finance / legal / registrations

- [ ] **QBO company address** — appears on invoices and estimates.
- [ ] **CRA** — business address on the CCPC (My Business Account); GST/HST account address.
- [ ] **Corporate registry** — registered office address (Ontario/federal, whichever applies); loop in accountant/lawyer if they file it.
- [ ] **Bank + credit cards** — business account statements/cards mailing address.
- [ ] **Insurance** — business policy address (also matters for coverage location).
- [ ] **Wholesale invoices** — draft orders render the Shopify shop address, so auto-fixed by the store-address change; spot-check the next wholesale invoice.

## Web presence / directories

- [ ] **Google Business Profile** — if one exists for RUBIES.
- [ ] **Google Merchant Center** — business information address (shopping feed).
- [ ] **Meta Business Manager / Instagram + Facebook shop** — business info address.
- [ ] **Domain registrar (rubyshines.com)** — registrant/WHOIS address.
- [ ] **Judge.me, Smile, other app accounts** — billing profiles (low priority, usually just card billing).
- [ ] **Retailer-facing docs** — line sheets, wholesale terms, any PDFs/decks that carry the old address.

## Before closing

- [ ] Final check: search Shopify, Klaviyo, and both repos for `Robina`, `M6C 3Y9`, `Bond St`, `M5B 1X8` — all clean. (Ask Claude to re-run this sweep.)
- [ ] Confirm a test marketing email footer and a test order confirmation both show the new address.
