const { test } = require('node:test');
const assert = require('node:assert');
const { stripQuotedContent } = require('../../gmail-management/lib/gmailSync');

// The reason this test file exists: the reply parser called a person's sign-off
// "signature" and threw it away with the quoted chain, so the stored body of
// this real email ended mid-thought and Lynn's name never reached the database.
test('the sender\'s sign-off is kept — it is their content, not a quote', () => {
  const body = [
    'Greetings and thanks for reaching out. We primarily carry fetish/fantasy wear',
    'and hosiery, but might consider this.',
    'Cheers,',
    'Lynn Raridon',
    '',
    'From: Jamie Alexander <jamie@rubyshines.com>',
    'Sent: Wednesday, September 9, 2026 12:50 PM',
    'To: info@forbiddenfruit.com',
    'Subject: Gender-affirming underwear and swimwear',
    '',
    '> Hi there, I am Jamie, founder of RUBIES.',
  ].join('\n');
  const out = stripQuotedContent(body);
  assert.match(out, /Lynn Raridon/, 'the name they signed with must survive');
  assert.match(out, /Cheers,/);
  assert.ok(!out.includes('jamie@rubyshines.com'), 'our own quoted email still goes');
  assert.ok(!out.includes('founder of RUBIES'), 'the quoted chain still goes');
});

test('a full signature block with a job title survives', () => {
  const body = [
    'Thanks so much! I will take a look.',
    '',
    'Katherine Crilley',
    'Co-Owner',
    'The Bra Room',
    '',
    'On Tue, Feb 24, 2026 at 1:37 PM Jamie Alexander <jamie@rubyshines.com> wrote:',
    '> Are you still available?',
  ].join('\n');
  const out = stripQuotedContent(body);
  assert.match(out, /Katherine Crilley/);
  assert.match(out, /Co-Owner/, 'the job title is the whole point of keeping the block');
  assert.ok(!out.includes('Are you still available'));
});

test('a message with no quoting is returned as written', () => {
  assert.equal(stripQuotedContent('Sure, give us a call - (828) 484-8878'),
    'Sure, give us a call - (828) 484-8878');
});

test('empty and non-string input pass straight through', () => {
  assert.equal(stripQuotedContent(''), '');
  assert.equal(stripQuotedContent(null), null);
  assert.deepEqual(stripQuotedContent({ not: 'a string' }), { not: 'a string' });
});
