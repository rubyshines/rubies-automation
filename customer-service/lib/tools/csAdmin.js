/**
 * CS Admin MCP Tools — log conversations handled via Claude Code back into the knowledge base
 *
 * Tools: cs_log_conversation
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { embed } = require('../embeddings');

// ---------------------------------------------------------------------------
// Tool: cs_log_conversation
// ---------------------------------------------------------------------------

async function handleLogConversation({ customer_email, category, summary, resolution_type, resolution_successful, messages }) {
  const supabase = getSupabaseClient();

  // Generate a unique ID
  const timestamp = Date.now();
  const convId = `claude_code:${timestamp}`;

  // Generate embedding from the summary
  let embedding = null;
  try {
    embedding = await embed(summary);
  } catch (e) {
    console.error('[csAdmin] Warning: could not generate embedding:', e.message);
  }

  // Insert conversation
  const { error: convErr } = await supabase
    .from('cs_conversations')
    .upsert({
      id: convId,
      source: 'claude_code',
      source_id: String(timestamp),
      customer_email: customer_email || null,
      subject: summary.slice(0, 100),
      status: 'resolved',
      channel: 'claude_code',
      category: category || 'general',
      resolution_successful: resolution_successful != null ? resolution_successful : true,
      resolution_type: resolution_type || 'info_provided',
      summary,
      created_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      message_count: (messages || []).length,
      embedding: embedding ? JSON.stringify(embedding) : null,
    });

  if (convErr) throw new Error(`Failed to log conversation: ${convErr.message}`);

  // Insert messages
  if (messages && messages.length > 0) {
    const msgRows = messages.map((m, i) => ({
      id: `claude_code:${timestamp}:${i}`,
      conversation_id: convId,
      source: 'claude_code',
      sender_type: m.sender_type || 'agent',
      sender_name: m.sender_name || null,
      body_text: m.body_text,
      created_at: new Date(Date.now() + i * 1000).toISOString(), // Order by index
    }));

    const { error: msgErr } = await supabase
      .from('cs_messages')
      .upsert(msgRows);

    if (msgErr) console.error('[csAdmin] Warning: could not save messages:', msgErr.message);
  }

  let md = `## Conversation Logged\n\n`;
  md += `**ID:** \`${convId}\`\n`;
  md += `**Category:** ${category || 'general'}\n`;
  md += `**Resolution:** ${resolution_type || 'info_provided'}\n`;
  md += `**Successful:** ${resolution_successful !== false ? 'Yes' : 'No'}\n`;
  md += `**Messages saved:** ${(messages || []).length}\n\n`;
  md += `This conversation is now searchable via \`cs_search_history\` and will help improve future responses.`;

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: cs_update_conversation
// ---------------------------------------------------------------------------

async function handleUpdateConversation({ conversation_id, category, resolution_type, resolution_successful, tags, notes }) {
  const supabase = getSupabaseClient();

  // Verify conversation exists
  const { data: existing, error: fetchErr } = await supabase
    .from('cs_conversations')
    .select('id, category, resolution_type, resolution_successful, summary')
    .eq('id', conversation_id)
    .limit(1);

  if (fetchErr) throw new Error(`Failed to fetch conversation: ${fetchErr.message}`);
  if (!existing || !existing.length) throw new Error(`Conversation not found: ${conversation_id}`);

  const current = existing[0];
  const updates = {};
  const changes = [];

  if (category && category !== current.category) {
    updates.category = category;
    changes.push(`category: ${current.category} → ${category}`);
  }
  if (resolution_type && resolution_type !== current.resolution_type) {
    updates.resolution_type = resolution_type;
    changes.push(`resolution_type: ${current.resolution_type} → ${resolution_type}`);
  }
  if (resolution_successful != null && resolution_successful !== current.resolution_successful) {
    updates.resolution_successful = resolution_successful;
    changes.push(`resolution_successful: ${current.resolution_successful} → ${resolution_successful}`);
  }
  if (notes) {
    // Append notes to summary
    updates.summary = current.summary + `\n\n[Update ${new Date().toISOString().split('T')[0]}]: ${notes}`;
    changes.push(`notes appended`);

    // Re-embed with updated summary
    try {
      const embedding = await embed(updates.summary);
      updates.embedding = JSON.stringify(embedding);
    } catch (e) {
      console.error('[csAdmin] Warning: could not re-embed:', e.message);
    }
  }
  if (tags) {
    // Store tags in the summary since cs_conversations doesn't have a tags column
    const tagStr = Array.isArray(tags) ? tags.join(', ') : tags;
    updates.summary = (updates.summary || current.summary) + `\n[Tags: ${tagStr}]`;
    changes.push(`tags: ${tagStr}`);
  }

  if (!changes.length) {
    return { content: [{ type: 'text', text: 'No changes to apply.' }] };
  }

  const { error: updateErr } = await supabase
    .from('cs_conversations')
    .update(updates)
    .eq('id', conversation_id);

  if (updateErr) throw new Error(`Failed to update: ${updateErr.message}`);

  let md = `## Conversation Updated\n\n`;
  md += `**ID:** \`${conversation_id}\`\n\n`;
  md += `**Changes:**\n`;
  for (const c of changes) md += `- ${c}\n`;

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'cs_log_conversation',
    description: 'Log a customer service conversation handled via Claude Code back into the knowledge base. Creates a feedback loop — successful conversations become searchable history for future reference.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_email: {
          type: 'string',
          description: 'Customer email address',
        },
        category: {
          type: 'string',
          description: 'Conversation category: sizing_fit, exchange_return, order_status, wholesale, shipping, product_info, payment, general',
        },
        summary: {
          type: 'string',
          description: 'Brief summary of the conversation and resolution',
        },
        resolution_type: {
          type: 'string',
          description: 'How was it resolved: exchange, refund, info_provided, no_action, escalated',
        },
        resolution_successful: {
          type: 'boolean',
          description: 'Was the customer satisfied with the resolution?',
        },
        messages: {
          type: 'array',
          description: 'Array of messages in the conversation',
          items: {
            type: 'object',
            properties: {
              sender_type: {
                type: 'string',
                description: 'Who sent this: customer or agent',
              },
              body_text: {
                type: 'string',
                description: 'Message text content',
              },
              sender_name: {
                type: 'string',
                description: 'Name of the sender (optional)',
              },
            },
          },
        },
      },
      required: ['summary'],
    },
    handler: handleLogConversation,
  },
  {
    name: 'cs_update_conversation',
    description: 'Update metadata on a logged conversation: re-categorize, change resolution, add notes or tags. Use cs_search_history to find the conversation ID first.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation ID (e.g. "claude_code:1710000000000" or "gorgias:12345")',
        },
        category: {
          type: 'string',
          description: 'New category: sizing_fit, exchange_return, order_status, wholesale, shipping, product_info, payment, general',
        },
        resolution_type: {
          type: 'string',
          description: 'New resolution type: exchange, refund, info_provided, no_action, escalated',
        },
        resolution_successful: {
          type: 'boolean',
          description: 'Update whether the resolution was successful',
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tags to add (e.g. "duplicate, follow-up-needed")',
        },
        notes: {
          type: 'string',
          description: 'Additional notes to append to the conversation summary',
        },
      },
      required: ['conversation_id'],
    },
    handler: handleUpdateConversation,
  },
];

module.exports = tools;
