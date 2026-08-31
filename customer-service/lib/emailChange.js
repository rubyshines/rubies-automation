/**
 * Customer email change — plan/execute pair behind the update_customer tool.
 *
 * Handles the full flow, not just the Shopify field write:
 *  - simple: new email is free → customerUpdate
 *  - merge:  new email already belongs to another Shopify customer →
 *            customerMerge keeping the new email (and, by default, the
 *            new-email profile's name — the account the customer pointed us at)
 *  - blocked: the profiles can't merge (gift cards, store credit,
 *            subscriptions, …) → report why, write nothing anywhere
 * plus Klaviyo (profile email patch, or profile merge when both addresses
 * exist), Gorgias (so the reply to the very ticket asking for the change
 * reaches the new address when the customer wrote from the old one), and the
 * Supabase mirror (which otherwise forks into two rows on an email change).
 *
 * Klaviyo consent is never changed here: a merge keeps the destination
 * profile's consent, and an address that never opted in is never subscribed.
 * When the old address was subscribed and the surviving one is not, that is
 * surfaced to the operator instead of "fixed".
 */

const {
  searchCustomers,
  getCustomerProfile,
  updateCustomer,
  getCustomerMergeable,
  customerMerge,
  pollShopifyJob,
} = require('./shopify');
const { searchCustomersFromSupabase } = require('./supabaseQueries');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getKlaviyoClient } = require('../../shared/klaviyoClient');
const gorgias = require('../import/gorgiasClient');

// Staged phase-1 plans, keyed on `${oldEmailOrId}|${newEmail}` (lowercased) so
// phase 2 only needs the same identifiers back. Same pattern as
// consolidateOrders' pendingConsolidations.
const pendingChanges = new Map();

function stageKey({ customer_id, customer_email, new_email }) {
  return `${(customer_email || customer_id || '').toLowerCase().trim()}|${(new_email || '').toLowerCase().trim()}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function resolveCustomerId({ customer_id, customer_email }) {
  if (customer_id) return customer_id;
  if (!customer_email) throw new Error('Provide customer_id or customer_email');
  let matches = await searchCustomersFromSupabase(customer_email);
  if (!matches.length) matches = await searchCustomers(`email:${customer_email}`);
  const exact = matches.find(c => (c.email || '').toLowerCase() === customer_email.toLowerCase());
  if (!exact) throw new Error(`No customer found for email ${customer_email}`);
  return exact.id;
}

function profileSummary(c) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)';
  const spent = c.amountSpent ? `${c.amountSpent.amount} ${c.amountSpent.currencyCode}` : '0';
  return `${name} — ${c.numberOfOrders ?? '?'} orders, ${spent} spent`;
}

function mergeBlockReason(who, mergeable) {
  const fields = (mergeable?.errorFields || []).join(', ');
  return `${who} profile can't be merged${mergeable?.reason ? `: ${mergeable.reason}` : ''}${fields ? ` (${fields})` : ''}`;
}

function consentOf(profile) {
  return profile?.attributes?.subscriptions?.email?.marketing?.consent || 'NEVER_SUBSCRIBED';
}

/**
 * Phase 1: read-only. Gathers state across Shopify, Klaviyo, and Gorgias and
 * returns { plan, preview } — preview is the operator-facing text ending in
 * "awaiting confirmation". Throws on unresolvable customer / invalid input.
 */
async function planEmailChange({ customer_id, customer_email, new_email, new_first_name, new_last_name }) {
  const newEmail = (new_email || '').toLowerCase().trim();
  if (!EMAIL_RE.test(newEmail)) throw new Error(`"${new_email}" is not a valid email address`);

  const oldId = await resolveCustomerId({ customer_id, customer_email });
  const oldCustomer = await getCustomerProfile(oldId);
  if (!oldCustomer) throw new Error(`Customer ${oldId} not found in Shopify`);
  const oldEmail = (oldCustomer.email || '').toLowerCase();
  if (oldEmail === newEmail) throw new Error(`The customer's email is already ${newEmail} — nothing to change`);

  // --- Shopify conflict check -------------------------------------------
  const candidates = await searchCustomers(`email:${newEmail}`);
  const conflict = candidates.find(c => (c.email || '').toLowerCase() === newEmail) || null;

  let mode = 'simple';
  let blocked_reason = null;
  let mergeables = null;
  if (conflict) {
    const [oldMergeable, newMergeable] = await Promise.all([
      getCustomerMergeable(oldId),
      getCustomerMergeable(conflict.id),
    ]);
    mergeables = { old: oldMergeable, new: newMergeable };
    if (oldMergeable?.isMergeable && newMergeable?.isMergeable) {
      mode = 'merge';
    } else {
      mode = 'blocked';
      blocked_reason = [
        !oldMergeable?.isMergeable ? mergeBlockReason(`The current (${oldEmail})`, oldMergeable) : null,
        !newMergeable?.isMergeable ? mergeBlockReason(`The target (${newEmail})`, newMergeable) : null,
      ].filter(Boolean).join('; ');
    }
  }

  // --- Klaviyo ----------------------------------------------------------
  const klaviyo = getKlaviyoClient();
  let klaviyoState = { configured: false, old_profile: null, new_profile: null, plan: 'none' };
  if (klaviyo) {
    const [oldProfile, newProfile] = await Promise.all([
      klaviyo.getProfileByEmail(oldEmail).catch(() => null),
      klaviyo.getProfileByEmail(newEmail).catch(() => null),
    ]);
    klaviyoState = {
      configured: true,
      old_profile: oldProfile ? { id: oldProfile.id, consent: consentOf(oldProfile) } : null,
      new_profile: newProfile ? { id: newProfile.id, consent: consentOf(newProfile) } : null,
      plan: !oldProfile ? 'none' : (newProfile ? 'merge' : 'patch'),
    };
  }
  // The surviving consent after this change: patch keeps the profile (and its
  // consent); merge keeps the destination's. A subscribed old address feeding a
  // never-subscribed survivor is the case worth warning about.
  const survivingConsent = klaviyoState.plan === 'merge'
    ? klaviyoState.new_profile.consent
    : klaviyoState.old_profile?.consent || null;
  const consent_warning = klaviyoState.plan === 'merge'
    && klaviyoState.old_profile.consent === 'SUBSCRIBED'
    && survivingConsent !== 'SUBSCRIBED';

  // --- Gorgias ----------------------------------------------------------
  // Only rewire Gorgias when the customer exists there under the OLD address
  // and the new address has no Gorgias customer of its own (if they wrote from
  // the new address, replies already route there).
  let gorgiasState = { old_customer_id: null, new_exists: false, update_needed: false, note: null };
  try {
    const [gOld, gNew] = await Promise.all([
      gorgias.findCustomerByEmail(oldEmail),
      gorgias.findCustomerByEmail(newEmail),
    ]);
    gorgiasState = {
      old_customer_id: gOld?.id || null,
      new_exists: !!gNew,
      update_needed: !!gOld && !gNew,
      note: gOld && gNew
        ? 'Both addresses exist as separate Gorgias customers — not auto-merged; replies to existing old-address tickets still go to the old address.'
        : null,
    };
  } catch (err) {
    gorgiasState.note = `Gorgias lookup failed (${err.message}) — reply routing not checked.`;
  }

  const plan = {
    mode,
    blocked_reason,
    old_customer: {
      id: oldCustomer.id,
      email: oldEmail,
      firstName: oldCustomer.firstName,
      lastName: oldCustomer.lastName,
      summary: profileSummary(oldCustomer),
    },
    new_email: newEmail,
    new_first_name: new_first_name || null,
    new_last_name: new_last_name || null,
    shopify_conflict: conflict ? {
      id: conflict.id,
      firstName: conflict.firstName,
      lastName: conflict.lastName,
      summary: profileSummary(conflict),
      mergeables,
    } : null,
    klaviyo: { ...klaviyoState, consent_warning },
    gorgias: gorgiasState,
  };

  return { plan, preview: renderPreview(plan) };
}

function renderPreview(plan) {
  const lines = [`**Email change: ${plan.old_customer.email} → ${plan.new_email}**`, ''];

  if (plan.mode === 'blocked') {
    lines.push(`⚠️ The new address already belongs to another Shopify customer (${plan.shopify_conflict.summary}), and Shopify refuses to merge these profiles:`);
    lines.push(`- ${plan.blocked_reason}`);
    lines.push('');
    lines.push('Nothing was changed in any system. This one needs manual handling in the Shopify admin (resolve the blocker or move the order history by hand).');
    return lines.join('\n');
  }

  if (plan.mode === 'merge') {
    lines.push('The new address already belongs to another Shopify customer. The two profiles will be **merged into one** (order history combines, cannot be undone):');
    lines.push(`- keep: ${plan.new_email} — ${plan.shopify_conflict.summary}`);
    lines.push(`- fold in: ${plan.old_customer.email} — ${plan.old_customer.summary}`);
    const survivorName = [plan.shopify_conflict.firstName, plan.shopify_conflict.lastName].filter(Boolean).join(' ') || '(no name)';
    const oldName = [plan.old_customer.firstName, plan.old_customer.lastName].filter(Boolean).join(' ') || '(no name)';
    lines.push(`- surviving name: **${survivorName}** (the new-email profile's). To keep "${oldName}" instead, say so before confirming.`);
  } else {
    lines.push(`Shopify: ${plan.old_customer.summary} — email will be updated in place.`);
  }

  if (!plan.klaviyo.configured) {
    lines.push('Klaviyo: not configured — skipped.');
  } else if (plan.klaviyo.plan === 'none') {
    lines.push('Klaviyo: no profile under the old address — nothing to move.');
  } else if (plan.klaviyo.plan === 'patch') {
    lines.push(`Klaviyo: profile email updated in place (consent: ${plan.klaviyo.old_profile.consent} — unchanged).`);
  } else {
    lines.push(`Klaviyo: both addresses have profiles — old (${plan.klaviyo.old_profile.consent}) merges into new (${plan.klaviyo.new_profile.consent}); the new profile's consent stands.`);
    if (plan.klaviyo.consent_warning) {
      lines.push('⚠️ The old address was SUBSCRIBED but the new one is not — after this change the customer is NOT on the newsletter. We never auto-subscribe an address that hasn\'t opted in; use klaviyo_subscription_update if their request covers it, or invite them to re-subscribe.');
    }
  }

  if (plan.gorgias.update_needed) {
    lines.push(`Gorgias: they wrote from the old address — replies and follow-ups will be re-routed to ${plan.new_email}.`);
  }
  if (plan.gorgias.note) lines.push(`Gorgias: ${plan.gorgias.note}`);
  lines.push('Mirror + open tickets will be updated to the new address.');

  lines.push('');
  lines.push('Reply "yes confirm" to proceed — awaiting confirmation');
  // A merge is irreversible and worth one human glance; a plain email swap
  // (with no consent surprise) is safe to one-click.
  if (plan.mode === 'merge') {
    lines.push('AUTO_CONFIRM: HOLD — irreversible profile merge, review both profiles');
  } else if (plan.klaviyo.consent_warning) {
    lines.push('AUTO_CONFIRM: HOLD — newsletter consent would be lost, see note');
  } else {
    lines.push('AUTO_CONFIRM: SAFE');
  }
  return lines.join('\n');
}

/**
 * Phase 2: execute a staged plan. Shopify first and abort-on-failure; Klaviyo,
 * Gorgias, and the mirror are best-effort with per-step outcomes. keep_name:
 * 'original' flips the merge's surviving name to the old profile's.
 * Returns { ok, steps: [{ step, ok, detail }], summary }.
 */
async function executeEmailChange(plan, { keep_name } = {}) {
  const steps = [];
  const oldEmail = plan.old_customer.email;
  const newEmail = plan.new_email;

  if (plan.mode === 'blocked') {
    return { ok: false, steps, summary: `Blocked: ${plan.blocked_reason}. Nothing was changed.` };
  }

  // --- 1. Shopify (abort on failure) ------------------------------------
  let survivorId = plan.old_customer.id;
  try {
    if (plan.mode === 'merge') {
      const nameSource = keep_name === 'original' ? plan.old_customer.id : plan.shopify_conflict.id;
      const merge = await customerMerge(plan.old_customer.id, plan.shopify_conflict.id, {
        customerIdOfEmailToKeep: plan.shopify_conflict.id,
        customerIdOfFirstNameToKeep: nameSource,
        customerIdOfLastNameToKeep: nameSource,
      });
      survivorId = merge.resultingCustomerId || plan.shopify_conflict.id;
      let jobDone = merge.done;
      if (!jobDone && merge.jobId) jobDone = await pollShopifyJob(merge.jobId);
      steps.push({
        step: 'shopify_merge', ok: true,
        detail: jobDone
          ? `Profiles merged; surviving customer ${survivorId} under ${newEmail}`
          : `Merge accepted by Shopify but still processing — verify in admin before retrying anything`,
      });
    } else {
      await updateCustomer(plan.old_customer.id, { email: newEmail });
      steps.push({ step: 'shopify_update', ok: true, detail: `Email updated to ${newEmail}` });
    }
    // Explicit name change requested alongside the email change wins over the
    // merge's surviving-name default.
    if (plan.new_first_name || plan.new_last_name) {
      const nameInput = {};
      if (plan.new_first_name) nameInput.firstName = plan.new_first_name;
      if (plan.new_last_name) nameInput.lastName = plan.new_last_name;
      await updateCustomer(survivorId, nameInput);
      steps.push({ step: 'shopify_name', ok: true, detail: `Name set to ${[plan.new_first_name, plan.new_last_name].filter(Boolean).join(' ')}` });
    }
  } catch (err) {
    steps.push({ step: plan.mode === 'merge' ? 'shopify_merge' : 'shopify_update', ok: false, detail: err.message });
    return { ok: false, steps, summary: `Shopify ${plan.mode === 'merge' ? 'merge' : 'update'} failed: ${err.message}. Nothing else was attempted.` };
  }

  // --- 2. Klaviyo (best-effort) -----------------------------------------
  const klaviyo = getKlaviyoClient();
  if (!klaviyo || !plan.klaviyo.configured) {
    steps.push({ step: 'klaviyo', ok: true, detail: 'Not configured — skipped' });
  } else if (plan.klaviyo.plan === 'none') {
    steps.push({ step: 'klaviyo', ok: true, detail: 'No profile under the old address — nothing to move' });
  } else {
    try {
      if (plan.klaviyo.plan === 'merge') {
        await klaviyo.mergeProfiles(plan.klaviyo.new_profile.id, plan.klaviyo.old_profile.id);
        steps.push({
          step: 'klaviyo', ok: true,
          detail: `Old profile merged into ${newEmail}'s profile (consent now: ${plan.klaviyo.new_profile.consent})`
            + (plan.klaviyo.consent_warning ? ' ⚠️ old address was SUBSCRIBED; the survivor is not — customer must re-consent' : ''),
        });
      } else {
        const res = await klaviyo.updateProfileEmail(plan.klaviyo.old_profile.id, newEmail);
        if (res.ok) {
          steps.push({ step: 'klaviyo', ok: true, detail: `Profile email updated (consent: ${plan.klaviyo.old_profile.consent} — unchanged)` });
        } else {
          // A profile under the new email appeared since phase 1 (e.g. Klaviyo's
          // own Shopify sync raced us) — merge into it instead.
          await klaviyo.mergeProfiles(res.duplicate_profile_id, plan.klaviyo.old_profile.id);
          steps.push({ step: 'klaviyo', ok: true, detail: `New email already had a profile — old profile merged into it` });
        }
      }
    } catch (err) {
      steps.push({ step: 'klaviyo', ok: false, detail: `${err.message} — fix manually in Klaviyo (profile for ${oldEmail})` });
    }
  }

  // --- 3. Gorgias (best-effort; before the Supabase writes per house rule) --
  if (plan.gorgias.update_needed && plan.gorgias.old_customer_id) {
    try {
      await gorgias.updateCustomerEmail(plan.gorgias.old_customer_id, newEmail);
      steps.push({ step: 'gorgias', ok: true, detail: `Replies re-routed to ${newEmail}` });
    } catch (err) {
      steps.push({ step: 'gorgias', ok: false, detail: `${err.message} — the reply to this ticket may still go to the OLD address; update the Gorgias customer manually` });
    }
  } else if (plan.gorgias.note) {
    steps.push({ step: 'gorgias', ok: true, detail: plan.gorgias.note });
  }

  // --- 4. Supabase mirror + open tickets (best-effort) ------------------
  try {
    const supabase = getSupabaseClient();
    const { data: newRow } = await supabase.from('customers').select('email').eq('email', newEmail).maybeSingle();
    if (newRow) {
      // Merge case (or fork already present): the new-email row survives;
      // remove the old-email row so one customer is one row.
      await supabase.from('customers').delete().eq('email', oldEmail);
    } else {
      await supabase.from('customers')
        .update({ email: newEmail, shopify_customer_id: survivorId, synced_at: new Date().toISOString() })
        .eq('email', oldEmail);
    }
    const { data: movedTickets } = await supabase.from('cs_tickets')
      .update({ customer_email: newEmail })
      .eq('customer_email', oldEmail)
      .neq('status', 'closed')
      .select('id');
    steps.push({ step: 'mirror', ok: true, detail: `Mirror updated${movedTickets?.length ? `; ${movedTickets.length} open ticket(s) moved to the new address` : ''}` });
  } catch (err) {
    steps.push({ step: 'mirror', ok: false, detail: `${err.message} — mirror row for ${oldEmail} may be stale until the next sync` });
  }

  const failures = steps.filter(s => !s.ok);
  const summary = failures.length
    ? `Email changed to ${newEmail} in Shopify, but ${failures.length} follow-up step(s) failed — see below.`
    : `Email changed to ${newEmail}${plan.mode === 'merge' ? ' (profiles merged)' : ''}; Klaviyo, Gorgias, and the mirror are in sync.`;
  return { ok: true, steps, summary };
}

module.exports = {
  planEmailChange,
  executeEmailChange,
  resolveCustomerId,
  pendingChanges,
  stageKey,
};
