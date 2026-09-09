# B2B Retailer Outreach

Turn the retailer channel back on, on the rails the org channel proved: locked
templates, fixed A/B subjects, nightly drafting, one review sitting, the automatic
follow-up ladder, and a vetted supply of new stores behind it.

- **Domain:** b2b_sales
- **Initiative:** B2B Expansion (Phase 3, active outreach)
- **Drafted:** 2026-09-08
- **Status:** Phase 0 done 2026-09-09 (Kickbox live, sweep run, She Bop order matching fixed). Phase 1 build shipped 2026-09-09 (both templates locked, samples override the age rule, fixed A/B subjects shared across channels); vetting and the first sends next. Decisions still open: affiliate build, vetting panel timing, unattended sends after round 1. (see the end)

---

## Where the retailer channel actually stands (2026-09-08)

The queue for the wholesale channel is **empty**, and it is empty by construction,
not because nothing is owed.

**The book:** 56 retailer rows in `b2b_companies`.

| State | n | What they are |
|---|---|---|
| active | 6 | Tuck and Bind, Sock Drawer Heroes, underDARE, Early To Bed, Transting, The Tool Shed. Reorder cadence covers them. |
| in_contact | 43 | Every retailer we have contacted that never ordered and never declined. **None vetted, no next-action date, so invisible to every queue branch.** |
| lost | 5 | Four sampled Nov 2025 and declined; stay lost. |
| prospect | 2 | Never contacted, never vetted. |

**Inside the 43 in_contact rows:**

- **13 sampled and silent.** Sample kits shipped 2025-11-04 as $0 orders, an apology-plus-intro on 12 Nov, a wholesale pitch on 18 Feb 2026 (50% off, free shipping, $300 floor). No reply from any of them except Grail Bra, who said the samples "looked great" on 15 Nov and went quiet after two chases. Clair de Lune has a Gmail address and no imported thread at all.
- **~22 intro-only and silent.** The 17-18 Feb 2026 batch: a wholesale pitch by email, no samples, no reply, `no_response_count` 2.
- **~6 with a reply on record** (Come As You Are, The Quilt Bag, A Women's Touch, The Smitten Kitten, As You Like It, Witch Bitch Thrift). Case by case, read before touching.
- **Two special cases.** Hello Gorgeous declined inventory in Feb 2026 and **accepted an affiliate arrangement** (10% off for referred customers, 15% commission) that was never delivered because the program was never built. That is an owed conversation, not a lead. She Bop is a paying customer (three POs since April 2026) but `order_count` is 0 on the row, so the orders mirror is not matching her orders to the company; she reads as in_contact.
- The Bra Room is paused by hand.

**Why nothing surfaces:** the samples check-in only fires inside 60 days of the
samples event; `re_approach` and the Tier-4 first touch both require `vetted_at`;
the automatic ladder only chases engine sends. Every one of these rows was worked
in Gmail before the engine existed, so the engine owes them nothing until a human
admits them. That was deliberate (2026-08-05), and the admission never happened
because the panel has no keep/drop control (parked, lead-supply plan phase 2).

**One rule that would misfire the moment we vet them:** the 2026-09-08 six-month
rule says pre-engine contact older than 183 days is a *fresh intro*. Every row in
the Feb batch is now 200+ days old, so vetting a store we shipped a sample kit to
would queue it a cold "I came across your store" intro. Right for a 2022 donation
enquiry from an org; wrong for a store holding our samples. Samples have to override
that rule (Phase 1).

**The cold intro is not on the locked-template treatment.** `intro_pitch` is
deliberately absent from `INITIATING_TYPES` ("until the locked template treatment
reaches retailers"), so nothing drafts it nightly, it has no A/B variants, and the
model still writes the subject. The org side has all three since 2026-09-02.

**New supply exists and is disconnected.** `retailer_prospects` holds **119
qualified retailers** (score 5+, researched June 2026) and **0 of them are in
`b2b_companies`**. There is no importer: the pipeline ends at a Google Sheet, and the
56 rows we have were hand-imported from the old contacts sheet. Behind the 119 sit
**416 rows that passed the Haiku pre-filter and were never researched**. Contact
quality in the discovery table is poor enough to matter: image filenames stored as
emails, `user@domain.com` placeholders, a font vendor's address on a boutique.

**Address verification is built and not live.** Kickbox probing exists in code
(2026-08-28) but `KICKBOX_API_KEY` is not set and the migration has not run. The
last round that went out unverified bounced at 12%.

**Org A/B round 1 is in flight, no read yet.** 23 org intros sent on the fixed
subjects (11 A / 12 B) on 2 Sep and 8 Sep. Zero replies so far, which means nothing
before the 14-day window closes on 22 Sep. There is no report; today the read is a
query.

---

## What transfers from the org channel, and what does not

**Transfers as-is** (already channel-agnostic in code): the queue and tiers, the
vetting gate (`b2b_triage` keep/drop), the nightly Initiating Drafts pass, the
follow-up ladder (5 then 10 business days, fixed text, unattended, retires the lead
at the end), bounce recovery, thread discovery, relationship summaries, the
composer templates and On Me. The ladder is the answer to "can we chase them
automatically": yes, the moment the re-approach is an engine send.

**Transfers with a port:** the locked-template intro with one model-filled slot,
the fixed A/B subjects rendered by code (`INTRO_SUBJECTS` is org-only and keyed on
`intro_outreach`), the variant assignment in `draftAllDue` (also org-only), and
Sonnet for initiating drafts.

**Does not transfer:** the call-first onboarding. Retailers close async by email
(sales prompt, from real threads). The retailer post-samples motion is samples,
delivery-triggered check-in, their internal review clock, first-order check-in.

---

## Design decisions

**D1 — Samples override the stale-history rule.** A company with
`samples_shipped_at` set never gets a fresh intro from the re-admission branch;
it gets `re_approach`. The kit is the door. Everything else about the six-month
rule stays as it is for orgs and for intro-only retailers.

**D2 — Two retailer initiating templates, both locked, both nightly-drafted.**
`intro_pitch` (never sampled) and the retailer `re_approach` (sampled, or a
conversation that lapsed). Same treatment as the org intro: verbatim body, one
model-filled why-this-store slot, fixed subject by A/B. `intro_pitch` joins
`INITIATING_TYPES`. Bodies are Jamie's to lock, line by line, from his own sent
mail, not the model's register. Drafts are review work, never click-to-generate.

**D3 — One ask in a cold email: the free sample kit.** Not "carry our line", and
not "carry our line or join the affiliate program". Nobody is asked to commit to
inventory in the intro; the kit is what they say yes to. The carry-versus-affiliate
fork happens after samples, in conversation, which is where the affiliate door is
opened (`track_transition` already exists in the sales prompt for exactly this).
Two doors in one cold email dilute the single ask (one CTA per email is a standing
rule) and the Feb 2026 batch that led with wholesale terms got zero replies from
~32 stores, while the samples-led approach is what converted She Bop and The Tool
Shed. Thin evidence, but it points one way. If Jamie wants the two-door framing
tested, it runs as a **body** A/B in a later round, one variable at a time, and only
once the program exists.

**D4 — The affiliate program is built before it is ever mentioned again, and it
is built because it is owed.** Hello Gorgeous accepted an affiliate arrangement in
February and got nothing. The prompts were corrected in August to stop offering a
program that did not exist; the fix is to make it exist, minimally, not to keep
apologising for it. Minimum: install the app, one deterministic
`affiliate_onboarding` composer template, `program_flags.affiliate` set on enrol,
first affiliate is Hello Gorgeous. No commission tuning, no cadence types, no
performance check-ins in v1. The design chose GoAffPro (~$24/mo, handles mixed
individuals and companies, bank-transfer payout); Shopify Collabs is the zero-cost
alternative if the mixed-entity requirement has softened.

**D5 — Retailer subject A/B uses the same mechanism, generalised.** Variants
become a per-channel table keyed on the first-touch type, assignment alternates
from the historical count exactly as orgs do, and the assigned string overrides
the model's. Measured the same way: reply within 14 days by variant, bounces
excluded, cumulative across rounds. Round sizes here are n≈20-30, so the first
read is directional; the design is to keep accumulating, not to declare a winner.

**D6 — A/B has a report, not a query.** One console tool (`b2b_ab_report`)
over `b2b_drafts` + `b2b_messages`: per message type and variant, sends, bounces,
replies inside 14 days, reply rate. Cheap, and it is what makes D5 an operating
layer rather than a one-off. Discharges the parked "A/B variant evaluation loop".

**D7 — New supply enters as `prospect`, unvetted, through one importer with
deterministic hygiene.** `retailer_prospects` (status `qualified`) → `b2b_companies`
with `source: 'discovery'`, domain-deduplicated at intake (fixing the parked
"nothing stops duplicate rows" entry in the same motion), the discovery
`outreach_angle` and subcategory carried into `enrich_facts` so the why-this-store
slot has something true to say. The email is kept only if it parses as an address
and its domain is not on the `emailDomains.js` denylist; otherwise the row carries
`contact_form_url` or is marked `no_contact` and skipped rather than shown. Kickbox
verifies on entry (already wired into `addProspect`).

**D8 — Vetting gets a panel surface.** The console tool works, but 119 rows now
and an ongoing flow later is not a console job. A Vetting sidebar mode: prospect
rows with `vetted_at` null, each showing name, subcategory, city, website, the
discovery angle, contact status; keep / drop with reason; keyboard-driven. It calls
the existing triage endpoint. Retailers and orgs are batched separately (the
channel filter already exists).

**D9 — Review before send for round 1, unattended later.** The re-approach and
intro bodies are fixed text, which is the standard the ladder meets for unattended
sending. What is not yet trustworthy is the address book: Kickbox has never run.
Round 1 of each cohort is one review sitting in the panel. Once Kickbox is live and
a round has gone out clean, initiating sends on locked templates can move to the
ladder's scheduled, guarded, mid-morning path.

---

## Phases

### Phase 0 — Address hygiene (prerequisite, cheap)

- **Jamie:** create the Kickbox account, put `KICKBOX_API_KEY` in `.env` and Railway.
- Run `customer-service/migrations-2026-08-28-b2b-email-verification.sql`.
- `node scripts/verifyB2bAddresses.js --live` (~281 addresses, ~$3). Retire or repoint the undeliverables before any retailer send.
- Fix She Bop's order matching so she reads `active` (the mirror is not matching her orders to the company row; find which email the POs were placed under and add it as a contact).

**done_when:** every active contact on a retailer row has a verification row; She Bop shows 3 orders.

### Phase 1 — Re-approach the retailers we have already contacted (the fastest real result)

The 13 sampled-and-silent stores plus the ~22 intro-only Feb batch. Not Hello
Gorgeous (Phase 4), not the six with replies (operator reads and writes those), not
the four lost.

1. **Lock the two templates with Jamie**, line by line. Proposed bodies and subject pairs are in "Emails by case" at the end of this file.
2. **Cadence:** D1 (samples override the stale-history rule). `intro_pitch` into `INITIATING_TYPES`. Retailer `re_approach` and `intro_pitch` routed to the locked template in `generateDraftForCompany`, the same way the follow-up rungs are. Tests: a sampled in_contact retailer vetted today yields `re_approach`; an intro-only one older than 183 days yields `intro_pitch`; orgs unchanged.
3. **Sales prompt:** replace the freeform `intro_pitch` and `re_approach` openers with the locked bodies and slot rules, mirroring the community prompt's `intro_outreach` block. Grep the prompt for the old lines in the same change.
4. **Subjects:** two fixed subjects per template (Phase 2's mechanism, needed here first). Proposed pair for the re-approach, one variable (store named vs not): A "Your RUBIES sample kit from last fall, [store]" / B "How did the RUBIES samples fit?". Jamie locks.
5. **Vet the cohort** in one sitting (panel vetting mode if Phase 3 has landed, otherwise a printed list plus `b2b_triage` keep/drop from the console). Drop anything that is not a fit on a second look.
6. **Nightly pass drafts them; Jamie reviews and sends in one sitting**, staggered by the daily cap. The ladder chases each unanswered send at 5 and 15 business days and retires the lead at the end. Nothing further to do by hand.

**done_when:** every kept row in the cohort has an engine send, the ladder is running on them, and the A/B report shows the round.

### Phase 2 — Cold intro on rails, plus the A/B read

1. Generalise `INTRO_SUBJECTS` to per-type variant tables (`intro_outreach`, `intro_pitch`, retailer `re_approach`), assignment in `draftAllDue` keyed on type rather than hard-coded to orgs, override applied for any typed variant. Tests: alternation per type from historical counts, byte-identical subjects.
2. `b2b_ab_report` console tool (D6). Read round 1 of the org test with it on 22 Sep.
3. Vet the two existing `prospect` retailers and send their intros as the first cold retailer sends on the template.

**done_when:** a cold retailer intro drafts nightly with a fixed A/B subject, and the report answers "reply rate by variant" for both channels.

### Phase 3 — New supply: import, vet, research

1. **Importer** `scripts/importRetailerProspects.js` (dry-run default, `--execute`): D7. Run over the 119 qualified rows; report kept / no-contact / duplicate.
2. **Panel vetting mode** (D8), wired to the existing triage endpoint. Static handler test covers the new buttons.
3. Jamie vets the imported cohort. Kept rows reach Tier 4 and draft nightly on the Phase 1 template.
4. **Research the 416 pre-filter survivors**: `node b2b-discovery/researchSurvivors.js --execute` in batches; re-run the importer for new qualifieds.
5. Later, not now: Tier 3 custom searches and a scheduled discovery run. Only worth it once the 119 + 416 are worked and the reply rate says the channel converts.

**done_when:** the retailer queue is fed from discovery without a spreadsheet in the loop, and a qualified prospect goes from discovery table to sent intro with exactly one human decision (vet).

### Phase 4 — Affiliate program minimum (decision D4)

1. Install the app (GoAffPro per the design, or Collabs if the requirement has softened). Jamie's call and Jamie's install.
2. `affiliate_onboarding` composer template (deterministic: first name, store, signup link, the two-line terms). `program_flags.affiliate` set when they enrol.
3. Lift the "does not exist" lines from both advisor prompts and restore the reactive `track_transition` offer, reactive only: a store that has samples and says it cannot hold inventory. Never in a cold intro (D3).
4. First affiliate: Hello Gorgeous, operator-written from the February thread, then the template.

**done_when:** one affiliate is live with a code that attributes an order, and the prompts describe the program as it actually works.

---

## Sequence and effort

Phase 0 is an afternoon and mostly Jamie's account setup. Phase 1 is the
highest-value build: one cadence rule, two templates, a prompt edit, the subject
generalisation pulled forward, then a review sitting. Phase 2's report is small.
Phase 3 is the largest (importer plus a new panel mode). Phase 4 is small in code
and is gated on the app decision.

Recommended order: 0 → 1 → 2 → 3 → 4, with Phase 4's Hello Gorgeous conversation
handled by hand earlier if Jamie wants to stop carrying that debt.

## Decisions Jamie needs to make

1. **The hook** for the sampled re-approach (what is new since February), and the final template wording for both retailer templates and both subject pairs.
2. **Affiliate:** build the minimum now (Phase 4) or keep the program non-existent. Recommendation: build it; it is owed to Hello Gorgeous and it is the only honest answer to "can't hold inventory".
3. **Cold intro offer:** single ask (samples) as designed in D3, or two-door. Recommendation: single ask; two-door only as a later body A/B once the program exists.
4. **Vetting surface:** build the panel mode (D8) before vetting the Feb cohort, or vet those ~35 rows from the console now and build the mode for the 119. Recommendation: console now for Phase 1, panel mode in Phase 3.
5. **Unattended sending** for locked-template initiating rounds after round 1 goes out clean (D9), or every round stays a review sitting.
6. ~~The daughter in the retailer opener~~ **Closed 2026-09-08:** one clause, as written in the templates. These stores were selected for trans and LGBTQ+ signals, so she is the credibility that this is not a generic supplier; the full story (age, transition) stays org-only, where mission is the point.

## Parked entries this plan touches

- *The 51 manual-send threads nobody answered* — Phase 1 is the retailer half of that decision (re-approach, via vetting). The org half stays parked.
- *Bulk address verification across b2b_contacts* — Phase 0 closes it.
- *B2B lead supply — remaining plan phases* — Phase 3 builds phase 2 (vetting UI) and the discharge of phase 5 is Phase 0 plus the existing daily cap.
- *Nothing stops duplicate company rows re-appearing* — the importer's intake dedupe (D7) fixes it.
- *Unified B2B Outreach — unbuilt remainder* — Phase 4 is the affiliate onboarding item; Phase 2's report is the A/B evaluation loop.
- *Gmail historical backfill has never run* — not required by this plan, but the retailer reply-rate baseline stays unknowable until it runs.

---

## Emails by case (proposed, for Jamie to lock)

Slots in brackets are the only variable parts. Everything else is byte-identical across sends.

### Case 1 — sampled last November, never replied (13 stores)

Subjects (A/B, one variable: whether the samples are mentioned). Both state what
RUBIES makes, because ten months on the kit may have gone to whoever handled the
inbox that week, and a subject that assumes they remember it reads as spam to
anyone who does not (Jamie, 2026-09-08):
- A: `Gender-affirming underwear and swimwear for trans women and girls, wholesale from RUBIES`
- B: `The gender-affirming underwear samples we sent [store] last fall`

```
Hi [first name],

I'm Jamie, founder of RUBIES. We make gender-affirming underwear and swimwear for trans women and girls, designed to feel like regular clothing, no tucking or compression needed. The brand started with my own trans daughter, who could not find anything that worked.

Last fall we sent you a sample kit and I would love to hear what you thought of the items.

Our wholesale terms are 50% off retail with free shipping. Let me know if you have any questions or if you would like to set up a quick conversation.

Talk soon,

Jamie Alexander, RUBIES Founder
```

Notes: locked by Jamie 2026-09-08. Pitch first, samples second, because the reader may not remember the kit. No resend offer, no gaff line, no $300 floor (the February pitch stated it and got no replies; it is flexible anyway and belongs in the reply). Grail Bra gets a hand edit (Carmen said clients would try them; ask how that went).

### Cases 2 and 3 — emailed in February with no samples (~22), or never contacted (the 119 from discovery)

Same cold intro for both. The February stores are past the six-month line and an email citing its own earlier email reads as a records lookup. The why-this-store slot draws from the discovery angle or the enrichment facts, never from the old thread.

Subjects (A/B, one variable: about us vs about their customers):
- A: `Gender-affirming underwear and swimwear for trans women and girls, wholesale from RUBIES`
- B: `Gender-affirming underwear and swimwear for your trans customers` (the first B, "A free RUBIES sample kit for [store]", read as junk mail: replaced 2026-09-09)
- Referral overrides both: `Referral from [name] at [their store] re: gender-affirming clothing from RUBIES`

```
Hi [first name],

I'm Jamie, founder of RUBIES. We make gender-affirming underwear and swimwear for trans women and girls, designed to feel like regular clothing, no tucking or compression needed. The brand started with my own trans daughter, who could not find anything that worked.

[One sentence on why this store specifically.]

I would love to send you a free sample kit so you can see the fit and fabric for yourself. No commitment, and I will pick the styles I think would suit your customers best.

If that sounds useful, just reply with the best shipping address.

Talk soon,

Jamie Alexander, RUBIES Founder
```

The first paragraph is the retailer version of the founder story: one clause on the daughter, not the org intro's full story (decision 6, closed). Single ask: the kit. No carrying ask, no affiliate mention (D3).

### What was sent before (imported from Gmail, for the register and the mistakes)

- Around Aug 2025: an automated email flood reached these stores by mistake.
- 4 Nov 2025: sample kits shipped as $0 orders, unannounced ("mystery package").
- 12 Nov 2025, "About those mysterious RUBIES emails + free sample order": apology, founder intro with the daughter ("now 17"), a Melbourne boutique's +10% sales anecdote, "did the package arrive?", and "if it's not the right fit, feel free to donate the items". Mostly "Hi!" with no name. Zero replies except Grail Bra (who had already replied).
- 18 Feb 2026, "Gender-affirming underwear for your trans customers": founder story ("after my daughter Ruby transitioned"), product paragraph, "sent some samples a few months ago and wanted to circle back", wholesale terms with the $300 minimum. "Hi!" again. Zero replies.

Lessons carried into the templates above: greet by name or "Hi there", never tell them doing nothing is fine, make the kit something to react to, keep the floor out of the opener.

### Case 4 — no reply (automatic, already live, no change)

Rung 1 at 5 business days: "Hi [first name], I am following up on this." Rung 2 at 10 more: the spam-folder line with the original quoted. Then the lead is retired.

### Case 5 — they reply

Operator-written (initiate-vs-continue rule). Existing rails: `setup_call` template if they want a call; the advisor proposes the $0 sample order and the operator confirms; `post_samples_checkin` fires 5 business days after delivery ("just checking in, did the RUBIES samples arrive okay?"); `sample_feedback_request` at ~3 weeks if they replied but have not ordered.

### Case 6 — "love them, can't hold inventory" (only once Phase 4 exists)

Operator-written from the thread, on the terms Hello Gorgeous already accepted (10% off for referred customers, 15% to the store):

```
Hi [first name],

Totally understand on the inventory. There is another way to work together that costs you nothing to hold: an affiliate link for [store]. Your customers shop RUBIES at 10% off through your link and [store] earns 15% on every order.

If that appeals I can have it set up in a day. I just need the name and email you want it under.

Talk soon,

Jamie Alexander, RUBIES Founder
```

### Case 7 — Hello Gorgeous (by hand, after the program is live)

```
Hi Kim,

So sorry for the silence on this. Back in February you and Michelle said yes to an affiliate arrangement with RUBIES, 10% off for the customers you send our way and 15% to Hello Gorgeous on each order, and I did not get it set up on my side.

It is ready now. If you are still up for it, I just need the name and email you would like the account under and I will send your link the same day.

Talk soon,

Jamie Alexander, RUBIES Founder
```

### Case 8 — the six who replied in February

No template. Read each thread, operator writes.
