/**
 * Admin MCP Tools — cache management, audit logging, system health
 *
 * Tools: refresh_costs, audit_log
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { refreshCosts } = require('../costsCache');

// ---------------------------------------------------------------------------
// Tool: refresh_costs
// ---------------------------------------------------------------------------

async function handleRefreshCosts() {
  const count = await refreshCosts();
  return {
    content: [{
      type: 'text',
      text: `## COGS Cache Refreshed\n\nReloaded **${count}** cost entries from Supabase. New prices will be reflected in margin calculations immediately.`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Tool: audit_log
// ---------------------------------------------------------------------------

async function handleAuditLog({ action_type, days_back, limit }) {
  const supabase = getSupabaseClient();
  const daysBack = days_back || 7;
  const maxResults = Math.min(limit || 50, 200);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  let query = supabase
    .from('audit_log')
    .select('*')
    .gte('created_at', cutoff.toISOString())
    .order('created_at', { ascending: false })
    .limit(maxResults);

  if (action_type) query = query.eq('action_type', action_type);

  const { data, error } = await query;

  if (error) {
    // Table may not exist yet — that's OK
    if (error.message.includes('does not exist') || error.code === '42P01') {
      return {
        content: [{
          type: 'text',
          text: 'Audit log table does not exist yet. Run the schema SQL in `customer-service/audit-schema.sql` to create it.',
        }],
      };
    }
    throw new Error(`Supabase error: ${error.message}`);
  }

  if (!data || !data.length) {
    return { content: [{ type: 'text', text: `No audit log entries in the last ${daysBack} days.` }] };
  }

  let md = `## Audit Log (last ${daysBack} days)\n\n`;
  md += '| Time | Action | Actor | Details |\n';
  md += '|------|--------|-------|--------|\n';

  for (const entry of data) {
    const time = entry.created_at ? entry.created_at.split('.')[0].replace('T', ' ') : '—';
    const action = entry.action_type || '—';
    const actor = entry.actor || '—';
    const details = entry.details ? JSON.stringify(entry.details).slice(0, 100) : '—';
    md += `| ${time} | ${action} | ${actor} | ${details} |\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Helper: write audit entry (used by other tools)
// ---------------------------------------------------------------------------

async function writeAuditEntry({ action_type, actor, details, entity_type, entity_id }) {
  try {
    const supabase = getSupabaseClient();
    await supabase.from('audit_log').insert({
      action_type,
      actor: actor || 'claude_code',
      details: details || {},
      entity_type: entity_type || null,
      entity_id: entity_id || null,
    });
  } catch (e) {
    // Audit logging should never break the main flow
    console.error('[Audit] Warning: could not write audit entry:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'refresh_costs',
    description: 'Reload COGS (cost of goods sold) data from Supabase into the in-memory cache. Use this after updating product costs in the Google Sheet and running the costs sync.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleRefreshCosts,
  },
  {
    name: 'audit_log',
    description: 'View the audit log of actions taken through the MCP server (order creation, exchanges, deletions, etc). Filter by action type and time period.',
    inputSchema: {
      type: 'object',
      properties: {
        action_type: {
          type: 'string',
          description: 'Filter by action type (e.g. "draft_order_created", "exchange_created", "draft_order_deleted")',
        },
        days_back: {
          type: 'number',
          description: 'How many days back to look (default: 7)',
        },
        limit: {
          type: 'number',
          description: 'Max entries to return (default: 50, max: 200)',
        },
      },
      required: [],
    },
    handler: handleAuditLog,
  },
];

module.exports = tools;
module.exports.writeAuditEntry = writeAuditEntry;
