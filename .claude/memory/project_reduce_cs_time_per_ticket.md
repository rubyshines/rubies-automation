---
name: Reduce CS Time Per Ticket
description: Close measurement gaps and surface cumulative touch time so we can systematically drive Jamie's time-per-ticket down. Foundation for follow-on advisor/dashboard optimizations under the CS Automation initiative.
type: project
domain: cs
done_when: |
  focus_time_seconds captured on every terminal action (send, release, close, snooze, park, delete, spam, manual reply);
  localStorage persistence in place so browser reload/crash doesn't lose accumulated time;
  per-ticket cumulative ("Total close time") shown on stats page;
  "Time on CS today/this week" headline KPI on stats page;
  daily-cs-stats.js email reports total time alongside the existing average;
  domain_cs.md updated with a Key Files pointer to the touch-time pipeline so we never hunt for it again
originSessionId: 4141f8b1-c639-4f1b-afc7-05728f25419c
---
## Goal

Reduce the time Jamie spends serving customers. Anchor metric is operator touch time per ticket (`cs_ai_drafts.focus_time_seconds`, instrumented since 2026-04-16). Early trend is encouraging — week-over-week mean has dropped 99s → 91s → 76s. To drive that systematically we need the metric trustworthy, visible at the level of the goal (total time, not per-draft averages), and discoverable in memory.

This project is the foundation; follow-on optimization work iterates on the [CS Automation initiative](initiative_cs_automation.md).

Not part of [project_cs_efficiency.md](project_cs_efficiency.md) — that's API cost/latency, different metric.

## Where touch time lives today

| Layer | File | Notes |
|---|---|---|
| Schema | [customer-service/drafter/analytics-columns.sql:6](../../customer-service/drafter/analytics-columns.sql#L6) | `focus_time_seconds integer DEFAULT 0` on `cs_ai_drafts` |
| Client timer | [customer-service/dashboard/public/app.js:16-87](../../customer-service/dashboard/public/app.js#L16-L87) | `_focusAccumulated` map, 60s idle, mousemove/keydown activity, visibilitychange pause/resume |
| Client → server | [customer-service/dashboard/public/app.js:2299-2307](../../customer-service/dashboard/public/app.js#L2299-L2307) | Currently only attached on `sendDraft()` |
| Server save | [customer-service/dashboard/server.js:281](../../customer-service/dashboard/server.js#L281) | `apiSendDraft` writes to draft row |
| Stats KPI | [customer-service/dashboard/server.js:855-866, 907](../../customer-service/dashboard/server.js#L855-L866) (daily), [938-948, 1019, 1045](../../customer-service/dashboard/server.js#L938-L948) (range) | `avg_focus_time_seconds` |
| Per-ticket field | [customer-service/dashboard/server.js:1069-1098](../../customer-service/dashboard/server.js#L1069-L1098) | One value per draft (no rollup yet) |
| Stats page UI | [customer-service/dashboard/public/stats.js:25, 173, 226-238](../../customer-service/dashboard/public/stats.js) | `formatFocusTime()` helper + KPI + table column |
| Daily email | [analytics/daily-cs-stats.js:97-110](../../analytics/daily-cs-stats.js#L97-L110) | Average across yesterday's sent drafts |
| Ad-hoc analysis | [scripts/_focus_time_trend.js](../../scripts/_focus_time_trend.js) | Per-day / per-week / per-message-type / per-ticket rollup |

## Recommended approach

Three small, independent changes shippable in one PR. No schema changes — sum-on-read.

### Change 1 — Capture time on every terminal action

**Server** ([customer-service/dashboard/server.js](../../customer-service/dashboard/server.js)): extend the existing `focus_time_seconds` write pattern from `apiSendDraft` (line 281) to `apiReleaseDraft`, `apiCloseDraft` (+ ticket-level `/close` wrapper), and the ticket-level snooze / park / delete / spam handlers. For `apiSendTicketMessage` (line 2006), write to the active draft row if one exists, otherwise create a lightweight draft row with `draft_kind='manual_send'`, `status='sent'`, empty `draft_response`, `sent_response=body` to anchor the focus time.

**Client** ([customer-service/dashboard/public/app.js](../../customer-service/dashboard/public/app.js)): every action call site that posts to one of those endpoints needs three lines — read `getFocusTime(ticketId)`, include `focus_time_seconds` in the body, call `clearFocusTime(ticketId)` after success. Replicate the `sendDraft` pattern in `releaseDraft`, `markSpam`, `deleteDraft`, `snoozeNoReply`, `closeNoReply`, `parkTicket`/`unparkTicket`. `sendTicketMessage` already includes it client-side (line 2307); just needs the server side wired.

### Change 2 — localStorage persistence

In [app.js:16-87](../../customer-service/dashboard/public/app.js#L16-L87), back `_focusAccumulated` with localStorage: write on `_accumulateFocus()` (already throttled — fires on idle, tab-hide, ticket-switch); restore at module init; clear on `clearFocusTime`; 24h TTL on entries.

### Change 3 — Surface "total time" as the headline metric

**Server**: `apiGetStatsTickets` (line 1051) — add `total_focus_time_seconds = sum(focus_time_seconds)` per ticket alongside the existing per-draft value. Reuses the `redirectsByTicket` aggregation pattern. `apiGetStatsDaily` and `apiGetStatsRange` — return `total_focus_time_seconds` (sum across all drafts) alongside the existing average.

**Stats page** ([stats.js](../../customer-service/dashboard/public/stats.js), [stats.html](../../customer-service/dashboard/public/stats.html)):
1. New headline KPI "Time on CS today" — sum of all today's focus time, formatted via `formatFocusTime()`. Promote above (or replace) "Avg focus time".
2. New "Total" column in today's tickets table — per-ticket cumulative across drafts.
3. Trends tab — small text block: "Time on CS this week: X hours" with delta vs prior week.

**Daily email** ([analytics/daily-cs-stats.js:97-110](../../analytics/daily-cs-stats.js#L97-L110)): add "Total time on CS yesterday: Xm Ys" line under the existing avg.

## Files to modify

- [customer-service/dashboard/server.js](../../customer-service/dashboard/server.js)
- [customer-service/dashboard/public/app.js](../../customer-service/dashboard/public/app.js)
- [customer-service/dashboard/public/stats.js](../../customer-service/dashboard/public/stats.js) and [stats.html](../../customer-service/dashboard/public/stats.html)
- [analytics/daily-cs-stats.js](../../analytics/daily-cs-stats.js)

## Verification

1. Run existing test suite: `node --test customer-service/test/*.test.js`.
2. Manual end-to-end:
   - Open ticket, wait ~30s, send draft → `focus_time_seconds` saved (regression check).
   - Open ticket, wait ~30s, click Release → saved on draft.
   - Open ticket, wait ~30s, refresh page → focus time restored from localStorage; click Send → time intact.
   - Open ticket, send manual reply (no draft path) → new `manual_send` draft row written.
3. Stats page: load `/stats`, verify "Time on CS today" KPI populates, "Total" column shows sums per ticket, weekly total appears on trends tab.
4. Daily email: check next morning's email for the total-time line.
5. Coverage check: `node scripts/_focus_time_trend.js` after 1-2 days — coverage % should approach 100%.

## On project completion

- Add to [domain_cs.md](domain_cs.md) Key Files: one-line pointer to the touch-time pipeline (the table above is the canonical reference).
- Add to [domain_cs.md](domain_cs.md) Key Decisions: "active operator engagement per ticket: accumulated mouse/keyboard time with 60s idle pause, captured on every terminal action, persisted to localStorage, summed across drafts for ticket totals. Headline metric is total time on CS per day/week."
- Add a progress bullet to [initiative_cs_automation.md](initiative_cs_automation.md) Current Status — touch-time visibility now reliable, baseline trend established.
- Delete this project file.
- Remove from MEMORY.md Active Projects.

## What's skipped / why

- **Per-activity-type buckets (read vs compose):** noisy signal, no decision drives off it.
- **Triage-time on the queue page:** different metric, would conflate.
- **`cs_tickets.total_focus_time_seconds` denormalized column:** premature at current volume; sum-on-read is cheap.
- **Resetting `focus_time` on draft refresh:** current cross-redraft accumulation is correct — that *is* operator effort on the ticket.
- **`focus_time_seconds` on `cs_ai_feedback_log`:** considered, not needed — the cs_ai_drafts join is already in place.
