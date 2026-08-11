const { test } = require('node:test');
const assert = require('node:assert');

// Stub supabase + flags BEFORE requiring the module under test (house pattern).
const path = require('path');
const sbPath = require.resolve('../../shared/supabaseClient');
const flagsPath = require.resolve('../../shared/systemFlags');

const state = { flagEnabled: false, contacts: [], company: null };
require.cache[sbPath] = {
  id: sbPath, filename: sbPath, loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: (table) => ({
        select: () => ({
          eq: () => ({
            // resolveRecipient chains several order() calls to break ties between
            // multiple primaries, so order() has to return itself here.
            eq: () => {
              const q = {
                order: () => q,
                limit: () => Promise.resolve({ data: state.contacts, error: null }),
              };
              return q;
            },
            maybeSingle: () => Promise.resolve({ data: state.company, error: null }),
          }),
        }),
      }),
    }),
  },
};
require.cache[flagsPath] = {
  id: flagsPath, filename: flagsPath, loaded: true,
  exports: { isFlagEnabled: async () => state.flagEnabled, setFlag: async () => true },
};

const { sendB2bEmail, buildRawMessage, encodeSubject } = require('../../b2b-outreach/lib/sendB2bEmail');

test('buildRawMessage produces decodable RFC822 with threading headers', () => {
  const raw = buildRawMessage({
    to: 'kim@hellogorgeousbrashop.com',
    subject: 'RUBIES samples',
    body: 'Hi Kim,\n\nTalk soon,\nJamie',
    inReplyTo: '<abc123@mail.gmail.com>',
    references: '<abc123@mail.gmail.com>',
  });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /From: Jamie Alexander <jamie@rubyshines.com>/);
  assert.match(decoded, /To: kim@hellogorgeousbrashop.com/);
  assert.match(decoded, /In-Reply-To: <abc123@mail.gmail.com>/);
  assert.match(decoded, /References: <abc123@mail.gmail.com>/);
  assert.match(decoded, /\r\n\r\nHi Kim,/);
});

test('encodeSubject passes ASCII through and encodes UTF-8', () => {
  assert.equal(encodeSubject('Plain subject'), 'Plain subject');
  const enc = encodeSubject('Café — heads-up');
  assert.match(enc, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(enc.slice(10, -2), 'base64').toString('utf8'), 'Café — heads-up');
});

test('phase 1 returns a preview and never sends', async () => {
  state.contacts = [{ email: 'ez@tgv.org.au', full_name: 'Ez Lowes', is_primary: true, is_active: true }];
  const res = await sendB2bEmail({
    company_id: 'transgender-victoria', message_type: 'community_checkin',
    subject: 'Checking in', body: 'Hi Ez, ...',
  });
  assert.equal(res.phase, 'preview');
  assert.equal(res.to, 'ez@tgv.org.au');
  assert.equal(res.threading, 'new thread');
});

test('phase 2 is HARD-BLOCKED when b2b_send_enabled is off', async () => {
  state.flagEnabled = false;
  state.contacts = [{ email: 'ez@tgv.org.au', full_name: 'Ez Lowes', is_primary: true, is_active: true }];
  const res = await sendB2bEmail({
    company_id: 'transgender-victoria', message_type: 'community_checkin',
    subject: 'Checking in', body: 'Hi Ez, ...', confirmed: true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'blocked');
  assert.match(res.error, /b2b_send_enabled/);
  assert.equal(res.preview.phase, 'preview');
});

test('missing contact AND general_email fails gracefully', async () => {
  state.contacts = [];
  state.company = { general_email: null };
  const res = await sendB2bEmail({
    company_id: 'mcminnville-trans-network', message_type: 'intro_outreach',
    subject: 'Hello', body: 'Hi, ...',
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /No active contact/);
});
