---
name: B2B deliverables
description: One piece of internal work above many promises — the fold the To do rows sit under; blocked items sort last and never hide; shipping completes nothing
type: project
domains: [b2b_sales, community, tech]
done_when: see the numbered list at the bottom — seeded against the live rows, folds on desktop and phone, Shipped verified end to end, On Me byte-identical, schema applied before deploy
---
Design record: `.claude/plans/b2b-deliverables.md` (decisions locked with Jamie 2026-09-16; this
file tracks execution). Builds on `project_b2b_commitments.md`; changes nothing about what a
commitment is.

## What is being built (branch `wt/b2b-deliverables`, started 2026-09-21)

- **Table** `b2b_deliverables` + `b2b_commitments.deliverable_id` (nullable, `ON DELETE SET
  NULL`): `gmail-management/migrations-2026-09-21-deliverables.sql` (schema record in
  `b2b-deliverables-schema.sql`). Apply BEFORE deploy; the code fails soft without it.
- **`b2b-outreach/lib/deliverables.js`** — `listDeliverables` (with member counts),
  `addDeliverable`, `updateDeliverable`, `shipDeliverable` (returns the released members, completes
  none), `reopenDeliverable`, `deleteDeliverable` (detaches first, then removes),
  `attachCommitment` (idempotent; refuses a shipped deliverable) / `detachCommitment`.
- **`commitments.js`**: `decorate` takes the deliverable and sets `blocked` (blocks + open + row
  open); `orderCommitments` ranks blocked last, pin still first; `listCommitments` joins the
  deliverable (fail-soft) and filters by `deliverable_id`; `updateCommitment` / `upsertCommitments`
  accept `deliverable_id`. `companiesOnMe`, `settleOnSend`, `syncOnMeFlag` untouched.
- **Tools**: `b2b_deliverables` (list / add / edit / ship / reopen / delete / attach / detach);
  `b2b_commitments` edit + list gain `deliverable_id`; `commitmentLine` prints `WAITING ON: …`.
- **Endpoints**: `GET/POST /api/b2b/deliverables`, `POST /api/b2b/deliverables/:id`.
- **Panel**: To do mine renders as batch folds (open) → loose rows → blocking folds ("Waiting on:
  …", closed, count visible); Shipped on a blocking fold; `+ deliverable` under the add box; the
  row editor gets a deliverable picker; rows carry a deliverable chip outside their fold.
- **Tests**: `customer-service/test/b2bDeliverables.test.js`.

## Progress

- 2026-09-21: everything above built; suite 3580 green; migration applied by Jamie; seeded
  **four** deliverables (the plan's three, minus Forbidden Fruit's done item, plus a fourth the
  eleven rows added since the plan made obvious — the Virtual Closet programme write-up, blocking
  Lumenus, Colors+, Attic and the Center on Colfax). 16 members attached: 18 of Jamie's rows
  read as 9 blocked in three folds, 5 in the October batch, 4 loose. On Me verified: same
  companies, counts, stamps and flag columns before/after; the only movement was created_at
  tie order, now broken by id (regression test). Ship→reopen round trip verified on the live
  affiliate deliverable through the endpoints: members stayed open, unblocked, re-blocked.

## Remaining (in order)

1. Jamie walks the To do view on desktop and phone; presses Shipped on one for real when it is.
2. Merge, deploy; confirm the nightly ingest still adds rows (loose, until phase 3).
3. Close-out memory: domain Key Decision (one line), parked entry for phase 3 (suggested
   membership). Decide what to do with commitment #50 ("build automation system for virtual
   closet"), which is the deliverable itself wearing a commitment's clothes.

## done_when

- `b2b_deliverables` exists with the three seeded rows; every commitment named in the plan's
  Seed carries the right `deliverable_id`, verified against the live rows.
- The To do view shows Jamie's items as three folds plus loose rows, on desktop and on the phone.
  The blocking folds are closed by default and their counts are visible without opening them.
- Pressing Shipped on "Affiliate programme for orgs" leaves its members **open**, moves them out
  of the fold into the actionable list, and each opens the company with the composer ready
  (verified end to end on one of them).
- Deleting a deliverable leaves its members open and loose.
- On Me is identical before and after for every company.
- `b2bDeliverables.test.js` green: ship completes no member; a blocked member is still listed; attach
  is idempotent; `companiesOnMe` unchanged by any grouping operation; delete detaches.
- Full suite green, schema applied before deploy, pushed to `main`, Railway redeployed.
