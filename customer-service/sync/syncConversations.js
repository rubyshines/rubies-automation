#!/usr/bin/env node

/**
 * RUBIES Conversation Sync — Daily Gorgias + Embedding Pipeline
 *
 * Imports recent Gorgias tickets (last 2 days) and embeds any
 * un-embedded conversations. Designed for daily use from the
 * unified runner or standalone.
 *
 * Gracefully skips if Gorgias env vars are not configured.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

// ---------------------------------------------------------------------------
// Exported run() for unified runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('RUBIES Conversation Sync — starting');

  let conversationsImported = 0;
  let conversationsEmbedded = 0;
  let hadError = false;
  let lastError = null;

  // --- Step 1: Import recent Gorgias tickets ---
  const hasGorgias = process.env.GORGIAS_DOMAIN && process.env.GORGIAS_API_KEY && process.env.GORGIAS_EMAIL;

  if (!hasGorgias) {
    const missing = ['GORGIAS_DOMAIN', 'GORGIAS_API_KEY', 'GORGIAS_EMAIL'].filter(k => !process.env[k]);
    console.warn(`  ⚠ ${missing.join(', ')} not set — skipping Gorgias import`);
    hadError = true;
    lastError = `${missing.join(', ')} not set`;
  } else {
    try {
      // Derive since from latest conversation (high-water mark)
      const { getSupabaseClient: getSupa } = require('../../shared/supabaseClient');
      const sbTemp = getSupa();
      const { data: latestConvo } = await sbTemp
        .from('cs_conversations')
        .select('created_at')
        .eq('source', 'gorgias')
        .order('created_at', { ascending: false })
        .limit(1);

      let since;
      if (latestConvo?.[0]?.created_at) {
        // Subtract 6 hours buffer for safety
        const lastDate = new Date(latestConvo[0].created_at);
        lastDate.setHours(lastDate.getHours() - 6);
        since = lastDate.toISOString().split('T')[0];
      } else {
        // No conversations yet — fetch last 30 days
        const d = new Date();
        d.setDate(d.getDate() - 30);
        since = d.toISOString().split('T')[0];
      }
      console.log(`  Fetching Gorgias tickets since ${since}`);

      // Import from Gorgias
      const { importGorgias } = require('../import/runImport');
      await importGorgias({ since, limit: null });

      // Count what was imported (approximation from import progress)
      const { getSupabaseClient } = require('../../shared/supabaseClient');
      const supabase = getSupabaseClient();
      const { data: progress } = await supabase
        .from('cs_import_progress')
        .select('records_processed')
        .eq('id', 'gorgias:tickets')
        .single();

      conversationsImported = progress?.records_processed || 0;
      console.log(`  Gorgias import complete: ${conversationsImported} total records`);
    } catch (err) {
      console.error('  Gorgias import error:', err.message);
      hadError = true;
      lastError = err.message;
    }
  }

  // --- Step 2: Embed un-embedded conversations ---
  const hasVoyage = !!process.env.VOYAGE_API_KEY;

  if (!hasVoyage) {
    console.warn('  ⚠ VOYAGE_API_KEY not set — skipping embedding');
    hadError = true;
    lastError = lastError || 'VOYAGE_API_KEY not set';
  } else {
    try {
      const { getSupabaseClient } = require('../../shared/supabaseClient');
      const { embedBatch } = require('../lib/embeddings');
      const supabase = getSupabaseClient();

      // Find conversations without embeddings that have summaries
      const { data: convos, error } = await supabase
        .from('cs_conversations')
        .select('id, summary, subject, category')
        .is('embedding', null)
        .not('summary', 'is', null)
        .limit(100);

      if (error) throw new Error(`Query failed: ${error.message}`);

      if (!convos || !convos.length) {
        console.log('  No conversations need embedding');
      } else {
        console.log(`  Embedding ${convos.length} conversations...`);

        const texts = convos.map(c =>
          `${c.category || ''} ${c.subject || ''} ${c.summary || ''}`.trim()
        );

        const vectors = await embedBatch(texts);

        for (let i = 0; i < convos.length; i++) {
          const { error: updateErr } = await supabase
            .from('cs_conversations')
            .update({ embedding: JSON.stringify(vectors[i]) })
            .eq('id', convos[i].id);

          if (updateErr) {
            console.error(`  Embed error for ${convos[i].id}:`, updateErr.message);
          } else {
            conversationsEmbedded++;
          }
        }

        console.log(`  Embedded ${conversationsEmbedded}/${convos.length} conversations`);
      }
    } catch (err) {
      console.error('  Embedding error:', err.message);
      hadError = true;
      lastError = err.message;
    }
  }

  const totalRows = conversationsImported + conversationsEmbedded;
  const success = !hadError || totalRows > 0;

  console.log('RUBIES Conversation Sync — done');

  return {
    sources: {
      conversations: {
        success,
        rowsWritten: totalRows,
        error: hadError ? lastError : null,
      },
    },
    status: success ? 'success' : 'failure',
  };
}

module.exports = { run };

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

if (require.main === module) {
  run().catch((err) => {
    console.error('RUBIES Conversation Sync — FAILED:', err.message);
    process.exit(1);
  });
}
