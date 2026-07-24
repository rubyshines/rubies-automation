/**
 * outreachAdvisor.js — step 6: the two B2B advisors (Design #5).
 *
 * One runner, two prompts: b2b_sales_advisor (retailers + affiliates) and
 * b2b_community_advisor (LGBTQ+ orgs). Reads company + contacts + enrichment +
 * thread history, drafts the next message with an API-ENFORCED output schema
 * (no hand-parsing — same approach as the CS advisor upgrade), and lands the
 * draft in b2b_drafts (superseding any pending draft — one per company).
 *
 * v1 is deliberately tool-less: warm-list message types (checkins, pitches,
 * referral asks) don't require live inventory; the prompt instructs the
 * advisor to flag any fact needing verification in `audit` instead of
 * asserting it. Tools arrive with the cold-retailer phase.
 *
 * DRAFTS ONLY. Sending is sendB2bEmail's job, behind its own off-by-default
 * flag, after operator review.
 */
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    email_subject: { type: 'string', description: 'Subject line. For replies, keep the existing thread subject with Re: prefix.' },
    email_body: { type: 'string', description: "The complete email exactly as Jamie would send it — greeting line, body, warm sign-off, 'Jamie Alexander, RUBIES Founder'. Plain text. No em dashes." },
    message_type: { type: 'string', description: 'The catalog message type this draft implements (e.g. community_checkin, reorder_nudge, purchase_pitch). For Tier-1 replies, the type that best describes your response.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    needs_review_reason: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Why an operator should look closely (new relationship, unusual thread, uncertain fact) — or null when standard.' },
    open_commitments: { type: 'array', items: { type: 'string' }, description: "Every promise this email makes that requires follow-through (e.g. 'send tracking by Friday', 'ship 5 sample sets'). The org failure mode is OUR follow-through — this list feeds the queue." },
    facts_to_verify: { type: 'array', items: { type: 'string' }, description: "ONLY claims in the draft whose truth you cannot establish from the data you were given — and that the SYSTEM cannot check either. Anything from the operator's steer, the thread, the company record, or tool results is ground truth: never list it back for verification. Do not list claims derivable from our own data (order history, prices in your facts block, program terms). Qualifying examples: an external state that may have changed (a website listing being live, an arrangement still standing), a policy detail you inferred rather than were told, timezone math. Do NOT question whether a contact is current unless there is a staleness signal (bounce, departure auto-reply, or a year-plus silent thread). An EMPTY list is the normal, good outcome — most drafts should have zero." },
    next_touch_days: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: "Override the standard follow-up cadence ONLY when the thread gives a concrete reason the default timing is wrong: they named a timeline ('reach out in September', 'our Pride budget lands in May'), a rough patch followed by a comeback order (check in warmly SOONER than their order gap suggests), or a stated pause. Days from now until we should next touch this relationship; the reason must appear in audit. Null = standard cadence (the usual case)." },
    audit: { type: 'array', items: { type: 'string' }, description: 'Your reasoning steps.' },
  },
  required: ['email_subject', 'email_body', 'message_type', 'confidence', 'needs_review_reason', 'open_commitments', 'facts_to_verify', 'next_touch_days', 'audit'],
  additionalProperties: false,
};

function pickAdvisor(company) {
  if (company.relationship_type === 'lgbtq_org') {
    return { name: 'b2b_community_advisor', prompt: require('../prompts/communityAdvisorPrompt').PROMPT };
  }
  return { name: 'b2b_sales_advisor', prompt: require('../prompts/salesAdvisorPrompt').PROMPT };
}

/** Assemble the per-company context block the advisor reads. */
async function buildCompanyContext(sb, companyId) {
  const { data: company, error } = await sb.from('b2b_companies').select('*').eq('id', companyId).maybeSingle();
  if (error || !company) throw new Error(`company ${companyId}: ${error?.message || 'not found'}`);

  const contacts = await fetchAllPaginated(() => sb.from('b2b_contacts')
    .select('email, full_name, role, title, is_primary, is_active, notes')
    .eq('company_id', companyId).order('is_primary', { ascending: false }));

  const messages = await fetchAllPaginated(() => sb.from('b2b_messages')
    .select('direction, message_type, body_text, sent_at, from_email')
    .eq('company_id', companyId).order('sent_at', { ascending: false })).then(r => r.slice(0, 20).reverse());

  return { company, contacts, messages };
}

function renderContext({ company, contacts, messages }, queueEntry, steer) {
  const lines = [];
  lines.push(`## Company`);
  lines.push(`${company.name} (${company.relationship_type}, state: ${company.relationship_state || 'unknown'}, status: ${company.status || '—'})`);
  if (company.city || company.country) lines.push(`Location: ${[company.city, company.region, company.country].filter(Boolean).join(', ')}`);
  if (company.description) lines.push(`About: ${company.description}`);
  if (company.ai_summary) lines.push(`Relationship summary: ${company.ai_summary}`);
  if (company.order_count) lines.push(`Orders: ${company.order_count} (total $${company.total_sales || 0}, last ${company.last_order_date || '—'})`);
  if (company.program_flags && Object.keys(company.program_flags).length) lines.push(`Programs: ${JSON.stringify(company.program_flags)}`);
  lines.push('');
  lines.push('## Contacts');
  for (const c of contacts) {
    lines.push(`- ${c.full_name || c.email}${c.title ? ` (${c.title})` : c.role ? ` (${c.role})` : ''} <${c.email}>${c.is_primary ? ' [primary]' : ''}${c.is_active === false ? ' [INACTIVE]' : ''}`);
    if (c.notes) lines.push(`  NOTES: ${c.notes}`);
  }
  lines.push('');
  if (messages.length) {
    lines.push('## Thread history (oldest first, most recent 20)');
    for (const m of messages) {
      const who = m.direction === 'outbound' ? 'JAMIE' : 'THEM';
      lines.push(`[${(m.sent_at || '').slice(0, 10)}] ${who}${m.message_type ? ` (${m.message_type})` : ''}: ${(m.body_text || '').replace(/\s+/g, ' ').slice(0, 500)}`);
    }
  } else {
    lines.push('## Thread history\n(none on record — treat as relationship context only from the summary above)');
  }
  lines.push('');
  lines.push('## Your task');
  lines.push(`Queue tier ${queueEntry.tier}: ${queueEntry.reason}`);
  lines.push(queueEntry.message_type
    ? `Draft the **${queueEntry.message_type}** message for this company, using its locked opener adapted to this relationship's specifics.`
    : `They are waiting on a reply from us. Read the thread and draft Jamie's response.`);
  if (steer) lines.push(`\nOPERATOR STEER (final authority on intent): ${steer}`);
  return lines.join('\n');
}

/**
 * Generate (or regenerate) the draft for a company's queue entry.
 * Supersedes any pending draft. Returns the inserted b2b_drafts row id + draft.
 */
async function generateDraft({ company_id, queueEntry, steer, variant_id }) {
  const sb = getSupabaseClient();
  const ctx = await buildCompanyContext(sb, company_id);
  const advisor = pickAdvisor(ctx.company);

  const response = await callClaude({
    component: advisor.name,
    model: MODELS.OPUS,
    max_tokens: 3000,
    system: advisor.prompt,
    messages: [{ role: 'user', content: renderContext(ctx, queueEntry, steer) }],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    metadata: { company_id },
  });
  const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const out = JSON.parse(text);

  // one-pending-per-company: supersede, then insert
  await sb.from('b2b_drafts').update({ status: 'superseded' })
    .eq('company_id', company_id).eq('status', 'pending');
  const { data: row, error } = await sb.from('b2b_drafts').insert({
    company_id,
    thread_id: queueEntry.thread_id || null,
    message_type: out.message_type || queueEntry.message_type || 'reply',
    variant_id: variant_id || null,
    subject: out.email_subject,
    body: out.email_body,
    structured: {
      confidence: out.confidence,
      needs_review_reason: out.needs_review_reason,
      open_commitments: out.open_commitments,
      facts_to_verify: out.facts_to_verify,
      next_touch_days: out.next_touch_days ?? null,
      audit: out.audit,
    },
    queue_tier: queueEntry.tier,
    queue_reason: queueEntry.reason,
    advisor: advisor.name,
    operator_steer: steer || null,
  }).select('id').single();
  if (error) throw new Error(`b2b_drafts insert: ${error.message}`);

  return { draft_id: row.id, advisor: advisor.name, ...out };
}

module.exports = { generateDraft, buildCompanyContext, renderContext, pickAdvisor, OUTPUT_SCHEMA };
