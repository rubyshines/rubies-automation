/**
 * Upload a logo to Shopify Files (so partner logos live on our own CDN
 * instead of depending on third-party sites that can move or disappear).
 *
 * Uses the Shopify Admin GraphQL `fileCreate` mutation with `originalSource`:
 * Shopify fetches the external URL itself and re-hosts it under
 * https://cdn.shopify.com/s/files/1/0255/9636/2837/files/<name>.
 *
 * Strategy: if the input URL is already on `cdn.shopify.com`, return it
 * unchanged. Otherwise create a Shopify file and poll until READY.
 */

const fs = require('fs');
const path = require('path');
const { shopifyGraphQL } = require('./shopify');

const READY_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;

function isShopifyCdnUrl(url) {
  return /^https?:\/\/cdn\.shopify\.com\//i.test(url || '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Poll `node(id)` until the file's `fileStatus = READY` and we have a CDN URL,
 * or we hit the timeout.
 */
async function pollUntilReady(fileId, { timeoutMs = READY_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await shopifyGraphQL(`
      query($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            id
            fileStatus
            fileErrors { code details message }
            image { url altText }
          }
          ... on GenericFile {
            id
            fileStatus
            fileErrors { code details message }
            url
          }
        }
      }
    `, { id: fileId });
    const node = data?.node;
    if (!node) throw new Error(`Shopify file ${fileId} not found`);
    if (node.fileStatus === 'FAILED') {
      const err = (node.fileErrors || []).map(e => e.message || e.code).join('; ') || 'unknown';
      throw new Error(`Shopify file processing failed: ${err}`);
    }
    const url = node.image?.url || node.url;
    if (node.fileStatus === 'READY' && url) return url;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Shopify file ${fileId} did not become READY within ${timeoutMs}ms`);
}

/**
 * Re-host an external image URL on Shopify CDN. If the URL is already on
 * cdn.shopify.com, returns it unchanged.
 *
 * @param {string} sourceUrl   Public URL Shopify can fetch.
 * @param {object} opts
 *   alt                       Optional alt text.
 * @returns {Promise<{ cdnUrl: string, fileId: string|null, source: string }>}
 *          source is 'existing' if unchanged, 'shopify' if newly hosted.
 */
async function rehostImageOnShopify(sourceUrl, { alt } = {}) {
  if (!sourceUrl) throw new Error('rehostImageOnShopify: sourceUrl is required');
  if (isShopifyCdnUrl(sourceUrl)) {
    return { cdnUrl: sourceUrl, fileId: null, source: 'existing' };
  }

  // Shopify is permissive about contentType — pass IMAGE for logos.
  // It infers extension/MIME from the fetched response.
  const filenameHint = path.basename(new URL(sourceUrl).pathname.split('?')[0]) || 'logo';
  const createRes = await shopifyGraphQL(`
    mutation($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage { id image { url } }
          ... on GenericFile { id url }
        }
        userErrors { field message code }
      }
    }
  `, {
    files: [{
      originalSource: sourceUrl,
      contentType: 'IMAGE',
      alt: alt || filenameHint,
    }],
  });

  const userErrors = createRes?.fileCreate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(`Shopify fileCreate failed: ${userErrors.map(e => e.message).join('; ')}`);
  }
  const file = createRes?.fileCreate?.files?.[0];
  if (!file) throw new Error('Shopify fileCreate returned no file');

  // Some files come back READY immediately; most need a poll.
  const immediateUrl = file.image?.url || file.url;
  const finalUrl = immediateUrl && file.fileStatus === 'READY'
    ? immediateUrl
    : await pollUntilReady(file.id);

  return { cdnUrl: finalUrl, fileId: file.id, source: 'shopify' };
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function inferMime(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

/**
 * Upload a local image file to Shopify Files via staged uploads.
 *
 * Flow:
 *   1. stagedUploadsCreate → get a presigned upload target
 *   2. POST the bytes as multipart/form-data to that target
 *   3. fileCreate with originalSource = the staged resourceUrl
 *   4. Poll until READY
 *
 * @param {string} filePath
 * @param {object} opts  { alt }
 * @returns {Promise<{ cdnUrl: string, fileId: string, source: 'shopify' }>}
 */
async function rehostImageFromFile(filePath, { alt } = {}) {
  if (!filePath) throw new Error('rehostImageFromFile: filePath is required');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const bytes = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const mimeType = inferMime(filename);

  // Step 1 — staged upload target.
  const stagedRes = await shopifyGraphQL(`
    mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `, {
    input: [{
      filename,
      mimeType,
      httpMethod: 'POST',
      resource: 'FILE',
      fileSize: String(bytes.length),
    }],
  });

  const stagedErrors = stagedRes?.stagedUploadsCreate?.userErrors || [];
  if (stagedErrors.length) {
    throw new Error(`stagedUploadsCreate failed: ${stagedErrors.map(e => e.message).join('; ')}`);
  }
  const target = stagedRes?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error('stagedUploadsCreate returned no target');

  // Step 2 — POST bytes to staged URL with all provided params + the file.
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([bytes], { type: mimeType }), filename);
  const uploadRes = await fetch(target.url, { method: 'POST', body: form });
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => '');
    throw new Error(`Staged upload POST failed (${uploadRes.status}): ${body.slice(0, 500)}`);
  }

  // Step 3 — register as a Shopify file with originalSource = staged resourceUrl.
  const createRes = await shopifyGraphQL(`
    mutation($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage { id image { url } }
          ... on GenericFile { id url }
        }
        userErrors { field message code }
      }
    }
  `, {
    files: [{
      originalSource: target.resourceUrl,
      contentType: 'IMAGE',
      alt: alt || filename,
    }],
  });
  const userErrors = createRes?.fileCreate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(`fileCreate failed: ${userErrors.map(e => e.message).join('; ')}`);
  }
  const file = createRes?.fileCreate?.files?.[0];
  if (!file) throw new Error('fileCreate returned no file');

  const immediateUrl = file.image?.url || file.url;
  const finalUrl = immediateUrl && file.fileStatus === 'READY'
    ? immediateUrl
    : await pollUntilReady(file.id);

  return { cdnUrl: finalUrl, fileId: file.id, source: 'shopify' };
}

module.exports = { rehostImageOnShopify, rehostImageFromFile, isShopifyCdnUrl };
