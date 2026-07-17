/**
 * Attachment images — advisor vision input.
 *
 * Customer photos (checkout-error screenshots, defect photos, sizing shots)
 * arrive as Gorgias attachments or inline images. The advisor prompt lists
 * them by filename ([ATTACHMENTS] note), but filenames alone leave the model
 * blind to the content. These helpers turn a message's image attachments into
 * Anthropic vision blocks so the advisor can read what the customer sent.
 *
 * Gorgias re-hosts attachments on uploads.gorgias.io with unauthenticated
 * URLs (verified 2026-07-17), so a plain fetch works.
 */

// Types the Anthropic API accepts as image blocks. HEIC (common from iPhones)
// is not supported — those stay filename-only in the [ATTACHMENTS] note.
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

const MAX_IMAGES = 4;              // cap vision cost per draft (~1.5k tokens/image)
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // API limit is 5MB; leave headroom for base64

// Pick the attachments worth sending as vision input.
function selectImageAttachments(attachments, { max = MAX_IMAGES } = {}) {
  return (attachments || [])
    .filter(a => a?.url && SUPPORTED_IMAGE_TYPES.has(a.content_type))
    .slice(0, max);
}

// Placeholder text for a message that has attachments but no text at all —
// without this, intake would have nothing to put in [LATEST CUSTOMER MESSAGE].
function attachmentOnlyPlaceholder(attachments) {
  const n = (attachments || []).length;
  return `[Customer sent ${n} attachment${n === 1 ? '' : 's'} with no message text]`;
}

// Fetch selected attachments and return Anthropic image content blocks.
// Fail-soft per image: a fetch error or oversized file drops that image
// (the advisor still sees its filename in the [ATTACHMENTS] note) and never
// blocks the draft.
async function fetchImagesAsBlocks(attachments, { fetchImpl = fetch, max = MAX_IMAGES, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const blocks = [];
  for (const a of selectImageAttachments(attachments, { max })) {
    try {
      const res = await fetchImpl(a.url);
      if (!res.ok) {
        console.warn(`[attachmentImages] fetch ${a.name || a.url}: HTTP ${res.status} — skipping`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) {
        console.warn(`[attachmentImages] ${a.name || a.url}: ${buf.length} bytes exceeds cap — skipping`);
        continue;
      }
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.content_type, data: buf.toString('base64') },
      });
    } catch (err) {
      console.warn(`[attachmentImages] fetch ${a.name || a.url} failed: ${err.message} — skipping`);
    }
  }
  return blocks;
}

module.exports = {
  SUPPORTED_IMAGE_TYPES,
  selectImageAttachments,
  attachmentOnlyPlaceholder,
  fetchImagesAsBlocks,
};
