const { test } = require('node:test');
const assert = require('node:assert');
const {
  draftAttachmentSpecs, withAttachment, withoutAttachment, describeAttachment,
} = require('../../b2b-outreach/lib/draftAttachments');

// ── reading specs off a draft ───────────────────────────────────────────────

test('specs come off structured.attachments, defaulting to none', () => {
  assert.deepEqual(draftAttachmentSpecs({ structured: { attachments: [{ kind: 'partner_agreement' }] } }),
    [{ kind: 'partner_agreement' }]);
  assert.deepEqual(draftAttachmentSpecs({ structured: {} }), []);
  assert.deepEqual(draftAttachmentSpecs({}), []);
  assert.deepEqual(draftAttachmentSpecs(null), []);
});

test('malformed specs are ignored rather than reaching the send path', () => {
  const draft = { structured: { attachments: [{ kind: 'partner_agreement' }, null, {}, 'nope', { filename: 'x' }] } };
  assert.deepEqual(draftAttachmentSpecs(draft), [{ kind: 'partner_agreement' }]);
});

// ── mutating specs ──────────────────────────────────────────────────────────

test('attaching twice replaces rather than duplicating', () => {
  const once = withAttachment({}, { kind: 'partner_agreement' });
  const twice = withAttachment(once, { kind: 'partner_agreement' });
  assert.equal(twice.attachments.length, 1, 'the agreement must not send twice');
});

test('attaching preserves the rest of structured', () => {
  const s = withAttachment({ facts_verified: [0, 1], next_touch_days: 30 }, { kind: 'partner_agreement' });
  assert.deepEqual(s.facts_verified, [0, 1]);
  assert.equal(s.next_touch_days, 30);
});

test('overrides ride along on the spec', () => {
  const s = withAttachment({}, { kind: 'partner_agreement', org_name: 'Legal Name Inc', country: 'Canada' });
  assert.deepEqual(s.attachments[0], { kind: 'partner_agreement', org_name: 'Legal Name Inc', country: 'Canada' });
});

test('a spec without a kind is refused', () => {
  assert.throws(() => withAttachment({}, {}), /needs a kind/);
  assert.throws(() => withAttachment({}, null), /needs a kind/);
});

test('detaching removes only the named kind', () => {
  const s = { attachments: [{ kind: 'partner_agreement' }, { kind: 'pricelist' }] };
  assert.deepEqual(withoutAttachment(s, 'partner_agreement').attachments, [{ kind: 'pricelist' }]);
  assert.deepEqual(withoutAttachment({}, 'partner_agreement').attachments, []);
});

// ── describing without generating ───────────────────────────────────────────

test('an attachment can be described without rendering a PDF', () => {
  const us = describeAttachment({ kind: 'partner_agreement' }, { name: 'BAGLY', country: 'United States' });
  assert.match(us.filename, /^RUBIES LGBTQ\+ Organization Donation Partnership Agreement - BAGLY\.pdf$/);
  assert.match(us.note, /50%/);

  const intl = describeAttachment({ kind: 'partner_agreement' }, { name: 'Transting', country: 'Denmark' });
  assert.match(intl.note, /30%/);
});

test('describing survives a missing company without throwing', () => {
  const d = describeAttachment({ kind: 'partner_agreement' }, null);
  assert.ok(d.filename.includes('this organization'));
  assert.match(d.note, /30%/, 'unknown country stays conservative');
});
