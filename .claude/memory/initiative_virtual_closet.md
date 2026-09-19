---
name: Virtual Closet
description: A page in each LGBTQ+ centre's name where its community buys, asks and gives, and RUBIES matches every dollar
type: initiative
domains: [community, b2b_sales, marketing, tech]
last_updated: 2026-09-19
---

## Goal
Turn LGBTQ+ centre partnerships into a revenue channel that also stocks their closets: each centre gets a Virtual Closet page; its community buys with an automatic discount on one order, applies for free pairs, or sponsors the closet; everything lands in one box that RUBIES matches dollar for dollar. Grew out of the retailer affiliate idea, redirected at orgs after the Uniting Pride call (2026-09-11). Full record and every decision: `.claude/plans/org-closet-programme.md` (read its "Where things stand" summary first).

## Phases
1. Design — done September 2026 (four discussion sessions; record in the plan file)
2. Prototypes for centre conversations — done: centre's page, programme page with terms, one-screen brief, nine-slide deck (all on branch `wt/closet-prototype`, `prototypes/`)
3. Detailed spec / project file — done (`project_virtual_closet.md`)
4. Build at low fidelity — done 2026-09-18: public pages, centre accounts and view, requests, money, boxes, operator section in the CS dashboard, emails, daily job; deployed as its own Railway service
5. Pilot — Uniting Pride first (Pride Fest October 2026), then 3-5 standing-closet partners
6. Widen — more centres, campus resource centres as a second wave, partner brand (trans-masc-only) if one fits

## Current Status
- **2026-09-18 — Built and live at low fidelity.** Claude Design produced 43 lo-fi wireframes from the brief; the app was built from them in one session and passes an end-to-end smoke test against real data and the real store objects (hidden "Sponsor a closet" product, "Virtual Closet 20%" discount). Next: Jamie's own click-through, then Uniting Pride as the first centre.
- **2026-09-19 — Hi-fi pass done.** Every user-facing surface (public pages, the centre's private view, the emails) is in the rubyshines.com design system: the store's fonts, colours, square buttons, product photography and wordmark. The operator side stays in the CS dashboard's own look. Guarded by `customer-service/test/virtualClosetBrand.test.js`.

Terms as of 2026-09-18: 20% off one order per customer, existing customers included, applied automatically (hidden single-use discount per click, no code shown); 25% of each order into the centre's box; sponsors and the centre's own budget into the same box, matched 1:1; box target set by the centre with a $300 floor, goal grows to cover everyone approved, centre decides past the goal; free pairs approved automatically within centre-set limits and placed in the open box until the centre sends it, auto-swap if out of stock, final; $15 per shipped package charged to the box; menu of five styles (AJ, Charlie, Sassy, Brooke, Ruby). Language is matching, never discount. Uniting Pride has agreed to be first.

## Decisions Made
- 2026-09-18 — Stage 1 review applied to the app (record: `.claude/plans/virtual-closet-handover/virtual-closet-stage1-review.md`). Two rule changes: an approved request always joins the open box and the goal grows to cover it (the wait list only ever held requests made against a funded box the centre had not sent, which stranded them; sending opens the next box so later requests land there); and the request form offers each style its own size run (AJ, Charlie, Brooke and Ruby run in kids numbers then L to 3X, with XS, S and M meaning the 12, 14 and 16 on the shelf; Sassy runs XS to 4X). The 30-day attribution line came off Home and Offer details until the theme script exists (parked).
- 2026-09-18 — Sign-up is self-service with the operator approving after; the donation programme is called Pass It On; sizes are the store's (no XL); the 20% is once per customer, new or returning; add-to-the-box is paid on the spot; ordering outside the box stays by email; the operator side lives in the CS dashboard; accounts are the service's own tables.
- 2026-09-16 — No visible code: the discount is applied at checkout from the centre's link; a 30-day browser window from the link credits later orders to the closet (credit only). First order only for both discount and credit. Superseded 2026-09-18: one order per customer, existing customers included.
- 2026-09-16 — One box open per centre, sequential; goal is the larger of the centre's target and the cost of approved requests; wait list for the shipment after; centre chooses send-now past the goal. No time-based auto-ship.
- 2026-09-16 — Requests carry the name they go by, items, pickup or ship (address collected for shipping, held by RUBIES only), a sentence on what a pair would mean, and an opt-in to share it anonymously.
- 2026-09-16 — Box menu limited to the five highest-margin, deepest-stock styles; gaff, Stella and basic chest pads excluded (negative or thin at the matched price).
- 2026-09-14 — Virtual first; the physical lobby stand and serialised kits are parked behind the virtual programme.
- 2026-09-14 — Orgs will not maintain a tool: the page runs on RUBIES data; the centre's jobs are share the link, set limits, fill the box.
- 2026-09-14 — Sponsorship is a product sale, not a donation, and there is no wallet; money in a box is matched, never held for a named person.
