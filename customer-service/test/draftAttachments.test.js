const { test } = require('node:test');
const assert = require('node:assert');
const {
  attachmentKey, draftAttachmentSpecs, withAttachment, withoutAttachment,
  describeAttachment, formatBytes, resolveAttachmentSpec,
} = require('../../b2b-outreach/lib/draftAttachments');

const upload = (over = {}) => ({
  kind: 'upload',
  path: 'operator-uploads/abc-123/Pricelist.pdf',
  filename: 'Pricelist.pdf',
  mime_type: 'application/pdf',
  size: 2_400_000,
  ...over,
});

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

test('an upload with no storage path is dropped before send, not at send', () => {
  // Resolving it would throw at the worst possible moment — mid-send, on an
  // email whose body may already promise the file.
  const draft = { structured: { attachments: [upload(), { kind: 'upload', filename: 'ghost.pdf' }] } };
  assert.deepEqual(draftAttachmentSpecs(draft).map(a => a.filename), ['Pricelist.pdf']);
});

// ── identity ────────────────────────────────────────────────────────────────

test('a generated document is identified by kind, an upload by its path', () => {
  assert.equal(attachmentKey({ kind: 'partner_agreement' }), 'partner_agreement');
  assert.equal(attachmentKey(upload()), 'upload:operator-uploads/abc-123/Pricelist.pdf');
  assert.equal(attachmentKey(null), null);
});

// ── mutating specs ──────────────────────────────────────────────────────────

test('attaching the agreement twice replaces rather than duplicating', () => {
  const once = withAttachment({}, { kind: 'partner_agreement' });
  const twice = withAttachment(once, { kind: 'partner_agreement' });
  assert.equal(twice.attachments.length, 1, 'the agreement must not send twice');
});

test('two different uploads both survive — uploads are plural', () => {
  // The bug this guards: keying uploads on `kind` would make each new file
  // silently replace the last, so "the lookbook and the pricelist" sends one.
  let s = withAttachment({}, upload());
  s = withAttachment(s, upload({ path: 'operator-uploads/def-456/Lookbook.pdf', filename: 'Lookbook.pdf' }));
  assert.deepEqual(s.attachments.map(a => a.filename), ['Pricelist.pdf', 'Lookbook.pdf']);
});

test('re-uploading the same stored file replaces its spec', () => {
  let s = withAttachment({}, upload());
  s = withAttachment(s, upload({ size: 99 }));
  assert.equal(s.attachments.length, 1);
  assert.equal(s.attachments[0].size, 99);
});

test('an upload and the agreement coexist on one draft', () => {
  let s = withAttachment({}, { kind: 'partner_agreement' });
  s = withAttachment(s, upload());
  assert.deepEqual(s.attachments.map(a => a.kind), ['partner_agreement', 'upload']);
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

test('a spec without a kind, or an upload without bytes, is refused', () => {
  assert.throws(() => withAttachment({}, {}), /needs a kind/);
  assert.throws(() => withAttachment({}, null), /needs a kind/);
  assert.throws(() => withAttachment({}, { kind: 'upload', filename: 'x.pdf' }), /storage path/);
});

test('detaching removes only the named key', () => {
  const s = { attachments: [{ kind: 'partner_agreement' }, upload(), upload({ path: 'operator-uploads/def/B.pdf', filename: 'B.pdf' })] };
  assert.deepEqual(withoutAttachment(s, 'partner_agreement').attachments.map(a => a.filename),
    ['Pricelist.pdf', 'B.pdf']);
  assert.deepEqual(
    withoutAttachment(s, 'upload:operator-uploads/abc-123/Pricelist.pdf').attachments.map(a => a.filename || a.kind),
    ['partner_agreement', 'B.pdf']);
  // A bare 'upload' names no file in particular and must remove nothing.
  assert.equal(withoutAttachment(s, 'upload').attachments.length, 3);
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

test('an upload is described from its own spec, without touching storage', () => {
  const d = describeAttachment(upload(), null);
  assert.equal(d.filename, 'Pricelist.pdf');
  assert.match(d.note, /2\.3 MB|2\.4 MB/);
  assert.equal(describeAttachment(upload({ size: undefined }), null).note, 'uploaded');
});

test('sizes read the way a person would write them', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(0), null);
  assert.equal(formatBytes(undefined), null);
});

// ── resolving to real bytes ─────────────────────────────────────────────────

function storageStub(files) {
  return {
    storage: {
      from() {
        return {
          async download(path) {
            if (!(path in files)) return { data: null, error: { message: 'Object not found' } };
            const buf = files[path];
            return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null };
          },
        };
      },
    },
  };
}

test('an upload resolves to the bytes in storage', async () => {
  const sb = storageStub({ 'operator-uploads/abc-123/Pricelist.pdf': Buffer.from('%PDF-1.4 hello') });
  const file = await resolveAttachmentSpec(sb, upload(), { name: 'BAGLY' });
  assert.equal(file.filename, 'Pricelist.pdf');
  assert.equal(file.mimeType, 'application/pdf');
  assert.equal(file.content.toString(), '%PDF-1.4 hello');
});

test('a file that has gone from storage fails loudly rather than sending nothing', async () => {
  // The body may say "I have attached our pricelist" — sending it without one
  // is worse than not sending at all.
  const sb = storageStub({});
  await assert.rejects(() => resolveAttachmentSpec(sb, upload(), null), /Pricelist\.pdf/);
});

test('an empty stored object is a failure, not a zero-byte attachment', async () => {
  const sb = storageStub({ 'operator-uploads/abc-123/Pricelist.pdf': Buffer.alloc(0) });
  await assert.rejects(() => resolveAttachmentSpec(sb, upload(), null), /empty/);
});

test('an unknown kind never reaches the mail builder', async () => {
  await assert.rejects(() => resolveAttachmentSpec(storageStub({}), { kind: 'lookbook' }, null),
    /unknown attachment kind/);
});

// ── URL → storage path (how an agent names a file it only has a URL for) ────

test('a public bucket URL yields the storage path, and anything else yields null', () => {
  const { storagePathFromUrl } = require('../../shared/operatorUploads');
  assert.equal(
    storagePathFromUrl('https://xyz.supabase.co/storage/v1/object/public/email-attachments/operator-uploads/abc-123/Price%20List.pdf'),
    'operator-uploads/abc-123/Price List.pdf');
  assert.equal(
    storagePathFromUrl('https://xyz.supabase.co/storage/v1/object/public/email-attachments/operator-uploads/abc/a.pdf?t=1'),
    'operator-uploads/abc/a.pdf');
  // A URL somewhere else entirely must not be mistaken for one of ours — the
  // attach would succeed and the send would then fail on a file we never had.
  assert.equal(storagePathFromUrl('https://example.com/pricelist.pdf'), null);
  assert.equal(storagePathFromUrl('https://xyz.supabase.co/storage/v1/object/public/other-bucket/a.pdf'), null);
  assert.equal(storagePathFromUrl(''), null);
  assert.equal(storagePathFromUrl(null), null);
});
