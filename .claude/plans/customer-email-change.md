# Customer email-change: full flow (Shopify + merge, Klaviyo, Gorgias, mirror)

## Context

Ticket 3405 (ops.rubyshines.com/#ticket-3405): a customer wrote from a soon-to-be-dead school address asking that all correspondence go to a new gmail address. The advisor correctly staged `action_type: customer_profile_update` with `new_email`, but execution failed — the new address already belongs to another Shopify customer, `customerUpdate` returned "Email has already been taken," and the operator was told to sort it out manually. Klaviyo was never touched, the reply would still go to the dead old address, and the Supabase mirror forks into duplicate rows on every email change.

Goal: an email-change request is handled end-to-end by the existing `update_customer` tool — Shopify update **or profile merge** when the new email is taken, Klaviyo profile email update **or profile merge**, Gorgias customer update so the reply reaches the new address, and mirror hygiene — all behind the standard two-phase preview/confirm so one-click Execute & Send works.

Decisions locked with Jamie (2026-08-31):
- **Gorgias update included**, scoped to the case where the ticket came from the OLD address (ticket 3405's shape; when the customer writes from the new address the ticket already routes there).
- **On merge, the new-email profile's name survives by default** (the account the customer pointed us at wins email AND name); the phase-1 preview always shows both names so the operator can override before confirming.

## Verified current state

- [updateCustomer.js](customer-service/lib/tools/updateCustomer.js) — 72 lines, single-phase, Shopify-only. No "email taken" branch (raw userErrors string passthrough), no Klaviyo, no `confirmed` param.
- **Execute & Send structural mismatch**: `evaluateExecuteSendGate` ([dashboard/server.js](customer-service/dashboard/server.js) ~:2350) requires exactly one phase-1 "awaiting confirmation" preview. Single-phase `update_customer` executes in phase 1 → gate holds → the email never auto-sends even on success. Two-phase fixes this for free.
- Advisor prompt [aiAdvisor.js:1502-1514](customer-service/lib/aiAdvisor.js#L1502): `customer_profile_update` + past-tense reply; "account merges" currently listed as manual-in-Shopify. Operator agent prompt has zero `update_customer` guidance. `autoactionGate.js` keeps it NEVER_AUTO (unchanged).
- Shopify client is GraphQL 2025-10 ([shopify.js](customer-service/lib/shopify.js)) — `customerMerge`, `Customer.mergeable`, override fields all available, none wired. Merge blockers (verified enum): company contact, payment methods, gift cards, store credit, subscriptions, multipass, pending data request/redaction, merge in progress.
- [shared/klaviyoClient.js](shared/klaviyoClient.js) (revision 2024-10-15): profile lookup + subscribe/unsubscribe only. No profile PATCH, no merge. Klaviyo API supports `PATCH /api/profiles/{id}` (email change; duplicate-profile error carries the conflicting profile id) and `POST /api/profile-merge` (source merged into destination, source deleted, async).
- **Mirror bug**: [webhooks/handlers/shopifyCustomers.js:22-24](webhooks/handlers/shopifyCustomers.js#L22) upserts `customers` with `onConflict: 'email'` → email change creates a second row sharing one `shopify_customer_id`; old row orphaned forever. [webhooks/handlers/shopifyOrders.js:18-32](webhooks/handlers/shopifyOrders.js#L18) has the same upsert shape. No CUSTOMERS_DELETE webhook registered, so a merge loser's row also lingers.
- Two-phase convention to copy: [consolidateOrders.js](customer-service/lib/tools/consolidateOrders.js) (phase 1 stages server-side, preview text ends "awaiting confirmation" + `AUTO_CONFIRM` verdict line; phase 2 = `confirmed: true`).

## Design

### New lib: `customer-service/lib/emailChange.js`

Business logic lives here (MCP tool stays a thin wrapper), two functions mirroring the exchangeMath pattern:

**`planEmailChange({ customer_id, customer_email, new_email })`** — read-only phase 1. Gathers and returns a plan object:

```js
{
  old_customer: { id, email, firstName, lastName, numberOfOrders, amountSpent },
  new_email,
  shopify_conflict: null | {            // new email already a Shopify customer
    id, firstName, lastName, numberOfOrders, amountSpent,
    old_mergeable: { isMergeable, reason, errorFields },
    new_mergeable: { isMergeable, reason, errorFields },
  },
  mode: 'simple' | 'merge' | 'blocked', // blocked = conflict exists but non-mergeable
  blocked_reason: null | string,        // human sentence from errorFields
  klaviyo: {
    old_profile: null | { id, consent },   // email marketing consent state
    new_profile: null | { id, consent },
    plan: 'patch' | 'merge' | 'none',
  },
  gorgias_update_needed: bool,          // ticket/customer currently keyed to old address
}
```

Preview text renders both profiles side by side (names, order counts, spend — never shown to a customer, operator-only), the Klaviyo consent states with a warning when the surviving consent is weaker than the old one, what will happen in each system, and for merge mode: "the new-email profile's name (X) will survive; say 'keep the name <other>' to override." Ends with `AUTO_CONFIRM` verdict + "awaiting confirmation". Staged server-side (module-level map keyed on old customer id, like edit_order) so phase 2 needs only identifiers.

`mode: 'blocked'` renders the reason (e.g. "target profile has store credit — Shopify cannot merge these; handle manually in admin: <both admin links>") and stages nothing; the gate correctly holds.

**`executeEmailChange(staged, { name_override })`** — phase 2, in this order, each step recorded as `{ step, ok, detail }`:

1. **Shopify** (abort-on-failure — if this fails nothing else runs):
   - simple: `customerUpdate` email.
   - merge: `customerMerge(oldId, newId, overrideFields: { customerIdOfEmailToKeep: newId, customerIdOfFirstNameToKeep/customerIdOfLastNameToKeep: newId unless name_override })`, then poll the returned job (bounded ~20s, 2s interval); on timeout report "merge still processing in Shopify — re-check before retrying" rather than failing the rest.
2. **Klaviyo** (best-effort; failure reported, never blocks):
   - `patch`: update old profile's email to new.
   - If the PATCH returns the duplicate-profile error (or plan said `merge`): `mergeProfiles(destination = new-email profile, source = old profile)`.
   - `none` (no old profile): skip with note.
   - Never touch consent. Result notes both consent states; if the old profile was SUBSCRIBED and the surviving one is not, the result says so explicitly and tells the operator the customer must re-consent (we never auto-subscribe).
   - Ordering note: Klaviyo runs AFTER Shopify here because on the merge path the Shopify merge must succeed first; on the simple path a race with Klaviyo's own Shopify sync can at worst create a duplicate profile that our patch-then-merge fallback already handles on the next run — not worth two orderings.
3. **Gorgias** (best-effort): new `gorgiasClient.updateCustomerEmail(gorgiasCustomerId, newEmail)` (`PUT /customers/{id}`), only when `gorgias_update_needed`. Resolve the Gorgias customer id via the ticket, else `findOrCreateCustomer(old email)`. Per house rule this Gorgias write precedes the Supabase writes below.
4. **Supabase mirror** (best-effort): by `shopify_customer_id` — update the surviving row's email to `new_email`, delete any other `customers` rows holding that `shopify_customer_id` (the forked/loser rows). Update `cs_tickets.customer_email` for OPEN tickets on the old email (so follow-up sweeps and queue display route right); historical closed tickets/conversations keep the old email (they're records).

Tool result text carries per-step outcomes and the standard "filed into actions[]" narrative — attempts with outcomes, failures visible, matching the attempts-not-successes convention.

### Tool rework: `customer-service/lib/tools/updateCustomer.js`

- Add `confirmed` (and optional `keep_name: 'new' | 'original'`) to the schema. Name-only / no-email-change updates stay single-step but ALSO go two-phase for gate compatibility (preview is trivial: "will set name to X — awaiting confirmation").
- Handler: phase 1 → `planEmailChange` + preview; phase 2 → `executeEmailChange`.
- Rewrite the tool description (the text nearest the decision wins): states it handles taken-email merges itself, that phase 1 must be shown before phase 2, and that the operator never needs to route "email exists" cases away manually.

### Client additions

- [shopify.js](customer-service/lib/shopify.js): `getCustomerMergeable(customerId)` (query `customer { mergeable { isMergeable reason errorFields mergeInProgress { jobId } } }`), `customerMerge(idOne, idTwo, overrideFields)` (returns `{ jobId, resultingCustomerId }`), `pollJob(jobId, { timeoutMs })` (query `job(id:) { done }`). Reuse existing `getCustomerProfile` (shopify.js:1034) for the profile summaries.
- [shared/klaviyoClient.js](shared/klaviyoClient.js): `updateProfileEmail(profileId, email)` (`PATCH /api/profiles/{id}`; surface the duplicate-profile id from the 409 meta), `mergeProfiles(destinationId, sourceId)` (`POST /api/profile-merge`). Verify both endpoints accept revision `2024-10-15` at implementation; bump the pinned revision only if the merge endpoint requires it.
- [gorgiasClient.js](customer-service/import/gorgiasClient.js): `updateCustomerEmail(customerId, email)`.

### Advisor + operator prompt edits

- [aiAdvisor.js:1502-1514](customer-service/lib/aiAdvisor.js#L1502): unchanged action_type/fields/past-tense rule (Execute & Send runs the action before sending, so past tense stays true; on failure the email is held). Remove "account merges" from the manual-in-Shopify list **when part of an email change** — the tool now owns it; standalone merge requests stay manual.
- [operatorAgent.js](customer-service/lib/operatorAgent.js) system prompt: short new section for `update_customer` — it is two-phase like the other write tools; on "email already in use" the tool previews a merge, it is not an error to work around.
- Dashboard: no changes (prefill string unchanged; Execute & Send now completes because the tool emits a real phase-1 preview).

### Mirror hygiene (webhook fix + migration)

- Migration SQL (`webhooks/customers-unique-shopify-id.sql` or into the existing schema file): partial unique index on `customers(shopify_customer_id) WHERE shopify_customer_id IS NOT NULL`, preceded by a one-off cleanup of existing forked rows (keep the row matching the customer's current Shopify email; delete orphans).
- Shared helper `upsertCustomerRow(supabase, row)` in `webhooks/lib/` used by BOTH [shopifyCustomers.js](webhooks/handlers/shopifyCustomers.js) and [shopifyOrders.js](webhooks/handlers/shopifyOrders.js): resolve by `shopify_customer_id` first — if a row exists under a different email, UPDATE its email in place; else upsert `onConflict: 'email'` as today. Concurrency-safe under the unique index (per the idempotent-writes rule).
- The tool's own mirror step (execute step 4) does the immediate cleanup so nothing depends on webhook timing; the handler fix stops the fork from ever recurring (Shopify admin edits included).

### Scenarios covered

1. New email free everywhere → simple update, Klaviyo patch, done.
2. New email = another Shopify customer (ticket 3405) → merge preview → merge keeping new email + its name → Klaviyo merge/patch.
3. Non-mergeable (store credit, gift cards, subscriptions…) → `blocked` preview with reason + admin links; zero writes anywhere.
4. Klaviyo-only conflict → simple Shopify update + Klaviyo merge.
5. No Klaviyo profile for old email → skip, noted.
6. Consent asymmetry → surfaced, never auto-fixed.
7. Ticket from old (dead) address → Gorgias customer updated before the reply sends.
8. Same email / invalid email / customer not found → existing loud failures preserved.

## Files to change

- `customer-service/lib/emailChange.js` — new (plan/execute)
- `customer-service/lib/tools/updateCustomer.js` — two-phase rework + description
- `customer-service/lib/shopify.js` — mergeable/merge/job poll
- `shared/klaviyoClient.js` — profile patch + merge
- `customer-service/import/gorgiasClient.js` — updateCustomerEmail
- `customer-service/lib/aiAdvisor.js` — prompt lines ~1502-1514
- `customer-service/lib/operatorAgent.js` — prompt section
- `webhooks/lib/` shared customer upsert + both handlers
- migration SQL for the partial unique index + orphan cleanup
- tests (below)

## Tests

`customer-service/test/emailChange.test.js` with stubbed clients via the `require.cache` pattern ([resolveLineItems.test.js](customer-service/test/resolveLineItems.test.js) reference):
- simple plan (no conflicts) → `mode: 'simple'`, preview ends "awaiting confirmation"
- Shopify conflict, both mergeable → `mode: 'merge'`, both names in preview
- conflict, non-mergeable → `mode: 'blocked'`, reason rendered, nothing staged
- execute simple: order of writes, mirror update, per-step outcomes
- execute merge: overrideFields carry new-email id for email + name; `keep_name: 'original'` flips the name fields; job poll timeout reports rather than fails
- Klaviyo duplicate error → merge fallback; no old profile → skip
- consent asymmetry flagged in result text; no subscribe call ever made
- Shopify failure aborts (no Klaviyo/Gorgias/mirror calls); Klaviyo failure does NOT abort Gorgias/mirror
- update existing `updateCustomer.test.js` for the two-phase shape
- `webhooks/test` (or existing suite location): upsert helper — email change updates the existing row in place, no second row; both handlers use it

Run: `node --test customer-service/test/*.test.js` before and after.

## Verification (done_when)

1. Suite green.
2. Migration applied in Supabase; forked `customers` rows cleaned (query: shopify_customer_id with >1 row → zero).
3. On ticket 3405 via the dashboard: Execute & Send runs phase 1 (merge preview showing both profiles), confirms, and completes — Shopify shows ONE customer under sunshiny.nora@gmail.com with the order history, Klaviyo shows one profile under the new email, `customers` mirror has one row, and the reply goes out to the new address (Gorgias customer updated).
4. Close-out sweep: schema applied, tools registered (updateCustomer already spread into allTools — verify), deployed (push to main → Railway), memory delta proposed (domain_cs Key Decision on the email-change/merge design, one line).
