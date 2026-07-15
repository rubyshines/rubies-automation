/**
 * Recolor a product shot to another colorway using a reference image.
 *
 * Stopgap for when the photographer shot only one colorway (or recolored the
 * wrong garment): takes the luminance detail of each input image and maps it
 * through the color ramp of a reference image via histogram matching, so the
 * output keeps the input's fabric texture but wears the reference's color.
 * Transparency is preserved, so outputs flow straight into
 * scripts/process-product-images.js like any other shoot file.
 *
 * Usage:
 *   node scripts/recolor-product-images.js \
 *     --ref  path/to/reference.png   (garment in the TARGET color, alpha background)
 *     --color PNK                    (color token for output filenames)
 *     --out  DIR                     (output directory)
 *     input1.png [input2.png ...]    (garment shots to recolor, alpha background)
 *
 * Output names replace the input's color token with --color, e.g.
 * "2026_0701_Rubies_HLA_BLK_0043.png" -> "HLA_PNK_0043.png".
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let sharp;
try {
  sharp = require('sharp');
} catch {
  sharp = require(path.join(
    os.homedir(),
    'Library/Mobile Documents/com~apple~CloudDocs/Documents/RUBIES creative content/code/rubies-repo/rubies-utilities/node_modules/sharp'
  ));
}

const COLOR_TOKEN = /(^|[_-])(BLK|WHT|SND|PNK|UNI|BLU)([_-])/i;
const ALPHA_SOLID = 200; // only fully-opaque pixels inform the color statistics

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function loadRaw(p) {
  return sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

/**
 * Decide which reference pixels belong to the garment. Preferred signal is
 * the alpha channel; if the reference is flattened (no transparency, e.g. an
 * image downloaded from the live site), fall back to masking by color
 * distance from the background, sampled at the four corners.
 */
function garmentMask(data, info) {
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < ALPHA_SOLID) transparent++;
  if (transparent / (data.length / 4) > 0.01) {
    return (i) => data[i + 3] >= ALPHA_SOLID;
  }
  // Flattened reference: background color = mean of the four corner pixels.
  const w = info.width, h = info.height;
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
  const bg = [0, 1, 2].map((c) => corners.reduce((s, o) => s + data[o + c], 0) / 4);
  const BG_DIST = 30;
  return (i) => {
    const dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db) > BG_DIST;
  };
}

/**
 * Build a 101-entry color ramp from the reference image: for each luminance
 * percentile of the garment pixels, the mean RGB of pixels around that
 * percentile.
 */
function buildRamp(data, info) {
  const isGarment = garmentMask(data, info);
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    if (isGarment(i)) {
      pixels.push([luminance(data[i], data[i + 1], data[i + 2]), data[i], data[i + 1], data[i + 2]]);
    }
  }
  if (pixels.length < 1000) throw new Error('Reference has too few opaque pixels');
  pixels.sort((a, b) => a[0] - b[0]);

  const ramp = [];
  for (let p = 0; p <= 100; p++) {
    const lo = Math.floor((p / 100) * (pixels.length - 1) * 0.98);
    const hi = Math.min(pixels.length - 1, lo + Math.max(50, Math.floor(pixels.length * 0.02)));
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = lo; i <= hi; i++) {
      r += pixels[i][1]; g += pixels[i][2]; b += pixels[i][3]; n++;
    }
    ramp.push([r / n, g / n, b / n]);
  }
  return ramp;
}

/** CDF of garment luminance (256 bins) -> percentile 0..100 */
function buildCdf(data) {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] >= ALPHA_SOLID) {
      hist[Math.round(luminance(data[i], data[i + 1], data[i + 2]))]++;
      total++;
    }
  }
  const cdf = new Float64Array(256);
  let acc = 0;
  for (let l = 0; l < 256; l++) {
    acc += hist[l];
    cdf[l] = (acc / total) * 100;
  }
  return cdf;
}

function recolorPixels(data, cdf, ramp) {
  const out = Buffer.from(data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const l = Math.round(luminance(data[i], data[i + 1], data[i + 2]));
    const p = cdf[l];
    const lo = Math.min(100, Math.floor(p));
    const hi = Math.min(100, lo + 1);
    const f = p - lo;
    out[i] = Math.round(ramp[lo][0] * (1 - f) + ramp[hi][0] * f);
    out[i + 1] = Math.round(ramp[lo][1] * (1 - f) + ramp[hi][1] * f);
    out[i + 2] = Math.round(ramp[lo][2] * (1 - f) + ramp[hi][2] * f);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputs = [];
  let ref, color, out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') ref = argv[++i];
    else if (argv[i] === '--color') color = argv[++i].toUpperCase();
    else if (argv[i] === '--out') out = argv[++i];
    else inputs.push(argv[i]);
  }
  if (!ref || !color || !out || !inputs.length) {
    console.error('Usage: node scripts/recolor-product-images.js --ref REF.png --color PNK --out DIR input1.png ...');
    process.exit(1);
  }
  fs.mkdirSync(out, { recursive: true });

  const refRaw = await loadRaw(ref);
  const ramp = buildRamp(refRaw.data, refRaw.info);
  console.log(`Reference ramp from ${path.basename(ref)}: dark rgb(${ramp[5].map(Math.round)}) mid rgb(${ramp[50].map(Math.round)}) light rgb(${ramp[95].map(Math.round)})`);

  for (const input of inputs) {
    const { data, info } = await loadRaw(input);
    const cdf = buildCdf(data);
    const recolored = recolorPixels(data, cdf, ramp);

    const base = path.basename(input, path.extname(input));
    const outName = (COLOR_TOKEN.test(base)
      ? base.replace(COLOR_TOKEN, (m, pre, tok, post) => `${pre}${color}${post}`)
      : `${base}_${color}`) + '.png';

    await sharp(recolored, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toFile(path.join(out, outName));
    console.log(`${path.basename(input)} -> ${outName}`);
  }
}

main().catch((e) => {
  console.error('Recolor failed:', e);
  process.exit(1);
});
