# B2B deliverables — one piece of work above many promises

Status: planned (discussed 2026-09-16). Promote to `project_b2b_deliverables.md` when the build starts.
Domains: b2b_sales, community, tech
Builds on: `.claude/plans/b2b-commitments.md` / `project_b2b_commitments.md` (the commitments list,
live since 2026-09-10). Nothing here changes what a commitment is.

## Problem

The commitments list works and is already too long to read. 33 open rows (14 mine, 19 theirs)
across 13 companies, six weeks in: 21 lifted from meetings, 10 from mail, 2 from claims. Three
calls on one night produced 13 of them. The extractor is not at fault — it is a strict parse of
Wispr's "Next Steps" and invents nothing — and the inflow will not slow down, because every new
partner call produces four to six items by design.

The list has one axis: company. So 33 rows read as 33 unrelated errands. Sorted by what the work
actually *is*, Jamie's 14 are about six pieces of work:

| Work | Items | State |
|---|---|---|
| Send product (BMC 23, COLAGE 11, Forbidden Fruit 22, Le JAG 2, StandWithTrans 6, Uniting Pride 25) | 6 | actionable; 2 date-driven (Oct 18, Oct Pride Fest) |
| Affiliate programme (Hello Gorgeous 17, Uniting Pride 32) | 2 | **blocked — the app does not exist** |
| Partner collateral (Le JAG tabling 5, Le JAG stand 2, GSRC QR/card 18) | 3 | **blocked — the kit does not exist** |
| Listing / routing setup (Uniting Pride map 26, StandWithTrans routing 7) | 2 | one flow, run per org |
| Wholesale info pack (Come As You Are 35, Forbidden Fruit 22) | 2 | one document, two sends |
| One-off (As You Like It reschedule 30) | 1 | — |

Two separate problems fall out of that table, and they are easy to conflate:

1. **Five of the 14 cannot be done at all** until something internal ships. They are on screen
   every day and have been since they were captured. That is not a volume problem; it is a
   missing dependency. Jamie's own framing: *"once I have the affiliate app built for orgs I can
   pretty much knock off a bunch of them."*
2. **The rest repeat.** Six shipments are six addresses, six size runs, two deadlines — but one
   sitting at the packing table.

`b2b_commitments.blocked_by` exists (self-FK, settable through `updateCommitment`, renders a
"blocked" badge at [app.js:5808](../../customer-service/dashboard/public/app.js#L5808)) and
nothing has ever set it. It points commitment → commitment, which cannot express "waiting on a
thing that is not a promise to anybody".

## Decisions locked with Jamie (2026-09-16)

1. **A deliverable is a first-class row, not a commitment.** New table `b2b_deliverables`. It is
   internal work — building the affiliate app is a promise to nobody — so it must never sit in
   the To do list as a promise and must never touch On Me. This was the open question; Jamie
   chose the table over the cheap "commitment row with no company" alternative.
2. **Commitments keep every field and behaviour they have.** One nullable FK,
   `b2b_commitments.deliverable_id`. A row with no deliverable behaves exactly as it does today,
   so the migration cannot regress anything.
3. **One boolean decides what membership means: `blocks`.**
   - `blocks = true` — members cannot be done until the deliverable ships (affiliate app,
     collateral kit).
   - `blocks = false` — a batch. Members are actionable now; they are grouped because they are
     done in one sitting ("October org shipments").
   This replaces my first proposal, which was to store only the blocking kind and derive batches
   as a query over action type. Two things killed that: the fold only pays off if the unblocked
   items group too (otherwise six shipments stay six top-level lines and the list barely
   shrinks), and a curated dated batch like "October org shipments" is not expressible as a
   query. One boolean is cheaper than a second mechanism.
4. **Blocked never means hidden.** A blocked item folds under its deliverable with a visible
   count — "Waiting on: Affiliate programme for orgs (3)" — and is one click away. Nothing drops
   out of the list. A silently suppressed commitment is the worst failure this system can have:
   it looks like coverage and fixes nothing (`feedback_technical_rules.md`, the claim-leak
   lesson). Folding is the whole win; hiding is not needed for it.
5. **Shipping a deliverable does NOT complete its members.** The app existing is not the same as
   having written to Emma. On ship, members become actionable and the panel offers each one
   "write to them" straight into the composer, riding the existing
   `structured.completes_commitment_id` so the send completes that row exactly as it does now.
   This preserves the rule the list's trustworthiness rests on: nothing but Jamie's check or
   Jamie's send closes something Jamie owes.
6. **Blocked beats batched when an item is both.** One FK, so one home. Le JAG's "sample product
   with a stand" is a shipment *and* waits on the stand existing; it belongs to the collateral
   kit, because until that ships the batch cannot have it.
7. **The engine may attach, never ship.** Suggesting which deliverable a new item belongs to is
   organisation, not completion — a wrong guess costs one click and hides nothing (decision 4).
   Marking a deliverable shipped is Jamie's alone.
8. **On Me is untouched in v1.** An open me-row still puts its company on Jamie whether it is
   blocked, batched or loose. `companiesOnMe` does not learn about deliverables. See Open
   questions — there is a real argument the other way, and four readers downstream.
9. **Not B2B-specific in shape.** Same note as commitments: a deliverable that groups CS work
   should fit the table unchanged. Keep the `b2b_` prefix for family consistency; do not wire CS.
10. **Phone matters.** Folds must work in the PWA — the To do list is read and ticked on a phone
    after a call.

## Data

New table `b2b_deliverables` (schema SQL in `gmail-management/`, idempotent, applied BEFORE code
deploys, per the house rule):

- `id`, `name` (text, the header line), `detail` (text, nullable — what "done" means),
  `blocks` (bool, default true), `status` (`open` | `shipped`), `target_on` (date, nullable),
  `shipped_at`, `notes` (text, nullable), `created_by` (`operator` | `engine`),
  `created_at`, `updated_at`.
- `b2b_commitments` gains `deliverable_id BIGINT REFERENCES b2b_deliverables(id)`, nullable,
  `ON DELETE SET NULL` so deleting a deliverable detaches its members rather than orphaning or
  cascading them away.
- Index: `b2b_commitments (deliverable_id) WHERE status = 'open'`.
- `blocked_by` stays as it is. It is the right field for "this one item waits on that one item"
  (COLAGE's shipment waiting on the organizer contact) and is a different relation from "this
  item waits on a piece of work". Still unset by anything; leave it.

## Code

All logic in the lib, per `feedback_technical_rules.md` — the tool, the endpoints and the panel
are thin over it.

- **`b2b-outreach/lib/deliverables.js`** (new): `listDeliverables` (open first, then shipped;
  each decorated with its open/done member counts), `addDeliverable`, `updateDeliverable`,
  `shipDeliverable` (sets status + `shipped_at`, returns the members that just became
  actionable — it does not write to them), `reopenDeliverable`, `deleteDeliverable` (detach),
  `attachCommitment` / `detachCommitment`.
- **`commitments.js`**: `updateCommitment` accepts `deliverable_id`; `upsertCommitments` accepts
  it per item; `listCommitments` returns it and joins the deliverable's name, `blocks` and
  status onto each decorated row so the panel can fold without a second fetch. `decorate` gains
  `blocked: deliverable && deliverable.blocks && deliverable.status === 'open'`. No change to
  `companiesOnMe`, `settleOnSend`, `syncOnMeFlag` or the complete/reopen/delete paths.
- **Tools** (`customer-service/lib/tools/b2bOutreach.js`): new `b2b_deliverables`
  (`list` | `add` | `edit` | `ship` | `reopen` | `delete` | `attach` | `detach`), spread into
  `allTools`. `b2b_commitments` `edit` gains `deliverable_id`, and its `list` gains a
  `deliverable_id` filter. Tool descriptions must say that shipping completes nothing.
- **Endpoints**: `GET/POST /api/b2b/deliverables`, `POST /api/b2b/deliverables/:id`, beside the
  existing `GET/POST /api/b2b/commitments` in `customer-service/dashboard/server.js`.
- **Panel** (`customer-service/dashboard/public/app.js`, To do mode): mine renders as
  deliverable folds then loose rows. A blocking fold is titled "Waiting on: {name}" and is
  closed by default; a batch fold is titled by name with its `target_on`, open by default. Both
  show a count. Existing row rendering, the editor, the check and the add box are reused
  untouched; the editor gains a deliverable picker (datalist, same pattern as the company one).
  A "Shipped" control on a blocking fold calls `ship` and re-renders the members as actionable
  with their per-item "write to them".

## The AI part (phase 3, last)

Membership is suggested, not pattern-matched — CLAUDE.md is explicit that classification is the
model's job and that regexing customer or partner words is the wrong instinct.

One shared function `suggestDeliverable(items, { deliverables, company })` in
`deliverables.js`, called from both write paths: `meetingNotes.js` after `parseNextSteps` (which
stays deterministic — it decides *what* the items are; this decides only where they file), and
`relationshipSummary.js` alongside its existing commitments extraction. It is handed the open
deliverables with their detail lines and returns an id or null per item.

- **Sonnet**, matching the summariser it rides beside: narrow classification over text we already
  hold, fails closed (null → the item is simply loose, exactly as today), and Jamie reads the
  grouping before acting on it. Code comment to say so, per the model-choice rule.
- Through `callClaude` with `component: 'b2b_deliverable_grouping'`, never the raw SDK.
- Never creates a deliverable. Proposing new buckets from a single call's items is how this turns
  back into noise; Jamie creates them, the model only files into them.

Until this ships, Jamie attaches by hand — with 33 items that is a couple of minutes, which is
why it is phased last and not first.

## Seed (by hand, at build time)

Three deliverables are already visible in the live rows:

- **Affiliate programme for orgs** — `blocks`. Members: 17 (Hello Gorgeous), 32 (Uniting Pride).
  This is the parked "Unified B2B Outreach — unbuilt remainder" item (2) affiliate onboarding
  flow (GoAffPro). Le JAG's 20 discount codes (commitment 1, done) was the manual version.
  **Note what this deliverable actually is** (checked 2026-09-17): not a build. The affiliate
  programme does not exist and is never offered (`domain_b2b_sales.md` Key Decision 2026-08-13),
  the channel already exists in the outreach spine, and the IRAP plan's line is *"choose affiliate
  app + verify it tags Shopify orders (not just the app dashboard)"*. So the blocker is an open
  decision plus SaaS configuration, tracked on `initiative_b2b_expansion.md` ("the affiliate
  decision (two stores have asked) is still open"). It could ship in an afternoon, which is an
  argument for seeding it first and pressing Shipped early.
- **Partner collateral kit** — `blocks`. Members: 5 (Le JAG tabling material), 18 (GSRC QR /
  digital card), 2 (Le JAG sample + stand, by decision 6). Le JAG's own infographic (3, theirs)
  waits on the same assets and should be attached too — a `them` row can belong to a deliverable.
- **October org shipments** — batch, `target_on` 2026-10-10. Members: 6 (StandWithTrans, Oct 18),
  25 (Uniting Pride, Pride Fest), 11 (COLAGE Atlanta), 23 (BMC), 22 (Forbidden Fruit).

That takes Jamie's 14 lines to 3 folds + 3 loose rows. Listing/routing (26, 7) and the wholesale
info pack (35, 22) are real groups too but only two items each; leave them loose until they earn
a fold.

## Phases

1. **Schema + lib + tool + folds.** Migration applied, `deliverables.js` with tests, tool
   registered in `allTools`, endpoints, To do renders folds, seed the three above by hand.
   The list reads as pieces of work. Blocked items stop competing with actionable ones.
2. **The ship moment.** "Shipped" on a blocking deliverable → its members surface as actionable
   with a per-item "write to them" into the composer. This is the payoff Jamie described and it
   is deliberately second, not last.
3. **Suggested membership.** The Sonnet classifier above, wired into both write paths.

## done_when

- `b2b_deliverables` exists with the three seeded rows; every one of the 11 commitments named in
  Seed carries the right `deliverable_id`, verified against the live rows.
- The To do view shows Jamie's items as three folds plus three loose rows, on desktop and on the
  phone. The two blocking folds are closed by default and their counts are visible without
  opening them.
- Pressing Shipped on "Affiliate programme for orgs" leaves commitments 17 and 32 **open**,
  moves them out of the fold into the actionable list, and offers each a composer that completes
  that row on send (verified end to end on one of them).
- Deleting a deliverable leaves its members open and loose (no orphans, nothing cascaded away).
- On Me is byte-identical before and after the migration for all 13 companies.
- Unit tests green in `customer-service/test/b2bDeliverables.test.js`: ship completes no member;
  a blocked member is still returned by `listCommitments`; attach/detach is idempotent;
  `companiesOnMe` output is unchanged by any grouping operation; delete detaches.
- Full suite green (`node --test customer-service/test/*.test.js`), schema applied before deploy,
  pushed to `main` and Railway redeployed.

## Open questions

- **Should a company whose only open me-item is blocked still be On Me?** Argument for: he does
  owe them. Argument against: On Me suppresses cadence, so a blocked item quietly stops us
  chasing — which may be right (do not chase while we cannot deliver) or may strand a partner for
  months. Four readers depend on the flag (cadence suppression, pending-draft merge, panel badge,
  tab count), so v1 changes nothing. Revisit after watching the folds for a few weeks.
- **Does a shipped deliverable ever reopen itself?** If the collateral kit ships and a new org
  asks for a tabling kit, is that a new member on a shipped deliverable, or a loose item? Lean:
  loose, and the deliverable stays shipped — but confirm once it happens rather than guessing.
- **Wholesale info pack and partner listing/routing** are groups of two today and will grow. Leave
  loose now; they become deliverables when they hit four or so.
