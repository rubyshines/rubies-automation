const { test } = require('node:test');
const assert = require('node:assert');
const { parseBounce, isPermanentFailure, normalizeAddress } = require('../../b2b-outreach/lib/bounceRecovery');

/**
 * The two real bounces from the 2026-08-19 partner check-in round, verbatim from
 * email_messages. Fixtures rather than invented bodies: the bug this module
 * fixes was that the DETECTOR was fine and never ran, so a parser tested only
 * against text written to satisfy it proves very little.
 */
const BAGLY_DSN = `** Address not found **

Your message wasn't delivered to lflynn@bagly.org because the address couldn't be found, or is unable to receive mail.

Learn more here: https://support.google.com/mail/?p=DisabledUser

The response was:

550 5.2.1 The email account that you tried to reach is inactive. For more information, go to https://support.google.com/mail/?p=DisabledUser 956f58d0204a3-66ccb1139bdsor799414d50.2 - gsmtp
Final-Recipient: rfc822; lflynn@bagly.org
Action: failed
Status: 5.2.1
Diagnostic-Code: smtp; 550-5.2.1 The email account that you tried to reach is inactive. For more
 550-5.2.1 information, go to
 550 5.2.1  https://support.google.com/mail/?p=DisabledUser 956f58d0204a3-66ccb1139bdsor799414d50.2 - gsmtp
Last-Attempt-Date: Wed, 19 Aug 2026 12:12:17 -0700 (PDT)`;

const VALID_USA_DSN = `** Address not found **

Your message wasn't delivered to ax.switzer@validbybrodie.com because the address couldn't be found, or is unable to receive mail.

Learn more here: https://support.google.com/mail/?p=NoSuchUser

The response was:

550 5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address for typos or unnecessary spaces. For more information, go to https://support.google.com/mail/?p=NoSuchUser 956f58d0204a3-66ccaec878csor793384d50.0 - gsmtp
Final-Recipient: rfc822; ax.switzer@validbybrodie.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist. Please try
 550-5.1.1 double-checking the recipient's email address for typos or
 550-5.1.1 unnecessary spaces. For more information, go to
 550 5.1.1  https://support.google.com/mail/?p=NoSuchUser 956f58d0204a3-66ccaec878csor793384d50.0 - gsmtp
Last-Attempt-Date: Wed, 19 Aug 2026 12:09:02 -0700 (PDT)`;

const dsn = (body, from = 'mailer-daemon@googlemail.com') => ({
  from, subject: 'Delivery Status Notification (Failure)', body,
});

test('parseBounce: the two real 2026-08-19 bounces', () => {
  const bagly = parseBounce(dsn(BAGLY_DSN));
  assert.equal(bagly.unparsed, false);
  assert.equal(bagly.failures.length, 1);
  assert.equal(bagly.failures[0].address, 'lflynn@bagly.org');
  assert.equal(bagly.failures[0].status, '5.2.1');
  assert.equal(bagly.failures[0].action, 'failed');
  assert.equal(bagly.failures[0].permanent, true);

  const valid = parseBounce(dsn(VALID_USA_DSN));
  assert.equal(valid.failures[0].address, 'ax.switzer@validbybrodie.com');
  assert.equal(valid.failures[0].status, '5.1.1');
  assert.equal(valid.failures[0].permanent, true);
});

test('parseBounce: not a DSN returns null, so ordinary replies are untouched', () => {
  assert.equal(parseBounce({ from: 'kim@org.org', body: 'Thanks, ordering next week!' }), null);
  assert.equal(parseBounce({ from: 'lflynn@bagly.org', body: 'Final-Recipient: rfc822; someone@x.org' }), null);
});

test('parseBounce: a delayed warning is never permanent', () => {
  // Gmail sends these while it is STILL RETRYING. Retiring a contact off one
  // would take a working address out of service because a server was slow.
  const delayed = parseBounce(dsn(`** Delivery incomplete **

There was a temporary problem delivering your message to kim@org.org. Gmail will retry for 44 more hours.

Final-Recipient: rfc822; kim@org.org
Action: delayed
Status: 4.4.1`));
  assert.equal(delayed.failures.length, 1);
  assert.equal(delayed.failures[0].permanent, false);

  // Action: delayed outranks even a 5.x.x status.
  const oddball = parseBounce(dsn('Final-Recipient: rfc822; kim@org.org\nAction: delayed\nStatus: 5.1.1'));
  assert.equal(oddball.failures[0].permanent, false);
});

test('parseBounce: 4.x.x transient is not permanent, 5.x.x is', () => {
  const soft = parseBounce(dsn('Final-Recipient: rfc822; a@b.org\nAction: failed\nStatus: 4.2.2'));
  assert.equal(soft.failures[0].permanent, false);
  const hard = parseBounce(dsn('Final-Recipient: rfc822; a@b.org\nAction: failed\nStatus: 5.1.1'));
  assert.equal(hard.failures[0].permanent, true);
});

test('parseBounce: falls back to the SMTP code when Status: is absent', () => {
  const r = parseBounce(dsn('Final-Recipient: rfc822; a@b.org\nDiagnostic-Code: smtp; 550 No such user here'));
  assert.equal(r.failures[0].permanent, true);
  const soft = parseBounce(dsn('Final-Recipient: rfc822; a@b.org\nDiagnostic-Code: smtp; 451 Try again later'));
  assert.equal(soft.failures[0].permanent, false);
});

test('parseBounce: several recipients each keep their own verdict', () => {
  const r = parseBounce(dsn([
    'Final-Recipient: rfc822; dead@org.org',
    'Action: failed',
    'Status: 5.1.1',
    'Final-Recipient: rfc822; slow@org.org',
    'Action: delayed',
    'Status: 4.4.1',
  ].join('\n')));
  assert.equal(r.failures.length, 2);
  assert.equal(r.failures[0].address, 'dead@org.org');
  assert.equal(r.failures[0].permanent, true);
  assert.equal(r.failures[1].address, 'slow@org.org');
  assert.equal(r.failures[1].permanent, false);
});

test('parseBounce: reads the address out of prose when there is no machine part', () => {
  const r = parseBounce(dsn("** Address not found **\n\nYour message wasn't delivered to gone@org.org because the address couldn't be found.\n\n550 5.1.1 no such user"));
  assert.equal(r.unparsed, false);
  assert.equal(r.failures[0].address, 'gone@org.org');
  assert.equal(r.failures[0].permanent, true);
});

test('parseBounce: an unreadable DSN is flagged, never silently dropped', () => {
  // A bounce we cannot parse is a failed send whose contact we still treat as
  // good. It has to land somewhere the operator can see it.
  const r = parseBounce(dsn('Something went wrong delivering your message.'));
  assert.equal(r.unparsed, true);
  assert.deepEqual(r.failures, []);
});

test('parseBounce: recognises postmaster and angle-bracketed senders', () => {
  assert.ok(parseBounce({ from: 'postmaster@corp.example.com', body: 'Final-Recipient: rfc822; a@b.org\nStatus: 5.0.0' }));
  assert.ok(parseBounce({ from: 'Mail Delivery System <MAILER-DAEMON@mx.org>', body: 'Final-Recipient: rfc822; a@b.org\nStatus: 5.0.0' }));
});

test('normalizeAddress: strips display names and trailing punctuation', () => {
  assert.equal(normalizeAddress('Liz Flynn <LFlynn@BAGLY.org>'), 'lflynn@bagly.org');
  assert.equal(normalizeAddress('  a@b.org;  '), 'a@b.org');
});

test('isPermanentFailure: no status and no diagnostic is not assumed permanent', () => {
  // Fail closed the safe way: doing nothing leaves a working contact in place,
  // where a wrong retire takes away the only address we have.
  assert.equal(isPermanentFailure({ action: 'failed', status: null, diagnostic: null }), false);
});

// ── the write path ──────────────────────────────────────────────────────────
const { handleBounce, reachableAlternates, bounceReason } = require('../../b2b-outreach/lib/bounceRecovery');
const { fakeSupabase } = require('./helpers/fakeSupabase');

const SENT_AT = '2026-08-19T19:12:15.656+00:00';

/** BAGLY as it actually stood the morning after the bounce. */
function baglyWorld({ contacts, generalEmail = null } = {}) {
  const f = fakeSupabase({
    b2b_companies: [{
      id: 'bagly', name: 'BAGLY', website: 'https://bagly.org',
      general_email: generalEmail, contact_unknown: false,
      next_action_date: '2027-02-15', last_outbound_at: SENT_AT,
      contact_form_url: null, relationship_type: 'lgbtq_org', relationship_state: 'active',
    }],
    b2b_contacts: contacts || [
      { id: 'lflynn@bagly.org', email: 'lflynn@bagly.org', company_id: 'bagly', is_primary: true, is_active: true, message_count: 0, bounced_at: null },
      { id: 'info@bagly.org', email: 'info@bagly.org', company_id: 'bagly', is_primary: false, is_active: true, message_count: 0, bounced_at: null },
    ],
    b2b_messages: [
      { id: 1659, company_id: 'bagly', direction: 'outbound', to_email: 'lflynn@bagly.org', from_email: 'jamie@rubyshines.com', sent_at: '2025-09-11T12:49:03+00:00', gmail_thread_id: 'old', undelivered_at: null, message_type: null, thread_id: 100 },
      { id: 1679, company_id: 'bagly', direction: 'outbound', to_email: 'agonzales@bagly.org', from_email: 'jamie@rubyshines.com', sent_at: '2024-05-14T01:34:28+00:00', gmail_thread_id: 'older', undelivered_at: null, message_type: null, thread_id: 101 },
      { id: 3705, company_id: 'bagly', direction: 'outbound', to_email: 'lflynn@bagly.org', from_email: 'jamie@rubyshines.com', sent_at: SENT_AT, gmail_thread_id: '1a01b703d5f37300', undelivered_at: null, message_type: 'community_checkin', thread_id: 550 },
    ],
    b2b_drafts: [{
      id: 92, company_id: 'bagly', thread_id: null, message_type: 'community_checkin', variant_id: null,
      subject: 'Checking in on your RUBIES donations',
      body: "Hi Liz,\n\n[the AI's much longer original]",
      sent_subject: 'Checking in on your RUBIES donations',
      sent_body: "Hi Liz,\n\nIt has been a while, and I wanted to check in on how the RUBIES donations have working out",
      structured: { confidence: 'high' }, advisor: 'b2b_community_advisor',
      status: 'sent', operator_edited: true, sent_at: SENT_AT, queue_tier: 3, bounced_from_draft_id: null,
    }],
  });
  f.unique('b2b_drafts', ['bounced_from_draft_id', 'status']);
  return f;
}

const BAGLY_FAILURE = { address: 'lflynn@bagly.org', status: '5.2.1', action: 'failed', permanent: true, diagnostic: null };

test('handleBounce: retires the dead address and keeps the company reachable', async () => {
  const f = baglyWorld();
  const r = await handleBounce(f.client, { failure: BAGLY_FAILURE, gmail_thread_id: '1a01b703d5f37300' });

  assert.equal(r.handled, true);
  assert.equal(r.company_id, 'bagly');
  const dead = f.db.b2b_contacts.find(c => c.email === 'lflynn@bagly.org');
  assert.equal(dead.is_active, false, 'the dead mailbox must stop being a send target');
  assert.ok(dead.bounced_at, 'recorded as known-dead, not merely inactive');
  assert.ok(f.db.b2b_contacts.find(c => c.email === 'info@bagly.org').is_active,
    'retiring one address must not touch the others');

  assert.equal(f.db.b2b_companies[0].contact_unknown, false,
    'info@ is still live — flagging the company would mute a partner we can reach');
});

test('handleBounce: revives Jamie\'s sent text, not the AI original, as a new pending draft', async () => {
  const f = baglyWorld();
  const r = await handleBounce(f.client, { failure: BAGLY_FAILURE, gmail_thread_id: '1a01b703d5f37300' });

  const revived = f.db.b2b_drafts.find(d => d.id === r.revived_draft_id);
  assert.ok(revived, 'the approved message comes back');
  assert.match(revived.body, /have working out/, 'seeded from sent_body — his edit, not the AI draft');
  assert.equal(revived.status, 'pending');
  assert.equal(revived.queue_tier, 1);
  assert.equal(revived.bounced_from_draft_id, 92);
  assert.equal(revived.advisor, 'b2b_community_advisor',
    'advisor carried forward — nulling it would read as "Jamie composed this himself"');
  assert.match(revived.queue_reason, /bounced/);
  assert.match(revived.queue_reason, /info@bagly.org/, 'the reason names what to try instead');
});

test('handleBounce: the original send record is preserved intact', async () => {
  const f = baglyWorld();
  await handleBounce(f.client, { failure: BAGLY_FAILURE, gmail_thread_id: '1a01b703d5f37300' });
  const original = f.db.b2b_drafts.find(d => d.id === 92);
  assert.equal(original.status, 'sent', 'never flipped back to pending');
  assert.equal(original.operator_edited, true);
  assert.match(original.sent_body, /have working out/,
    'sent_body is the edit-rate training signal and the only record a first attempt happened');
});

test('handleBounce: the failed send stops counting as contact', async () => {
  const f = baglyWorld();
  await handleBounce(f.client, { failure: BAGLY_FAILURE, gmail_thread_id: '1a01b703d5f37300' });

  const msg = f.db.b2b_messages.find(m => m.id === 3705);
  assert.ok(msg.undelivered_at, 'the send row must stop asserting we reached them');
  assert.match(msg.undelivered_reason, /5\.2\.1/);

  const company = f.db.b2b_companies[0];
  assert.equal(company.next_action_date, null,
    'a message that never arrived must not buy six months of quiet');
  assert.equal(company.last_outbound_at, '2025-09-11T12:49:03+00:00',
    'rolled back to the newest send that actually landed, not left on the bounce');
});

test('handleBounce: sets contact_unknown only when nothing is reachable', async () => {
  const f = baglyWorld({ contacts: [
    { id: 'lflynn@bagly.org', email: 'lflynn@bagly.org', company_id: 'bagly', is_primary: true, is_active: true, message_count: 0, bounced_at: null },
  ] });
  const r = await handleBounce(f.client, { failure: BAGLY_FAILURE, gmail_thread_id: '1a01b703d5f37300' });
  // agonzales@bagly.org is still discoverable from 2024 history, so even here
  // the company is not unreachable — which is the point of looking.
  assert.ok(r.alternates.some(a => a.email === 'agonzales@bagly.org'),
    'a predecessor seen only in old correspondence is still a lead');
  assert.equal(f.db.b2b_companies[0].contact_unknown, false);
});

test('handleBounce: a company with genuinely nothing left is flagged unknown', async () => {
  const f = fakeSupabase({
    b2b_companies: [{ id: 'valid', name: 'Valid USA', general_email: null, contact_form_url: null, contact_unknown: false, next_action_date: '2027-02-15', last_outbound_at: SENT_AT }],
    b2b_contacts: [{ id: 'ax@validbybrodie.com', email: 'ax@validbybrodie.com', company_id: 'valid', is_primary: true, is_active: true, message_count: 0, bounced_at: null }],
    b2b_messages: [{ id: 1, company_id: 'valid', direction: 'outbound', to_email: 'ax@validbybrodie.com', from_email: 'jamie@rubyshines.com', sent_at: SENT_AT, gmail_thread_id: 't', undelivered_at: null, message_type: 'community_checkin', thread_id: 5 }],
    b2b_drafts: [],
  });
  const r = await handleBounce(f.client, {
    failure: { address: 'ax@validbybrodie.com', status: '5.1.1', permanent: true }, gmail_thread_id: 't',
  });
  assert.equal(r.contact_unknown, true);
  assert.equal(f.db.b2b_companies[0].contact_unknown, true,
    'nothing left to try — the queue branch is what keeps this visible');
});

test('handleBounce: idempotent, so the replay can be re-run', async () => {
  const f = baglyWorld();
  const first = await handleBounce(f.client, { failure: BAGLY_FAILURE, gmail_thread_id: '1a01b703d5f37300' });
  const second = await handleBounce(f.client, { failure: BAGLY_FAILURE, gmail_thread_id: '1a01b703d5f37300' });
  assert.equal(first.handled, true);
  assert.equal(second.handled, false);
  assert.equal(second.already, true);
  assert.equal(f.db.b2b_drafts.filter(d => d.status === 'pending').length, 1,
    'a second run must not hand Jamie two identical drafts');
});

test('handleBounce: a transient failure changes nothing', async () => {
  const f = baglyWorld();
  const r = await handleBounce(f.client, {
    failure: { address: 'lflynn@bagly.org', status: '4.4.1', permanent: false }, gmail_thread_id: '1a01b703d5f37300',
  });
  assert.equal(r.handled, false);
  assert.ok(f.db.b2b_contacts.find(c => c.email === 'lflynn@bagly.org').is_active,
    'a slow mail server must never retire a working address');
  assert.equal(f.db.b2b_messages.find(m => m.id === 3705).undelivered_at, undefined);
});

test('handleBounce: an address on no company is reported, not swallowed', async () => {
  const f = baglyWorld();
  const r = await handleBounce(f.client, {
    failure: { address: 'nobody@stranger.org', status: '5.1.1', permanent: true },
  });
  assert.equal(r.handled, false);
  assert.match(r.reason, /not on any company/,
    'a silent miss here is indistinguishable from having no bounces at all');
});

test('reachableAlternates: never suggests an address already known dead', async () => {
  const f = baglyWorld({ contacts: [
    { id: 'a@bagly.org', email: 'a@bagly.org', company_id: 'bagly', is_primary: false, is_active: true, message_count: 0, bounced_at: '2026-01-01T00:00:00Z' },
    { id: 'info@bagly.org', email: 'info@bagly.org', company_id: 'bagly', is_primary: false, is_active: true, message_count: 0, bounced_at: null },
  ] });
  const { alternates } = await reachableAlternates(f.client, 'bagly', 'lflynn@bagly.org');
  assert.ok(!alternates.some(a => a.email === 'a@bagly.org'), 'a bounced address is not an alternate');
  assert.ok(alternates.some(a => a.email === 'info@bagly.org'));
});

test('bounceReason: says what to try, or says plainly that there is nothing', () => {
  assert.equal(
    bounceReason({ messageType: 'community_checkin', address: 'lflynn@bagly.org', status: '5.2.1', alternates: [{ email: 'info@bagly.org' }] }),
    'community checkin bounced — lflynn@bagly.org is inactive; try info@bagly.org');
  assert.match(
    bounceReason({ messageType: 'community_checkin', address: 'x@y.org', status: '5.1.1', alternates: [] }),
    /no other address on file$/);
});

// ── the readers that treated a bounced send as contact made ─────────────────
const { renderMessage } = require('../../b2b-outreach/lib/relationshipSummary');

test('the summary transcript says a bounced send never arrived', () => {
  // Without this the recap reads "we checked in, they went quiet" when the truth
  // is they never heard from us — and that recap goes into the advisor's context.
  const line = renderMessage({
    direction: 'outbound', sent_at: SENT_AT, body_text: 'Checking in on donations',
    undelivered_at: '2026-08-20T00:00:00Z',
  });
  assert.match(line, /NEVER DELIVERED/);
  assert.match(line, /did not receive/);

  const normal = renderMessage({ direction: 'outbound', sent_at: SENT_AT, body_text: 'Checking in', undelivered_at: null });
  assert.ok(!/NEVER DELIVERED/.test(normal));
});

test('the summary renders a DSN as a mail-server event, not as their words', () => {
  const line = renderMessage({
    direction: 'inbound', message_type: 'bounce', sent_at: SENT_AT,
    from_email: 'mailer-daemon@googlemail.com', body_text: '550 5.2.1 inactive',
  });
  assert.match(line, /Mail server/);
  assert.ok(!/mailer-daemon/.test(line), 'the daemon is not a correspondent');
});

test('parseBounce: DMARC aggregate reports are not bounces', () => {
  // Same mailer-daemon senders, daily, forever. Twenty of them turned up in the
  // first 120-day dry run; left in they bury the real unreadable-DSN warnings.
  assert.equal(parseBounce({
    from: 'mailer-daemon@alln-inbound-g.cisco.com',
    subject: 'Report Domain: rubyshines.com Submitter: cisco.com Report-ID: <666226$9db5ab1@cisco.com>',
    body: 'aggregate report attached',
  }), null);
  assert.equal(parseBounce({
    from: 'mailer-daemon@amazonses.com',
    subject: 'Dmarc Aggregate Report Domain: {rubyshines.com}  Submitter: {Amazon SES}',
    body: 'xml',
  }), null);
  // A real failure whose subject merely mentions a domain is still a bounce.
  assert.ok(parseBounce(dsn(BAGLY_DSN)));
});

const { splitAddresses } = require('../../b2b-outreach/lib/bounceRecovery');

test('splitAddresses: a To: header is not one address', () => {
  // Real BAGLY row. Treated as a single string it becomes an alternate that does
  // not exist, and it defeats the dedupe — so the mailbox we had just retired
  // came back as the thing to try instead.
  assert.deepEqual(splitAddresses('bsullivan@bagly.org, lflynn@bagly.org'),
    ['bsullivan@bagly.org', 'lflynn@bagly.org']);
  assert.deepEqual(splitAddresses('Liz <LFlynn@BAGLY.org>'), ['lflynn@bagly.org']);
  assert.deepEqual(splitAddresses(''), []);
  assert.deepEqual(splitAddresses('not an address'), []);
});

test('reachableAlternates: never offers back the address that just bounced', async () => {
  const f = baglyWorld();
  // A history row holding several recipients, exactly as manual sends store them.
  f.db.b2b_messages.push({
    id: 9001, company_id: 'bagly', direction: 'outbound',
    to_email: 'bsullivan@bagly.org, lflynn@bagly.org', from_email: 'jamie@rubyshines.com',
    sent_at: '2025-01-01T00:00:00Z', undelivered_at: null, thread_id: 1,
  });
  const { alternates } = await reachableAlternates(f.client, 'bagly', 'lflynn@bagly.org');
  const emails = alternates.map(a => a.email);
  assert.ok(!emails.includes('lflynn@bagly.org'), 'the dead address is not an alternate');
  assert.ok(emails.includes('bsullivan@bagly.org'), 'its co-recipient is a real lead');
  assert.equal(new Set(emails).size, emails.length, 'no duplicates');
  assert.ok(emails.every(e => e.includes('@') && !e.includes(',')));
});

test('bounceReason: dates a stale alternate rather than presenting it as live', () => {
  const now = new Date('2026-08-20T00:00:00Z');
  assert.match(bounceReason({
    messageType: 'community_checkin', address: 'ax@validbybrodie.com', status: '5.1.1',
    alternates: [{ email: 'tommy@validbybrodie.com', via: 'seen_in_history', last_seen: '2024-05-16T00:00:00Z' }], now,
  }), /tommy@validbybrodie\.com \(last used 2024\)/);

  // A recent address needs no caveat.
  assert.match(bounceReason({
    messageType: 'community_checkin', address: 'a@b.org', status: '5.1.1',
    alternates: [{ email: 'fresh@b.org', via: 'seen_in_history', last_seen: '2026-07-01T00:00:00Z' }], now,
  }), /try fresh@b\.org$/);
});

test('reachableAlternates: a third party on the thread is not an alternate', () => {
  // Valid USA's threads also carry a school district, a consultant and a
  // free-mail account. None of them speak for the org.
  const f = baglyWorld();
  f.db.b2b_messages.push({
    id: 9002, company_id: 'bagly', direction: 'inbound',
    to_email: 'jamie@rubyshines.com', from_email: 'consultant@someagency.com',
    sent_at: '2025-02-01T00:00:00Z', undelivered_at: null, thread_id: 1,
  });
  return reachableAlternates(f.client, 'bagly', 'lflynn@bagly.org').then(({ alternates }) => {
    assert.ok(!alternates.some(a => a.email === 'consultant@someagency.com'));
  });
});
