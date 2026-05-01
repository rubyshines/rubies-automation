/**
 * Backfill stranded operator-action history into cs_ai_drafts.actions[].
 *
 * Background: per domain_cs.md, completed operator actions should be appended
 * to cs_ai_drafts.actions[] (the canonical timeline log). Three classes of
 * drafts ended up with completion data stranded in `action_result` instead:
 *   (a) Pre-Apr 29 drafts — the migration logic didn't exist yet.
 *   (b) Drafts whose tool wasn't in the original completingTool detection
 *       (split_shipment, create_invoice_order, create_discount_code, etc.).
 *   (c) Drafts handled by the legacy execute endpoints (apiExecuteExchange/
 *       Refund/Edit), which set action_result.phase='completed' but never
 *       wrote to actions[].
 *
 * This script synthesises an actions[] entry from the available data and
 * filters drafts where the action_result clearly represents a completion
 * (write-tool result OR phase='completed'). Drafts whose action_result is just
 * a phase-1 preview or a stalled chat are left alone.
 *
 * Usage:
 *   node scripts/backfill-stranded-actions.js          # dry-run, prints what it would do
 *   node scripts/backfill-stranded-actions.js --send   # execute the writes
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

const SEND = process.argv.includes('--send');

const WRITE_TOOLS = new Set([
  'create_exchange_order', 'create_invoice_order', 'create_order',
  'create_order_complete', 'create_wholesale_order', 'refund_order',
  'edit_order', 'cancel_order', 'warehouse_hold', 'release_warehouse_hold',
  'release_address_hold', 'add_order_note', 'create_discount_code',
  'update_customer', 'split_shipment', 'send_draft_order_invoice',
  'delete_draft_order', 'set_product_prices',
]);

function findCompletingTool(toolResults) {
  if (!Array.isArray(toolResults)) return null;
  return toolResults.find(tr => {
    if (!WRITE_TOOLS.has(tr.tool)) return false;
    if (typeof tr.result === 'string' && /awaiting confirmation/i.test(tr.result)) return false;
    return true;
  });
}

function extractLinks(toolResults) {
  const links = [];
  for (const tr of (toolResults || [])) {
    const text = typeof tr.result === 'string' ? tr.result : '';
    const orderMatches = text.matchAll(/https:\/\/admin\.shopify\.com\/store\/[^\s)]+orders\/(\d+)/g);
    for (const m of orderMatches) {
      if (m[0].includes('draft_orders/')) continue;
      const orderNum = text.match(/#(\d{4,6})/);
      links.push({ type: 'order', label: `Order ${orderNum ? orderNum[0] : ''}`, url: m[0] });
    }
    const draftMatches = text.matchAll(/https:\/\/admin\.shopify\.com\/store\/[^\s)]+draft_orders\/(\d+)/g);
    for (const m of draftMatches) {
      const draftNum = text.match(/#D(\d+)/);
      links.push({ type: 'draft', label: `Draft ${draftNum ? draftNum[0] : ''}`, url: m[0] });
    }
    const discountMatches = text.matchAll(/https:\/\/admin\.shopify\.com\/store\/[^\s)]+\/discounts\/(\d+)/g);
    for (const m of discountMatches) {
      const codeMatch = text.match(/`([A-F0-9]{10})`/i);
      links.push({ type: 'discount', label: codeMatch ? `Code ${codeMatch[1]}` : 'Discount code', url: m[0] });
    }
  }
  // dedupe by URL
  const seen = new Set();
  return links.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
}

function buildEntryFromChatPath(draft) {
  const ar = draft.action_result || {};
  const completing = findCompletingTool(ar.chat_tool_results);
  if (!completing) return null;
  return {
    executed_at: draft.action_executed_at || draft.created_at,
    action_type: draft.action_type || null,
    summary: ar.chat_response || (typeof completing.result === 'string' ? completing.result : ''),
    links: ar.chat_links?.length ? ar.chat_links : extractLinks(ar.chat_tool_results),
  };
}

function buildEntryFromLegacyPath(draft) {
  const ar = draft.action_result || {};
  if (ar.phase !== 'completed' || !ar.phase2) return null;
  const text = ar.phase2?.content?.[0]?.text || '';
  if (!text) return null;
  return {
    executed_at: draft.action_executed_at || draft.created_at,
    action_type: draft.action_type || null,
    summary: text,
    links: extractLinks([{ tool: '', result: text }]),
  };
}

(async () => {
  const sb = getSupabaseClient();
  const { data: drafts, error } = await sb
    .from('cs_ai_drafts')
    .select('id, gorgias_ticket_id, action_type, action_executed_at, actions, action_result, created_at')
    .not('action_result', 'is', null)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const candidates = drafts.filter(d => {
    const actionsLen = Array.isArray(d.actions) ? d.actions.length : 0;
    if (actionsLen > 0) return false; // already filed
    return !!d.action_result;
  });

  const updates = [];
  const skipped = [];
  for (const d of candidates) {
    const entry = buildEntryFromLegacyPath(d) || buildEntryFromChatPath(d);
    if (!entry) {
      skipped.push({ id: d.id, reason: 'no completing write tool result found' });
      continue;
    }
    updates.push({ draft: d, entry });
  }

  console.log(`Stranded candidates: ${candidates.length}`);
  console.log(`Will backfill: ${updates.length}`);
  console.log(`Skipped (incomplete): ${skipped.length}`);
  console.log();
  for (const u of updates) {
    console.log(`  draft ${u.draft.id} | ${u.draft.created_at.slice(0,10)} | ${u.entry.action_type || '(no type)'} | ${u.entry.summary.slice(0,80).replace(/\s+/g,' ')}`);
    console.log(`    links: ${u.entry.links.map(l => l.label).join(', ') || '(none)'}`);
  }
  if (skipped.length) {
    console.log('\nSkipped:');
    for (const s of skipped) console.log(`  draft ${s.id} — ${s.reason}`);
  }

  if (!SEND) {
    console.log('\n(dry-run — pass --send to write)');
    return;
  }

  console.log('\nWriting backfill...');
  let ok = 0, fail = 0;
  for (const u of updates) {
    const { error: updErr } = await sb
      .from('cs_ai_drafts')
      .update({
        actions: [u.entry],
        action_result: null,
        action_executed_at: u.draft.action_executed_at || u.entry.executed_at,
      })
      .eq('id', u.draft.id);
    if (updErr) { console.error(`  draft ${u.draft.id} FAILED: ${updErr.message}`); fail++; }
    else { console.log(`  draft ${u.draft.id} OK`); ok++; }
  }
  console.log(`\nDone — ${ok} updated, ${fail} failed.`);
})();
