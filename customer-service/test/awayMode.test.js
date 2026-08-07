const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  isFirstContact,
  buildAwayAck,
  sendAwayAck,
  parseEastern,
  DEFAULT_RETURN_PHRASE,
} = require('../lib/awayMode');
const { isExpired } = require('../../shared/systemFlags');

// --- fakes -----------------------------------------------------------------

// Minimal PostgREST-shaped stub for the one query sendAwayAck builds:
//   .from('cs_tickets').update({...}).is('away_ack_sent_at', null).eq(...).select('id')
// `claimRows` is what that chain resolves to — [] means another worker won.
function fakeSupabase({ claimRows = [{ id: 7 }], claimError = null } = {}) {
  const calls = { updates: [], released: false };
  return {
    calls,
    from() {
      let payload = null;
      let isNullFilter = false;
      const chain = {
        update(p) { payload = p; calls.updates.push(p); return chain; },
        is() { isNullFilter = true; return chain; },
        eq() {
          // The release path (away_ack_sent_at -> null) has no .is() filter.
          if (!isNullFilter && payload && payload.away_ack_sent_at === null) {
            calls.released = true;
            return Promise.resolve({ data: null, error: null });
          }
          return chain;
        },
        select() { return Promise.resolve({ data: claimRows, error: claimError }); },
      };
      return chain;
    },
  };
}

function fakeGorgias({ throws = false } = {}) {
  const sent = [];
  return {
    sent,
    async createTicketReply(ticketId, body) {
      if (throws) throw new Error('gorgias 500');
      sent.push({ ticketId, ...body });
      return { id: 999 };
    },
  };
}

// --- first contact ---------------------------------------------------------

describe('isFirstContact', () => {
  it('is true for a single customer message', () => {
    assert.equal(isFirstContact([{ from_agent: false }]), true);
  });

  it('is false once the customer has written twice', () => {
    assert.equal(isFirstContact([{ from_agent: false }, { from_agent: false }]), false);
  });

  it('ignores agent messages — an auto-reply before the customer wrote again is still first contact', () => {
    assert.equal(isFirstContact([
      { from_agent: false },
      { from_agent: true },
    ]), true);
  });

  it('treats a bot/help-center flow transcript as one customer message', () => {
    // Gorgias packs the whole widget conversation into a single help-center
    // message (meta.origin === 'flow'), so bot users are first contact too.
    assert.equal(isFirstContact([
      { from_agent: false, channel: 'help-center', meta: { origin: 'flow' } },
    ]), true);
  });

  it('is false for an empty or missing message list', () => {
    assert.equal(isFirstContact([]), false);
    assert.equal(isFirstContact(undefined), false);
  });
});

// --- copy ------------------------------------------------------------------

describe('buildAwayAck', () => {
  it('renders the return phrase in both text and html', () => {
    const { text, html } = buildAwayAck('Sunday, August 9');
    assert.match(text, /out of town until Sunday, August 9 with limited internet access/);
    assert.match(html, /out of town until Sunday, August 9/);
  });

  it('falls back to a vague phrase rather than a wrong date', () => {
    assert.match(buildAwayAck().text, new RegExp(DEFAULT_RETURN_PHRASE));
  });

  it('contains no em dashes (brand guardrail on customer-facing copy)', () => {
    const { text, html } = buildAwayAck('Sunday, August 9');
    assert.ok(!text.includes('—'), 'text must not contain an em dash');
    assert.ok(!html.includes('—'), 'html must not contain an em dash');
  });

  it('signs off through the shared signature module', () => {
    const { text, html } = buildAwayAck('Sunday, August 9');
    assert.match(text, /Jamie Alexander, RUBIES Founder/);
    assert.match(html, /Jamie Alexander, RUBIES Founder/);
  });

  it('uses a neutral greeting — no customer name (dead-name risk)', () => {
    assert.match(buildAwayAck('Sunday').text, /^Hi there,/);
  });

  it('escapes html in the return phrase', () => {
    assert.match(buildAwayAck('<b>soon</b>').html, /&lt;b&gt;soon&lt;\/b&gt;/);
  });
});

// --- send + claim ----------------------------------------------------------

describe('sendAwayAck', () => {
  it('sends once and reports the body it sent', async () => {
    const supabase = fakeSupabase();
    const gorgias = fakeGorgias();
    const res = await sendAwayAck({
      supabase, gorgias, ticketId: 123, ticketRowId: 7, returnPhrase: 'Sunday, August 9',
    });
    assert.equal(res.sent, true);
    assert.equal(gorgias.sent.length, 1);
    assert.equal(gorgias.sent[0].ticketId, 123);
    assert.match(gorgias.sent[0].body_text, /out of town until Sunday, August 9/);
  });

  it('does not send when another worker already claimed the ticket', async () => {
    // The atomic claim returned no rows -> someone else owns this ack.
    const supabase = fakeSupabase({ claimRows: [] });
    const gorgias = fakeGorgias();
    const res = await sendAwayAck({
      supabase, gorgias, ticketId: 123, ticketRowId: 7, returnPhrase: 'Sunday',
    });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'already_sent');
    assert.equal(gorgias.sent.length, 0, 'must not email a customer twice');
  });

  it('never emails blind when the claim errors', async () => {
    const supabase = fakeSupabase({ claimError: { message: 'boom' } });
    const gorgias = fakeGorgias();
    const res = await sendAwayAck({
      supabase, gorgias, ticketId: 123, ticketRowId: 7, returnPhrase: 'Sunday',
    });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'claim_error');
    assert.equal(gorgias.sent.length, 0);
  });

  it('releases the claim when the send throws, so a later pass can retry', async () => {
    const supabase = fakeSupabase();
    const gorgias = fakeGorgias({ throws: true });
    await assert.rejects(
      sendAwayAck({ supabase, gorgias, ticketId: 123, ticketRowId: 7, returnPhrase: 'Sunday' }),
      /gorgias 500/
    );
    assert.equal(supabase.calls.released, true, 'a failed send must not leave the ticket marked acked');
  });
});

// --- self-expiry -----------------------------------------------------------

describe('flag expiry', () => {
  it('is not expired with no expiry set', () => {
    assert.equal(isExpired(null), false);
  });

  it('is expired once the instant has passed', () => {
    assert.equal(isExpired(new Date(Date.now() - 1000).toISOString()), true);
  });

  it('is not expired while the window is open', () => {
    assert.equal(isExpired(new Date(Date.now() + 60_000).toISOString()), false);
  });

  it('treats an unparseable expiry as no expiry, not as off', () => {
    // Failing the other way would silently disable a flag someone is relying on.
    assert.equal(isExpired('not a date'), false);
  });
});

describe('parseEastern', () => {
  it('reads a bare date-time as Eastern, not as host local time', () => {
    // 2026-08-10 08:00 ET is EDT (UTC-4) -> 12:00Z. This is the assertion that
    // fails if the host zone leaks in (Railway runs UTC, the laptop runs ET).
    assert.equal(parseEastern('2026-08-10 08:00').toISOString(), '2026-08-10T12:00:00.000Z');
  });

  it('honours an explicit zone when one is given', () => {
    assert.equal(parseEastern('2026-08-10T12:00:00Z').toISOString(), '2026-08-10T12:00:00.000Z');
  });

  it('defaults to midnight ET for a date with no time', () => {
    assert.equal(parseEastern('2026-08-10').toISOString(), '2026-08-10T04:00:00.000Z');
  });

  it('returns null on garbage rather than an Invalid Date', () => {
    assert.equal(parseEastern('next tuesday'), null);
    assert.equal(parseEastern(''), null);
    assert.equal(parseEastern(undefined), null);
  });
});
