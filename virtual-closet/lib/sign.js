'use strict';
/**
 * A printable sign for a link-mode centre (Jamie, 2026-09-21): one letter
 * page with RUBIES × the centre's logo, the page's headline, the QR that
 * opens the closet page, and the address under it. Attached to the welcome
 * email as closet-sign.pdf; the centre prints it and puts it up.
 *
 * Built with pdfkit (pure JS, so it runs on Railway). Logos are fetched from
 * the Shopify CDN and skipped, never fatal, if a fetch fails or the file is
 * not a PNG or JPEG (pdfkit cannot place an SVG).
 */
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { LOGO_PNG, COLOURS } = require('./brand');

const PAGE = { width: 612, height: 792, margin: 54 }; // US letter, points

async function fetchImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!/png|jpe?g/.test(type)) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) { console.warn(`[vc sign] logo skipped (${url}): ${err.message}`); return null; }
}

/** The finished PDF as a Buffer. `url` is the closet page; `logos: false` skips the network (tests). */
async function signPdf(centre, { url, logos = true } = {}) {
  const [rubies, theirs, qr] = await Promise.all([
    logos ? fetchImage(LOGO_PNG) : null,
    logos ? fetchImage(centre.logo_url) : null,
    QRCode.toBuffer(url, { type: 'png', width: 900, margin: 1, color: { dark: COLOURS.ink, light: '#FFFFFF' } }),
  ]);
  const doc = new PDFDocument({ size: 'LETTER', margin: PAGE.margin, info: { Title: `${centre.name} Virtual Closet`, Author: 'RUBIES' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const inner = PAGE.width - PAGE.margin * 2;
  let y = PAGE.margin;

  // Logos: RUBIES × centre, on one line, the row centred.
  const logoH = 44;
  const parts = [];
  if (rubies) parts.push({ img: rubies, w: logoH * (489 / 135), h: logoH });
  if (rubies && theirs) parts.push({ text: '×', w: 24 });
  if (theirs) parts.push({ img: theirs, w: logoH * 1.9, h: logoH, fit: true });
  const rowW = parts.reduce((s, p) => s + p.w, 0) + Math.max(0, parts.length - 1) * 14;
  let x = PAGE.margin + (inner - rowW) / 2;
  for (const p of parts) {
    if (p.img) doc.image(p.img, x, y, p.fit ? { fit: [p.w, p.h], align: 'center', valign: 'center' } : { height: p.h });
    else doc.fillColor(COLOURS.soft).font('Helvetica').fontSize(22).text(p.text, x, y + 9, { width: p.w, align: 'center' });
    x += p.w + 14;
  }
  y += (parts.length ? logoH : 0) + 40;

  doc.fillColor(COLOURS.blue).font('Helvetica-Bold').fontSize(27).text('Shop 20% off gender-affirming gear.', PAGE.margin, y, { width: inner, align: 'center' });
  y = doc.y + 14;
  doc.fillColor(COLOURS.ink).font('Helvetica').fontSize(14).text(`Shop RUBIES and support ${centre.name} Virtual Closet. RUBIES will donate a quarter of the value of your order to the closet.`, PAGE.margin, y, { width: inner, align: 'center', lineGap: 3 });
  y = doc.y + 28;

  const qrSize = 340;
  doc.image(qr, PAGE.margin + (inner - qrSize) / 2, y, { width: qrSize, height: qrSize });
  y += qrSize + 16;
  doc.fillColor(COLOURS.ink).font('Helvetica-Bold').fontSize(13).text('Scan to shop, or to sponsor the closet.', PAGE.margin, y, { width: inner, align: 'center' });
  y = doc.y + 6;
  doc.fillColor(COLOURS.blue).font('Helvetica').fontSize(13).text(url.replace(/^https?:\/\//, ''), PAGE.margin, y, { width: inner, align: 'center' });
  y = doc.y + 30;
  doc.fillColor(COLOURS.ink).font('Helvetica').fontSize(11).text(`${centre.name} uses what's raised to give free gender-affirming clothing to people who need it.`, PAGE.margin, y, { width: inner, align: 'center', lineGap: 2 });

  doc.fillColor(COLOURS.soft).font('Helvetica').fontSize(10).text('RUBIES · rubyshines.com · Never stop shining.', PAGE.margin, PAGE.height - PAGE.margin - 14, { width: inner, align: 'center' });
  doc.end();
  return done;
}

module.exports = { signPdf };
