/**
 * MCP tool for updating a Shopify customer profile (email and name only).
 *
 * Invoked by the operator agent (lib/operatorAgent.js) when the advisor sets
 * action_type: "customer_profile_update". The action panel prefills a command
 * like "update customer profile: email to X" — the operator agent reads that,
 * calls this tool, and the past-tense draft response gets sent right after.
 * Also exposed via the MCP server for direct calls.
 */

const { updateCustomer, searchCustomers } = require('../shopify');
const { searchCustomersFromSupabase } = require('../supabaseQueries');

async function resolveCustomerId({ customer_id, customer_email }) {
  if (customer_id) return customer_id;
  if (!customer_email) {
    throw new Error('Provide customer_id or customer_email');
  }
  let matches = await searchCustomersFromSupabase(customer_email);
  if (!matches.length) matches = await searchCustomers(`email:${customer_email}`);
  const exact = matches.find(c => (c.email || '').toLowerCase() === customer_email.toLowerCase());
  if (!exact) throw new Error(`No customer found for email ${customer_email}`);
  return exact.id;
}

const tools = [
  {
    name: 'update_customer',
    description: 'Update a Shopify customer profile. Supports email and name (first_name, last_name) only — these are the routine CS changes. For email changes the customer must verify the new address per Shopify\'s account flow. Provide either customer_id (preferred, GID or numeric) or customer_email to look up the customer. At least one of email, first_name, last_name must be provided.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Shopify customer ID (GID or numeric). Preferred.' },
        customer_email: { type: 'string', description: 'Existing customer email — used to look up the customer if customer_id is not provided.' },
        email: { type: 'string', description: 'New email address to set on the customer profile.' },
        first_name: { type: 'string', description: 'New first name.' },
        last_name: { type: 'string', description: 'New last name.' },
      },
    },
    handler: async ({ customer_id, customer_email, email, first_name, last_name }) => {
      if (!email && !first_name && !last_name) {
        return { content: [{ type: 'text', text: 'No fields to update — provide at least one of email, first_name, last_name.' }], isError: true };
      }
      let id;
      try {
        id = await resolveCustomerId({ customer_id, customer_email });
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }

      const input = {};
      if (email) input.email = email;
      if (first_name) input.firstName = first_name;
      if (last_name) input.lastName = last_name;

      try {
        const updated = await updateCustomer(id, input);
        const changes = Object.entries(input).map(([k, v]) => `${k}: ${v}`).join(', ');
        return {
          content: [{
            type: 'text',
            text: `Updated customer ${updated.id}: ${changes}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to update customer: ${err.message}` }], isError: true };
      }
    },
  },
];

module.exports = tools;
