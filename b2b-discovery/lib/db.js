const { randomUUID } = require('crypto');
const { getSupabaseClient, upsert } = require('../../shared/supabaseClient');

const PROSPECTS_TABLE = 'retailer_prospects';
const PROGRESS_TABLE = 'discovery_progress';

function generateId() {
  return randomUUID();
}

async function saveProspect(prospect) {
  await upsert(PROSPECTS_TABLE, [prospect], ['id']);
}

async function getProspectByDomain(domain) {
  if (!domain) return null;
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(PROSPECTS_TABLE)
    .select('*')
    .eq('website_domain', domain)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getProspectByPlaceId(placeId) {
  if (!placeId) return null;
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(PROSPECTS_TABLE)
    .select('*')
    .eq('google_place_id', placeId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function mergeProspect(existingId, newData) {
  const client = getSupabaseClient();

  // Merge sources array: fetch existing first to union arrays
  const { data: existing, error: fetchError } = await client
    .from(PROSPECTS_TABLE)
    .select('sources')
    .eq('id', existingId)
    .maybeSingle();
  if (fetchError) throw fetchError;

  const existingSources = existing?.sources || [];
  const newSources = newData.sources || [];
  const mergedSources = [...new Set([...existingSources, ...newSources])];

  const { error } = await client
    .from(PROSPECTS_TABLE)
    .update({ ...newData, sources: mergedSources })
    .eq('id', existingId);
  if (error) throw error;
}

async function markProgressComplete(id, resultCount) {
  const client = getSupabaseClient();
  await client.from(PROGRESS_TABLE).upsert(
    [{ id, completed: true, result_count: resultCount, completed_at: new Date().toISOString() }],
    { onConflict: 'id' }
  );
}

async function isProgressComplete(id) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(PROGRESS_TABLE)
    .select('completed')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data?.completed === true;
}

module.exports = {
  generateId,
  saveProspect,
  getProspectByDomain,
  getProspectByPlaceId,
  mergeProspect,
  markProgressComplete,
  isProgressComplete,
};
