---
name: free-swimwear-repeats
domain: community
done_when: >
  Duplicate / repeat free-swimwear applications are handled automatically — same-day
  resubmits collapse to one, same-recipient repeats within 1 year are closed with a
  friendly "reapply after <date>" email (not silent), different children on one email
  stay separate (flagged), and the review queue shows one active entry per recipient.
  Verified with a same-day double, a within-year repeat, and a two-kids-one-email case.
metadata:
  type: project
  domains: [community]
  last_updated: 2026-06-29
---

# Free Swimwear — duplicate / repeat-applicant handling

## Why
The program now imports every Form Responses submission. People submit more than once,
and the same email is reused for genuinely different recipients. We need to handle this
without (a) creating duplicate queue entries, (b) silently dropping people, or
(c) wrongly merging two different kids.

## What the data shows (analyzed 2026-06-29)
- 87 emails have >1 application.
- An Opus pass over all 87 found **~15–17 emails with genuinely DIFFERENT recipients**
  (siblings or parent+child), e.g. `saduncan9` = Sarah *and* Lyra Duncan; `kellirenee85`
  = Kelli *and* Zoe; adult-44 + child-17 on one email. So **collapsing by email alone is
  wrong** — it would merge real siblings.
- The form's name field is used inconsistently (sometimes the parent, sometimes the
  child) and age drifts year to year, so recipient identity is **fuzzy** → an AI judgment
  is the right tool to decide "same recipient vs different" (fits the AI-first principle).

## Locked design (Jamie, 2026-06-29)
Person identity = `(email, recipient)`, where "same recipient" is decided by AI when an
email already has prior applications. One **active** application per recipient per **1 year**
(window counts from the *last* application regardless of its outcome).

Decision flow at intake for a submission whose email already exists:
1. **Same recipient + same day** (accidental double / correction resubmit) → collapse to
   one, keep the **newest**, silently. (e.g. jennifer ~1h apart; LeAndra ~2.3h apart.)
2. **Same recipient + < 1 year** (too-soon repeat) → **do not** add an active queue item;
   set a closed status (`repeat`), and **send a friendly email**: "you've already applied —
   you're welcome to reapply after `<lastApplication + 1yr>`." (NOT silent — this was the
   explicit ask.)
3. **Same recipient + > 1 year** → allowed; new queue item, badge "received before on
   `<date>`" (and "already received" if a prior application reached `ordered`).
4. **Different recipient, same email** (different child) → valid new application; badge
   "⚠️ possible 2nd child — review".

Distinct from the existing **ineligible** path (Brazil / not-trans), which stays a
**silent** `rejected` with no email.

## Open items to confirm before/at build
- **Reapply email:** either Jamie creates a SendGrid dynamic template (give the `d-` id,
  like the acceptance one) OR draft brand-voice copy and send a plain templated email from
  **care@rubyshines.com** (no em dashes; warm, supportive). Needs a merge field for the
  reapply date. Default if unspecified: draft copy + send from care@.
- **Window = 1 year**, from last application (confirmed in principle; verify at build).
- Too-soon repeats and already-received: **close + email** (do not leave in the active
  queue), but keep visible under a filter (e.g. `repeat` / `archived`) for audit.

## Build sketch
- Intake/eligibility step (in `freeSwimwearSurvey.js` / the sync) gains a repeat check:
  for a new row, fetch prior rows for the same email; if any, an Opus call (component
  `free_swimwear_recipient_match`) classifies same-vs-different recipient; then apply the
  flow above to set status (`new` | `repeat` | collapse) + flags.
- New statuses/flags: `repeat` (closed, emailed); a `possible_second_child` boolean/flag
  surfaced as a queue badge; store `prior_application_at` / `prior_status` for the badge.
- New email: `sendRepeatNotice(row, reapplyDate)` in `freeSwimwear.js` (mirror
  `issueAcceptance`/`sendResend`; record the 2xx).
- Dashboard: badges for "possible 2nd child", "already received", "repeat — emailed"; a
  `repeat` filter chip.
- Tests: same-day collapse; within-year repeat → `repeat` + email; >1yr allowed;
  different-recipient kept + flagged. (Recipient-match AI mocked in tests.)

## Guardrails
- Never merge two different recipients — when AI is unsure, prefer "different" + flag for
  human review rather than collapsing.
- Same person, different email is out of scope (can't dedupe reliably; accept the gap).
- Keep identity on `(email, submitted_at)` + America/Toronto timestamp parsing (see
  `domain_community.md` Key Decisions) — do not regress that while adding this.
