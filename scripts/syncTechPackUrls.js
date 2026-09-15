#!/usr/bin/env node
/**
 * Point every `tech_packs` row at its tech pack on Drive.
 *
 *   node scripts/syncTechPackUrls.js            # show what it would set
 *   node scripts/syncTechPackUrls.js --write    # write tech_packs.tech_pack_url
 *
 * The tech packs live in two folders owned by Pigeons & Thread and shared with
 * our service account. Matching is by name: each product carries the words that
 * appear in its tech pack's title, most specific first, and a title has to match
 * every word. Ambiguous or unmatched products are reported rather than guessed,
 * because pointing a product at the wrong tech pack would silently put another
 * garment's sketch and targets on a QC sheet.
 *
 * Run it when a tech pack is replaced with a new version (the title changes) or
 * a new product gets one.
 */

require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { getDriveClient } = require('../shared/googleDriveClient');

const FOLDERS = [
  '1N9OEIc7xrjasPoUWxXli3_72bY_ohy5w', // TECHPACKS - DO NOT MOVE FILES
  '1GAe_Blmbt0cz72LeXdWSEzLvCwWnbkOZ', // OLD TECHPACKS
];

// tech_packs.product_handle -> words that must all appear in the tech pack title.
// `avoid` rules out a near-miss (the Cami has a "Round 4 comments" copy; the
// Genesis surf short and the older "sport short" are different garments).
const MATCH = {
  aj: { words: ['aj'] },
  charlie: { words: ['charlie'] },
  flo: { words: ['flo'] },
  sassy: { words: ['sassy'] },
  naomi: { words: ['naomi'] },
  brooke: { words: ['brooke'] },
  boxer: { words: ['boxer'] },
  cami: { words: ['cami'], avoid: ['comments'] },
  sportsbra: { words: ['sports', 'bra'] },
  ava: { words: ['seamless'] },
  ruby: { words: ['bikini'], avoid: ['cheeky', 'high waisted'] },
  cheeky: { words: ['cheeky'] },
  mia: { words: ['mia'] },
  tankini: { words: ['tankini'] },
  shorty: { words: ['shorty'] },
  genesis: { words: ['genesis'] },
  stella: { words: ['high waisted'] },
  sky_reg: { words: ['sky'] },
  sky_youth: { words: ['sky'] },
};

async function listTechPacks(drive) {
  const files = [];
  for (const folder of FOLDERS) {
    const { data } = await drive.files.list({
      q: `'${folder}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, shortcutDetails)',
      pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    for (const f of data.files || []) {
      const isSheet = f.mimeType === 'application/vnd.google-apps.spreadsheet';
      const isShortcut = f.mimeType === 'application/vnd.google-apps.shortcut';
      if (isSheet || isShortcut) files.push(f);
    }
  }
  return files;
}

function matchFile(handle, files) {
  const rule = MATCH[handle];
  if (!rule) return { error: 'no match rule — add one to MATCH in this script' };
  const hits = files.filter((f) => {
    const t = f.name.toLowerCase();
    if (!rule.words.every((w) => t.includes(w))) return false;
    return !(rule.avoid || []).some((w) => t.includes(w));
  });
  if (!hits.length) return { error: `no tech pack titled like [${rule.words.join(' + ')}]` };
  if (hits.length > 1) return { error: `ambiguous: ${hits.map((h) => h.name).join(' | ')}` };
  return { file: hits[0] };
}

async function main() {
  const write = process.argv.includes('--write');
  const sb = getSupabaseClient();
  const drive = await getDriveClient();
  const files = await listTechPacks(drive);
  const { data: rows, error } = await sb.from('tech_packs').select('id, product_handle, tech_pack_url').order('product_handle');
  if (error) throw new Error(`tech_packs: ${error.message}`);

  console.log(`${files.length} tech packs on Drive, ${rows.length} tech_packs rows${write ? '' : ' — DRY RUN, pass --write to save'}\n`);
  const updates = [];
  for (const row of rows) {
    const m = matchFile(row.product_handle, files);
    if (m.error) { console.log(`✗ ${row.product_handle.padEnd(11)} ${m.error}`); continue; }
    const url = `https://docs.google.com/spreadsheets/d/${m.file.id}`;
    const unchanged = row.tech_pack_url === url;
    console.log(`${unchanged ? '·' : '✓'} ${row.product_handle.padEnd(11)} ${m.file.name}`);
    if (!unchanged) updates.push({ id: row.id, url });
  }

  if (!updates.length) { console.log('\nnothing to change'); return; }
  if (!write) { console.log(`\n${updates.length} row(s) would be updated`); return; }
  for (const u of updates) {
    const { error: e } = await sb.from('tech_packs').update({ tech_pack_url: u.url, updated_at: new Date().toISOString() }).eq('id', u.id);
    if (e) throw new Error(`update ${u.id}: ${e.message}`);
  }
  console.log(`\n${updates.length} row(s) updated`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { matchFile, MATCH };
