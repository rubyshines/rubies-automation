'use strict';
/**
 * The printable table sign for a link-mode centre (Jamie, 2026-09-21): one
 * US Letter sheet, black and white, that folds into an A-frame tent. Attached
 * to the welcome email as [slug]-virtual-closet-sign.pdf and served at
 * /[slug]/qr-sign so the centre can reprint it without asking.
 *
 * Sheet map, top to bottom (inches):
 *   0 to 1      tab, blank but for its fold note; folded under, hidden
 *   1 to 5.5    staff face, printed upside down so it reads once folded
 *   5.5         the crease
 *   5.5 to 10   visitor face: wordmark, centre name, QR, headline, the pitch
 *   10 to 11    tab, as above
 * The two tabs meet flat on the table and are taped together, which is what
 * keeps a plain-paper tent standing. Every fold note sits on the part that
 * ends up hidden, so nothing printed lands on the ridge or the table edge.
 *
 * Built with pdfkit (pure JS, so it runs on Railway). The wordmark is drawn
 * from public/rubies-logo.svg's paths, in black. Type is Fixel Display, the
 * store's face, fetched once from the Shopify CDN and cached per process;
 * Helvetica when the fetch fails or the network is off (tests).
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const IN = 72; // points per inch
const PAGE = { w: 8.5 * IN, h: 11 * IN };
const TAB = 1 * IN;
const FACE = 4.5 * IN;
const CREASE = 5.5 * IN;
const PAD = { top: 0.32 * IN, side: 0.55 * IN, bottom: 0.28 * IN };
const INNER = PAGE.w - PAD.side * 2;
const GREY = '#888888';
const BLACK = '#000000';

// The store's faces, as public/closet.css declares them. Regular is the
// 500 file; Light (400) is too thin for a copier at 12pt.
const FONT_URLS = {
  bold: 'https://cdn.shopify.com/s/files/1/0255/9636/2837/files/FixelDisplay-Bold.otf?v=1728655781',
  semi: 'https://cdn.shopify.com/s/files/1/0255/9636/2837/files/FixelDisplay-SemiBold.otf?v=1728655781',
  regular: 'https://cdn.shopify.com/s/files/1/0255/9636/2837/files/FixelDisplay-Regular.otf?v=1728655781',
};
const FALLBACK = { bold: 'Helvetica-Bold', semi: 'Helvetica-Bold', regular: 'Helvetica' };
const fontCache = new Map();

async function fetchFont(key) {
  if (fontCache.has(key)) return fontCache.get(key);
  let buf = null;
  try {
    const res = await fetch(FONT_URLS[key], { signal: AbortSignal.timeout(8000) });
    if (res.ok) buf = Buffer.from(await res.arrayBuffer());
  } catch (err) { console.warn(`[vc sign] font ${key} skipped: ${err.message}`); }
  fontCache.set(key, buf);
  return buf;
}

// The wordmark's outlines, read once. Every path is filled black on the sign.
let wordmarkPaths = null;
function wordmark() {
  if (!wordmarkPaths) {
    const svg = fs.readFileSync(path.join(__dirname, '../public/rubies-logo.svg'), 'utf8');
    const box = /viewBox="([\d.\s]+)"/.exec(svg)[1].split(/\s+/).map(Number);
    wordmarkPaths = { w: box[2], h: box[3], d: [...svg.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]) };
  }
  return wordmarkPaths;
}

/** The finished PDF as a Buffer. `url` is the closet page; `logos: false` keeps off the network (tests). */
async function signPdf(centre, { url, logos = true } = {}) {
  const fonts = {};
  for (const key of Object.keys(FONT_URLS)) {
    const buf = logos ? await fetchFont(key) : null;
    fonts[key] = buf ? { name: `Fixel-${key}`, buf } : { name: FALLBACK[key] };
  }
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, info: { Title: `${centre.name} Virtual Closet table sign`, Author: 'RUBIES' } });
  for (const f of Object.values(fonts)) if (f.buf) doc.registerFont(f.name, f.buf);
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const ctx = { doc, fonts, qr, url, centre, shown: url.replace(/^https?:\/\//, '') };
  drawFoldNote(ctx, 0.74 * IN, 'down', 'fold this tab under');
  drawFoldNote(ctx, 5.3 * IN, 'down', 'fold here');
  drawFoldNote(ctx, 10.1 * IN, 'up', 'fold this tab under');

  // The staff face is drawn upright at its own position, then the whole
  // panel is turned 180° about its centre so it reads from behind the table.
  doc.save().rotate(180, { origin: [PAGE.w / 2, TAB + FACE / 2] });
  drawStaffFace(ctx, TAB);
  doc.restore();
  drawVisitorFace(ctx, CREASE);

  doc.end();
  return done;
}

function font(ctx, key, size) { ctx.doc.font(ctx.fonts[key].name).fontSize(size); return ctx.doc; }

function triangle(doc, cx, cy, dir) {
  const w = 0.14 * IN, h = 0.11 * IN;
  if (dir === 'down') doc.moveTo(cx - w / 2, cy - h / 2).lineTo(cx + w / 2, cy - h / 2).lineTo(cx, cy + h / 2).closePath().fill(GREY);
  else doc.moveTo(cx - w / 2, cy + h / 2).lineTo(cx + w / 2, cy + h / 2).lineTo(cx, cy - h / 2).closePath().fill(GREY);
}

/** A row of small arrows pointing at a crease, with a label in the middle. */
function drawFoldNote(ctx, y, dir, label) {
  const { doc } = ctx;
  const cy = y + 0.08 * IN;
  const text = label.toUpperCase();
  font(ctx, 'regular', 7.5).fillColor(GREY);
  const spacing = 1;
  const tw = doc.widthOfString(text, { characterSpacing: spacing });
  const gap = 0.1 * IN;
  triangle(doc, 0.3 * IN + 0.07 * IN, cy, dir);
  triangle(doc, PAGE.w - 0.3 * IN - 0.07 * IN, cy, dir);
  const left = PAGE.w / 2 - tw / 2;
  triangle(doc, left - gap - 0.07 * IN, cy, dir);
  triangle(doc, left + tw + gap + 0.07 * IN, cy, dir);
  doc.fillColor(GREY).text(text, left, cy - 4, { characterSpacing: spacing, lineBreak: false });
  doc.fillColor(BLACK);
}

function drawWordmark(ctx, x, y, h) {
  const { doc } = ctx;
  const wm = wordmark();
  const s = h / wm.h;
  doc.save().translate(x, y).scale(s);
  for (const d of wm.d) doc.path(d).fill(BLACK);
  doc.restore();
  return wm.w * s;
}

/** Wordmark left, the centre's name right, a rule under both. Returns the y below the rule. */
function drawHead(ctx, top, { wordmarkH, nameSize, subSize, rule }) {
  const { doc, centre } = ctx;
  const y = top + PAD.top;
  const nameH = nameSize * 1.1 + subSize * 1.1;
  const rowH = Math.max(wordmarkH, nameH);
  drawWordmark(ctx, PAD.side, y + rowH - wordmarkH, wordmarkH);
  const right = PAGE.w - PAD.side;
  font(ctx, 'bold', nameSize).fillColor(BLACK);
  const nameW = Math.min(doc.widthOfString(centre.name), INNER * 0.55);
  doc.text(centre.name, right - nameW, y + rowH - nameH, { width: nameW, align: 'right', lineBreak: false, ellipsis: true });
  font(ctx, 'semi', subSize);
  doc.text('VIRTUAL CLOSET', right - INNER * 0.55, y + rowH - subSize * 1.1, { width: INNER * 0.55, align: 'right', characterSpacing: subSize * 0.12, lineBreak: false });
  const ruleY = y + rowH + 0.1 * IN;
  doc.moveTo(PAD.side, ruleY).lineTo(right, ruleY).lineWidth(rule).stroke(BLACK);
  return ruleY + rule;
}

function drawQr(ctx, x, y, size) {
  const { doc, qr } = ctx;
  const n = qr.modules.size;
  const cell = size / n;
  doc.save().fillColor(BLACK);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) doc.rect(x + c * cell, y + r * cell, cell + 0.2, cell + 0.2);
  doc.fill();
  doc.restore();
}

function drawVisitorFace(ctx, top) {
  const { doc, centre, shown } = ctx;
  const headBottom = drawHead(ctx, top, { wordmarkH: 0.38 * IN, nameSize: 15, subSize: 10, rule: 2 });

  // Foot: the tagline and the store, above a hairline.
  const footH = 8.5 * 1.2 + 0.08 * IN + 1;
  const footTop = top + FACE - PAD.bottom - footH;
  doc.moveTo(PAD.side, footTop).lineTo(PAGE.w - PAD.side, footTop).lineWidth(1).stroke(BLACK);
  font(ctx, 'regular', 8.5).fillColor('#333333').text('Never stop shining.', PAD.side, footTop + 0.08 * IN + 1, { lineBreak: false });
  font(ctx, 'bold', 8.5).fillColor(BLACK).text('rubyshines.com', PAD.side, footTop + 0.08 * IN + 1, { width: INNER, align: 'right', lineBreak: false });

  // Body: QR left, the pitch right, both centred in what is left.
  const gap = 0.12 * IN;
  const bodyTop = headBottom + gap, bodyBottom = footTop - gap;
  const qrSize = 1.8 * IN;
  const pitchX = PAD.side + qrSize + 0.35 * IN;
  const pitchW = PAGE.w - PAD.side - pitchX;
  const [host, rest] = splitUrl(shown);
  const urlLines = rest ? 2 : 1;
  const qrBlockH = qrSize + 0.08 * IN + urlLines * 9.5 * 1.2;

  // Two set lines, so the wrap never lands inside "gender-affirming", at the
  // largest size where both fit the column (Jamie, 2026-09-21: two lines).
  const h1Lines = ['Scan for 20% off gender-affirming', 'underwear and swimwear.'];
  let h1Size = 24;
  font(ctx, 'bold', h1Size);
  while (h1Size > 14 && h1Lines.some(l => doc.widthOfString(l) > pitchW - 2)) font(ctx, 'bold', h1Size -= 0.5);
  // Each line is drawn unwrapped: pdfkit would otherwise break at the hyphen.
  const h1LineH = h1Size * 1.15;
  const about = `RUBIES makes great fitting, super comfortable clothing made specifically for trans girls and women that look, wear and feel like regular underwear and swimwear.`;
  const quarter = `A quarter of every order goes to ${centre.name}'s Virtual Closet.`;
  const sponsorLead = 'Here as an ally?';
  const sponsor = ' Sponsor the closet from $10 at the same link.';
  const pGap = 0.09 * IN;
  const h1H = h1Lines.length * h1LineH;
  font(ctx, 'regular', 12);
  const aboutH = doc.heightOfString(about, { width: pitchW, lineGap: 2 });
  const quarterH = doc.heightOfString(quarter, { width: pitchW, lineGap: 2 });
  font(ctx, 'regular', 11);
  const sponsorH = doc.heightOfString(sponsorLead + sponsor, { width: pitchW, lineGap: 2 });
  const pitchH = h1H + 0.12 * IN + aboutH + pGap + quarterH + pGap + sponsorH;

  const blockH = Math.max(qrBlockH, pitchH);
  const blockTop = bodyTop + Math.max(0, (bodyBottom - bodyTop - blockH) / 2);

  const qrY = blockTop + (blockH - qrBlockH) / 2;
  drawQr(ctx, PAD.side, qrY, qrSize);
  font(ctx, 'semi', 9.5).fillColor(BLACK);
  doc.text(host, PAD.side, qrY + qrSize + 0.08 * IN, { width: qrSize, align: 'center', lineBreak: false });
  if (rest) doc.text(rest, PAD.side, qrY + qrSize + 0.08 * IN + 9.5 * 1.2, { width: qrSize, align: 'center', lineBreak: false });

  let y = blockTop + (blockH - pitchH) / 2;
  font(ctx, 'bold', h1Size).fillColor(BLACK);
  h1Lines.forEach((l, i) => doc.text(l, pitchX, y + i * h1LineH, { lineBreak: false }));
  y += h1H + 0.12 * IN;
  font(ctx, 'bold', 12).text('RUBIES', pitchX, y, { width: pitchW, continued: true, lineGap: 2 });
  font(ctx, 'regular', 12).text(about.slice('RUBIES'.length), { width: pitchW, lineGap: 2 });
  y += aboutH + pGap;
  font(ctx, 'regular', 12).text(quarter, pitchX, y, { width: pitchW, lineGap: 2 });
  y += quarterH + pGap;
  font(ctx, 'bold', 11).fillColor('#222222').text(sponsorLead, pitchX, y, { width: pitchW, continued: true, lineGap: 2 });
  font(ctx, 'regular', 11).text(sponsor, { width: pitchW, lineGap: 2 });
  doc.fillColor(BLACK);
}

function drawStaffFace(ctx, top) {
  const { doc, centre, shown } = ctx;
  const headBottom = drawHead(ctx, top, { wordmarkH: 0.28 * IN, nameSize: 12, subSize: 8.5, rule: 1 });

  // The setup box sits at the bottom, by the crease once folded. One line of
  // instructions and the reprint address; no diagram (Jamie, 2026-09-21: how
  // to stand it up is obvious).
  const boxText = 'fold the tabs under and the sheet in half, stand it up, and tape the tabs together underneath. Cardstock is best; plain paper works indoors.';
  const reprint = `${shown}/qr-sign`;
  const boxPad = { x: 0.14 * IN, y: 0.09 * IN };
  const textX = PAD.side + boxPad.x;
  const textW = INNER - boxPad.x * 2;
  font(ctx, 'regular', 9);
  const setupH = doc.heightOfString('To set up: ' + boxText, { width: textW, lineGap: 1.5 });
  const reprintH = doc.heightOfString('Reprint any time: ' + reprint, { width: textW, lineGap: 1.5 });
  const boxH = setupH + reprintH + boxPad.y * 2;
  const boxTop = top + FACE - PAD.bottom - boxH;
  doc.rect(PAD.side, boxTop, INNER, boxH).lineWidth(1).stroke(BLACK);
  // pdfkit sizes a continued run from its first call, so the width goes there.
  let y = boxTop + boxPad.y;
  font(ctx, 'bold', 9).fillColor(BLACK).text('To set up: ', textX, y, { width: textW, continued: true, lineGap: 1.5 });
  font(ctx, 'regular', 9).text(boxText, { width: textW, lineGap: 1.5 });
  y += setupH;
  font(ctx, 'bold', 9).text('Reprint any time: ', textX, y, { width: textW, continued: true, lineGap: 1.5 });
  font(ctx, 'regular', 9).text(reprint, { width: textW, lineGap: 1.5 });

  // The facts, between the head and the box.
  let fy = headBottom + 0.1 * IN;
  font(ctx, 'bold', 10).fillColor(BLACK).text('THE FACTS', PAD.side, fy, { characterSpacing: 0.6, lineBreak: false });
  fy += 10 * 1.2 + 0.05 * IN;
  const facts = [
    'RUBIES makes great fitting, super comfortable clothing made specifically for trans girls and women that look, wear and feel like regular underwear and swimwear.',
    '20% off is one order per person, applied at checkout. No code to type.',
    `A quarter of every order and every sponsor dollar goes to ${centre.name}'s Virtual Closet.`,
    'Here as an ally? Anyone can sponsor the closet from $10 at the same link.',
    'Questions: jamie@rubyshines.com',
  ];
  const listX = PAD.side + 0.18 * IN;
  const listW = Math.min(6.6 * IN, PAGE.w - PAD.side - listX);
  font(ctx, 'regular', 11.5);
  for (const fact of facts) {
    doc.text('•', PAD.side + 0.04 * IN, fy, { lineBreak: false });
    doc.text(fact, listX, fy, { width: listW, lineGap: 1.5 });
    fy += doc.heightOfString(fact, { width: listW, lineGap: 1.5 }) + 0.04 * IN;
  }
}

/** "closet.rubyshines.com/the-attic" as ["closet.rubyshines.com", "/the-attic"], so the line under the QR never breaks mid-word. */
function splitUrl(shown) {
  const i = shown.indexOf('/');
  return i === -1 ? [shown, ''] : [shown.slice(0, i), shown.slice(i)];
}

module.exports = { signPdf };
