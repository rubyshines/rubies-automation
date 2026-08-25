# Bug tab — flagging tickets that are blocked on an advisor fix

## Context

Jamie hits an advisor bug mid-ticket. Fixing it takes a session, so he moves on to
other CS work — and the bugged ticket goes invisible. There is nothing on the
dashboard that says "this one is waiting on a fix", so remembering it is pure
cognitive load, carried by him, across days.

On Me solves the same shape of problem for "I owe this person an answer myself".
This adds the third deferral: **"this one is broken and I am waiting on a fix."**

### Why a flag and not a status (the one design departure from On Me)

On Me is a ticket **status** (`pending_operator`), so a ticket holds exactly one
state. Modelling Bug the same way would have forced a choice on every bugged
ticket: answer the customer (send + close, losing the bug marker) or keep the
marker (leaving a customer parked because *we* have a bug). Most advisor bugs are
found on a draft Jamie then rewrites and sends — precisely the case a status
cannot hold. So `bug_flagged_at` is a **column orthogonal to status**:

| ticket state | where it shows |
|---|---|
| `open` + bug | New / Follow-up (with a red `bug` badge) **and** Bug tab |
| `pending_operator` + bug | On Me (with the badge) **and** Bug tab |
| `closed` + bug | Closed **and** Bug tab |

Clearing the flag is the only thing that empties the tab. Two things this buys for
free: nothing in the status machine moves, so the drift reconciler
(`gorgiasDriftCore.js` `STATUS_OK`), the follow-up sweep, the daily report's On Me
precedence rule and the autosend gate all need **zero** changes; and Gorgias is
never written to, so there is no Gorgias-before-Supabase ordering concern.

Name: **Bug**. Short enough for the tab row, and unambiguous about whose problem it is.

---

## 1. Schema

`customer-service/drafter/tickets-schema.sql` — append alongside the other
`ADD COLUMN IF NOT EXISTS` migrations (there is no CHECK constraint on
`cs_tickets.status`, and we are not touching it anyway):

```sql
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS bug_flagged_at timestamptz;
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS bug_note text;
CREATE INDEX IF NOT EXISTS idx_tickets_bug ON cs_tickets (bug_flagged_at)
  WHERE bug_flagged_at IS NOT NULL;
```

Run it in the Supabase SQL Editor before deploying. `bug_note` is the one thing a
future diagnosis session cannot recover from the data (`draft_history[0]`, intake
state and tool calls are all already stored) — it captures *what looked wrong to
Jamie*, which is where the flagged-draft protocol in `domain_cs.md` starts.

## 2. Server — `customer-service/dashboard/server.js`

- `TICKET_TABS` (~L2643): add `'bug'` as the first entry.
- `apiGetTickets`:
  - add `bug_flagged_at, bug_note` to the `.select(...)` list — the badge has to
    render in **every** queue, not only the Bug tab.
  - ordering: `orderCol` becomes `tab === 'parked' ? 'parked_at' : tab === 'bug' ? 'bug_flagged_at' : 'updated_at'`, ascending — oldest bug on top, same nag as the other work queues.
  - `case 'bug': q = q.not('bug_flagged_at', 'is', null); break;` — deliberately
    **no status filter**. That is the whole point of the tab.
- `apiGetTicketStats` (~L2830): add a count alongside the existing five —
  `.select('id', { count:'exact', head:true }).not('bug_flagged_at','is',null)` —
  returned as `bug`.
- Two new handlers, modelled on `apiPendTicket` / `apiUnpendTicket` (~L3691):
  - `apiFlagBug(ticketId, body)` → sets `bug_flagged_at` **only if currently null**
    (a re-flag updates `bug_note` but must not reset the clock — the age is the nag),
    and `bug_note` from `body.note` when supplied.
  - `apiClearBug(ticketId)` → nulls both.
  - Neither touches `status`, `active_draft_id`, Gorgias, or `focus_time_seconds`.
    The focus-time capture in `apiPendTicket` exists because On Me is a *terminal*
    action; flagging a bug leaves the ticket open in front of you, so capturing
    there would truncate a live timer.
- Register both in the route table beside the pend/unpark routes (~L4032):
  `POST /api/tickets/(\d+)/flag-bug` and `POST /api/tickets/(\d+)/clear-bug`.

## 3. Markup — `customer-service/dashboard/public/index.html`

- **First** child of `#nav-tabs`, hidden by default:
  `<button class="tab tab-bug" data-tab="bug" onclick="switchTab('bug')" hidden>Bug <span class="tab-count" id="tab-count-bug"></span></button>`
  Being first means `layoutNavOverflow()` never pushes it into the More menu (it
  harvests from the end), so it cannot hide behind a caret.
- Detail panel `.btn-row-secondary`, next to On Me / Park:
  `btn-flag-bug` ("Bug", `onclick="flagBug()"`) and `btn-clear-bug`
  ("Bug fixed", `onclick="clearBug()"`, `display:none`).
- **Mobile bottom nav** (the agreed 5-slot swap):
  - new first `.bottom-tab` `data-bottom-tab="bug"` with `id="bottom-count-bug"`, `hidden`.
  - give the existing Closed bottom tab an id so it can be hidden.
  - add a Closed entry to `#bottom-more-popover` (hidden by default) so it stays
    reachable while displaced.

## 4. Client — `customer-service/dashboard/public/app.js`

- `QUEUE_TABS` (L3735): add `'bug'` so the open tab owns its own badge and
  `updateActiveTabCount` keeps the number matching the rendered rows.
- Restore list (L265): add `'bug'`.
- `loadStats`: `setTabCount('bug', s.bug)` — **required**, `dashboardHandlers.test.js`
  fails if a `tab-count-*` span exists with no matching `setTabCount` call — then
  `applyBugTabVisibility(s.bug)`.
- New `applyBugTabVisibility(count)`:
  - desktop tab `hidden = count === 0 && currentTab !== 'bug'`;
  - if `currentTab === 'bug' && count === 0` → `switchTab('new')`, then hide
    (guard the recursion) — never yank the tab out from under an open list;
  - mobile: show the Bug bottom tab and hide the Closed one when `count > 0`,
    unhide the popover's Closed entry, and reverse it at zero;
  - finish with `layoutNavOverflow()` (`writeTabCount` already calls it, but a
    visibility change alone does not).
- `flagBug()` / `clearBug()`, modelled on `pendTicket()` but with two deliberate
  differences: **no `advanceToNextTicket`** (you are usually still reading the
  draft) and no focus-time capture. Flag → toast → re-render the button row →
  `loadStats()`. Optional note via the existing `prompt()` pattern already used by
  `forwardTicket` / outreach pause — cancel still flags, so the fast path stays
  one click.
- Button visibility (~L1052, beside the On Me/Unpend block): `btn-flag-bug` when
  `!ticket.bug_flagged_at`, `btn-clear-bug` when flagged. No status condition —
  a closed ticket can be flagged and unflagged.
- `ticketCardHtml` (L746): push `<span class="badge badge-bug">bug</span>` into
  `row2Parts` whenever `t.bug_flagged_at`, so a bugged ticket is marked in New,
  On Me and Closed as well. In the Bug tab itself, mirror the parked pattern —
  a `bugAge()` helper alongside `parkedAge()` (L4199) rendering "Flagged 3 days ago"
  into the `timeStr` slot with fresh/aging/stale tiers.

## 5. Styles — `customer-service/dashboard/public/styles.css`

Mirror the On Me amber block at L243-267 in red: `.tab-bug`, `.tab-bug .tab-count`,
`.tab-bug.active .tab-count`, `.nav-more-menu .tab.tab-bug`, `.btn-bug`,
`.badge-bug`, `.badge-bug-{fresh,aging,stale}`. `#dc2626` on `#fee2e2`.

## 6. Daily digest — `reports/dailyOrderAlerts.js`

This is the half that works when Jamie is not in the dashboard, and it is the
direct answer to "I forget this one has a bug".

- Fetch alongside the existing `pending_operator` query (~L758): tickets with
  `bug_flagged_at not null`, ordered ascending, selecting `bug_note` too.
  Fail-soft `try/catch`, same as its neighbours.
- Render a **Bugs (waiting on a fix)** section immediately before On Me, reusing
  the On Me card shape (~L471): deep link, `Nd flagged` age chip reddening past 5
  days, order number, email, and the note. Add to `summaryParts`.
- A flagged ticket that is already **closed** still appears here on purpose —
  that is the most forgettable case of all.

## 7. Tests

- `customer-service/test/dashboardHandlers.test.js` covers the wiring for free:
  the inline-handler scan catches a missing `flagBug`/`clearBug`, and the badge
  test fails if the span and the poll write do not both exist.
- New `customer-service/test/bugFlag.test.js`, stubbed Supabase in the style of
  `apiCloseDraft.test.js`:
  - flag sets `bug_flagged_at` and stores the note;
  - re-flagging an already-flagged ticket updates the note and **leaves the
    timestamp alone**;
  - clear nulls both;
  - **neither handler ever writes `status` or `active_draft_id`** — this is the
    invariant that keeps the feature orthogonal, and it is the one a future edit
    is most likely to break by copying the On Me handler wholesale.
- Run the suite before and after: `node --test customer-service/test/*.test.js`.

## 8. Optional, easy to cut

An MCP tool listing flagged tickets with their notes, so a fix session can ask
"what is bugged?" rather than waiting for a screenshot, and clear the flag when
the fix ships. Genuinely closes the loop, but the tab is useful without it and
`scripts/sb.js` answers the same question today. Drop it if you want this small.

---

## Verification

1. Apply the SQL in the Supabase editor; confirm the columns exist
   (`node scripts/sb.js "sb.from('cs_tickets').select('id,bug_flagged_at,bug_note').limit(1)"`).
2. Restart the dashboard with `scripts/restart-dashboard.sh` (never by port) and
   confirm exactly one process plus a healthy `/health`.
3. With no bugs flagged: the Bug tab is absent from the header and the bottom bar
   shows New / Follow-up / Closed / Ad Hoc / More unchanged.
4. Flag a bug on an **open** ticket: the tab appears leftmost with a red `1`, the
   ticket still sits in New carrying a red `bug` badge, and it also appears in the
   Bug tab. Narrow the window until the header overflows — Bug must stay visible
   while later tabs fold into More.
5. Send & close that ticket: it leaves New, stays in the Bug tab, and the Bug
   button in the detail panel still offers "Bug fixed".
6. Flag a second bug on a ticket that is already **closed** — proves the tab is
   status-independent.
7. Mobile (or a narrow viewport): Bug takes the first bottom slot, Closed moves
   into More, and both revert when the last flag clears.
8. Clear the last flag **while the Bug tab is open**: it switches to New and the
   tab disappears rather than stranding an empty list.
9. `node reports/dailyOrderAlerts.js` (dry/print mode) and confirm the Bugs
   section renders with the age chip and note.
10. `node --test customer-service/test/*.test.js` — all green.

## Memory delta at close-out

One line in `domain_cs.md` Key Decisions beside the existing `pending_operator` /
On Me entry: Bug is a flag rather than a status, and why (a bug outlives the
conversation state, so the marker has to survive send-and-close). Nothing else —
the rest is implementation that lives in the code.
