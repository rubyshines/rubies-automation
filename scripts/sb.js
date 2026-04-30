#!/usr/bin/env node
// Ad-hoc Supabase query CLI. Exposes `sb` as the singleton client and evaluates
// a chained query expression. Example:
//   node scripts/sb.js "sb.from('cs_tickets').select('id, status').limit(3)"
// For multi-step logic (joins, aggregation, multiple queries), write a
// scripts/_<name>.js script instead.

const { getSupabaseClient } = require('../shared/supabaseClient');

(async () => {
  const expr = process.argv.slice(2).join(' ').trim();
  if (!expr) {
    console.error('Usage: node scripts/sb.js "<expression using sb>"');
    console.error('Example: node scripts/sb.js "sb.from(\'cs_tickets\').select(\'*\').limit(3)"');
    process.exit(1);
  }

  const sb = getSupabaseClient();

  let result;
  try {
    const fn = new Function('sb', `return (${expr});`);
    result = await fn(sb);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }

  if (result && typeof result === 'object' && 'data' in result && 'error' in result) {
    if (result.error) {
      console.error('Supabase error:', result.error);
      process.exit(1);
    }
    console.log(JSON.stringify(result.data, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
})();
