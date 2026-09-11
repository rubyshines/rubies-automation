/**
 * backfillProgramProfiles.js — land the read of every org's programme.
 *
 * The reading itself is in b2b-outreach/data/program-profiles.json: 83 orgs,
 * classified in a Claude Code session on 2026-09-11 from what each org said in
 * its own words (survey write-up, call recording, their own replies). No model
 * call runs here or anywhere in this feature — see the note at the top of
 * lib/programProfile.js.
 *
 * Re-runnable: writes are by company id and the watermark comes from a live
 * gather, so a company whose evidence has moved on since the file was written
 * is reported rather than stamped as current.
 *
 *   node b2b-outreach/sync/backfillProgramProfiles.js           # print only
 *   node b2b-outreach/sync/backfillProgramProfiles.js --write   # apply
 */
require('dotenv').config();
const path = require('path');
const { setProgramProfile, listProgramProfiles, programLine } = require('../lib/programProfile');

const DATA = path.join(__dirname, '..', 'data', 'program-profiles.json');

async function run({ write = false } = {}) {
  const { profiles, _read_on: readOn } = require(DATA);
  if (!readOn) throw new Error('program-profiles.json needs _read_on: staleness is measured against when the reading happened.');
  const rows = await listProgramProfiles();
  const byId = new Map(rows.map(r => [r.id, r]));

  const applied = [];
  const missing = [];
  const moved = [];
  const unchanged = [];

  for (const p of profiles) {
    const row = byId.get(p.id);
    if (!row) { missing.push(p.id); continue; }

    // The file recorded a reading of the evidence as it stood on `_read_on`. If
    // evidence has landed SINCE THE READING, say so rather than stamping the old
    // reading as current — the watermark must never lie about what was read.
    //
    // Compared against the reading date, NOT against the newest date in
    // `sources`: those are different things and conflating them reported 21
    // orgs as stale on the first run. `sources` is what the reading rests on —
    // the message that actually said what they run — and a "thanks!" or an
    // out-of-office landing two days later is newer evidence that was read and
    // correctly not cited. Only something arriving after the reading is new.
    if (row.evidence_through && readOn
      && new Date(row.evidence_through) > new Date(`${readOn}T23:59:59Z`)) {
      moved.push({ id: p.id, read_on: readOn, evidence_through: row.evidence_through });
    }

    // Compared through programLine(), the one function that defines how a
    // profile renders. Rebuilding the expected string by hand here got the
    // `unknown` case wrong — programLine() returns null for it, deliberately,
    // so all 27 unknown rows rewrote themselves on every run.
    if (row.type === p.type && row.line === programLine({ type: p.type, line: p.line })) {
      unchanged.push(p.id);
      continue;
    }

    if (write) {
      await setProgramProfile(p.id, {
        type: p.type,
        line: p.line,
        sources: p.sources,
        evidence_through: row.evidence_through,
      });
    }
    applied.push({ id: p.id, name: row.name, type: p.type, line: p.line });
  }

  const noEvidence = rows.filter(r => !r.has_evidence).length;
  return { applied, unchanged, missing, moved, no_evidence: noEvidence, total_orgs: rows.length, write };
}

module.exports = { run };

if (require.main === module) {
  const write = process.argv.includes('--write');
  run({ write }).then(r => {
    console.log(`${write ? 'WROTE' : 'DRY RUN'} — ${r.applied.length} profile(s), ${r.unchanged.length} already current`);
    for (const a of r.applied) console.log(`  ${a.type.padEnd(16)} ${a.id}${a.line ? ` — ${a.line}` : ''}`);
    if (r.missing.length) console.log(`\nNot in b2b_companies (skipped): ${r.missing.join(', ')}`);
    if (r.moved.length) {
      console.log('\nEvidence has landed since the reading — re-read these:');
      for (const m of r.moved) console.log(`  ${m.id}: read ${m.read_on}, newest evidence ${String(m.evidence_through).slice(0, 10)}`);
    }
    console.log(`\n${r.total_orgs} orgs total; ${r.no_evidence} have nothing on record to read.`);
    if (!write) console.log('\nRe-run with --write to apply.');
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
