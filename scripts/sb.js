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
      const status = result.status ? ` [HTTP ${result.status}${result.statusText ? ' ' + result.statusText : ''}]` : '';
      console.error(`Supabase error${status}:`, result.error);
      if (result.status === 400 && (!result.error.message || result.error.message === '')) {
        console.error('  Hint: HTTP 400 with empty error usually means a bad column name (PostgREST swallows the body when head:true). Check schema.');
      }
      process.exit(1);
    }
    if (result.count !== undefined && result.count !== null) {
      console.log(JSON.stringify({ data: result.data, count: result.count }, null, 2));
    } else {
      console.log(JSON.stringify(result.data, null, 2));
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
})();
