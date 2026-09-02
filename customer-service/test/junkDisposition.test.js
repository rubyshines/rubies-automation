'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { shouldAutoCloseJunk, junkCloseNote } = require('../lib/junkDisposition');

// The regression this pins: a phishing email that evades Gorgias's spam
// detector enters normal intake and lands in the operator queue as a pending
// draft (observed 2026-09-02: SendGrid-impersonation campaign — the flagged
// copy was caught by the spam gate, the unflagged twin was drafted). The
// advisor's own junk verdict now closes the ticket, guarded so a known
// customer or an in-progress conversation is never auto-closed.

test('junk from an unknown sender on a fresh thread auto-closes', () => {
  assert.equal(shouldAutoCloseJunk({ messageType: 'junk', known: false, hasAgentReply: false }), true);
});

test('a known customer is never auto-closed, whatever the verdict', () => {
  assert.equal(shouldAutoCloseJunk({ messageType: 'junk', known: true, hasAgentReply: false }), false);
});

test('a thread an agent has replied on is never auto-closed', () => {
  assert.equal(shouldAutoCloseJunk({ messageType: 'junk', known: false, hasAgentReply: true }), false);
});

test('non-junk message types never auto-close here', () => {
  for (const messageType of ['uncategorized', 'general_inquiry', 'business_outreach', 'refund', 'closing']) {
    assert.equal(shouldAutoCloseJunk({ messageType, known: false, hasAgentReply: false }), false, messageType);
  }
});

test('junkCloseNote carries the advisor summary and the reopen instruction', () => {
  const note = junkCloseNote('phishing email impersonating sendgrid, do not click');
  assert.match(note, /phishing email impersonating sendgrid/);
  assert.match(note, /Reopen if this is wrong/);
});

test('junkCloseNote survives a missing summary', () => {
  assert.match(junkCloseNote(null), /no genuine customer inquiry/);
  assert.match(junkCloseNote('   '), /no genuine customer inquiry/);
});
