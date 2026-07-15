/**
 * Process raw product-shoot PNGs into site-ready images.
 *
 * Replaces the old rubies-utilities/scripts/core/process-product-images.js.
 *
 * What it does:
 *   1. Parses raw shoot filenames (e.g. "2026_0701_Rubies_CKY_BLK_0012.png",
 *      "2026_0701_Rubies_ESB-BLK-0021.png") into product / color / size / frame,
 *      tolerating mixed _- separators and case typos.
 *   2. Renames to the live-site convention PRODUCT-COLOR-SIZE-NN.png
 *      (NN = 01..N per product+color group, ordered by ascending frame number).
 *   3. Dimension-aware compositing: reads each image's alpha bounding box and
 *      decides the treatment from what it sees, no alignment markers needed:
 *        - content clear of all edges  -> trim, scale to 80% of canvas, center
 *        - content touching edges      -> anchor to the touched edges
 *          (e.g. a close-up crop that bleeds off the bottom is fitted to full
 *          width and bottom-aligned; a full-bleed crop covers the canvas)
 *   4. Composites onto the standard 11:12 pastel canvas. Background colors
 *      rotate deterministically within each product+color group, so re-runs
 *      always produce identical output.
 *
 * Usage:
 *   node scripts/process-product-images.js --src ~/Downloads/Review-V1 [--out DIR] [--width 1000]
 *
 * Output: DIR (default <src>/processed) with final PNGs + manifest.json
 * describing source -> output mapping and intended upload order.
 *
 * Upload to Shopify is a separate step (see manifest.json); this script only
 * produces files locally.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// sharp is not a dependency of this repo (it would bloat the Railway deploy);
// resolve it from the rubies-utilities checkout where it is installed.
let sharp;
try {
  sharp = require('sharp');
} catch {
  const UTIL_SHARP = path.join(
    os.homedir(),
    'Library/Mobile Documents/com~apple~CloudDocs/Documents/RUBIES creative content/code/rubies-repo/rubies-utilities/node_modules/sharp'
  );
  sharp = require(UTIL_SHARP);
}

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

// Shoot code -> live-site product code (site filenames are the source of truth:
// Evey Sports Bra is SPB on the site, Naomi gaff is GF).
const PRODUCT_CODE_MAP = {
  ESB: 'SPB',
  NEOMI: 'GF',
  NAOMI: 'GF',
};

// Default sample-size token per (site) product code when the shoot filename
// carries none. Site convention: adult sample = S, kids sample = numeric.
const DEFAULT_SIZE = {
  FLO: '6', // kids dance underwear
};
const DEFAULT_ADULT_SIZE = 'S';

const CANVAS_RATIO = 12 / 11; // height = width * 12/11 (existing 1000x1091)

// Same palettes as the old script; rotate per product+color group.
const BACKGROUND_COLORS = {
  BLK: ['#F3F0FF', '#FFF5FF', '#D7F2FF', '#E5FFED'],
  WHT: ['#D7F2FF', '#EAE4FF'],
  SND: ['#FFF7F3', '#FFFCF8'],
  PNK: ['#FFF7F3', '#FFF8F9', '#F3F0FF', '#FFF5FF'],
  UNI: ['#D7F2FF'],
  BLU: ['#D7F2FF'],
  DEFAULT: ['#F3F0FF', '#FFF5FF'],
};

const COLOR_CODES = new Set(['BLK', 'WHT', 'SND', 'PNK', 'UNI', 'BLU']);

// Content within this many source pixels of an edge counts as touching it.
const EDGE_TOLERANCE = 4;

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw shoot filename into { product, color, size, frame }.
 * Handles: date/brand prefixes, mixed _ and - separators, case typos,
 * optional size token, shoot->site product code remapping.
 * Returns null if the name can't be parsed.
 */
function parseShootFilename(filename) {
  let base = path.basename(filename, path.extname(filename));
  // Strip leading date + brand tokens, e.g. "2026_0701_Rubies_"
  base = base.replace(/^\d{4}[_-]\d{4}[_-]/, '').replace(/^Rubies[_-]/i, '');

  const tokens = base.split(/[_-]+/).filter(Boolean).map((t) => t.toUpperCase());
  if (tokens.length < 3) return null;

  const frameToken = tokens[tokens.length - 1];
  if (!/^\d+$/.test(frameToken)) return null;
  const frame = parseInt(frameToken, 10);

  const product = PRODUCT_CODE_MAP[tokens[0]] || tokens[0];
  const color = tokens[1];
  if (!COLOR_CODES.has(color)) return null;

  // Optional size token between color and frame (e.g. SB-BLK-XS-0024).
  // The site convention uses the token as an age-group marker, not the true
  // sample size: adult files always say S, kids files use a numeric size. So
  // any alpha size token from the shoot (XS, XXS, ...) normalizes to S.
  let size = tokens.length >= 4 ? tokens[2] : null;
  if (!size) size = DEFAULT_SIZE[product] || DEFAULT_ADULT_SIZE;
  else if (/^[A-Z]+$/.test(size)) size = DEFAULT_ADULT_SIZE;

  return { product, color, size, frame };
}

// ---------------------------------------------------------------------------
// Image analysis
// ---------------------------------------------------------------------------

/**
 * Compute the alpha bounding box and which source edges the content touches.
 * Uses sharp's trim offsets rather than scanning pixels.
 */
async function analyzeImage(imagePath) {
  const meta = await sharp(imagePath).metadata();
  const { info } = await sharp(imagePath)
    .trim()
    .toBuffer({ resolveWithObject: true });

  const left = Math.abs(info.trimOffsetLeft || 0);
  const top = Math.abs(info.trimOffsetTop || 0);
  const right = meta.width - (left + info.width);
  const bottom = meta.height - (top + info.height);

  return {
    width: meta.width,
    height: meta.height,
    bbox: { left, top, width: info.width, height: info.height },
    touches: {
      left: left <= EDGE_TOLERANCE,
      top: top <= EDGE_TOLERANCE,
      right: right <= EDGE_TOLERANCE,
      bottom: bottom <= EDGE_TOLERANCE,
    },
  };
}

function treatmentFor(touches) {
  const touched = ['left', 'top', 'right', 'bottom'].filter((e) => touches[e]);
  if (touched.length === 0) return 'center';
  return `bleed:${touched.join('+')}`;
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  hex = hex.replace(/^#/, '');
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16),
  };
}

/**
 * Composite one image onto the pastel canvas.
 *
 * center      -> trim, fit inside 80% box, center
 * bleed:...   -> fit so the bleeding axis spans the full canvas, anchor to the
 *                touched edges, crop overflow on the anchored axis.
 */
async function composite(imagePath, analysis, bgHex, outPath, canvasWidth) {
  const canvasHeight = Math.round(canvasWidth * CANVAS_RATIO);
  const { touches } = analysis;
  const treatment = treatmentFor(touches);

  const trimmed = await sharp(imagePath).trim().toBuffer();
  const tMeta = await sharp(trimmed).metadata();

  let scale;
  if (treatment === 'center') {
    scale = Math.min(
      (canvasWidth * 0.8) / tMeta.width,
      (canvasHeight * 0.8) / tMeta.height
    );
  } else {
    // Bleed: span the full canvas along the bleeding axis.
    const horizontalBleed = touches.left || touches.right;
    const verticalBleed = touches.top || touches.bottom;
    if (horizontalBleed && verticalBleed) {
      // Bleeds both ways -> cover the whole canvas.
      scale = Math.max(canvasWidth / tMeta.width, canvasHeight / tMeta.height);
    } else if (verticalBleed) {
      scale = canvasWidth / tMeta.width; // fit width, anchor top/bottom
    } else {
      scale = canvasHeight / tMeta.height; // fit height, anchor left/right
    }
  }

  const scaledW = Math.round(tMeta.width * scale);
  const scaledH = Math.round(tMeta.height * scale);
  const resized = await sharp(trimmed)
    .resize({ width: scaledW, height: scaledH })
    .toBuffer();

  // Position: center by default, snap to any touched edge.
  let leftOff = Math.round((canvasWidth - scaledW) / 2);
  let topOff = Math.round((canvasHeight - scaledH) / 2);
  if (treatment !== 'center') {
    if (touches.left && !touches.right) leftOff = 0;
    if (touches.right && !touches.left) leftOff = canvasWidth - scaledW;
    if (touches.top && !touches.bottom) topOff = 0;
    if (touches.bottom && !touches.top) topOff = canvasHeight - scaledH;
  }

  // Crop any overflow out of the source region so the composite stays in canvas.
  const cropLeft = Math.max(0, -leftOff);
  const cropTop = Math.max(0, -topOff);
  const visibleW = Math.min(scaledW - cropLeft, canvasWidth - Math.max(0, leftOff));
  const visibleH = Math.min(scaledH - cropTop, canvasHeight - Math.max(0, topOff));
  const inputBuffer =
    cropLeft || cropTop || visibleW < scaledW || visibleH < scaledH
      ? await sharp(resized)
          .extract({ left: cropLeft, top: cropTop, width: visibleW, height: visibleH })
          .toBuffer()
      : resized;

  const rgb = hexToRgb(bgHex);
  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { ...rgb, alpha: 1 },
    },
  })
    .composite([{ input: inputBuffer, left: Math.max(0, leftOff), top: Math.max(0, topOff) }])
    .png()
    .toFile(outPath);

  return treatment;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { width: 1000 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--src') args.src = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--width') args.width = parseInt(argv[++i], 10);
  }
  if (!args.src) {
    console.error('Usage: node scripts/process-product-images.js --src DIR [--out DIR] [--width 1000]');
    process.exit(1);
  }
  args.src = args.src.replace(/^~/, os.homedir());
  args.out = (args.out || path.join(args.src, 'processed')).replace(/^~/, os.homedir());
  return args;
}

async function main() {
  const { src, out, width } = parseArgs(process.argv);
  fs.mkdirSync(out, { recursive: true });

  const files = fs
    .readdirSync(src)
    .filter((f) => /\.png$/i.test(f))
    .sort();

  // Parse and group by product+color.
  const groups = new Map();
  const unparsed = [];
  for (const file of files) {
    const parsed = parseShootFilename(file);
    if (!parsed) {
      unparsed.push(file);
      continue;
    }
    const key = `${parsed.product}-${parsed.color}-${parsed.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file, ...parsed });
  }
  for (const file of unparsed) console.warn(`SKIP (unparsed filename): ${file}`);

  const manifest = [];
  for (const [key, items] of [...groups.entries()].sort()) {
    items.sort((a, b) => a.frame - b.frame);
    const palette = BACKGROUND_COLORS[items[0].color] || BACKGROUND_COLORS.DEFAULT;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const seq = String(i + 1).padStart(2, '0');
      const outName = `${key}-${seq}.png`;
      const bg = palette[i % palette.length];
      const srcPath = path.join(src, item.file);

      const analysis = await analyzeImage(srcPath);
      const treatment = await composite(srcPath, analysis, bg, path.join(out, outName), width);

      console.log(
        `${item.file}  ->  ${outName}  [${analysis.width}x${analysis.height}, ${treatment}, bg ${bg}]`
      );
      manifest.push({
        source: item.file,
        output: outName,
        product: item.product,
        color: item.color,
        size: item.size,
        frame: item.frame,
        position: i + 1,
        sourceDimensions: `${analysis.width}x${analysis.height}`,
        treatment,
        background: bg,
      });
    }
  }

  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n${manifest.length} images processed -> ${out}`);
  if (unparsed.length) console.log(`${unparsed.length} skipped (see warnings above)`);
}

main().catch((e) => {
  console.error('Processing failed:', e);
  process.exit(1);
});
