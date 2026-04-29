require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

let supabaseClient = null;

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  }

  supabaseClient = createClient(url, key);
  return supabaseClient;
}

async function upsert(table, rows, conflictColumns) {
  if (!rows || !rows.length) return 0;

  const client = getSupabaseClient();
  const { error } = await client.from(table).upsert(rows, {
    onConflict: conflictColumns ? conflictColumns.join(',') : undefined,
  });

  if (error) {
    throw error;
  }

  return rows.length;
}

module.exports = {
  getSupabaseClient,
  upsert,
};

