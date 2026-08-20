/**
 * A small in-memory stand-in for the Supabase client, for write paths that chain
 * more than a one-off stub can carry (order + limit + is/neq + insert…select).
 *
 * Deliberately NOT a PostgREST emulator. It is enough to assert which rows a
 * function decides to touch; it cannot catch a schema violation, a missing
 * NOT NULL, or an ON CONFLICT that does not match a real index — that class of
 * bug has bitten this codebase twice and is only caught by round-tripping
 * against the real table. Unit-test the decisions here; verify the writes for
 * real before shipping.
 */
function fakeSupabase(tables = {}) {
  const db = {};
  for (const [name, rows] of Object.entries(tables)) db[name] = rows.map(r => ({ ...r }));
  const log = [];
  let autoId = 1000;

  function from(name) {
    db[name] = db[name] || [];
    const filters = [];
    const order = [];
    let limit = null;
    let pending = null; // { op, patch }

    const rows = () => {
      let out = db[name].filter(r => filters.every(f => f(r)));
      for (const [col, asc] of [...order].reverse()) {
        out = out.slice().sort((a, b) => {
          const x = a[col] ?? null, y = b[col] ?? null;
          if (x === y) return 0;
          if (x === null) return 1;
          if (y === null) return -1;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      return limit == null ? out : out.slice(0, limit);
    };

    const apply = () => {
      if (!pending) return { data: rows(), error: null };
      if (pending.op === 'update') {
        const hit = db[name].filter(r => filters.every(f => f(r)));
        for (const r of hit) Object.assign(r, pending.patch);
        log.push({ table: name, op: 'update', patch: pending.patch, count: hit.length });
        return { data: hit, error: null };
      }
      if (pending.op === 'insert') {
        const row = { id: ++autoId, ...pending.patch };
        for (const u of db._unique?.[name] || []) {
          if (db[name].some(r => u.every(c => r[c] === row[c]) && u.every(c => row[c] != null))) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
        }
        db[name].push(row);
        log.push({ table: name, op: 'insert', row });
        return { data: row, error: null };
      }
      return { data: rows(), error: null };
    };

    const q = {
      select() { return q; },
      eq(c, v) { filters.push(r => r[c] === v); return q; },
      neq(c, v) { filters.push(r => r[c] !== v); return q; },
      is(c, v) { filters.push(r => (r[c] ?? null) === v); return q; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
      ilike(c, pat) {
        const re = new RegExp(`^${String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i');
        filters.push(r => re.test(r[c] || ''));
        return q;
      },
      order(c, o = {}) { order.push([c, o.ascending !== false]); return q; },
      limit(n) { limit = n; return q; },
      update(patch) { pending = { op: 'update', patch }; return q; },
      insert(patch) { pending = { op: 'insert', patch }; return q; },
      upsert(patch) { pending = { op: 'insert', patch }; return q; },
      maybeSingle() { const r = apply(); return Promise.resolve({ data: (r.data || [])[0] ?? null, error: r.error }); },
      single() {
        const r = apply();
        const one = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
        return Promise.resolve({ data: one, error: r.error });
      },
      then(res, rej) { return Promise.resolve(apply()).then(res, rej); },
    };
    return q;
  }

  return { client: { from }, db, log, unique(table, cols) { db._unique = db._unique || {}; (db._unique[table] = db._unique[table] || []).push(cols); } };
}

module.exports = { fakeSupabase };
