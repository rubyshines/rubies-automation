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
  draft = true, steer = null,
} = {}) {
  if (!name?.trim()) throw new Error('name is required');
  if (!INTRO_BY_CHANNEL[channel]) throw new Error(`channel must be one of: ${Object.keys(INTRO_BY_CHANNEL).join(', ')}`);
  const id = slugify(name);
  if (!id) throw new Error('name produced an empty slug');

  const { data: existing } = await sb.from('b2b_companies')
    .select('id, relationship_state, metadata').eq('id', id).maybeSingle();

  const meta = {
    ...(existing?.metadata || {}),
    ...(referred_by ? { referred_by } : {}),
    ...(blurb ? { blurb } : {}),
    seeded: `${new Date().toISOString().slice(0, 10)} referred-prospect intake`,
  };
  const { error } = await sb.from('b2b_companies').upsert({
    id, name: name.trim(),
    relationship_type: channel, entity_type,
    // Never resurrect an explicitly closed relationship by re-adding it.
    relationship_state: existing?.relationship_state === 'lost' ? 'lost' : (existing?.relationship_state || 'in_contact'),
    status: 'qualified_lead',
    temperature: referred_by ? 'warm' : 'cold',
    website, general_email: email, country,
    source: 'referral',
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

  return { id, existed: !!existing, draft_id: draftResult?.draft_id || null };
}

module.exports = { addProspect, slugify, INTRO_BY_CHANNEL };
