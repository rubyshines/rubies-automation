# Design #7 — Historical B2B/Org Conversation Analysis (Findings)

**Run:** 2026-06-10, read-only against Supabase (`scripts/_b2b_history_01_match.js`, `_02_dump.js`, `_03_aggregate.js`).
**Sources:** `b2b_companies` (218), `b2b_contacts` (257), `donation_partners` (21, 17 active), `email_messages` (5,486), `email_threads`.
**Verdict up front:** the corpus is real but thin — 3.4 months, 9 companies. It is rich enough to extract qualitative patterns, objection handling, and a ~14-thread scenario set. It is NOT sufficient for opener reply-rate baselines (no un-referred cold intro exists in the synced data). Details and remediation below.

---

## 1. Data availability — the headline finding

**The corpus only covers 2026-03-01 → 2026-06-10.** `gmail_sync_state.backfill_pass = 0` — the historical Gmail backfill never ran. Every established retailer relationship (Sock Drawer Heroes, Illusions/Tuck and Bind, Early to Bed, underDARE, Transting) predates the corpus, so **first-touch → first-order timing is unobservable for all but one company** (She Bop, whose conversion happened in-window). The full history exists in Gmail itself; it just was never synced. If Design #7 wants deeper baselines, run the backfill first — that is cheaper than any alternative.

**Coverage:** 398 of 5,486 messages match a known B2B/org contact, forming **32 threads across only 9 companies** (7 wholesale, 2 lgbtq_org). Of 218 `b2b_companies`, **195 are `status=lead` with zero synced email history** — they are imported cold lists (klaviyo_centerlink 112, centerlink_sheet 40, etc.), never contacted or contacted pre-corpus. Status distribution: lgbtq_org/lead 157, wholesale/lead 38, wholesale/qualified_lead 8, wholesale/customer 7, wholesale/not_interested 3, lgbtq_org/active_partner 3, lgbtq_org/qualified_lead 2.

**Data-quality findings that affect the new system's design:**

1. **Sent-message pollution: Gmail auto-save draft checkpoints are synced as separate `is_sent` rows.** Example: thread `19de08871cfc4ed9` shows 64 "outbound" messages that are actually ~4 real sends — every few-second draft snapshot is a row ("Yes for sure" → "Yes for sur" → "Yes for sure. We have two kinds." …). Any reply-rate metric computed naively from `email_messages` is garbage. Analysis must collapse consecutive outbound bursts (<30 min apart → keep last). The new `b2b_messages` table must store only final sent messages.
2. **`donation_partners` has no email column.** The design plan's assumption ("emails of 14 active partners") is wrong on both counts: 21 rows (17 active), and partner emails live in `b2b_contacts` with `source='donation_form'` (30 contacts).
3. **Live org relationships are missing from `b2b_contacts` entirely.** The classifier tags their email `lgbtq_org` (81 msgs), but no contact row exists — so the planned reply-correlation (sender ∈ b2b_contacts) would miss active relationships on day one. Found in-corpus, currently unmatched:
   - Transgender Victoria — ez@tgv.org.au (Ez Lowes, Affirmation Station Manager) — donation-routing partner-in-progress, 15-msg thread
   - Fenway Health — cskaggs@fenwayhealth.org (Courtney Skaggs, Trans Health Program) — active gift-card program, ~$720 outstanding
   - GR Trans Foundation — info@grtransfoundation.org (Gage) — active discount-code program ("partner in this program")
   - Lumenus Foundation — lchampion@lumenus.ca (Laura Champion) — recurring Pride event partner
   - SoCirC — rachel@socirc.ca (Rachel David) — Pride party performer/partner, $500 donation
   - TDSB Gender & Sexual Diversity Team — ilana.david@tdsb.on.ca — event amplification partner
   - COLAGE — katyc@colage.org (Katy Chatel) — inbound event-donation requester
   - Montgomery Pride United — lorelei@montgomeryprideunited.org — onboarding in progress (met 2026-06-04)
   - Unity Conejo — jess@unityconejo.org — partnership discussion in progress
   - THProjekt (Germany) — thprojekt@gmx.net (Billy) — donation closet partner, signed agreement Apr 2026
   - McMinnville Trans Network — referenced as a return-routing destination (no direct thread)
   - Carleton CUSA — eman.elnaidany1@cusaonline.ca (the gsrc@ alias IS in b2b_contacts, the actual human is not)
   **Recommendation:** backfill these ~12 contacts before go-live.
4. `rubies-utilities/scripts/update-sales-leads.js` and its output are **not on this machine** (repo absent under `~/Code/rubies-repo/`). The old AI-followup history exists only in the Main Contacts sheet + Gmail. Treat as unavailable for this analysis.

---

## 2. Thread inventory (the scenario set)

After collapsing draft checkpoints and auto-replies: **20 two-way conversation threads.** Threads opened by us in-corpus: 8, of which 5 got replies (the 3 non-replies were all sent within the last 3 weeks, so not meaningful negatives). All thread IDs are `email_messages.gmail_thread_id`, retrievable any time.

### Retailer threads (companies in b2b_companies)
| Thread | Company | What it is | Use as |
|---|---|---|---|
| `19c48fbd502e24b9` | She Bop | Referral intro → questions → samples → PO. The only full prospect→customer arc in corpus | **Positive — gold standard** |
| `19d4f59fbaab6e9b` | She Bop | post_samples_checkin, reply in 35 min | Positive |
| `19d9266098fc4937` | She Bop | first_order_checkin → "doing really well, ordering more next week" + price-increase notice | Positive |
| `19e4927fc9d4663a` | She Bop | Checkin sent to info@ AFTER being told twice to use purchasing@ — no reply | **Negative — channel discipline** |
| `19de08871cfc4ed9` | Early To Bed / Trans Essentials | Inbound wholesale expansion ask (chest pads) + price-increase notice | Positive |
| `19e5bb81806b49eb` | underDARE | Dormant ~6mo → inbound reorder; minimums objection; order in 48h | **Positive — dormant revival** |
| `19d92507fa67e552` | Transting (DK) | Reorder + duties/discount structure objection (30% w/ duties vs 50% without) | Positive — objection handling |
| `19c9ca78b6b31928` | Sock Drawer Heroes | Invoice follow-up → product feedback → gaff tester recruitment | Positive — feedback loop |
| `19df62379eeddc33` | Sock Drawer Heroes | Inbound order + address change + price-increase notice | Positive |
| `19caf7faaff7085c` | Tuck and Bind (Illusions Lingerie AU) | Proactive "what's new + gaff samples" checkin → order placed in-thread | **Positive — checkin → order** |
| `19e49233f0f4ee63` | Tuck and Bind | Sample feedback request → detailed tester verbatim | Positive |
| `19d998dc73707903` / `19d7a784b933c16e` | Tuck and Bind | Lost-package recovery, proactive reshipment | Positive — service recovery |
| `19616cbd4d49b4b0` | The Bra Room | "keep us in mind if that program happens" — interest logged, nothing since | Negative — dropped thread |

### Org threads (mostly NOT in b2b_companies — see §1.3)
| Thread | Org | What it is | Use as |
|---|---|---|---|
| `19d444b28bc17f55` + `19d877faa5bdd7f5` | THProjekt (DE) | Cold donation-closet intro → same-day yes → call → signed agreement in 13 days. THEN: their ask for logo/photos chased twice, unanswered | **Positive intro / negative follow-through** |
| `19c4245037542cb6` | Transgender Victoria | Donation-routing partnership; Jamie no-showed two scheduled meetings; recovery via candid apology | **Negative — meeting discipline** |
| `19a82f225a639df8` | Carleton CUSA | Org purchase below minimum → 15% bridge discount → order same week | Positive — purchase path |
| `19cd864238de4ad1` + `19d3f3cb71362f36` + `19dc06ef0bc7892a` | Transformation Closet / SHNS | Grant-purchase delivery failure → transparent recovery → "package arrived!" | Positive — service recovery |
| `19e46a0488b635b1` | Fenway Health | Gift-card program breakage → reissued 36×$20 as 15×$50 | Positive — program maintenance |
| `19df4642f0d683c9` | GR Trans Foundation | Annual discount-code renewal request | Positive — program type evidence |
| `19d6d484966b6c26` + `19df423af37ff812` + `19d6e274d56d7327` + `19e927936e021d78` | Lumenus / TDSB / SoCirC | RUBIES-hosted Pride party coordination: org asks "is it happening?", amplification requests, cancellation + $500 donation | Positive — event partner coordination |
| `19ddee462db9b56a` | COLAGE | Inbound event-donation request (Family Week raffle) → response: "let's set up a call" | event_donation_response example |
| `19938cb968ec8b4e` | Oasis Youth Center | Contact role change → "let me connect you with new point of contact" → Jamie chasing | Contact-change scenario (validates Design #3) |

---

## 3. What the threads actually show

### 3.1 Most B2B email is inbound and service-shaped
24 of 32 matched threads were started by them. Established retailers self-serve: they email when they want to restock, and the "outreach" Jamie does mid-relationship is mostly operational (invoices, shipping recovery, price notices). Implication: **for `active` retailers, the highest-volume advisor work will be inbound-order handling and service recovery, not outbound persuasion.** Design #6's inbound-order path is, on this evidence, the most-used path.

### 3.2 The She Bop arc — the canonical retailer conversion
Referral from Searah Deysach (Early to Bed) → intro (pre-corpus, ~mid-Feb) → Mar 16: practical questions ("What is your minimum, wholesale prices and most popular styles… we do not have the space to [carry] swimwear") → factual same-night answer (50% off, $300 min free shipping, four named bestsellers, "warehouse in Tualatin so shipping to Portland is super quick and tariff-free" — a locally relevant detail) → call offered, **declined** ("We don't have time for a call but we will reach out") → they ask for ONE sample; Jamie sends three items and steers ("If you were only to carry one product I would recommend the AJs… simple and hence more popular") + a staff-education link → Apr 2 checkin "did you receive the samples?" → reply in 35 min ("given the pieces to one of our staff to try out. Product meeting in two weeks") → Apr 14: "We are so excited to be picking up The Charlie Underwear and The Brooke Bra!" → PO Apr 15.

**Timing: referral-reply → first PO ≈ 30 days; samples shipped → PO = 4 weeks; ~5 real outbound touches.** Key moments: (a) proactively sending MORE samples than asked, with a recommendation, (b) respecting the no-call preference — everything closed async, (c) the buyer's internal product-meeting cadence (2 weeks) was the real clock; the checkin synced to it rather than pressuring. Five weeks later, a first_order_checkin ("checking in to see how the last order went… always open to any feedback") got a same-day "RUBIES are doing really well for us. I am going to be placing a new order next week" — **the relationship checkin directly preceded a reorder with zero sales pressure.** This validates the catalog's first_order_checkin design exactly as written.

### 3.3 Objections observed and how they resolved
- **"No space / limited space"** (She Bop): narrowed the line to bestsellers, recommended the single simplest product, let them start tiny. Resolved → customer.
- **"Just trying a dozen, don't imagine huge volumes"** (Early to Bed pads): accepted gracefully, flagged that larger volumes are possible later ("let me know so I can take this into account next time I place an order"). No pressure.
- **"Is there still a minimum per SKU???"** (underDARE, on a strict budget): "Nope… it doesn't make a difference how many units of each SKU" + $300 order floor for the 50% discount. Response: *"Jamie—you are the GOAT. You'll be hearing from me soon."* Order placed within 24h.
- **Duties/landed-cost confusion** (Transting, DK): offered an explicit choice — 30% off with duties covered vs 50% off self-managed — and let their accountant pick. Choice-framing, not policy-defending.
- **Below order minimum** (Carleton CUSA, $259 vs $400): bridge discount (15%) instead of refusal → order same week, relationship preserved.
- **Carrier failures** (Illusions, SHNS — recurring): transparency + proactive reshipment + carrier change commitment. Partners responded with empathy, not churn ("I of all people know that once it leaves our hands we have ZERO control").
- Not observed anywhere in corpus: price pushback, brand-fit objections, competitor comparisons. RUBIES B2B relationships are, as the design doc says, universally warm.

### 3.4 The price-increase notice — a proven, repeatable template
Sent to 4+ retailers in May 2026, same structure every time: *"after keeping our prices the same for many years, we have recently increased them. Our bikini bottom was $44 for 6 years! I will continue to discount the old pricing by 50% on your orders until the end of July"* + per-SKU before/after **for the products that specific retailer commonly orders.** Results: "Thanks so much for the grace!" (Early to Bed), "Thanks for the update… and for keeping our existing pricing" (SDH), "We will try to get in a few more orders before prices go up in August" (She Bop — **the deadline generated demand**). Formula: justification-by-history + grandfather window + retailer-specific SKU specificity. This should be a message type (see §4).

### 3.5 Tone that works (consistent across every successful thread)
Short. Warm. Personal life shared both directions (Ruby's art school acceptance, trips to China, partner's new baby — "Mazel tov!", store moves, staff drama). Fast turnaround (engaged partners reply in minutes-to-hours; Jamie usually same day). Generous defaults (extra samples, bridge discounts, no minimums). Honest about problems including self-deprecation ("OMG! I am so sorry for standing you up"). Zero corporate language. Partners mirror it back: "amazing as always", "you are the GOAT", "Thanks for being our partner." The advisor prompt should encode: **lead with the relationship, put commerce second, be specific to their order history, never pad.**
One counter-finding for drafts: several real sent emails contain typos ("invoioe", "abou th", "recenty") — authentic but not something to emulate; advisor drafts get this warmth without the noise.

### 3.6 Org relationships are call-shaped; retailer relationships are email-shaped
Every org thread that advanced (TGV, THProjekt, COLAGE, Unity Conejo, Montgomery Pride, Dana Siegel/Uphold) moved to scheduling a video call — onboarding closes on calls, not email. Retailers explicitly declined calls (She Bop) and closed everything async. **The single biggest failure mode in org threads was meeting logistics, not messaging:** Jamie no-showed TGV twice (timezone confusion + calendar misses) and THProjekt once; Billy chased an unanswered asset request twice; Oasis required chasing for a contact handoff. Ez stayed gracious ("Let's give this one more go! I am still super interested") — mission-aligned orgs are extraordinarily forgiving, but the pattern is clear. **The org advisor's highest-value job on this evidence is follow-through: surface owed replies, owed assets, and scheduled meetings — not clever pitches.** This strongly supports the Tier-1 "they replied, waiting on us" queue design, and suggests meeting/asset commitments deserve explicit tracking.

### 3.7 The cold-intro evidence (limited but consistent)
Only two cold/cold-ish intros exist in corpus, and **both were referral-anchored:**
- THProjekt (cold org intro, Apr 1): founder story ("RUBIES was inspired by my daughter, Ruby, who transitioned at age 9 and is now 18") + referral framing ("One of our German customers provided your information") + concrete program description. Reply same day: *"I just checked out your website and I truly love what you're doing… I would be very, very happy for the project to receive support from you!"* Intro → signed agreement: **13 days, one call.** Note: first send bounced (wrong address on their website) — the `general_email` fallback in Design #6 is validated by a real case.
- She Bop (retailer intro, pre-corpus): subject literally "Referral from Searah Deysach of EarlyToBed re: gender affirming clothing from RUBIES." Converted to customer.
**No un-referred cold intro to any retailer or org appears in the synced corpus.** Implication: (a) the warm-referral channel demonstrably works and should be cultivated deliberately (ask happy partners for intros — Searah referred She Bop, a German customer referred THProjekt); (b) there is **no historical baseline for the catalog's `intro_pitch`/`intro_outreach` performance** — the planned A/B variant tracking (Locked Decision #15) is the only way to get one. Do not let anyone claim a reply-rate baseline from this data.

### 3.8 Timing patterns (what little is measurable)
- She Bop: samples → first PO = 4 weeks; first reply → PO = 30 days.
- THProjekt: cold intro → signed agreement = 13 days.
- Reply latency from engaged partners: 0.2h–2 days typical; orgs lapse 1–3 weeks around vacations/part-time staffing (signatures explicitly say so: "small team that works part-time hours").
- underDARE: ~6 months dormant, several unanswered checkins, then returned inbound and ordered within 48h. Referencing the unanswered checkins on their return ("I have sent you a few emails to check in over the last six months so it's nice to hear from you") landed fine. **Dormant ≠ lost; the checkins kept RUBIES top-of-mind and the reorder arrived on the retailer's clock.** Supports the catalog's warm-not-worried reactivation tone.
- Buyer-side internal clocks (product meetings, budget cycles, grant phases — CUSA "Phase Two") drive conversion timing more than our cadence does. The advisor should ask about and remember these clocks.

---

## 4. Message-type catalog: validation against reality

**Validated by real threads:** `post_samples_checkin` (She Bop, 35-min reply), `first_order_checkin` (She Bop → reorder), `reorder_nudge` implied (underDARE referenced received checkins), `purchase_pitch` (CUSA, SHNS grant purchases), `event_donation_response` (COLAGE), `intro_outreach` w/ founder story (THProjekt), contact-change handling (Oasis), general_email fallback (THProjekt bounce).

**Missing from the catalog (seen repeatedly in real threads):**
1. **`price_change_notice`** — proven template (§3.4), sent to every active retailer, drove orders. Low-variance, auto-send candidate for healthy accounts.
2. **`sample_feedback_request` / tester recruitment** — distinct from post_samples_checkin: recruiting the retailer's *customers* as product testers for R&D (gaff program with SDH + Illusions), shipping tester samples, collecting verbatims (Kayla's XXL gaff review is marketing-grade copy: "as comfy as normal underwear… easily gone a full day with no pain"). This is how RUBIES does product development AND deepens retailer relationships simultaneously.
3. **`invoice_followup`** — "just making sure you saw the invoices", "let me know once you have taken care of the invoice so I can make sure it ships using the right carrier." Mechanical, recurring, auto-send candidate.
4. **`event_partner_coordination`** (org track) — RUBIES *hosts* events (Pride party) and orgs amplify/perform/attend (Lumenus, TDSB, SoCirC). Multi-party logistics threads, recurring annually, inherently needs_review. The catalog only models orgs' events, not RUBIES' own.
5. **Org program types not modeled:** Fenway Health = **gift-card program** (bulk gift cards distributed by org staff to patients); GR Trans Foundation = **annual discount code** for org community. Neither is donation_closet, purchases, nor affiliate. Either add program flags or fold into a `community_program: gift_cards | discount_code` notion — both have annual-renewal cadence (GRTF asked for their 2026 code themselves; better if we'd offered first).
6. **Asset/onboarding fulfillment** — partners ask for logos, photos, posters, line sheets (Billy, Rachel, Marcy). Not a message type so much as an advisor capability: deliver collateral on request and track that it was delivered (Billy's unfulfilled request is the worst look in the corpus).

**Catalog elements with zero historical evidence (rely on design judgment):** affiliate track entirely (no affiliate threads exist), donation_closet_pitch as scarcity-framed (the THProjekt pitch that worked was referral-framed instead), community_checkin seasonal triggers, new_collection broadcast (the gaff announcements were personalized 1:1, which worked — consider whether new_collection should feel 1:1 even when batched).

---

## 5. Implications for the two advisor prompts

**Sales Advisor (`b2b_sales_advisor`):**
- Default mode: respond fast, specific, generous; reference their order history by SKU; respect stated contact channels (the one clear self-inflicted miss: emailing info@ after She Bop said twice to use purchasing@ — thread `19e4927fc9d4663a`, no reply).
- Conversion playbook: answer practical questions factually → offer samples proactively (more than asked) with a single clear recommendation → delivery-triggered checkin → let their internal review cadence run → first_order_checkin with no ask.
- Objection posture: every observed objection resolved by *flexibility + choice-framing*, never by holding a line. Bridge discounts beat refusals.
- Don't push calls on retailers; close async.

**Community Advisor (`b2b_community_advisor`):**
- The bottleneck is follow-through, not persuasion. Track owed replies, owed assets, scheduled calls; meeting no-shows are the #1 observed failure.
- Onboarding closes on a video call → agreement + onboarding survey. Drafts should move toward scheduling, with explicit timezone arithmetic (two of three missed meetings were timezone/calendar confusion).
- Founder story + referral framing is the proven cold opener for orgs.
- Orgs are slow and forgiving — patience in cadence, warmth in tone, never pressure. Expect 1–3 week silences as normal, not as signal.
- Cross-program awareness must include gift-card and discount-code programs, with annual renewal nudges (offer the renewal before they ask).

---

## 6. What's missing and what to do about it (gates and follow-ups)

1. **Run the Gmail backfill** (`gmail_sync_state.backfill_pass=0`) if pre-March-2026 history is wanted — it would unlock first-touch→first-order arcs for SDH, Illusions, underDARE, Early to Bed, and the original She Bop intro. The data exists in Gmail; it was simply never synced. (Re-run this analysis after backfill — the three `scripts/_b2b_history_*.js` scripts are reusable.)
2. **Backfill the ~12 missing org contacts** (§1.3 list) into `b2b_companies`/`b2b_contacts` before reply-correlation goes live.
3. **Fix the donation_partners email assumption** in the design plan — emails come from `b2b_contacts` (source=donation_form), not `donation_partners` (no email column).
4. **Collapse draft checkpoints** in any future email analysis; design `b2b_messages` writes so only final sends are recorded.
5. **No A/B baseline exists or can exist from this data** — variant tracking from day one (Locked Decision #15) is the baseline plan. The qualitative finding to seed variants with: referral-anchored and founder-story openers are the only cold approaches with observed wins.
6. LGBTQ+ org empirical history is thicker than the design doc assumed ("no compiled contact list exists") — it exists, it's just unindexed (81 messages classified `lgbtq_org`, contacts missing from tables). The org advisor prompt can cite real scenarios, not only design decisions.

**Design #7 gate assessment: PASSED with caveats.** There is enough evidence to write both advisor prompts grounded in real threads (scenario set in §2, patterns in §3, prompt directives in §5), provided the prompts do not claim quantitative opener baselines and the contact backfill (item 2) happens before reply-matching ships.
