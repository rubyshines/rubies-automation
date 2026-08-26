/**
 * Operator attachment uploads — stash files dropped into the ad-hoc operator
 * console in Supabase Storage so the operator can pass a public URL to MCP
 * tools (logos, design assets, etc.).
 *
 * The dashboard sees a file in-browser, base64-encodes it, and ships it to
 * the server. The server uploads it to the existing `email-attachments`
 * bucket under `operator-uploads/<uuid>/<safe-filename>` and returns the
 * public URL. The operator's prompt is enriched with this URL so Claude can
 * pass it to tools that take a `logo_url` (or similar URL field). The actual
 * destination (e.g. Shopify CDN for partner logos) is handled by the tool's
 * own re-host step on confirm.
 *
 * The bucket is public; URLs are unguessable UUIDs.
 */

const crypto = require('crypto');
const path = require('path');

const { getSupabaseClient } = require('./supabaseClient');

const BUCKET = 'email-attachments'; // reuse existing public bucket
const PREFIX = 'operator-uploads';

function safeFilename(name) {
  const base = (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  // Avoid absurdly long names that bloat storage paths.
  return base.length > 96 ? base.slice(0, 96) : base;
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @param {object} opts
 *   filename   display name (extension preserved for content-type sniffing)
 *   mimeType   defaults to image/png if not provided
 * @returns {Promise<{ url: string, path: string }>}
 */
async function uploadOperatorBytes(bytes, { filename, mimeType } = {}) {
  if (!bytes || !(bytes.length || bytes.byteLength)) {
    throw new Error('uploadOperatorBytes: empty bytes');
  }
  const supabase = getSupabaseClient();
  const id = crypto.randomUUID();
  const fname = safeFilename(filename || 'upload.bin');
  const storagePath = `${PREFIX}/${id}/${fname}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, {
      contentType: mimeType || 'application/octet-stream',
      upsert: false,
    });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  if (!urlData?.publicUrl) throw new Error('No public URL returned for uploaded file');
  return { url: urlData.publicUrl, path: storagePath };
}

/**
 * Upload a base64-encoded file (the dashboard's wire format for drag-and-drop).
 */
async function uploadOperatorBase64(base64, opts = {}) {
  const bytes = Buffer.from(base64, 'base64');
  return uploadOperatorBytes(bytes, opts);
}

/**
 * Public URL → the storage path inside BUCKET, or null if the URL doesn't point
 * into this bucket at all. The ad-hoc operator console hands Claude a public URL
 * for every file dropped into it, so a URL is often the only handle an agent
 * has on a file it wants to attach somewhere. Pure.
 */
function storagePathFromUrl(url) {
  const s = String(url || '');
  const marker = `/object/public/${BUCKET}/`;
  const i = s.indexOf(marker);
  if (i === -1) return null;
  const path = s.slice(i + marker.length).split('?')[0];
  return path ? decodeURIComponent(path) : null;
}

module.exports = { uploadOperatorBytes, uploadOperatorBase64, storagePathFromUrl, BUCKET, PREFIX };
