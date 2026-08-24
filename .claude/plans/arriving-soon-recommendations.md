# Arriving-soon recommendations — say it's coming, not that it's here

Design session 2026-08-23. Follows PR #140 (`restockEta`, `worth_offering`) and PR #143
(`waitNote`). Decisions below are founder-locked; open items are marked.

## The defect

The only copy that says "coming in stock soon" is `waitNote` in
`sizingEngine.js` `prescribeSizingResolution`, which is a **dead path** — `walkTree` is
called from nothing but tests (file header, line 7). Customers get Opus writing off
`compare_products`, where:

- `style_switch_options` holds in-stock alternatives only.
- An arriving-soon style lands in a field named `style_switch_unavailable`.
- The prompt never mentions `style_switch_unavailable`, `worth_offering`, or
  `sellable_phrase`, while the leg-cut rule tells the model to confirm the size is
  available before naming a style.

So the model either drops the arriving style or names it in the in-stock register, which is
the only template it has. Same class as "advisor guidance that lives only in the JSON
schema has never shipped".

Compounding: `OPEN_STATUSES` (restockEta.js:21) is `['uploaded','in_transit','partially_received']`.
`partially_received` is not a legal status; `receiving` is legal and missing. KALI-2601 went
to `receiving` on 08-20 and is our only open shipment, so **every restock lookup returns null
today** and the feature is dark.

## Locked decisions

### 1. Fit wording drops the waist clause (founder, 2026-08-23)

    before: "...has a roomier leg opening as it is cut higher, so the thighs get more room
             without sizing up the waist."
    after:  "...has a roomier leg opening as it is cut higher, so there should be more room
             for the thighs."

Supersedes the 2026-08-13 wording ruling. Lead with the roomier opening and give "cut
higher" as the reason — that part is unchanged and still test-enforced.

Dropping "without sizing up the waist" does not lose the tie back to the waist: the model
already writes that as its own sentence (draft 3306: *"Since the waist fits fine, sizing down
would only make the thighs tighter. Instead I'd suggest the Sassy..."*), and the rule's DO NOT
SIZE DOWN instruction is separate from the template.

Every copy of the sentence changes together, or the model picks between two ways of saying
one fact. **Narrower than first scoped:** only the consequence clause moves, and the
product-knowledge lines, the tool description and the `style_switch` notes carry the cut fact
without that clause, so they were untouched. Three sites, not six:
- `aiAdvisor.js` — the CRITICAL leg-cut rule, both the main template and the size-down
  override sentence
- `sizingEngine.js` — `why()` singular + plural
- `sizingEngine.test.js` — asserted the old clause; now asserts the new one AND that the
  superseded clause is gone

### 2. `inbound_shipments` is the restock authority (founder, 2026-08-23)

Where the inbound row and the variant `pre_order_date` metafield disagree, the inbound row
wins for the recommendation decision and for the date we quote.

The metafield stays what it already is: the checkout promise the customer was shown, quoted
by `check_unfulfilled_order` for items already on their order. Two different questions.

**Assumption (not blocking, flag if wrong):** no inbound row means not offerable, i.e. today's
Naomi rule stands. We do not fall back to the metafield to make a style recommendable.

### 3. It is an exchange, not a rebuy (founder, 2026-08-23)

The customer already owns something that does not work. We are not asking them to buy a
pre-order; we are setting up an exchange that waits for stock. At one to two weeks out that
is worth offering FIRST, ahead of an in-stock style that fits worse.

Draft copy:

> The Sassy has a roomier leg opening as it is cut higher, so there should be more room for
> the thighs. It is not in stock in size M right now, but the next shipment should be in end
> of August. I can set up the exchange now and send it as soon as it arrives, or if you'd
> rather not wait I can see what's in stock now.

Hedge the logistics ("should be in"), never the recourse (the unhedged alternative at the
end). Vague phrase only. No em dashes.

## Build items

1. **Prompt template for the arriving-soon case.** A verbatim positive template, plus the
   exclusions: never say "in stock" about an arriving style, and quote only `sellable_phrase`
   — never `eta`, `sellable_estimate`, `days_until_sellable`, `basis`, or `transfer_number`,
   all of which the tool currently hands the model with no rule against repeating them.
2. **Three buckets in `compare_products`, not two.** In stock now / arriving (offerable, with
   phrase) / unavailable. A field named `unavailable` holding something we want offered is the
   ambiguity that causes the collapse. Arriving-soon sorts ahead of a worse-fitting in-stock
   option per decision 3.
3. **Fix `OPEN_STATUSES`** — add `receiving`, drop `partially_received`. One line, but nothing
   above fires without it.
4. **Apply decision 1** across the sites listed.
5. **Delete the legacy `walkTree`/`prescribe*` path** (already parked). Two implementations of
   this wording is how compare_products and sizingEngine diverged the first time.

## Shipped 2026-08-23 — items 1 to 4

Item 5 was deliberately NOT taken. It is a ~1300-line test migration with no customer-visible
effect, and bundling it with a customer-facing copy change would mean a regression could not be
attributed to either half. Parked entry updated with what the delay now costs (the hand-sync of
the dead `waitNote`).

Bucketing was extracted to `styleSwitch.buildStyleSwitchOptions` rather than left inline in the
`compare_products` handler: the handler needs a catalog RPC, a product cache and live config to
exercise, so the ordering rule had no test seam. The pure helper has eight.

## Validation

Scenario test, never live regen (order-state drift). `--repeat 3` minimum; a mixed result is
FLAKY, not a pass. Re-measure the assertions NOT being targeted.

Done: suite 2539/2539. `waistLooseLegsTight` 3/3, plus `productComparisonGrounding` and
`shapingExplanationGating` 3/3 each as the untargeted neighbours. End-to-end against live data
(the Sassy is genuinely zero in M and S today, on KALI-2601, which is sitting in `receiving`):
`compare_products(AJ, M)` returns the Sassy under `style_switch_options` with
`availability: "arriving"` and `back_in_stock: "end of August, 2026"`, while the Naomi — no
inbound at all — stays under `style_switch_unavailable`. At size L the same call returns the
Sassy as `in_stock`. Before the fix the M case returned an EMPTY options list and told the
advisor nothing wider was available.

One thing the suite cannot cover: no pinned scenario exercises the arriving-soon reply itself,
because it needs a style that is out of stock with a live inbound, which is a transient state of
the world. Worth adding a scenario with a stubbed availability payload if this recurs.

## Memory delta when this ships

Rewrite the 2026-08-13 tight-legs Key Decision in `domain_cs.md` for the new wording and
add the restock-authority ruling. Close or narrow the parked entry "Advisor rule 7 promises a
restock date compare_products cannot return".
