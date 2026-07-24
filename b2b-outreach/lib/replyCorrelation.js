/**
 * replyCorrelation.js — Trigger 2: inbound email → B2B relationship state.
 *
 * Called from the Gmail push handler (and the nightly sync as catch-up) for
 * each new inbound message. If the sender belongs to a known B2B contact or a
 * company's general_email, the message is recorded on the company's thread
 * (idempotent on gmail_message_id — Pub/Sub is at-least-once) and the company
 * surfaces as Tier 1 in the queue (computed from lastInbound > lastOutbound).
 *
 * Also implements the design's contact-change detection: hard bounces and
 * "no longer with" auto-replies flag contact_unknown, which pauses cadence
 * (cadence.companyEligible) until the operator confirms a new contact.
 */
const { getSupabaseClient } = require('../../shared/supabaseClient');

/** Bounce / departure detection (Design #3 contact-change flow). Pure. */
function detectContactLoss({ subject = '', body = '', from = '' } = {}) {
  const s = `${subject}\n${body}`.slice(0, 2000);
  if (/mailer-daemon|postmaster@/i.test(from) && /(delivery|undeliver|not be delivered|address not found|550|user unknown)/i.test(s)) {
    return 'hard_bounce';
  }
  if (/(no longer (with|at|works)|has left the (org|company|team)|is no longer employed|please (contact|reach out to) .{0,60} going forward)/i.test(s)) {
    return 'departed';
  }
  return null;
}

/** Heuristic: does an inbound look like a wholesale order? Pure. */
function looksLikeOrder(body = '') {
  const lines = body.split('\n');
  let itemish = 0;
  for (const l of lines) {
    if (/^\s*\d+\s*[xX×]?\s+[A-Za-z]/.test(l) && /(size|S|M|L|XL|\d{1,2})/i.test(l)) itemish++;
  }
  return itemish >= 2 || /\b(purchase order|PO\s*#|wholesale order|order form)\b/i.test(body);
}

/**
 * Conservative auto-responder detection (content layer — the gmail intake's
 * is_auto_reply and protocol headers are the first line; this catches what
 * they miss, e.g. Mermaids' "we'll be back to you within 2 business days").
 * Deliberately narrow patterns: a mislabel in either direction is visible and
 * recoverable (the message stays in history either way), so favor precision.
 * Pure.
 */
function detectAutoReply({ subject, body }) {
  const s = `${subject || ''}\n${body || ''}`;
  return /\b(automatic reply|auto[- ]?repl(y|ied)|out of (the )?office|this (inbox|mailbox) is not monitored|do not reply to this (e-?mail|message)|we('|’)?ll (get|be) back to you within [^.\n]{0,30}(business |working )?days)\b/i.test(s);
}

/**
 * Correlate one inbound message. Returns
 * { matched, company_id?, thread_id?, duplicate?, contact_loss?, looks_like_order?, auto_reply? }.
 */
async function correlateInbound(msg) {
  const { gmail_message_id, gmail_thread_id, from_email, to_email, subject, body_text, received_at } = msg;
  if (!gmail_message_id || !from_email) return { matched: false, reason: 'missing ids' };
  const sb = getSupabaseClient();
  const sender = String(from_email).toLowerCase().replace(/^.*</, '').replace(/>.*$/, '').trim();

  // 1. Sender → company
  let companyId = null;
  const { data: contact } = await sb.from('b2b_contacts')
    .select('company_id').eq('email', sender).maybeSingle();
  if (contact?.company_id) companyId = contact.company_id;
  if (!companyId) {
    const { data: byGeneral } = await sb.from('b2b_companies')
      .select('id').eq('general_email', sender).maybeSingle();
    if (byGeneral?.id) companyId = byGeneral.id;
  }

  // Bounce case: sender is mailer-daemon — correlate via thread instead
  const loss = detectContactLoss({ subject, body: body_text, from: sender });
  if (!companyId && loss === 'hard_bounce' && gmail_thread_id) {
    const { data: thread } = await sb.from('b2b_threads')
      .select('id, company_id').eq('gmail_thread_id', gmail_thread_id).maybeSingle();
    if (thread) companyId = thread.company_id;
  }
  if (!companyId) return { matched: false };

  // 2. Thread: match by gmail_thread_id, else create
  let threadId = null;
  const { data: thread } = await sb.from('b2b_threads')
    .select('id').eq('gmail_thread_id', gmail_thread_id).maybeSingle();
  if (thread) {
    threadId = thread.id;
  } else {
    const { data: created, error } = await sb.from('b2b_threads').insert({
      company_id: companyId, thread_type: 'other',
      subject: (subject || '').slice(0, 300), gmail_thread_id,
      last_message_at: received_at || new Date().toISOString(),
    }).select('id').single();
    if (error) {
      // unique race: another worker created it — refetch
      const { data: again } = await sb.from('b2b_threads')
        .select('id').eq('gmail_thread_id', gmail_thread_id).maybeSingle();
      if (!again) throw new Error(`thread create: ${error.message}`);
      threadId = again.id;
    } else {
      threadId = created.id;
    }
  }

  // 3. Idempotent message insert (UNIQUE gmail_message_id). Auto-responders
  // are kept for history but labeled so they never create a Tier-1
  // "waiting on us" (queueContext skips message_type='auto_reply').
  const autoReply = detectAutoReply({ subject, body: body_text });
  const { error: mErr } = await sb.from('b2b_messages').insert({
    thread_id: threadId, company_id: companyId, direction: 'inbound',
    message_type: autoReply ? 'auto_reply' : null,
    gmail_message_id, gmail_thread_id,
    from_email: sender, to_email: to_email || null,
    body_text: (body_text || '').slice(0, 20000),
    sent_at: received_at || new Date().toISOString(), source: 'pubsub',
  });
  if (mErr) {
    if (mErr.code === '23505') return { matched: true, company_id: companyId, thread_id: threadId, duplicate: true };
    throw new Error(`b2b_messages insert: ${mErr.message}`);
  }

  // 4. State updates
  const nowIso = new Date().toISOString();
  await sb.from('b2b_threads').update({ last_message_at: received_at || nowIso }).eq('id', threadId);
  if (loss) {
    await sb.from('b2b_companies').update({ contact_unknown: true, updated_at: nowIso }).eq('id', companyId);
  }

  return {
    matched: true,
    company_id: companyId,
    thread_id: threadId,
    contact_loss: loss,
    looks_like_order: looksLikeOrder(body_text || ''),
  };
}

module.exports = { correlateInbound, detectContactLoss, looksLikeOrder, detectAutoReply };
