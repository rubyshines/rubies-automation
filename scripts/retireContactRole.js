#!/usr/bin/env node
/**
 * retireContactRole.js — empty `b2b_contacts.role` and put what was in it
 * somewhere it belongs.
 *
 * `role` and `title` were two fields for one fact, and only one of them was
 * ever read for anything a person sees. What `role` actually accumulated:
 *
 *   - `program_coordinator` on 30 rows — a blanket label the org sync stamped
 *     on every contact it created, true of nobody in particular. It now
 *     contradicts real titles harvested from signatures (a Senior Director, a
 *     Social Worker, an Executive Board Secretary are all "program_coordinator"
 *     here), so carrying it into `title` would make the book less accurate, not
 *     more. Dropped.
 *   - one real job title ("Owner") — moved to `title` when `title` is empty.
 *   - four sentences of sales notes ("Store owner said it wasn't a fit for
 *     their store") pasted into the field by the Main Contacts sheet import —
 *     appended to `notes`, which is what that column is for.
 *
 * Run alongside the change that stops writing `role` (this sync and the
 * contact-update tool). Running it while a writer still sets the column would
 * just refill it on the next sync.
 *
 * Usage: node scripts/retireContactRole.js [--live]   (print-only by default)
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

/** The sync's blanket stamp — information-free, so it is not migrated. */
const BLANKET = 'program_coordinator';
/** Above this it is prose, not a job title. */
const TITLE_WORDS = 6;

/** Where does this role value belong? PURE. */
function classifyRole(role, title) {
  const v = String(role || '').trim();
  if (!v) return { to: 'drop' };
  if (v === BLANKET) return { to: 'drop' };
  if (v.split(/\s+/).length <= TITLE_WORDS && !/[.!?]/.test(v)) {
    return title ? { to: 'drop' } : { to: 'title', value: v };
  }
  return { to: 'notes', value: v };
}

async function main() {
  const live = process.argv.includes('--live');
  const sb = getSupabaseClient();

  const { data: rows, error } = await sb.from('b2b_contacts')
    .select('email, role, title, notes').not('role', 'is', null);
  if (error) throw new Error(error.message);
  console.log(`${rows.length} contacts carry a role value.`);

  const counts = { drop: 0, title: 0, notes: 0 };
  for (const r of rows) {
    const where = classifyRole(r.role, r.title);
    counts[where.to]++;
    const patch = { role: null };
    if (where.to === 'title') patch.title = where.value;
    if (where.to === 'notes') {
      patch.notes = [r.notes, `From the old role field: ${where.value}`].filter(Boolean).join('\n');
    }
    console.log(`${live ? 'WROTE' : 'would write'}  ${r.email.padEnd(38)} ${where.to}${where.value ? `: "${where.value.slice(0, 60)}"` : ''}`);
    if (live) {
      const { error: uErr } = await sb.from('b2b_contacts')
        .update({ ...patch, updated_at: new Date().toISOString() }).eq('email', r.email);
      if (uErr) throw new Error(`${r.email}: ${uErr.message}`);
    }
  }
  console.log(`\n${rows.length} rows: ${counts.drop} cleared, ${counts.title} moved to title, ${counts.notes} appended to notes.`);
  if (!live) console.log('Re-run with --live to write.');
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });

module.exports = { classifyRole };
