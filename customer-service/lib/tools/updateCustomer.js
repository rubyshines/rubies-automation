/**
 * MCP tool for updating a Shopify customer profile (email and name).
 *
 * Invoked by the operator agent (lib/operatorAgent.js) when the advisor sets
 * action_type: "customer_profile_update". The action panel prefills a command
 * like "update customer profile: email to X" — the operator agent reads that,
 * calls this tool, and the past-tense draft response gets sent right after.
 * Also exposed via the MCP server for direct calls.
 *
 * Two-phase like the other write tools: phase 1 previews what will happen in
 * every system (Shopify, Klaviyo, Gorgias, the Supabase mirror), phase 2
 * (confirmed: true) executes. Email changes are handled end-to-end by
 * lib/emailChange.js — including the case where the new address already
 * belongs to another Shopify customer, which becomes a profile merge rather
 * than an error.
 */

const {
  planEmailChange,
  executeEmailChange,
  resolveCustomerId,
  pendingChanges,
  stageKey,
} = require('../emailChange');
const { updateCustomer } = require('../shopify');

const tools = [
  {
    name: 'update_customer',
    description: [
      'Update a Shopify customer profile: email and/or name (first_name, last_name).',
      'Email changes are handled END-TO-END: Shopify, the Klaviyo profile (email updated or profiles merged, consent never changed), Gorgias reply routing when the customer wrote from the old address, and the Supabase mirror.',
      'If the new email already belongs to another Shopify customer this is NOT an error — the tool previews a profile merge (order history combines, the new-email profile\'s name survives by default; pass keep_name: "original" to keep the current customer\'s name). If Shopify refuses the merge (gift cards, store credit, subscriptions) the preview says why and nothing is written; do not try to work around it.',
      'Provide either customer_id (preferred, GID or numeric) or customer_email to look up the customer. At least one of email, first_name, last_name must be provided.',
      'Two-phase: phase 1 (confirmed omitted/false) previews; phase 2 (confirmed=true) executes. You MUST present phase 1 to the operator and receive explicit confirmation before calling phase 2.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Shopify customer ID (GID or numeric). Preferred.' },
        customer_email: { type: 'string', description: 'Existing customer email — used to look up the customer if customer_id is not provided.' },
        email: { type: 'string', description: 'New email address to set on the customer profile.' },
        first_name: { type: 'string', description: 'New first name.' },
        last_name: { type: 'string', description: 'New last name.' },
        keep_name: { type: 'string', enum: ['new', 'original'], description: 'Merge only: which profile\'s name survives. Default "new" (the profile already holding the new email). Pass "original" when the operator says to keep the current customer\'s name.' },
        confirmed: { type: 'boolean', description: 'Set true in phase 2 to execute the previewed change.' },
      },
    },
    handler: async ({ customer_id, customer_email, email, first_name, last_name, keep_name, confirmed }) => {
      if (!email && !first_name && !last_name) {
        return { content: [{ type: 'text', text: 'No fields to update — provide at least one of email, first_name, last_name.' }], isError: true };
      }

      const key = stageKey({ customer_id, customer_email, new_email: email || '(name-only)' });

      // ---------------------------------------------------------------
      // Phase 2: execute the staged plan
      // ---------------------------------------------------------------
      if (confirmed) {
        const staged = pendingChanges.get(key);
        if (!staged) {
          return { content: [{ type: 'text', text: 'Error: No pending profile update found for these arguments. Run phase 1 first.' }], isError: true };
        }
        pendingChanges.delete(key);

        if (staged.name_only) {
          try {
            const input = {};
            if (staged.first_name) input.firstName = staged.first_name;
            if (staged.last_name) input.lastName = staged.last_name;
            const updated = await updateCustomer(staged.customer_shopify_id, input);
            return { content: [{ type: 'text', text: `Updated customer ${updated.id}: ${Object.entries(input).map(([k, v]) => `${k}: ${v}`).join(', ')}` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Failed to update customer: ${err.message}` }], isError: true };
          }
        }

        const result = await executeEmailChange(staged.plan, { keep_name });
        const lines = [result.summary, ''];
        for (const s of result.steps) lines.push(`${s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`);
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: !result.ok };
      }

      // ---------------------------------------------------------------
      // Phase 1: preview
      // ---------------------------------------------------------------
      try {
        if (!email) {
          // Name-only change: trivial preview, still two-phase so the
          // Execute & Send gate sees a clean "awaiting confirmation".
          const id = await resolveCustomerId({ customer_id, customer_email });
          pendingChanges.set(key, { name_only: true, customer_shopify_id: id, first_name, last_name });
          const name = [first_name, last_name].filter(Boolean).join(' ');
          return {
            content: [{
              type: 'text',
              text: `Will update customer ${customer_email || id}: name to ${name}.\n\nReply "yes confirm" to proceed — awaiting confirmation\nAUTO_CONFIRM: SAFE`,
            }],
          };
        }

        const { plan, preview } = await planEmailChange({
          customer_id, customer_email, new_email: email,
          new_first_name: first_name, new_last_name: last_name,
        });
        if (plan.mode === 'blocked') {
          // Nothing staged — a confirm on a blocked plan must not execute.
          return { content: [{ type: 'text', text: preview }] };
        }
        pendingChanges.set(key, { plan });
        return { content: [{ type: 'text', text: preview }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    },
  },
];

module.exports = tools;
