# B2B post-call follow-up + composer templates

Locked with Jamie 2026-09-03. Design record for the build; code is truth once shipped.

## Problem

A booked meeting suppresses the cadence (correct), but once the meeting passes nothing
resurfaces the company — Unity Conejo's call happened Aug 31 and the engine went silent.
The original meeting-scheduling plan had `post_call_followup` and cut it for scope.
Separately: continuations are operator-written (2026-09-02 initiate-vs-continue), but the
common continuation shapes are near-boilerplate ("let's set up a call", "here's the
agreement + survey") and retyping them is waste.

## Decisions (all locked)

1. **Post-call follow-up is a queue signal, not a draft.** New cadence type
   `post_call_followup`: due the next business morning after a `b2b_meetings` row ends
   (`status='booked'`, `ends_at` past) with no outbound on the company since the meeting
   ended. Tier 1. NOT in `INITIATING_TYPES` — the nightly pass never drafts it; the entry
   opens the composer with the template picker, "Partner onboarding" pre-selected.
   Cleared by any outbound after the meeting end, or explicit dismiss (writes
   `b2b_meetings.status='followup_dismissed'` — no schema change; sending needs no write
   at all). Meeting fields go into `buildContexts` in the same change (the
   branches-only-read-what-buildContexts-sets trap).

2. **Templates are pure deterministic fill — no model call anywhere.** Every fillable
   piece is a mechanical lookup: contact first name, org name, country discount
   (`partnerDiscountPercent`), meeting day (from `b2b_meetings`, in their timezone),
   survey link. Call-specific content is an explicit highlighted
   `[YOUR NOTES FROM THE CALL — one or two lines]` slot. Rationale: the facts that matter
   happened on the call, which no model can see — same reasoning that made continuations
   operator-written. Template picking is itself the operator's judgment call.

3. **Picker lives on the composer everywhere**, not just post-call entries (the
   set-up-a-call template is used on Tier-1 replies — Youth OUTright, Le JAG shapes).
   Applying a template fills the same autosaving `b2b_drafts` compose row, records
   `template_id` in `structured`, and can write attachment specs (onboarding carries
   `kind: 'agreement'`, rendered fresh at send as today). Send is `sendDraftById`, so the
   follow-up ladder chases it (`post_call_followup` gets a `NEXT_ACTION_DAYS` entry).

4. **v1 templates (bodies drawn verbatim from Jamie's sent mail** — Youth OUTright +
   Le JAG 2026-09-03, Trans Closet of the Hudson Valley 2026-08-10; add more only as
   needed):
   - **Set up a call**: "Great to hear from you." + optional program-summary paragraph
     (donation routing + {discount}% purchase program), auto-included ONLY when no
     intro (`intro_outreach`/`intro_pitch`) was ever sent to the company — deterministic
     from `b2b_messages`, deletable in the composer. Then: "Let me know if you have 30
     mins sometime next week to chat. Feel free to suggest some times." Times are always
     theirs to suggest — never proposed (standing scheduling decision).
   - **Partner onboarding**: "Great talking with you on {meeting_day}." + notes slot +
     agreement attached + onboarding survey link
     (https://forms.gle/1Hq93BSiPrhJkgfB8) + "once I have the signed copy and the survey
     back…" + "{discount}% off retail" purchase line. Agreement and survey go in the
     SAME email (per the Hudson Valley precedent).

5. **Template quality signal**: `template_id` on the draft row means ai/template body vs
   `sent_body` diffs measure template drift the same way they measure advisor drift.

## Out of scope

- Reschedule/no-show handling beyond dismiss (manual for now).
- Retailer-flavored templates (add when a retailer call happens).
- Reopen-and-compose picker integration (parked item stands; picker makes it cheaper).

## done_when

- A company whose booked meeting has passed with no outbound since surfaces at Tier 1
  the next business morning as post-call follow-up, with no AI draft.
- Sending anything (or dismissing) clears it; a dismissed meeting never resurfaces.
- The composer offers the two templates on any company; applying "Partner onboarding"
  yields a filled body with the agreement spec attached to the compose row, and Send
  delivers it threaded with the PDF.
- Applying "Set up a call" includes the program summary iff no intro was ever sent.
- Tests cover: cadence due/cleared/dismissed logic, buildContexts meeting fields,
  template fill (both templates, intro-detection, discount by country, meeting-day
  rendering), and dashboard handler wiring stays green.
