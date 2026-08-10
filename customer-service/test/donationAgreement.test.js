const { test } = require('node:test');
const assert = require('node:assert');
const {
  partnerDiscountPercent, agreementFilename, agreementHtml, signatureDataUri,
} = require('../../b2b-outreach/lib/donationAgreement');
const { buildRawMessage } = require('../../b2b-outreach/lib/sendB2bEmail');

// ── discount by country ─────────────────────────────────────────────────────

test('US and Australia get 50%, matching wholesale (no duties to absorb)', () => {
  for (const c of ['United States', 'united states', 'USA', 'US', 'Australia', 'AU']) {
    assert.equal(partnerDiscountPercent(c), 50, c);
  }
});

test('everywhere else gets 30%', () => {
  for (const c of ['Canada', 'Denmark', 'Germany', 'United Kingdom', 'Sweden']) {
    assert.equal(partnerDiscountPercent(c), 30, c);
  }
});

test('unknown country quotes the conservative rate rather than guessing generous', () => {
  assert.equal(partnerDiscountPercent(null), 30);
  assert.equal(partnerDiscountPercent(''), 30);
  assert.equal(partnerDiscountPercent('   '), 30);
});

// ── filename ────────────────────────────────────────────────────────────────

test('filename carries the org name and strips path-hostile characters', () => {
  assert.equal(agreementFilename('BAGLY'),
    'RUBIES LGBTQ+ Organization Donation Partnership Agreement - BAGLY.pdf');
  assert.ok(!agreementFilename('A/B: C*').includes('/'));
  assert.ok(!agreementFilename('A/B: C*').includes(':'));
});

// ── the document itself ─────────────────────────────────────────────────────

test('the org name and only the org name varies in the body', () => {
  const a = agreementHtml({ orgName: 'Oasis Youth Center', discountPercent: 50 });
  const b = agreementHtml({ orgName: 'Skipping Stone', discountPercent: 50 });
  assert.ok(a.includes('RUBIES Apparel Inc and Oasis Youth Center'));
  assert.ok(b.includes('RUBIES Apparel Inc and Skipping Stone'));
  // Same contract, different counterparty: the ONLY difference is the name.
  assert.equal(a.replace(/Oasis Youth Center/g, 'X'), b.replace(/Skipping Stone/g, 'X'));
});

test('the discount rate reaches the clause', () => {
  assert.ok(agreementHtml({ orgName: 'X', discountPercent: 50 }).includes('50% discount off the retail price'));
  assert.ok(agreementHtml({ orgName: 'X', discountPercent: 30 }).includes('30% discount off the retail price'));
});

test('both parties\' obligations are present and unaltered', () => {
  const html = agreementHtml({ orgName: 'X', discountPercent: 50 });
  for (const clause of [
    'Provide a primary point of contact',
    'within one\n    month after receipt',
    'Promote RUBIES clothing availability on your social media',
    'roster of organizations that RUBIES customers will be',
    'packaging instructions for their donations',
    'materials to help educate your community',
  ]) {
    assert.ok(html.includes(clause), `missing: ${clause}`);
  }
});

test('a bad discount is refused rather than written into a contract', () => {
  assert.throws(() => agreementHtml({ orgName: 'X', discountPercent: 40 }), /must be 30 or 50/);
  assert.throws(() => agreementHtml({ orgName: 'X', discountPercent: 0 }), /must be 30 or 50/);
  assert.throws(() => agreementHtml({ orgName: '', discountPercent: 50 }), /orgName is required/);
});

test('an org name with HTML characters cannot break the document', () => {
  const html = agreementHtml({ orgName: 'Q<script>alert(1)</script>Center', discountPercent: 50 });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('the founder signature is embedded, the counter-signature line is blank', () => {
  const html = agreementHtml({ orgName: 'X', discountPercent: 50, signatureDataUri: 'data:image/png;base64,AAA' });
  assert.ok(html.includes('src="data:image/png;base64,AAA"'));
  assert.ok(html.includes('Jamie Alexander - RUBIES Founder'));
  assert.ok(html.includes('class="countersign"'), 'partner still has a line to sign');
});

test('the stored signature asset loads as a PNG data URI', () => {
  assert.match(signatureDataUri(), /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
});

// ── attachments on the send path ────────────────────────────────────────────

const decode = (raw) => Buffer.from(raw, 'base64url').toString('utf8');

test('no attachments keeps the plain multipart/alternative shape', () => {
  const raw = decode(buildRawMessage({ to: 'a@b.org', subject: 'Hi', body: 'Hello' }));
  assert.ok(raw.includes('Content-Type: multipart/alternative'));
  assert.ok(!raw.includes('multipart/mixed'));
});

test('an attachment nests the alternative inside multipart/mixed', () => {
  const raw = decode(buildRawMessage({
    to: 'a@b.org', subject: 'Agreement', body: 'Attached.',
    attachments: [{ filename: 'Agreement - BAGLY.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4 fake') }],
  }));
  assert.ok(raw.includes('Content-Type: multipart/mixed'), 'top level is mixed');
  assert.ok(raw.includes('Content-Type: multipart/alternative'), 'body parts still nested inside');
  assert.ok(raw.includes('Content-Disposition: attachment; filename="Agreement - BAGLY.pdf"'));
  assert.ok(raw.includes('Content-Transfer-Encoding: base64'));
  assert.ok(raw.includes(Buffer.from('%PDF-1.4 fake').toString('base64')));
  // Both bodies survive alongside the file.
  assert.ok(raw.includes('Attached.'));
});

test('base64 payload is wrapped at 76 chars per RFC 2045', () => {
  const big = Buffer.alloc(600, 0x41);
  const raw = decode(buildRawMessage({
    to: 'a@b.org', subject: 'S', body: 'B',
    attachments: [{ filename: 'f.pdf', mimeType: 'application/pdf', content: big }],
  }));
  const payload = raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n\r\n')[0];
  for (const line of payload.split('\r\n')) assert.ok(line.length <= 76, `line too long: ${line.length}`);
});

test('several attachments each get their own part', () => {
  const raw = decode(buildRawMessage({
    to: 'a@b.org', subject: 'S', body: 'B',
    attachments: [
      { filename: 'one.pdf', mimeType: 'application/pdf', content: Buffer.from('1') },
      { filename: 'two.pdf', mimeType: 'application/pdf', content: Buffer.from('2') },
    ],
  }));
  assert.ok(raw.includes('filename="one.pdf"'));
  assert.ok(raw.includes('filename="two.pdf"'));
});

test('a non-ASCII filename is encoded rather than mangled', () => {
  const raw = decode(buildRawMessage({
    to: 'a@b.org', subject: 'S', body: 'B',
    attachments: [{ filename: 'Sanktförening.pdf', mimeType: 'application/pdf', content: Buffer.from('x') }],
  }));
  assert.ok(raw.includes('=?UTF-8?B?'), 'RFC 2047 encoded');
});

test('threading headers survive the mixed wrapper', () => {
  // sendB2bEmail passes references alongside inReplyTo; both must land on the
  // outer headers, or an agreement sent as a reply starts a detached thread.
  const raw = decode(buildRawMessage({
    to: 'a@b.org', subject: 'Re: hi', body: 'B',
    inReplyTo: '<abc@mail>', references: '<abc@mail>',
    attachments: [{ filename: 'f.pdf', mimeType: 'application/pdf', content: Buffer.from('x') }],
  }));
  assert.ok(raw.includes('In-Reply-To: <abc@mail>'));
  assert.ok(raw.includes('References: <abc@mail>'));
  // ...and on the OUTER header block, not buried in a body part.
  assert.ok(raw.split('\r\n\r\n')[0].includes('In-Reply-To: <abc@mail>'));
});

// ── cc and multi-recipient ──────────────────────────────────────────────────

const { addressList } = require('../../b2b-outreach/lib/sendB2bEmail');

test('addressList normalizes arrays, comma strings, blanks and duplicates', () => {
  assert.equal(addressList('a@b.org'), 'a@b.org');
  assert.equal(addressList(['a@b.org', 'c@d.org']), 'a@b.org, c@d.org');
  assert.equal(addressList('a@b.org, c@d.org'), 'a@b.org, c@d.org');
  assert.equal(addressList(['a@b.org', '', null, ' ']), 'a@b.org');
  assert.equal(addressList(['a@b.org', 'A@B.org']), 'a@b.org', 'deduped case-insensitively');
  assert.equal(addressList(null), '');
});

test('a copied colleague lands in Cc and is not dropped', () => {
  // Trans Closet HV: Callum wrote in with a second person on the thread who
  // now handles their ordering. Replying to the sender alone would cut them out.
  const raw = decode(buildRawMessage({
    to: 'transclosethv@gmail.com', cc: 'themaisystem@gmail.com',
    subject: 'Re: agreement and next steps', body: 'Hi Callum,',
  }));
  assert.ok(raw.includes('To: transclosethv@gmail.com'));
  assert.ok(raw.includes('Cc: themaisystem@gmail.com'));
});

test('no cc emits no Cc header at all', () => {
  const raw = decode(buildRawMessage({ to: 'a@b.org', subject: 'S', body: 'B' }));
  assert.ok(!raw.includes('Cc:'));
});

test('cc survives alongside attachments and threading', () => {
  const raw = decode(buildRawMessage({
    to: 'a@b.org', cc: ['c@d.org', 'e@f.org'], subject: 'Re: S', body: 'B',
    inReplyTo: '<x@mail>', references: '<x@mail>',
    attachments: [{ filename: 'agreement.pdf', mimeType: 'application/pdf', content: Buffer.from('x') }],
  }));
  const head = raw.split('\r\n\r\n')[0];
  assert.ok(head.includes('Cc: c@d.org, e@f.org'));
  assert.ok(head.includes('In-Reply-To: <x@mail>'));
  assert.ok(head.includes('multipart/mixed'));
});

// ── URL linkifying ──────────────────────────────────────────────────────────

const { toHtmlBody } = require('../../b2b-outreach/lib/sendB2bEmail');

test('a URL ending a sentence does not swallow the full stop', () => {
  // The onboarding survey link went out as ".../1Hq93BSiPrhJkgfB8." — Gmail
  // renders the href verbatim, so the partner got a dead link.
  const html = toHtmlBody('here is the survey: https://forms.gle/1Hq93BSiPrhJkgfB8.');
  assert.ok(html.includes('href="https://forms.gle/1Hq93BSiPrhJkgfB8"'), 'href is clean');
  assert.ok(!html.includes('1Hq93BSiPrhJkgfB8."'), 'the period is not inside the href');
  assert.ok(html.endsWith('.'), 'but the sentence keeps its full stop');
});

test('other trailing sentence punctuation is handled too', () => {
  for (const [text, punct] of [['see https://a.org/x,', ','], ['now https://a.org/x!', '!'], ['really https://a.org/x?', '?'], ['note https://a.org/x;', ';']]) {
    const html = toHtmlBody(text);
    assert.ok(html.includes('href="https://a.org/x"'), text);
    assert.ok(html.endsWith(punct), text);
  }
});

test('punctuation inside a URL is preserved', () => {
  const html = toHtmlBody('open https://a.org/path?q=1&x=2 now');
  assert.ok(html.includes('href="https://a.org/path?q=1&amp;x=2"'));
});

test('a bare domain mid-sentence still links', () => {
  assert.ok(toHtmlBody('visit rubyshines.com today').includes('<a href='));
});
