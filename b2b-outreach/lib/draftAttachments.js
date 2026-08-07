/**
 * draftAttachments.js — files that go out with a B2B draft.
 *
 * A draft stores an attachment SPEC, not bytes. For the partner agreement that
 * is strictly better than storing a blob: generation is deterministic, so
 * resolving the spec at send time reproduces the document byte-for-byte, and
 * an agreement can never go out stale (wrong org name, wrong discount) because
 * it was rendered days earlier and the company record moved on.
 *
 * Specs live on `b2b_drafts.structured.attachments`, alongside `facts_verified`
 * — structured already carries operator state, so no new column is needed.
 *
 *   { kind: 'partner_agreement' }
 *     → the LGBTQ+ Organization Donation Program agreement for this draft's
 *       company, rendered fresh, discount derived from the company's country.
 *
 * Adding a kind here is how future attachment types (a pricelist, a lookbook)
 * arrive; the send path never learns about any of them.
 */

/** Attachment specs on a draft. Pure; always an array. */
function draftAttachmentSpecs(draft) {
  const list = draft?.structured?.attachments;
  return Array.isArray(list) ? list.filter(a => a && typeof a.kind === 'string') : [];
}

/**
 * Merge a spec onto a draft's structured payload, de-duplicated by kind so
 * clicking Attach twice doesn't send the agreement twice. Pure.
 */
function withAttachment(structured, spec) {
  if (!spec?.kind) throw new Error('attachment spec needs a kind');
  const s = structured || {};
  const existing = Array.isArray(s.attachments) ? s.attachments : [];
  const deduped = existing.filter(a => a?.kind !== spec.kind);
  return { ...s, attachments: [...deduped, spec] };
}

/** Remove every spec of a kind. Pure. */
function withoutAttachment(structured, kind) {
  const s = structured || {};
  const existing = Array.isArray(s.attachments) ? s.attachments : [];
  return { ...s, attachments: existing.filter(a => a?.kind !== kind) };
}

/**
 * A human label for a spec, for the panel and tool output — resolved without
 * generating anything, so listing attachments is free. Pure.
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
  return { filename: spec.filename || spec.kind, note: spec.kind };
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
    if (spec.kind === 'partner_agreement') {
      const { renderAgreementPdf } = require('./donationAgreement');
      const { filename, buffer } = await renderAgreementPdf({
        orgName: spec.org_name || company.name,
        country: spec.country || company.country,
      });
      out.push({ filename, mimeType: 'application/pdf', content: buffer });
      continue;
    }
    // Fail loudly: silently sending an email WITHOUT the file it promises is
    // worse than not sending it at all — the body says "I have attached".
    throw new Error(`unknown attachment kind '${spec.kind}' on draft #${draft.id}`);
  }
  return out;
}

/** Attach (or replace) a spec on a pending draft. */
async function attachToDraft(sb, { draft_id, kind = 'partner_agreement', org_name, country } = {}) {
  if (!draft_id) throw new Error('draft_id required');
  const { data: draft, error } = await sb.from('b2b_drafts')
    .select('id, company_id, structured, status').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  if (draft.status !== 'pending') throw new Error(`draft #${draft_id} is '${draft.status}' — only pending drafts can be changed`);

  const spec = { kind };
  if (org_name) spec.org_name = org_name;
  if (country) spec.country = country;

  const structured = withAttachment(draft.structured, spec);
  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', draft_id);
  if (uErr) throw new Error(uErr.message);
  return { draft_id, attachments: structured.attachments };
}

/** Remove a spec from a pending draft. */
async function detachFromDraft(sb, { draft_id, kind } = {}) {
  if (!draft_id || !kind) throw new Error('draft_id and kind required');
  const { data: draft, error } = await sb.from('b2b_drafts')
    .select('id, structured, status').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);

  const structured = withoutAttachment(draft.structured, kind);
  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', draft_id);
  if (uErr) throw new Error(uErr.message);
  return { draft_id, attachments: structured.attachments };
}

module.exports = {
  draftAttachmentSpecs,
  withAttachment,
  withoutAttachment,
  describeAttachment,
  resolveDraftAttachments,
  attachToDraft,
  detachFromDraft,
};
