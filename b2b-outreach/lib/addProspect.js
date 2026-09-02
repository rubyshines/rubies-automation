/**
 * addProspect.js — the referred-org/retailer intake motion, as one operation.
 *
 * "Someone recommended X" → company row with referral provenance, optional
 * contact, and (by default) the channel's intro draft waiting in the queue.
 * Callable from the operator console (b2b_add_prospect), a Claude session,
 * or any future surface — tools own operations, agents own judgment.
 */
const { generateDraftForCompany } = require('./queueService');

const INTRO_BY_CHANNEL = {
  lgbtq_org: 'intro_outreach',
  wholesale: 'intro_pitch',
  affiliate: 'affiliate_intro',
};

/** "Not A Phase!" → "not-a-phase". Pure. */
function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function addProspect(sb, {
  name, channel = 'lgbtq_org', entity_type = 'company',
  website = null, email = null, contact_name = null,
  referred_by = null, blurb = null, country = null,
  contact_form_url = null,
  draft = true, steer = null,
  // 'referral' (someone recommended them) or 'inbound_email' (they wrote to
  // us). Recorded so a future reader knows which kind of row this is — an
  // inbound-admitted org was never "referred" by anyone.
  source = 'referral',
} = {}) {
  if (!name?.trim()) throw new Error('name is required');
  if (!INTRO_BY_CHANNEL[channel]) throw new Error(`channel must be one of: ${Object.keys(INTRO_BY_CHANNEL).join(', ')}`);
  const id = slugify(name);
  if (!id) throw new Error('name produced an empty slug');

  const { data: existing } = await sb.from('b2b_companies')
    .select('id, relationship_state, metadata, vetted_at').eq('id', id).maybeSingle();

  const meta = {
    ...(existing?.metadata || {}),
    ...(referred_by ? { referred_by } : {}),
    ...(blurb ? { blurb } : {}),
    seeded: `${new Date().toISOString().slice(0, 10)} ${source === 'inbound_email' ? 'inbound-email intake' : 'referred-prospect intake'}`,
  };
  const { error } = await sb.from('b2b_companies').upsert({
    id, name: name.trim(),
    relationship_type: channel, entity_type,
    // Never resurrect an explicitly closed relationship by re-adding it.
    // A brand-new referral is a `prospect`: never approached. It was landing in
    // `in_contact` because this path predates that state, which left it outside
    // Tier-4 first-touch entirely — visible only while its draft was pending,
    // and gone from the queue the moment that draft was dismissed.
    relationship_state: existing?.relationship_state === 'lost' ? 'lost' : (existing?.relationship_state || 'prospect'),
    // An operator adding a named referral IS the vetting decision, so stamp the
    // Tier-4 admission gate here rather than making them triage their own
    // deliberate act. Preserved if already set.
    vetted_at: existing?.vetted_at || new Date().toISOString(),
    status: 'qualified_lead',
    // An org that wrote to us first is as warm as a referral gets.
    temperature: referred_by || source === 'inbound_email' ? 'warm' : 'cold',
    website, general_email: email, country, contact_form_url,
    source,
    metadata: meta,
  }, { onConflict: 'id' });
  if (error) throw new Error(`company upsert: ${error.message}`);

  if (existing?.relationship_state === 'lost') {
    return { id, existed: true, warning: `'${id}' already exists and is marked lost (${existing.metadata?.closed_reason || 'no reason recorded'}) — not re-opened, no draft generated. Re-open deliberately if that was intended.` };
  }

  if (email && contact_name) {
    const { error: cErr } = await sb.from('b2b_contacts').upsert({
      id: email.toLowerCase(), email: email.toLowerCase(), company_id: id,
      full_name: contact_name, is_primary: true, source: 'referral',
    }, { onConflict: 'id' });
    if (cErr) throw new Error(`contact upsert: ${cErr.message}`);
  }

  // Verify the address the moment it enters the book, so the sweep stays a
  // catch-up rather than a pre-round chore. Fail-soft by design: a vendor
  // outage must not break intake.
  let verification = null;
  if (email) {
    const { verifyEmail } = require('./emailVerify');
    verification = await verifyEmail(sb, email, { source: 'intake' });
  }

  // A draft we have no way to deliver is a queue row that looks like work and
  // isn't. Drafting is fine for a form company (the operator submits it by
  // hand); it is not fine when we have no address AND no form.
  const { resolveDelivery } = require('./sendB2bEmail');
  const delivery = await resolveDelivery(sb, id);
  if (draft && delivery.mode === 'none') {
    return {
      id,
      existed: !!existing,
      draft_id: null,
      warning: `'${id}' saved with its referral provenance, but has no email and no contact form — no draft generated. Add a way to reach them, then draft.`,
    };
  }

  let draftResult = null;
  if (draft) {
    const referralSteer = [
      referred_by ? `Referral context: ${referred_by}. Reference the referral honestly (a member of our community / a customer recommended them) without naming the referrer.` : null,
      blurb ? `About the org (from the referrer): ${blurb}` : null,
      steer,
    ].filter(Boolean).join(' ');
    draftResult = await generateDraftForCompany(sb, {
      company_id: id,
      message_type: INTRO_BY_CHANNEL[channel],
      steer: referralSteer || undefined,
    });
  }

  return {
    id,
    existed: !!existing,
    draft_id: draftResult?.draft_id || null,
    delivery: delivery.mode,
    ...(delivery.mode === 'form' ? { form_url: delivery.url } : {}),
    // Surfaced so the operator hears "that address is dead" at intake, when
    // fixing it costs one question to the referrer, not a bounced first touch.
    ...(verification?.status === 'undeliverable'
      ? { warning: `${email} verified UNDELIVERABLE (${verification.reason || 'no reason given'}) — get a working address before sending.` }
      : {}),
  };
}

module.exports = { addProspect, slugify, INTRO_BY_CHANNEL };
