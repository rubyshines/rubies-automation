#!/usr/bin/env node
/**
 * Fetch a product's points-of-measure sketch out of its tech pack and store it
 * as the QC sheet's per-product asset.
 *
 *   node scripts/fetchPomSketch.js <handle|all>          # preview only (default)
 *   node scripts/fetchPomSketch.js naomi --write         # save the asset
 *   node scripts/fetchPomSketch.js all --write --force   # refresh every product
 *
 * Why this exists: `generate_qc_sheet` embeds `customer-service/assets/qc-pom/
 * <tech-pack handle>.<ext>` on each tab, and that asset is stored, never drawn at
 * generate time. This is how the stored one is produced, so adding a new product
 * is one command rather than a manual export-and-crop.
 *
 * How it works:
 *   1. `tech_packs.tech_pack_url` holds the tech pack's Drive URL — Supabase is
 *      the registry, populated by scripts/syncTechPackUrls.js.
 *   2. Drive exports the tech pack as .xlsx. (A Sheet's stored size is not its
 *      export size: a 40MB tech pack exports as ~8MB of xlsx.)
 *   3. The sketch is lifted off the Points of Measure sheet as the embedded
 *      IMAGE OBJECT it already is — no rendering, no pixel-cropping.
 *
 * The image-object route is deliberate. The obvious alternative — render the tab
 * to PDF and crop the drawing out of the page — has to guess where the drawing
 * ends and the measurement table begins, and that guess breaks on every layout
 * variation (reference photos under the table, drawings below it rather than
 * beside it, full-width header rules closing the gutter it keys on). Anchors are
 * exact, and they are already in the file.
 *
 * Assets are always flattened onto white — tech packs hold transparent PNGs and
 * at least one CMYK JPEG, neither of which renders dependably everywhere — but
 * the container follows the source: PNG for line drawings, JPEG for the tech
 * packs whose "sketch" is really a measured photograph, because re-encoding a
 * photograph as PNG multiplies its size (Genesis: 210KB of JPEG, 1.8MB of PNG).
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { getSupabaseClient } = require('../shared/supabaseClient');
const { getDriveClient, driveIdFromUrl, resolveShortcut, exportSheetXlsx } = require('../shared/googleDriveClient');

const ASSET_DIR = path.join(__dirname, '..', 'customer-service', 'assets', 'qc-pom');

let sharp;
try {
  sharp = require('sharp');
} catch {
  // Same fallback as scripts/process-product-images.js — sharp is deliberately
  // not a dependency of this repo (it would bloat the Railway image).
  sharp = require(path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Documents/RUBIES creative content/code/rubies-repo/rubies-utilities/node_modules/sharp'));
}

// The drawing sits in the top band of the sheet, right of the POM table.
// Below that band is reference photography and pattern-piece screenshots; the
// logo is small and sits in the far-left corner.
const SKETCH_MAX_ROW = 24;    // anchored no lower than this (0-based)
const SKETCH_MIN_COL = 3;     // anchored right of the measurement table
const SKETCH_MIN_WIDTH = 400; // px — rules out logos and icons

// The sheet displays the sketch ~600px wide, and a workbook carries one per
// tab, so a 2048px source is all cost. Cap the stored asset well above display
// size (it stays crisp if someone zooms) but nowhere near the 2MB originals.
const MAX_ASSET_WIDTH = 1400;

const isPomSheet = (name) => /points?\s*of\s*measure/i.test(String(name || ''));

/**
 * Choose the points-of-measure drawing among a sheet's embedded images. Pure.
 *
 * @param {Array} images  ExcelJS `worksheet.getImages()` entries
 * @returns {{image: object, row, col, width, height, reason}|null}
 */
function pickSketch(images) {
  const scored = images.map((img) => {
    const { tl, ext } = img.range;
    return {
      image: img,
      row: tl.nativeRow,
      col: tl.nativeCol,
      width: ext ? Math.round(ext.width) : 0,
      height: ext ? Math.round(ext.height) : 0,
    };
  });
  const candidates = scored.filter((s) =>
    s.row <= SKETCH_MAX_ROW && s.col >= SKETCH_MIN_COL && s.width >= SKETCH_MIN_WIDTH);
  if (!candidates.length) return null;
  // Topmost anchor wins — the drawing sits above any comparison shots sharing
  // the band. Widest breaks a tie, since it spans the front and back views.
  candidates.sort((a, b) => (a.row - b.row) || (b.width - a.width));
  const pick = candidates[0];
  return { ...pick, reason: `r${pick.row}c${pick.col} ${pick.width}x${pick.height}` };
}

async function techPackRows(handle) {
  const sb = getSupabaseClient();
  let q = sb.from('tech_packs').select('product_handle, product_name, tech_pack_url').order('product_handle');
  if (handle && handle !== 'all') q = q.eq('product_handle', handle.toLowerCase());
  const { data, error } = await q;
  if (error) throw new Error(`tech_packs: ${error.message}`);
  if (!data.length) throw new Error(`no tech_packs row for "${handle}" (handles come from the tech_packs table)`);
  return data;
}

/** Fetch one product's sketch. Returns a report; writes the asset only with `write`. */
async function fetchOne(row, { write = false, force = false, outDir = ASSET_DIR } = {}) {
  const handle = row.product_handle;
  const existing = ['png', 'jpg', 'jpeg', 'gif'].map((e) => path.join(outDir, `${handle}.${e}`)).filter((f) => fs.existsSync(f));
  if (!force && write && existing.length) return { handle, skipped: 'asset exists (use --force to replace)' };
  if (!row.tech_pack_url) return { handle, error: 'tech_packs.tech_pack_url is empty — run scripts/syncTechPackUrls.js' };

  const id0 = driveIdFromUrl(row.tech_pack_url);
  if (!id0) return { handle, error: `could not read a Drive id out of ${row.tech_pack_url}` };

  const drive = await getDriveClient();
  const { id, name } = await resolveShortcut(drive, id0);
  const xlsx = await exportSheetXlsx(id);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx);
  const ws = wb.worksheets.find((w) => isPomSheet(w.name));
  if (!ws) return { handle, techPack: name, error: `no "Points of Measure" sheet (tabs: ${wb.worksheets.map((w) => w.name).join(', ').slice(0, 110)})` };

  const images = ws.getImages();
  if (!images.length) return { handle, techPack: name, error: 'the Points of Measure sheet has no embedded images' };

  const pick = pickSketch(images);
  if (!pick) return { handle, techPack: name, error: `no drawing among ${images.length} image(s) — none anchored in the top band right of the table` };

  const media = wb.getImage(pick.image.imageId);
  // Flatten onto white and standardise on PNG: tech packs carry transparent PNGs
  // and at least one CMYK JPEG, neither of which renders dependably everywhere.
  const asJpeg = /jpe?g/i.test(media.extension || '');
  const pipeline = sharp(media.buffer)
    .flatten({ background: '#ffffff' })
    .resize({ width: MAX_ASSET_WIDTH, withoutEnlargement: true });
  const out = await (asJpeg ? pipeline.jpeg({ quality: 88 }) : pipeline.png({ compressionLevel: 9 })).toBuffer();
  const meta = await sharp(out).metadata();
  const file = path.join(outDir, `${handle}.${asJpeg ? 'jpg' : 'png'}`);
  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of existing) if (f !== file) fs.unlinkSync(f);
    fs.writeFileSync(file, out);
  }
  return {
    handle, techPack: name, path: write ? file : null,
    size: `${meta.width}x${meta.height}`, kb: Math.round(out.length / 1024),
    format: asJpeg ? 'jpg' : 'png', source: media.extension, reason: pick.reason, images: images.length,
    buffer: write ? null : out,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const force = args.includes('--force');
  const target = args.find((a) => !a.startsWith('--')) || 'all';
  const previewDir = write ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'pom-preview-'));

  const rows = await techPackRows(target);
  console.log(`${rows.length} tech pack(s)${write ? '' : ' — DRY RUN, pass --write to save'}\n`);
  let ok = 0;
  const problems = [];
  for (const row of rows) {
    try {
      const r = await fetchOne(row, { write, force });
      if (r.error) { console.log(`✗ ${r.handle.padEnd(11)} ${r.error}`); problems.push(r.handle); continue; }
      if (r.skipped) { console.log(`· ${r.handle.padEnd(11)} ${r.skipped}`); continue; }
      ok++;
      if (previewDir) fs.writeFileSync(path.join(previewDir, `${r.handle}.${r.format}`), r.buffer);
      console.log(`✓ ${r.handle.padEnd(11)} ${r.size.padEnd(10)} ${String(r.kb + 'KB').padEnd(7)} ${r.format} · ${r.reason} (of ${r.images})`);
    } catch (e) {
      console.log(`✗ ${row.product_handle.padEnd(11)} ${e.message.slice(0, 130)}`);
      problems.push(row.product_handle);
    }
  }
  console.log(`\n${ok}/${rows.length} sketches ${write ? `written to ${path.relative(process.cwd(), ASSET_DIR)}/` : `previewed in ${previewDir}`}`);
  if (problems.length) console.log(`needs a hand: ${problems.join(', ')}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { pickSketch, isPomSheet, fetchOne, SKETCH_MAX_ROW, SKETCH_MIN_COL, SKETCH_MIN_WIDTH, MAX_ASSET_WIDTH };
