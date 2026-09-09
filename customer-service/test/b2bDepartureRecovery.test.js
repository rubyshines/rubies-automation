const { test } = require('node:test');
const assert = require('node:assert');
const { fakeSupabase } = require('./helpers/fakeSupabase');

// ── stubs, installed before the module under test is required ───────────────
// The extraction is a model call; the verifier is a paid probe; the draft
// generator is an Opus/Sonnet call. All three are replaced with recorders so the
// test exercises the DECISIONS (who is retired, what is marked, what is
// scheduled) and never the network.
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let extraction;      // what "Sonnet" returns for the next call
let extractCalls = [];
stub('../../shared/aiClient', {
  callClaude: async (params) => {
    extractCalls.push(params);
    if (extraction instanceof Error) throw extraction;
    return { content: [{ type: 'tool_use', name: 'submit_departure', input: extraction }] };
  },
  embedTexts: async () => { throw new Error('not used'); },
});
stub('../../b2b-outreach/lib/emailVerify', {
  verifyEmail: async () => ({ status: null, skipped: 'stubbed' }),
  fetchVerifications: async () => ({ byEmail: new Map() }),
  filterUndeliverable: (c) => c, isUndeliverable: () => false,
  normalizeEmail: (e) => String(e || '').trim().toLowerCase(), EMAIL_RE: /.+@.+/, DEFAULT_MAX_AGE_DAYS: 30,
  mapKickboxResult: () => null,
});

let generateCalls = [];
let generateBehaviour = 'ok';
let world;
stub('../../b2b-outreach/lib/queueService', {
  generateDraftForCompany: async (sb, args) => {
    generateCalls.push(args);
    if (generateBehaviour === 'throw') throw new Error('advisor unavailable');
    const { data } = await sb.from('b2b_drafts').insert({
      company_id: args.company_id, message_type: args.message_type, variant_id: args.variant_id || null,
      subject: 'Could your community use gender-affirming clothing donations?',
      body: 'Hi there,\n\nI\'m Jamie, founder of RUBIES...', status: 'pending', advisor: 'b2b_community_advisor',
      queue_tier: 3, queue_reason: args.reason, operator_edited: false,
    }).select('id').single();
    return { draft_id: data.id, advisor: 'b2b_community_advisor' };
  },
});

const {
  handleDeparture, acceptRedirect, departureReason, UNDELIVERED_REASON,
} = require('../../b2b-outreach/lib/departureRecovery');

const SENT_AT = '2026-09-08T14:37:27.233+00:00';
// Processed the NEXT day, as the nightly replay would: dates in the record must
// come from the notice, not from the clock.
const NOW = new Date('2026-09-09T02:00:00Z');

const COLORS_NOTICE = {
  company_id: 'lgbtq-colorsplus',
  sender: 'kpepera@colorsplus.org',
  subject: 'New contact at this email Re: Could your community use gender-affirming clothing donations?',
  body: 'Thank you for contacting Colors+ Youth Center. Kameron Pepera is no longer with the organization. To reach a staff member, please contact info@colorsplus.org.\n\nFor more information, visit https://www.colorsplus.org/.',
  gmail_thread_id: '1a08173fc95f0578',
  received_at: '2026-09-08T14:37:36+00:00',
  now: NOW,
};

/** Colors+ as it stood the moment the autoresponder answered. */
function colorsWorld({ generalEmail = 'info@colorsplus.org', operatorEdited = false, contacts } = {}) {
  const f = fakeSupabase({
    b2b_companies: [{
      id: 'lgbtq-colorsplus', name: 'Colors+ Youth Center', website: 'https://colorsplus.org',
      general_email: generalEmail, contact_unknown: false, contact_form_url: null,
      next_action_date: '2026-09-15', last_outbound_at: SENT_AT,
      relationship_type: 'lgbtq_org', relationship_state: 'in_contact', country: 'US', region: 'Ohio',
    }],
    b2b_contacts: contacts || [
      { id: 'kpepera@colorsplus.org', email: 'kpepera@colorsplus.org', company_id: 'lgbtq-colorsplus', full_name: null, is_primary: true, is_active: true, message_count: 3, bounced_at: null },
    ],
    b2b_messages: [
      { id: 2679, company_id: 'lgbtq-colorsplus', direction: 'inbound', from_email: 'kpepera@colorsplus.org', to_email: 'jamie@rubyshines.com', sent_at: '2024-05-29T14:19:22+00:00', gmail_thread_id: '18fc4b8775d9177c', thread_id: 425, undelivered_at: null },
      { id: 2600, company_id: 'lgbtq-colorsplus', direction: 'outbound', from_email: 'jamie@rubyshines.com', to_email: 'kpepera@colorsplus.org', sent_at: '2024-03-27T15:31:32+00:00', gmail_thread_id: '18e67949851b1fa3', thread_id: 594, undelivered_at: null, message_type: null },
      // The intro answered by the notice. The notice sits on a DIFFERENT Gmail
      // thread (the autoresponder changed the subject), which is the real shape.
      { id: 6545, company_id: 'lgbtq-colorsplus', direction: 'outbound', from_email: 'jamie@rubyshines.com', to_email: 'kpepera@colorsplus.org', sent_at: SENT_AT, gmail_thread_id: '1a08173d5a5bd785', thread_id: 598, undelivered_at: null, message_type: 'intro_outreach', source: 'send_tool' },
    ],
    b2b_drafts: [{
      id: 201, company_id: 'lgbtq-colorsplus', thread_id: null, message_type: 'intro_outreach', variant_id: 'subject_b',
      subject: 'Could your community use gender-affirming clothing donations?',
      body: 'Hi Kameron,\n\nI\'m Jamie, founder of RUBIES...',
      sent_subject: 'Could your community use gender-affirming clothing donations?',
      sent_body: operatorEdited ? 'Hi Kameron,\n\nJamie here — my own words.' : 'Hi Kameron,\n\nI\'m Jamie, founder of RUBIES...',
      structured: { confidence: 'high' }, advisor: 'b2b_community_advisor',
      status: 'sent', operator_edited: operatorEdited, sent_at: SENT_AT, queue_tier: 4, bounced_from_draft_id: null,
    }],
  });
  f.unique('b2b_drafts', ['bounced_from_draft_id', 'status']);
  return f;
}

function reset() {
  extraction = {
    departed_name: 'Kameron Pepera', departed_email: null,
    redirect_email: 'info@colorsplus.org', redirect_name: null, redirect_title: null,
  };
  extractCalls = [];
  generateCalls = [];
  generateBehaviour = 'ok';
}

// ── the gate ────────────────────────────────────────────────────────────────
const company = { website: 'https://colorsplus.org', general_email: null };

test('acceptRedirect: an address at the organisation\'s own domain is accepted', () => {
  const r = acceptRedirect({ redirect: 'Info@ColorsPlus.org', departed: 'kpepera@colorsplus.org', company, contacts: [] });
  assert.equal(r.ok, true);
});

test('acceptRedirect: the general inbox or a contact already on file is accepted whatever its domain', () => {
  assert.equal(acceptRedirect({ redirect: 'team@parentorg.org', departed: 'k@colorsplus.org', company: { website: 'https://colorsplus.org', general_email: 'team@parentorg.org' }, contacts: [] }).ok, true);
  assert.equal(acceptRedirect({ redirect: 'sam@other.org', departed: 'k@colorsplus.org', company, contacts: [{ email: 'sam@other.org' }] }).ok, true);
});

test('acceptRedirect: a free-mail or foreign-domain address is left for the operator', () => {
  assert.equal(acceptRedirect({ redirect: 'kameron.new@gmail.com', departed: 'k@colorsplus.org', company, contacts: [] }).ok, false);
  assert.equal(acceptRedirect({ redirect: 'director@somewhereelse.org', departed: 'k@colorsplus.org', company, contacts: [] }).ok, false);
});

test('acceptRedirect: never the departed address itself, a system mailbox, or nothing', () => {
  assert.equal(acceptRedirect({ redirect: 'k@colorsplus.org', departed: 'k@colorsplus.org', company, contacts: [] }).ok, false);
  assert.equal(acceptRedirect({ redirect: 'noreply@colorsplus.org', departed: 'k@colorsplus.org', company, contacts: [] }).ok, false);
  assert.equal(acceptRedirect({ redirect: null, departed: 'k@colorsplus.org', company, contacts: [] }).ok, false);
});

test('acceptRedirect: the departed mailbox\'s domain counts when the company has no website', () => {
  const r = acceptRedirect({ redirect: 'hello@tinyorg.org', departed: 'kim@tinyorg.org', company: { website: null }, contacts: [] });
  assert.equal(r.ok, true);
});

test('departureReason: names who left, where the org said to write, and what happened', () => {
  assert.match(departureReason({ departedName: 'Kameron Pepera', redirect: 'info@colorsplus.org', retry: 'scheduled', noticeAt: '2026-09-08T14:37:36+00:00', now: NOW }),
    /Kameron Pepera has left \(auto-reply 2026-09-08\); the org says write to info@colorsplus.org — contact updated, retry scheduled/);
  assert.match(departureReason({ departedAddress: 'k@x.org', redirect: null, now: NOW }), /k@x.org has left \(auto-reply 2026-09-09\).* no forwarding address/);
  assert.match(departureReason({ departedName: 'Kim', redirect: 'a@x.org', retry: 'review', now: NOW }), /check the greeting/);
});

// ── the write path: Colors+ ─────────────────────────────────────────────────

test('handleDeparture: the org\'s stated address becomes the recipient and the departed person is retired', async () => {
  reset();
  world = colorsWorld();
  const r = await handleDeparture(world.client, COLORS_NOTICE);
  assert.equal(r.handled, true);
  assert.equal(r.retired_contact, 'kpepera@colorsplus.org');
  assert.equal(r.new_contact, 'info@colorsplus.org');

  const k = world.db.b2b_contacts.find(c => c.email === 'kpepera@colorsplus.org');
  assert.equal(k.is_active, false);
  assert.equal(k.is_primary, false);
  assert.match(k.notes, /Left the organisation per auto-reply 2026-09-08; org directs contact to info@colorsplus.org/);
  const info = world.db.b2b_contacts.find(c => c.email === 'info@colorsplus.org');
  assert.ok(info, 'the redirect address is on file now');
  assert.equal(info.is_primary, true);
  assert.equal(info.is_active, true);

  const c = world.db.b2b_companies[0];
  assert.equal(c.contact_unknown, false, 'a known good address means the company is reachable');
  assert.equal(c.next_action_date, null, 'the date the failed send bought is cleared');
  assert.equal(c.last_outbound_at, '2024-03-27T15:31:32+00:00', 'rolled back to the newest send that landed');
});

test('handleDeparture: the answered send is marked undelivered with the departure reason', async () => {
  reset();
  world = colorsWorld();
  await handleDeparture(world.client, COLORS_NOTICE);
  const m = world.db.b2b_messages.find(x => x.id === 6545);
  assert.ok(m.undelivered_at, 'the intro to the departed mailbox is not contact made');
  assert.equal(m.undelivered_reason, UNDELIVERED_REASON);
  assert.equal(world.db.b2b_messages.find(x => x.id === 2600).undelivered_at, null, 'older sends untouched');
});

test('handleDeparture: an unedited initiating send is re-rendered for the new recipient and scheduled', async () => {
  reset();
  world = colorsWorld();
  const r = await handleDeparture(world.client, COLORS_NOTICE);
  assert.equal(r.retry, 'scheduled');
  assert.equal(generateCalls.length, 1);
  assert.equal(generateCalls[0].message_type, 'intro_outreach');
  assert.equal(generateCalls[0].variant_id, 'subject_b', 'a retry keeps the A/B arm; it is not a new sample');
  assert.equal(generateCalls[0].force, true);

  const retry = world.db.b2b_drafts.find(d => d.id === r.retry_draft_id);
  assert.equal(retry.status, 'pending');
  assert.equal(retry.bounced_from_draft_id, 201);
  assert.equal(retry.queue_tier, 1);
  assert.ok(retry.scheduled_send_at, 'goes out on the ladder\'s schedule, under its cap and guards');
  assert.match(retry.schedule_reason, /retry to info@colorsplus.org after departure/);
  assert.match(retry.queue_reason, /Kameron Pepera has left/);
  assert.match(retry.body, /^Hi there,/, 'fresh render, not the text addressed to Kameron');

  const original = world.db.b2b_drafts.find(d => d.id === 201);
  assert.equal(original.status, 'sent', 'the first attempt stays on the record');
  assert.equal(original.sent_at, SENT_AT);
});

test('handleDeparture: a second pass finds nothing left to do', async () => {
  reset();
  world = colorsWorld();
  await handleDeparture(world.client, COLORS_NOTICE);
  const again = await handleDeparture(world.client, COLORS_NOTICE);
  assert.equal(again.handled, false);
  assert.equal(again.already, true);
  assert.equal(world.db.b2b_drafts.filter(d => d.status === 'pending').length, 1, 'no second retry');
  assert.equal(extractCalls.length, 2, 'extraction runs before the idempotency check is possible; cheap and harmless');
});

test('handleDeparture: text Jamie edited is revived for review, never re-rendered or auto-sent', async () => {
  reset();
  world = colorsWorld({ operatorEdited: true });
  const r = await handleDeparture(world.client, COLORS_NOTICE);
  assert.equal(r.retry, 'review');
  assert.equal(generateCalls.length, 0);
  const retry = world.db.b2b_drafts.find(d => d.id === r.retry_draft_id);
  assert.equal(retry.body, 'Hi Kameron,\n\nJamie here — my own words.', 'seeded from what he sent');
  assert.equal(retry.scheduled_send_at ?? null, null, 'bespoke text waits for a human');
  assert.equal(retry.queue_tier, 1);
  assert.match(retry.queue_reason, /check the greeting/);
});

test('handleDeparture: a template render that fails still leaves the company as Tier-1 work', async () => {
  reset();
  generateBehaviour = 'throw';
  world = colorsWorld();
  const r = await handleDeparture(world.client, COLORS_NOTICE);
  assert.equal(r.retry, 'review');
  assert.match(r.retry_error, /advisor unavailable/);
  const retry = world.db.b2b_drafts.find(d => d.id === r.retry_draft_id);
  assert.equal(retry.bounced_from_draft_id, 201);
  assert.equal(retry.scheduled_send_at ?? null, null);
});

test('handleDeparture: no usable redirect retires the mailbox and falls through to what is reachable', async () => {
  reset();
  extraction = { departed_name: 'Kameron Pepera', departed_email: null, redirect_email: 'kameron.new@gmail.com', redirect_name: null, redirect_title: null };
  world = colorsWorld();
  const r = await handleDeparture(world.client, COLORS_NOTICE);
  assert.equal(r.handled, true);
  assert.equal(r.new_contact, undefined);
  assert.match(r.redirect_refused, /free-mail/);
  assert.equal(world.db.b2b_contacts.find(c => c.email === 'kpepera@colorsplus.org').is_active, false);
  assert.equal(r.contact_unknown, false, 'the general inbox is still reachable, so the company is not muted');
  assert.equal(world.db.b2b_companies[0].contact_unknown, false);
  assert.equal(world.db.b2b_drafts.filter(d => d.status === 'pending').length, 0, 'no retry to an address we did not accept');
  assert.ok(world.db.b2b_messages.find(x => x.id === 6545).undelivered_at);
});

test('handleDeparture: nothing reachable at all is the one case that sets contact_unknown', async () => {
  reset();
  extraction = { departed_name: null, departed_email: null, redirect_email: null, redirect_name: null, redirect_title: null };
  world = colorsWorld({ generalEmail: null });
  const r = await handleDeparture(world.client, COLORS_NOTICE);
  assert.equal(r.contact_unknown, true);
  assert.equal(world.db.b2b_companies[0].contact_unknown, true);
  assert.match(r.queue_reason, /kpepera@colorsplus.org has left .* no forwarding address/);
});

test('handleDeparture: an extraction failure degrades to the no-redirect path, never to a crash', async () => {
  reset();
  extraction = new Error('overloaded');
  world = colorsWorld();
  const r = await handleDeparture(world.client, COLORS_NOTICE);
  assert.equal(r.handled, true);
  assert.equal(r.new_contact, undefined);
  assert.match(r.redirect_refused, /no redirect address/);
});

test('handleDeparture: a notice from a mailbox we do not know, about nobody we can identify, is reported not guessed', async () => {
  reset();
  extraction = { departed_name: 'Someone', departed_email: null, redirect_email: null, redirect_name: null, redirect_title: null };
  world = colorsWorld();
  const r = await handleDeparture(world.client, { ...COLORS_NOTICE, sender: 'autoreply@colorsplus.org', gmail_thread_id: 'unrelated' });
  assert.equal(r.handled, false);
  assert.match(r.reason, /which contact left/);
  assert.equal(world.db.b2b_contacts[0].is_active, true, 'nobody retired on a guess');
});

test('handleDeparture: a colleague\'s notice on our own thread still identifies who left from the send', async () => {
  reset();
  extraction = { departed_name: 'Kameron Pepera', departed_email: null, redirect_email: 'info@colorsplus.org', redirect_name: null, redirect_title: null };
  world = colorsWorld();
  // Sent from a system address on the intro's own Gmail thread: the send says
  // who we wrote to.
  const r = await handleDeparture(world.client, { ...COLORS_NOTICE, sender: 'noreply@colorsplus.org', gmail_thread_id: '1a08173d5a5bd785' });
  assert.equal(r.handled, true);
  assert.equal(r.retired_contact, 'kpepera@colorsplus.org');
});

test('handleDeparture: a redirect already on file is promoted rather than re-typed', async () => {
  reset();
  extraction = { departed_name: 'Kameron Pepera', departed_email: null, redirect_email: 'sam@colorsplus.org', redirect_name: 'Sam', redirect_title: null };
  world = colorsWorld({ contacts: [
    { id: 'kpepera@colorsplus.org', email: 'kpepera@colorsplus.org', company_id: 'lgbtq-colorsplus', is_primary: true, is_active: true, message_count: 3, bounced_at: null },
  ] });
  const r = await handleDeparture(world.client, COLORS_NOTICE);
  assert.equal(r.new_contact, 'sam@colorsplus.org');
  const sam = world.db.b2b_contacts.find(c => c.email === 'sam@colorsplus.org');
  assert.equal(sam.is_primary, true);
  assert.equal(sam.full_name, 'Sam');
});
