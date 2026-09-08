/**
 * The follow-up ladder sends fixed text (2026-09-08).
 *
 * followup_1 / followup_2 auto-send unreviewed, so they are templates in the
 * CS auto follow-up's shape — never model drafts. The pure halves are tested
 * exactly (the words ARE the feature); the DB-bound glue is a thin lookup over
 * them, covered by a stub for the one query with logic in it.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  FOLLOW_UP_TYPES, quotableBody, quoteLines, fillFollowUp, chasedMessage,
} = require('../../b2b-outreach/lib/messageTemplates');
const { toHtmlBody } = require('../../b2b-outreach/lib/sendB2bEmail');
const { generateDraft } = require('../../b2b-outreach/lib/outreachAdvisor');
const { SIGNATURE_NAME, SITE_LABEL } = require('../../customer-service/lib/signatures');

const INTRO = `Hello,

I am Jamie, the founder of RUBIES. Someone in our community recommended The Clare Project to us.

Would you be open to a short call to talk it through?

Talk soon,
${SIGNATURE_NAME}
${SITE_LABEL}`;

test('FOLLOW_UP_TYPES is exactly the two rungs', () => {
  assert.deepEqual([...FOLLOW_UP_TYPES].sort(), ['followup_1', 'followup_2']);
});

test('rung 1 is the CS Stage 1 line, nothing more', () => {
  const { body, attachments } = fillFollowUp({ firstName: 'Beck', message_type: 'followup_1', original: INTRO });
  assert.equal(body, `Hi Beck,\n\nI am following up on this.\n\nTalk soon,\n\n${SIGNATURE_NAME}\n${SITE_LABEL}`);
  assert.deepEqual(attachments, []);
});

test('rung 2 names the spam folder and quotes the chased message, signature stripped', () => {
  const { body } = fillFollowUp({ firstName: 'there', message_type: 'followup_2', original: INTRO });
  assert.match(body, /^Hi there,\n\n/);
  assert.match(body, /in case my earlier notes ended up in your spam folder\. This is what I wrote:\n\n> Hello,\n>\n> I am Jamie/);
  assert.match(body, /> Would you be open to a short call to talk it through\?\n\nTalk soon,/);
  // Our sign-off appears once — ours — never inside the quote.
  assert.equal(body.split(SIGNATURE_NAME).length - 1, 1);
  assert.ok(!body.includes('> Talk soon'), 'the valediction above the signature is not quoted');
  assert.ok(!body.includes(`> ${SITE_LABEL}`));
});

test('rung 2 with nothing to quote falls back to rung 1 wording', () => {
  for (const original of [null, '', '   ']) {
    const { body } = fillFollowUp({ firstName: 'Beck', message_type: 'followup_2', original });
    assert.match(body, /I am following up on this\./);
    assert.ok(!body.includes('spam folder'), 'no promise of a quote it cannot show');
  }
});

test('quotableBody keeps a message that carries no signature whole', () => {
  assert.equal(quotableBody('Just the one line.'), 'Just the one line.');
  assert.equal(quotableBody('Two lines\r\nwith CRLF\r\n\r\nTake care,\r\n' + SIGNATURE_NAME), 'Two lines\nwith CRLF');
});

test('quoteLines marks blank lines with a bare ">"', () => {
  assert.equal(quoteLines('a\n\nb'), '> a\n>\n> b');
});

test('no em dashes in any rung (customer-facing copy guardrail)', () => {
  for (const message_type of FOLLOW_UP_TYPES) {
    const { body } = fillFollowUp({ firstName: 'A', message_type, original: INTRO });
    assert.ok(!body.includes('—'), `em dash in ${message_type}`);
  }
});

test('the HTML part renders the quote as a blockquote with the markers stripped', () => {
  const { body } = fillFollowUp({ firstName: 'Beck', message_type: 'followup_2', original: INTRO });
  const html = toHtmlBody(body);
  assert.match(html, /This is what I wrote:<br>\r\n<blockquote style="[^"]+">Hello,<br>\r\n<br>\r\nI am Jamie/);
  assert.match(html, /talk it through\?<\/blockquote>Talk soon,<br>/);
  assert.ok(!html.includes('&gt;'), 'no literal quote markers in the HTML part');
  // Unquoted text is untouched by the quote pass.
  assert.equal(toHtmlBody('a\nb'), 'a<br>\r\nb');
});

test('the advisor refuses a rung outright, before touching anything', async () => {
  for (const message_type of FOLLOW_UP_TYPES) {
    await assert.rejects(
      generateDraft({ company_id: 'x', queueEntry: { message_type } }),
      /fixed template, never an advisor draft/,
    );
  }
});

test('chasedMessage picks the newest outbound that is not itself a rung', async () => {
  const rows = [
    { id: 3, message_type: 'followup_1', body_text: 'I am following up on this.', sent_at: '2026-08-27' },
    { id: 2, message_type: 'intro_outreach', body_text: INTRO, sent_at: '2026-07-28' },
    { id: 1, message_type: 'intro_outreach', body_text: 'older', sent_at: '2026-06-01' },
  ];
  const q = { eq: () => q, order: () => q, limit: () => Promise.resolve({ data: rows, error: null }) };
  const sb = { from: () => ({ select: () => q }) };
  const m = await chasedMessage(sb, { company_id: 'c', thread_id: 35 });
  assert.equal(m.id, 2);
  assert.equal(await chasedMessage(sb, { company_id: 'c', thread_id: null }), null, 'no thread, nothing to quote');
});
