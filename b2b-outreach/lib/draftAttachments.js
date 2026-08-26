/**
 * draftAttachments.js — files that go out with a B2B draft.
 *
 * A draft stores an attachment SPEC, not bytes. There are two families of spec
 * and the distinction is the whole design:
 *
 *   GENERATED — { kind: 'partner_agreement' }
 *     We hold the recipe, not the file. Resolving the spec at send time
 *     reproduces the document byte-for-byte, so an agreement can never go out
 *     stale (wrong org name, wrong discount) because it was rendered days
 *     earlier and the company record moved on.
 *
 *   UPLOADED — { kind: 'upload', path, filename, mime_type, size }
 *     A file the operator picked, which we cannot regenerate. The bytes go to
 *     Supabase Storage (the same `email-attachments` bucket and
 *     `operator-uploads/` prefix the CS advisor's replies use) and the spec
 *     points at them. Uploading at ATTACH time rather than at send time is what
 *     makes the file survive a refresh, a closed tab, or a failed send — the
 *     same reasoning as the composer's autosave.
 *
 * Specs live on `b2b_drafts.structured.attachments`, alongside `facts_verified`
 * — structured already carries operator state, so no new column is needed.
 *
 * Identity is `attachmentKey`, NOT `kind`. A generated document is one per
 * draft (a second agreement is the same agreement), but uploads are naturally
 * plural — "here are the lookbook and the pricelist" is one email — so keying
 * uploads on `kind` would make each new file silently replace the last.
 *
 * Adding a generated kind here is how future document types (a pricelist, a
 * lookbook) arrive; the send path never learns about any of them.
 */

const { BUCKET } = require('../../shared/operatorUploads');

/** Per-file identity within a draft. Pure. */
function attachmentKey(spec) {
  if (!spec?.kind) return null;
  // Uploads are plural and each one is its own file; the storage path is
  // already unique (a UUID directory per upload), so it IS the identity.
  return spec.kind === 'upload' ? `upload:${spec.path}` : spec.kind;
}

/** Attachment specs on a draft. Pure; always an array. */
function draftAttachmentSpecs(draft) {
  const list = draft?.structured?.attachments;
  if (!Array.isArray(list)) return [];
  return list.filter(a => {
    if (!a || typeof a.kind !== 'string') return false;
    // An upload with no path is a promise we cannot keep — it would throw at
    // send time, i.e. at the worst possible moment. Drop it here instead.
    if (a.kind === 'upload' && !a.path) return false;
    return true;
  });
}

/**
 * Merge a spec onto a draft's structured payload, de-duplicated by
 * `attachmentKey` so clicking Attach twice doesn't send the agreement twice —
 * while two different uploaded files both survive. Pure.
 */
function withAttachment(structured, spec) {
  if (!spec?.kind) throw new Error('attachment spec needs a kind');
  if (spec.kind === 'upload' && !spec.path) throw new Error('an upload spec needs a storage path');
  const s = structured || {};
  const existing = Array.isArray(s.attachments) ? s.attachments : [];
  const key = attachmentKey(spec);
  const deduped = existing.filter(a => attachmentKey(a) !== key);
  return { ...s, attachments: [...deduped, spec] };
}

/**
 * Remove a spec by key. A bare kind still works for the generated documents
 * (there, key === kind); an upload needs its full `upload:<path>` key. Pure.
 */
function withoutAttachment(structured, key) {
  const s = structured || {};
  const existing = Array.isArray(s.attachments) ? s.attachments : [];
  return { ...s, attachments: existing.filter(a => attachmentKey(a) !== key) };
}

/** "2.4 MB" / "812 KB" / "— " when we don't know. Pure. */
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A human label for a spec, for the panel and tool output — resolved without
 * generating or downloading anything, so listing attachments is free. Pure.
 */
function describeAttachment(spec, company) {
  if (spec.kind === 'partner_agreement') {
    const { agreementFilename, partnerDiscountPercent } = require('./donationAgreement');
    const name = company?.name || 'this organization';
    return {
      filename: agreementFilename(name),
      note: `partnership agreement, ${partnerDiscountPercent(company?.country)}% discount`,
    };
  }
  if (spec.kind === 'upload') {
    const size = formatBytes(spec.size);
    return {
      filename: spec.filename || 'attachment',
      note: size ? `uploaded, ${size}` : 'uploaded',
    };
  }
  return { filename: spec.filename || spec.kind, note: spec.kind };
}

/**
 * One spec → one real file for sendB2bEmail.
 *
 * Fails loudly on anything it cannot produce. Silently sending an email WITHOUT
 * the file it promises is worse than not sending it at all — the body says
 * "I have attached".
 *
 * @returns { filename, mimeType, content: Buffer }
 */
async function resolveAttachmentSpec(sb, spec, company) {
  if (spec.kind === 'partner_agreement') {
    const { renderAgreementPdf } = require('./donationAgreement');
    const { filename, buffer } = await renderAgreementPdf({
      orgName: spec.org_name || company?.name,
      country: spec.country || company?.country,
    });
    return { filename, mimeType: 'application/pdf', content: buffer };
  }

  if (spec.kind === 'upload') {
    if (!spec.path) throw new Error(`upload attachment '${spec.filename || '?'}' has no storage path`);
    const { data, error } = await sb.storage.from(BUCKET).download(spec.path);
    if (error) throw new Error(`could not read '${spec.filename || spec.path}': ${error.message}`);
    if (!data) throw new Error(`'${spec.filename || spec.path}' is no longer in storage`);
    // supabase-js hands back a Blob; Buffer is what the MIME builder needs.
    const content = Buffer.from(await data.arrayBuffer());
    if (!content.length) throw new Error(`'${spec.filename || spec.path}' is empty in storage`);
    return {
      filename: spec.filename || spec.path.split('/').pop(),
      mimeType: spec.mime_type || 'application/octet-stream',
      content,
    };
  }

  throw new Error(`unknown attachment kind '${spec.kind}'`);
}

/**
 * Turn a draft's specs into real files for sendB2bEmail.
 * @returns [{ filename, mimeType, content: Buffer }]
 */
async function resolveDraftAttachments(sb, draft) {
  const specs = draftAttachmentSpecs(draft);
  if (!specs.length) return [];

  const { data: company, error } = await sb.from('b2b_companies')
    .select('id, name, country').eq('id', draft.company_id).maybeSingle();
  if (error) throw new Error(`company lookup: ${error.message}`);
  if (!company) throw new Error(`company '${draft.company_id}' not found`);

  const out = [];
  for (const spec of specs) {
    try {
      out.push(await resolveAttachmentSpec(sb, spec, company));
    } catch (err) {
      throw new Error(`draft #${draft.id}: ${err.message}`);
    }
  }
  return out;
}

/** Read a pending draft, refusing anything that can no longer be changed. */
async function loadPendingDraft(sb, draft_id) {
  if (!draft_id) throw new Error('draft_id required');
  const { data: draft, error } = await sb.from('b2b_drafts')
    .select('id, company_id, structured, status').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  if (draft.status !== 'pending') throw new Error(`draft #${draft_id} is '${draft.status}' — only pending drafts can be changed`);
  return draft;
}

/** Attach (or replace) a spec on a pending draft. */
async function attachToDraft(sb, { draft_id, kind = 'partner_agreement', org_name, country, path, filename, mime_type, size } = {}) {
  const draft = await loadPendingDraft(sb, draft_id);

  const spec = { kind };
  if (kind === 'upload') {
    if (!path) throw new Error('an upload needs the storage path of its bytes');
    spec.path = path;
    spec.filename = filename || path.split('/').pop();
    if (mime_type) spec.mime_type = mime_type;
    if (Number.isFinite(size)) spec.size = size;
  } else {
    if (org_name) spec.org_name = org_name;
    if (country) spec.country = country;
  }

  const structured = withAttachment(draft.structured, spec);
  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', draft_id);
  if (uErr) throw new Error(uErr.message);
  return { draft_id, attachments: structured.attachments };
}

/**
 * Remove a spec from a pending draft, by key.
 *
 * The bytes of an upload are deliberately LEFT in storage. Removing a file from
 * one draft is not a statement about every other place its URL may have been
 * used, and a dead 200 KB object is cheaper than a broken attachment.
 */
async function detachFromDraft(sb, { draft_id, key, kind } = {}) {
  const target = key || kind;
  if (!draft_id || !target) throw new Error('draft_id and key required');
  const { data: draft, error } = await sb.from('b2b_drafts')
    .select('id, structured, status').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);

  const structured = withoutAttachment(draft.structured, target);
  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', draft_id);
  if (uErr) throw new Error(uErr.message);
  return { draft_id, attachments: structured.attachments };
}

module.exports = {
  attachmentKey,
  draftAttachmentSpecs,
  withAttachment,
  withoutAttachment,
  describeAttachment,
  formatBytes,
  resolveAttachmentSpec,
  resolveDraftAttachments,
  attachToDraft,
  detachFromDraft,
};
