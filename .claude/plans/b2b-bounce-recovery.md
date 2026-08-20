# B2B outreach — bounce detection and draft recovery

**Status:** planned, not built
**Domains:** b2b_sales, community
**Written:** 2026-08-20

## The goal, in one line

When an outreach email hard-bounces, the message Jamie approved comes back into the
queue marked bounced, with the dead address retired and reachable alternates offered,
so he can repoint it and resend in one pass. Nothing auto-sends.

## What happened (the case this is built from)

The 2026-08-19 partner check-in round sent **17 emails** through the engine. Two
hard-bounced within seconds, both permanent 5xx:

| Company | Address | Code | Meaning |
|---|---|---|---|
| Valid USA | `ax.switzer@validbybrodie.com` | 5.1.1 | account does not exist |
| BAGLY | `lflynn@bagly.org` | 5.2.1 | account inactive |

That is a **12% bounce rate on the round**, against the ~2% that starts damaging
sender reputation on `rubyshines.com` — the same domain Klaviyo uses for customer mail.

Neither bounce reached the outreach engine. `contact_unknown` is false on both
companies, no `b2b_messages` row exists for either bounce, and BAGLY's
`next_action_date` was stamped **2027-02-15** by the send. The engine believes the
check-in landed and will not look at BAGLY again for six months.

## Why nothing fired

The detection code is present and correct. `detectContactLoss`
(`b2b-outreach/lib/replyCorrelation.js`) matches both bounce bodies on sender +
"Address not found" + "550". **It has never run in production.**

Its only production call site is `webhooks/handlers/gmailPush.js:206`, one line under:

```js
if (m.is_sent || m.is_auto_reply) continue;   // gmailPush.js:204
```

The Gmail intake classifier marks mailer-daemon DSNs `is_auto_reply: true`. A bounce
is therefore exactly the message shape that can never reach the bounce detector. Both
the `hard_bounce` branch of `detectContactLoss` and the mailer-daemon correlation
branch inside `correlateInbound` have been unreachable since they were written.

There is no second net. Per the per-message thread-membership rule,
`discoverCompanyThreads` imports a message only when a company address appears in
from/to/cc. A bounce is *from* mailer-daemon *to* jamie@; the dead address appears
only in the body. So the bounce is absent from the panel's conversation history too —
the thread reads as "we sent a warm check-in, silence."

Same self-certifying-silence family as the partial-index upsert and the leaked claim:
a path that logs nothing and writes nothing looks identical to a path with no work to do.

## What is already in our favour

- **The approved text survives the send.** `b2b_drafts` #92 (BAGLY) is
  `status: 'sent'` with `sent_subject` / `sent_body` holding the exact text that went
  out, and `operator_edited: true`. Jamie rewrote the AI's draft substantially, so
  **recovery must seed from `sent_body`, never from `body`.**
- **A resend-to-a-different-address path already exists.** `sendB2bEmail` accepts
  `to_override`, fed from `draft.structured.to` by `sendDraftById`.
- **Retiring a contact already exists.** `updateContact.js` deactivates rather than
  deletes, keeps the person visible in the panel's "former" group, and offers restore.
- **BAGLY already has an alternate on file:** `info@bagly.org` (active, non-primary).
  `agonzales@bagly.org` appears on a 2024 thread but is not in `b2b_contacts`.

## Design

### 1. Let DSNs past the gate

`is_auto_reply` is the right filter for out-of-office and wrong for a delivery
failure. In `gmailPush.js`, route mailer-daemon / postmaster senders into
`correlateInbound` regardless of `is_auto_reply`. Nothing else in this plan works
without it.

### 2. Correlate on the failed recipient, not the sender

Parse `Final-Recipient: rfc822; <addr>` (and the `Status:` / `Diagnostic-Code:` lines)
out of the DSN body. Both current bounces did land on their original Gmail thread, so
the existing thread-id branch would have correlated the *company* — but only
Final-Recipient identifies **which address died**, which is what everything below
depends on.

Distinguish permanent from transient: 5.x.x is permanent and acts; 4.x.x is a
deferral and must not retire anybody. Note from the CS-side parked entry: Microsoft
consumer domains return the same wording for "no such user" and "blocked", so read
the code, not the prose.

### 3. The sent message is currently a lie — mark it undelivered

`b2b_messages` #3705 asserts we communicated with BAGLY on 2026-08-19. It has no
delivery-status column, and three things read it as truth:

- `lastOutboundAt` → the cadence believes contact was made
- `relationshipSummary.js` → will narrate "we checked in on Aug 19"
- Tier 1's `lastInbound > lastOutbound` comparison

Add a delivery-status marker on `b2b_messages` (nullable, so every existing row means
"no bounce known" rather than requiring a backfill) and make those three readers
respect it. Without this the record stays wrong even after a successful resend: it
would show two check-ins where only one arrived.

### 4. Revive the draft as a NEW pending row — never flip the original back

**Do not** set draft #92 back to `pending`. `sent_at`, `operator_edited`,
`sent_subject` and `sent_body` are the operator-edit training signal, the
`b2b_messages` row points at that send, and a second send through `sendDraftById`
would overwrite `sent_body` and destroy the record of the first attempt.

Instead clone: a new `b2b_drafts` row, `status: 'pending'`, `subject`/`body` seeded
from the original's `sent_subject`/`sent_body` (Jamie's text, including his edits),
carrying the original's `advisor` value forward so the training signal stays honest,
plus a link back to the bounced draft id. The original stays `sent` as the historical
record of what was attempted and failed.

`queue_reason` on the new row carries the bounce, since `mergePendingDraftEntries`
renders the tier and reason frozen on the draft row.

### 5. Retire the dead address; do not mute the company

"This mailbox is dead" and "we do not know who to talk to" are different facts. Today
a detected bounce sets `contact_unknown: true`, which makes `companyEligible` return
false (`cadence.js:131`) and drops the company out of the queue entirely — and nothing
in the panel renders `contact_unknown`. **A detected bounce today would silently mute
a partner, which is worse than the current miss.**

So: deactivate the bounced contact row via the existing retire path. `resolveRecipient`
then naturally falls through to the next active contact. Set `contact_unknown` **only
when no reachable address remains** — which is the honest meaning of the flag.

Also roll back `next_action_date` (`nextActionDateAfterSend` stamped it on a message
that never arrived). Six months of quiet must not be bought by a failed send.

### 6. Surface it as work, above the eligibility gate

**LOCKED: Tier 1, with its own reason string.** A bounce is not literally a person
waiting, but it is the same obligation — a message we believe we sent and did not.
It gets Tier 1 priority and a reason that never reads like a reply:

> check-in bounced — `lflynn@bagly.org` is inactive; try `info@bagly.org`

**Structural warning:** this must be a `computeQueueEntry` branch **above** the
`companyEligible` gate, alongside Tier 1. Put it below and a company whose only
remaining state is `contact_unknown` writes a disposition nothing ever renders — the
identical trap that made the first pause/snooze build appear to do nothing.

Tier 1's sort is oldest-`waiting_since`-first, so a bounced entry needs a
`waiting_since` (the failed send's `sent_at`) or it sorts undefined against real
replies.

### 7. Alternates are suggested, never used automatically

Offer, in the panel, ranked: active non-primary contacts on the company, then
addresses seen in from/to on the company's historical `b2b_messages` (this is where
`agonzales@bagly.org` comes from), then `general_email`, then `contact_form_url`.

Suggest only. Auto-resending to a guessed address is how a 12% bounce round becomes a
20% one, and unverified addresses are the thing that actually burns sender reputation.
Repointing uses the existing `structured.to` → `to_override` path.

### 8. Replay: correlation needs a catch-up path, not a one-off script

**LOCKED: the two live cases are repaired by the build, not by hand** — that is the
end-to-end proof it works. Both bounces are already in `email_messages` with
`processed_at` set and Pub/Sub will not redeliver them, so the build has to be able to
reach backwards.

This is a genuine gap rather than test scaffolding. The correlation step in
`gmailPush` is fire-and-forget: it keeps no record of which messages it considered, so
anything it skips (as it skipped every bounce ever received) or errors on is never
retried and leaves no trace. Same silent-failure shape as the bug itself.

So build a replay over stored `email_messages` — select candidates, run them through
the same `correlateInbound` the push path uses, idempotent on `gmail_message_id` (the
existing UNIQUE already makes re-runs safe). Repairing BAGLY and Valid USA is then its
first real run rather than a hand-patch, and it is the only honest way to verify the
whole chain: gate → parse → mark undelivered → retire address → clone draft → queue.

Scope it to a bounded lookback rather than the whole table, and have it report what it
matched and what it could not — a replay that silently correlates nothing is
indistinguishable from one with nothing to do, which is the mistake being fixed.

Expected outcome of the first run, as the acceptance test:

- BAGLY: `lflynn@` retired, `info@bagly.org` becomes reachable, draft #92's text
  returns as a new pending draft, company appears at Tier 1 "bounced", 2027-02-15
  rolled back, `b2b_messages` #3705 marked undelivered
- Valid USA: same, except no alternate is on file — so it should surface as bounced
  **and** unreachable, which is the case that must not silently vanish

## Tests

Per the deterministic-code rule, all of these are pure-function tests:

- DSN parsing: Final-Recipient extraction, 5.x.x vs 4.x.x, both real bodies as fixtures
- `detectContactLoss` reached through the real gmailPush filter shape (the bug was the
  gate, not the detector — a test of the detector alone would have stayed green)
- Queue: a bounced company surfaces despite `companyEligible` false
- Clone: original draft retains `sent_body` / `operator_edited` after revival
- Retire: last reachable contact is not removed; `contact_unknown` set only when empty

## Decisions locked (2026-08-20)

1. **Tier 1 with its own reason string** — see §6. Not a new tier.
2. **Repair happens through the build, via the replay path** — see §8. No hand-patching.

## Still open

**Pre-send address verification** (phase 5 of the parked *B2B lead supply* entry) —
deliberately OUT of this build. It is a vendor decision plus an integration, and it is
orthogonal to draft recovery. Recorded here so the reasoning is not re-derived:

- *Syntax + MX lookup* (free) would NOT have caught either 19 Aug bounce — `bagly.org`
  and `validbybrodie.com` both publish working MX; the individual mailboxes were dead.
  Worth having as a cheap guard against typos and dead domains, not as the answer.
- *SMTP probe / verification API* (ZeroBounce, Kickbox, NeverBounce, ~$0.005/address)
  WOULD have caught both, because the probe gets the same 5.1.1 / 5.2.1 the real send
  did.
- *Daily send cap in `sendB2bEmail`* bounds blast radius without verifying anything.

The higher-value version is not per-send checking but a **one-time bulk verification
pass over all `b2b_contacts`**: 242 companies hold addresses of unknown age, and
contact churn is the standing risk on the org side (Oasis handed off, Carleton's is a
yearly student post, Valid USA's contact left the state). A bulk pass converts a 12%
surprise into a known list of dead addresses before we write to anyone. Proposed as
the immediate follow-on to this build.

## Related

- Parked: *B2B lead supply — remaining plan phases* (phase 5: send rate + verification)
- Parked: *A bounced reply auto-closes the ticket and the customer silently disappears*
  — same class on the CS side, with a useful diagnostic note on reading bounce reasons
- `initiative_lgbtq_partnerships.md` — contact churn already flagged as the standing risk
