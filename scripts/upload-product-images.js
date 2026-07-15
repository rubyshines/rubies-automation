/**
 * Upload processed product images to Shopify product media, replacing the old
 * numbered shots and enforcing display order.
 *
 * Reads the manifest.json produced by scripts/process-product-images.js.
 * For each product in the manifest:
 *   1. Downloads full-res backups of the media it will delete.
 *   2. Uploads the new images (staged upload -> productCreateMedia).
 *   3. Deletes the old numbered images for the colors being replaced
 *      (keeps -char illustrations and anything it doesn't recognize).
 *   4. Reorders media into color groups: new shots 01..NN, then that color's
 *      -char image; colors follow their current order on the product.
 *
 * Usage:
 *   node scripts/upload-product-images.js --dir ~/Downloads/Review-V1/processed            (dry run)
 *   node scripts/upload-product-images.js --dir ~/Downloads/Review-V1/processed --execute
 *   [--backup DIR]   default <dir>/../replaced-originals
 *   [--product CKY]  limit to one product code
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { shopifyGraphQL } = require('../customer-service/lib/shopify.js');

// Shoot/site product code -> Shopify product. Extend as new codes appear.
const PRODUCTS = {
  CKY: { id: 'gid://shopify/Product/9747272532246', title: 'Cheeky Shaping Bikini Bottom' },
  HLA: { id: 'gid://shopify/Product/9987621454102', title: 'Sassy No-Tuck Shaping Underwear' },
  SB: { id: 'gid://shopify/Product/10173125591318', title: 'Ava Seamless Shaping Bra' },
  SPB: { id: 'gid://shopify/Product/10457041404182', title: 'Evey Shaping Sports Bra' },
  GF: { id: 'gid://shopify/Product/10426378354966', title: 'Naomi Gaff Shaping Underwear' },
  FLO: { id: 'gid://shopify/Product/9987603398934', title: 'Flo Shaping Dance Underwear' },
};

function mediaFilename(url) {
  return decodeURIComponent(url.split('/').pop().split('?')[0]);
}

// "SB-SND-S-01_330eb9c8-....png" -> { code, color, kind, seq }
function classifyFilename(name) {
  const base = name.replace(/_[0-9a-f]{8}-[0-9a-f-]{27}/i, '');
  let m = base.match(/^([A-Z0-9]+)-([A-Z]{3})-[A-Z0-9]+-char\.(png|jpe?g|svg|webp)$/i);
  if (m) return { code: m[1].toUpperCase(), color: m[2].toUpperCase(), kind: 'char' };
  m = base.match(/^([A-Z0-9]+)-([A-Z]{3})-[A-Z0-9]+-(\d+)\.(png|jpe?g|webp)$/i);
  if (m) return { code: m[1].toUpperCase(), color: m[2].toUpperCase(), kind: 'numbered', seq: parseInt(m[3], 10) };
  return { kind: 'other' };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function getProductMedia(productId) {
  const d = await shopifyGraphQL(
    `query($id: ID!) {
      product(id: $id) {
        media(first: 100) {
          nodes { id ... on MediaImage { id image { url } } }
        }
      }
    }`,
    { id: productId }
  );
  return d.product.media.nodes
    .filter((n) => n.image)
    .map((n) => ({ id: n.id, filename: mediaFilename(n.image.url), url: n.image.url }));
}

async function stagedUpload(filePath) {
  const bytes = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const staged = await shopifyGraphQL(
    `mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [{
        filename,
        mimeType: 'image/png',
        httpMethod: 'POST',
        resource: 'IMAGE',
        fileSize: String(bytes.length),
      }],
    }
  );
  const errs = staged?.stagedUploadsCreate?.userErrors || [];
  if (errs.length) throw new Error(`stagedUploadsCreate: ${errs.map((e) => e.message).join('; ')}`);
  const target = staged.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([bytes], { type: 'image/png' }), filename);
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Staged POST failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return target.resourceUrl;
}

async function createMedia(productId, resourceUrls) {
  const d = await shopifyGraphQL(
    `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { ... on MediaImage { id } }
        mediaUserErrors { field message }
      }
    }`,
    {
      productId,
      media: resourceUrls.map((u) => ({ originalSource: u, mediaContentType: 'IMAGE', alt: '' })),
    }
  );
  const errs = d?.productCreateMedia?.mediaUserErrors || [];
  if (errs.length) throw new Error(`productCreateMedia: ${errs.map((e) => e.message).join('; ')}`);
  return d.productCreateMedia.media.map((m) => m.id);
}

async function waitUntilReady(productId, mediaIds, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(mediaIds);
  while (pending.size && Date.now() < deadline) {
    const d = await shopifyGraphQL(
      `query($id: ID!) { product(id: $id) { media(first: 100) { nodes { ... on MediaImage { id fileStatus } } } } }`,
      { id: productId }
    );
    for (const n of d.product.media.nodes) {
      if (!pending.has(n.id)) continue;
      if (n.fileStatus === 'FAILED') throw new Error(`Media ${n.id} failed processing`);
      if (n.fileStatus === 'READY') pending.delete(n.id);
    }
    if (pending.size) await new Promise((r) => setTimeout(r, 2000));
  }
  if (pending.size) throw new Error(`${pending.size} media not READY within ${timeoutMs}ms`);
}

async function deleteMedia(productId, mediaIds) {
  const d = await shopifyGraphQL(
    `mutation($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        mediaUserErrors { field message }
      }
    }`,
    { productId, mediaIds }
  );
  const errs = d?.productDeleteMedia?.mediaUserErrors || [];
  if (errs.length) throw new Error(`productDeleteMedia: ${errs.map((e) => e.message).join('; ')}`);
}

async function reorderMedia(productId, orderedIds) {
  const d = await shopifyGraphQL(
    `mutation($id: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $id, moves: $moves) {
        job { id }
        mediaUserErrors { field message }
      }
    }`,
    { id: productId, moves: orderedIds.map((id, i) => ({ id, newPosition: String(i) })) }
  );
  const errs = d?.productReorderMedia?.mediaUserErrors || [];
  if (errs.length) throw new Error(`productReorderMedia: ${errs.map((e) => e.message).join('; ')}`);
}

async function main() {
  const argv = process.argv.slice(2);
  let dir, backup, only;
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i];
    else if (argv[i] === '--backup') backup = argv[++i];
    else if (argv[i] === '--product') only = argv[++i].toUpperCase();
    else if (argv[i] === '--execute') execute = true;
  }
  if (!dir) {
    console.error('Usage: node scripts/upload-product-images.js --dir PROCESSED_DIR [--execute] [--backup DIR] [--product CODE]');
    process.exit(1);
  }
  dir = dir.replace(/^~/, os.homedir());
  backup = (backup || path.join(dir, '..', 'replaced-originals')).replace(/^~/, os.homedir());

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  const byProduct = new Map();
  for (const m of manifest) {
    if (only && m.product !== only) continue;
    if (!byProduct.has(m.product)) byProduct.set(m.product, []);
    byProduct.get(m.product).push(m);
  }

  console.log(execute ? '=== EXECUTE MODE ===' : '=== DRY RUN (pass --execute to apply) ===');

  for (const [code, items] of byProduct) {
    const product = PRODUCTS[code];
    if (!product) {
      console.warn(`\n${code}: no product mapping — SKIPPED (${items.length} images)`);
      continue;
    }
    console.log(`\n### ${code} → ${product.title}`);

    const existing = (await getProductMedia(product.id)).map((m) => ({
      ...m,
      ...classifyFilename(m.filename),
    }));

    const newColors = [...new Set(items.map((i) => i.color))];

    // Current color order on the product (first appearance in media), then
    // any brand-new colors in manifest order.
    const colorOrder = [];
    for (const m of existing) if (m.color && !colorOrder.includes(m.color)) colorOrder.push(m.color);
    for (const c of newColors) if (!colorOrder.includes(c)) colorOrder.push(c);

    const toDelete = existing.filter(
      (m) => m.kind === 'numbered' && m.code === code && newColors.includes(m.color)
    );
    const keepChars = existing.filter((m) => m.kind === 'char');
    const keepOther = existing.filter(
      (m) => !toDelete.includes(m) && !keepChars.includes(m)
    );

    console.log(`  upload ${items.length}: ${items.map((i) => i.output).join(', ')}`);
    console.log(`  delete ${toDelete.length}: ${toDelete.map((m) => m.filename).join(', ') || '(none)'}`);
    console.log(`  keep   ${keepChars.length + keepOther.length}: ${[...keepChars, ...keepOther].map((m) => m.filename).join(', ') || '(none)'}`);

    // Desired final order: per color -> new 01..NN, then char; then unrecognized media.
    const orderPlan = [];
    for (const color of colorOrder) {
      for (const item of items.filter((i) => i.color === color).sort((a, b) => a.position - b.position)) {
        orderPlan.push({ type: 'new', key: item.output });
      }
      for (const m of keepChars.filter((m) => m.color === color)) {
        orderPlan.push({ type: 'existing', id: m.id, key: m.filename });
      }
    }
    for (const m of keepOther) orderPlan.push({ type: 'existing', id: m.id, key: m.filename });
    console.log(`  order  ${orderPlan.map((o) => o.key).join(' → ')}`);

    if (!execute) continue;

    // 1. Backup what we delete.
    if (toDelete.length) {
      fs.mkdirSync(backup, { recursive: true });
      for (const m of toDelete) {
        await download(m.url, path.join(backup, m.filename));
      }
      console.log(`  backed up ${toDelete.length} originals -> ${backup}`);
    }

    // 2. Upload new media (in manifest order so same-name collisions can't shuffle).
    const newIds = {};
    for (const item of items) {
      const resourceUrl = await stagedUpload(path.join(dir, item.output));
      const [id] = await createMedia(product.id, [resourceUrl]);
      newIds[item.output] = id;
      console.log(`  uploaded ${item.output} -> ${id}`);
    }
    await waitUntilReady(product.id, Object.values(newIds));

    // 3. Delete replaced media.
    if (toDelete.length) {
      await deleteMedia(product.id, toDelete.map((m) => m.id));
      console.log(`  deleted ${toDelete.length} old images`);
    }

    // 4. Enforce order.
    const orderedIds = orderPlan.map((o) => (o.type === 'new' ? newIds[o.key] : o.id));
    await reorderMedia(product.id, orderedIds);
    console.log('  reorder submitted');
  }

  if (execute) {
    // Give reorder jobs a moment, then print final state for verification.
    await new Promise((r) => setTimeout(r, 5000));
    console.log('\n=== FINAL STATE ===');
    for (const code of byProduct.keys()) {
      const product = PRODUCTS[code];
      if (!product) continue;
      const media = await getProductMedia(product.id);
      console.log(`\n${code} → ${product.title}`);
      media.forEach((m, i) => console.log(`  ${i + 1}. ${m.filename}`));
    }
  }
}

main().catch((e) => {
  console.error('Upload failed:', e);
  process.exit(1);
});
