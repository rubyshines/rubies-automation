#!/usr/bin/env node

/**
 * Customer Service Import Pipeline — CLI entry point
 *
 * Usage:
 *   node customer-service/import/runImport.js --source gorgias [--since 2025-03-01] [--limit 100]
 *   node customer-service/import/runImport.js --source tidio --file path/to/export.json
 *   node customer-service/import/runImport.js --categorize [--batch-size 20]
 *   node customer-service/import/runImport.js --embed [--batch-size 50]
 *   node customer-service/import/runImport.js --macros   (import Gorgias macros as knowledge articles)
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const fs = require('fs');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getTickets, getTicketMessages, getMacros, delay } = require('./gorgiasClient');
const { normalizeGorgiasTicket, normalizeTidioConversation } = require('./normalizer');
const { embed, embedBatch } = require('../lib/embeddings');

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || true;
}
const hasFlag = (name) => args.includes(name);

// ---------------------------------------------------------------------------
// Gorgias Import
// ---------------------------------------------------------------------------

async function importGorgias({ since, limit }) {
  const supabase = getSupabaseClient();
  const maxTickets = limit || Infinity;
  let imported = 0;
  let cursor = null;

  // Check for resume cursor
  const { data: progress } = await supabase
    .from('cs_import_progress')
    .select('last_cursor, records_processed')
    .eq('id', 'gorgias:tickets')
    .single();

  if (progress?.last_cursor) {
    cursor = progress.last_cursor;
    imported = progress.records_processed || 0;
    console.log(`[Import] Resuming from cursor, ${imported} already processed`);
  }

  console.log(`[Import] Fetching Gorgias tickets${since ? ` since ${since}` : ''}...`);

  while (imported < maxTickets) {
    const batchLimit = Math.min(30, maxTickets - imported);
    const { data: tickets, nextCursor } = await getTickets({
      cursor,
      limit: batchLimit,
      since,
    });

    if (!tickets.length) {
      console.log('[Import] No more tickets to fetch');
      break;
    }

    for (const ticket of tickets) {
      try {
        // Fetch messages for this ticket
        await delay(500); // Rate limit
        const messages = await getTicketMessages(ticket.id);

        // Normalize
        const { conversation, messages: normalizedMsgs } = normalizeGorgiasTicket(ticket, messages);

        // Upsert conversation
        const { error: convErr } = await supabase
          .from('cs_conversations')
          .upsert(conversation, { onConflict: 'id' });

        if (convErr) {
          console.error(`[Import] Error upserting ticket ${ticket.id}:`, convErr.message);
          continue;
        }

        // Upsert messages
        if (normalizedMsgs.length > 0) {
          const { error: msgErr } = await supabase
            .from('cs_messages')
            .upsert(normalizedMsgs, { onConflict: 'id' });

          if (msgErr) {
            console.error(`[Import] Error upserting messages for ticket ${ticket.id}:`, msgErr.message);
          }
        }

        imported++;
        if (imported % 10 === 0) {
          console.log(`[Import] Processed ${imported} tickets...`);
        }
      } catch (err) {
        console.error(`[Import] Error processing ticket ${ticket.id}:`, err.message);
      }
    }

    // Save progress
    cursor = nextCursor;
    await supabase.from('cs_import_progress').upsert({
      id: 'gorgias:tickets',
      source: 'gorgias',
      status: cursor ? 'processing' : 'complete',
      last_cursor: cursor,
      records_processed: imported,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    if (!cursor) break;

    await delay(500); // Rate limit between pages
  }

  // Mark complete
  await supabase.from('cs_import_progress').upsert({
    id: 'gorgias:tickets',
    source: 'gorgias',
    status: 'complete',
    last_cursor: cursor,
    records_processed: imported,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });

  console.log(`\n[Import] Done! Imported ${imported} Gorgias tickets.`);
}

// ---------------------------------------------------------------------------
// Tidio Import
// ---------------------------------------------------------------------------

async function importTidio({ filePath }) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}. Usage: --source tidio --file path/to/export.json`);
  }

  const supabase = getSupabaseClient();
  const raw = fs.readFileSync(filePath, 'utf8');

  let conversations;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      conversations = parsed;
    } else {
      conversations = parsed.conversations || parsed.examples || parsed.data || [parsed];
    }
  } catch {
    // Try line-delimited JSON (JSONL)
    conversations = raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  console.log(`[Import] Processing ${conversations.length} Tidio conversations from ${filePath}`);

  // Pre-create stub customer records so FK constraint doesn't block import
  const customerStubs = new Map();
  for (const c of conversations) {
    const email = (c.customer_email || c.visitor_email || c.email || '').toLowerCase().trim();
    if (email && email.includes('@') && !customerStubs.has(email)) {
      const name = c.customer_name || c.visitor_name || c.name || '';
      const parts = name.includes(' ') ? name.split(' ') : [name, ''];
      customerStubs.set(email, {
        email,
        first_name: parts[0] || null,
        last_name: parts.slice(1).join(' ') || null,
        synced_at: new Date().toISOString(),
      });
    }
  }
  console.log(`[Import] Ensuring ${customerStubs.size} customer records exist...`);
  const stubs = [...customerStubs.values()];
  const CHUNK = 500;
  for (let i = 0; i < stubs.length; i += CHUNK) {
    const batch = stubs.slice(i, i + CHUNK);
    const { error: custErr } = await supabase
      .from('customers')
      .upsert(batch, { onConflict: 'email', ignoreDuplicates: true });
    if (custErr) console.error(`[Import] Warning: customer stub batch error:`, custErr.message);
  }
  console.log(`[Import] Customer records ready.`);

  let imported = 0;
  let errors = 0;

  for (let i = 0; i < conversations.length; i++) {
    try {
      const { conversation, messages } = normalizeTidioConversation(conversations[i], i);

      const { error: convErr } = await supabase
        .from('cs_conversations')
        .upsert(conversation, { onConflict: 'id' });

      if (convErr) {
        console.error(`[Import] Error upserting tidio conversation ${i}:`, convErr.message);
        errors++;
        continue;
      }

      if (messages.length > 0) {
        const { error: msgErr } = await supabase
          .from('cs_messages')
          .upsert(messages, { onConflict: 'id' });

        if (msgErr) {
          console.error(`[Import] Error upserting messages for tidio ${i}:`, msgErr.message);
        }
      }

      imported++;
      if (imported % 100 === 0) console.log(`[Import] Processed ${imported}/${conversations.length}...`);
    } catch (err) {
      console.error(`[Import] Error processing tidio conversation ${i}:`, err.message);
      errors++;
    }
  }

  console.log(`\n[Import] Done! Imported ${imported}/${conversations.length} Tidio conversations (${errors} errors).`);
}

// ---------------------------------------------------------------------------
// Import Gorgias Macros as Knowledge Base Articles
// ---------------------------------------------------------------------------

async function importMacros() {
  const supabase = getSupabaseClient();
  console.log('[Import] Fetching Gorgias macros...');

  const macros = await getMacros();
  console.log(`[Import] Found ${macros.length} macros`);

  let imported = 0;
  for (const macro of macros) {
    const { stripHtml } = require('./gorgiasClient');
    const title = macro.name || `Macro ${macro.id}`;
    const bodyHtml = macro.actions?.find(a => a.type === 'set_response_body')?.args?.body || '';
    const bodyText = stripHtml(bodyHtml) || title;

    if (bodyText.length < 10) continue; // Skip empty macros

    let embedding = null;
    try {
      embedding = await embed(`${title}\n\n${bodyText.slice(0, 2000)}`);
    } catch (e) {
      console.error(`[Import] Warning: embedding failed for macro ${macro.id}:`, e.message);
    }

    const { error } = await supabase
      .from('cs_knowledge_base')
      .upsert({
        id: `gorgias-macro:${macro.id}`,
        title: `[Macro] ${title}`,
        category: 'faq',
        content: bodyText,
        source: 'gorgias_macro',
        tags: macro.tags?.map(t => t.name || t) || [],
        embedding: embedding ? JSON.stringify(embedding) : null,
        priority: 8, // High priority — these are curated responses
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) {
      console.error(`[Import] Error upserting macro ${macro.id}:`, error.message);
    } else {
      imported++;
    }
  }

  console.log(`\n[Import] Done! Imported ${imported} Gorgias macros as knowledge articles.`);
}

// ---------------------------------------------------------------------------
// Embed uncategorized/unembedded conversations
// ---------------------------------------------------------------------------

async function embedConversations({ batchSize = 50 } = {}) {
  const supabase = getSupabaseClient();

  // Find conversations without embeddings that have summaries
  const { data: convos, error } = await supabase
    .from('cs_conversations')
    .select('id, summary, subject, category')
    .is('embedding', null)
    .not('summary', 'is', null)
    .limit(batchSize);

  if (error) throw new Error(`Query failed: ${error.message}`);
  if (!convos || !convos.length) {
    console.log('[Embed] No conversations need embedding (all done or no summaries yet — run --categorize first)');
    return;
  }

  console.log(`[Embed] Generating embeddings for ${convos.length} conversations...`);

  const texts = convos.map(c =>
    `${c.category || ''} ${c.subject || ''} ${c.summary || ''}`.trim()
  );

  const vectors = await embedBatch(texts);

  let updated = 0;
  for (let i = 0; i < convos.length; i++) {
    const { error: updateErr } = await supabase
      .from('cs_conversations')
      .update({ embedding: JSON.stringify(vectors[i]) })
      .eq('id', convos[i].id);

    if (updateErr) {
      console.error(`[Embed] Error updating ${convos[i].id}:`, updateErr.message);
    } else {
      updated++;
    }
  }

  console.log(`\n[Embed] Done! Embedded ${updated}/${convos.length} conversations.`);

  // Check if more remain
  const { count } = await supabase
    .from('cs_conversations')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null)
    .not('summary', 'is', null);

  if (count > 0) {
    console.log(`[Embed] ${count} more conversations need embedding. Run again to continue.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const source = getArg('--source');

  if (source === 'gorgias') {
    await importGorgias({
      since: getArg('--since'),
      limit: getArg('--limit') ? parseInt(getArg('--limit'), 10) : null,
    });
  } else if (source === 'tidio') {
    await importTidio({
      filePath: getArg('--file'),
    });
  } else if (hasFlag('--categorize')) {
    // Delegate to categorizer
    const { categorizeConversations } = require('./categorizer');
    const batchSize = getArg('--batch-size') ? parseInt(getArg('--batch-size'), 10) : 20;
    await categorizeConversations({ batchSize });
  } else if (hasFlag('--embed')) {
    const batchSize = getArg('--batch-size') ? parseInt(getArg('--batch-size'), 10) : 50;
    await embedConversations({ batchSize });
  } else if (hasFlag('--macros')) {
    await importMacros();
  } else {
    console.log(`
RUBIES CS Import Pipeline

Usage:
  node customer-service/import/runImport.js --source gorgias [--since 2025-03-01] [--limit 100]
  node customer-service/import/runImport.js --source tidio --file path/to/export.json
  node customer-service/import/runImport.js --categorize [--batch-size 20]
  node customer-service/import/runImport.js --embed [--batch-size 50]
  node customer-service/import/runImport.js --macros

Steps (in order):
  1. Import conversations: --source gorgias or --source tidio
  2. Categorize with AI:   --categorize
  3. Generate embeddings:  --embed
  4. Import macros:        --macros (optional, imports Gorgias templates)
    `);
  }
}

module.exports = { importGorgias, importTidio, embedConversations };

if (require.main === module) {
  main().catch(err => {
    console.error('[Import] Fatal error:', err);
    process.exit(1);
  });
}
