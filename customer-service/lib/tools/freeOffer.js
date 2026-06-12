/**
 * MCP tool for managing "free gift with purchase" offers.
 *
 * Wraps promotions/freeOffer.js. The offer deliberately avoids the discount
 * engine (BXGY free gifts conflict with non-combinable discount codes):
 * each gift is a hidden $0 "twin" product (compare-at = real price, same SKU
 * so the warehouse ships the real item). The rubies-ecom-v4 theme reads the
 * free_gift_offer_* shop metafields and shows the offer in the cart drawer —
 * one gift in the collection auto-adds to qualifying carts; several gifts
 * show a picker.
 *
 * Delete is permanent and therefore two-phase (confirmed=true to execute).
 */

const {
  createTwin,
  removeTwin,
  enableOffer,
  disableOffer,
  deleteTwin,
  getStatus,
  GIFT_COLLECTION_HANDLE,
} = require('../../../promotions/freeOffer');

function formatStatus({ metafields: mfs, collection }) {
  const lines = ['**Free Gift Offer Status**', ''];
  if (Object.keys(mfs).length === 0) {
    lines.push('Offer metafields: not set (offer disabled)');
  } else {
    lines.push(`**Minimum:** $${mfs.free_gift_offer_minimum ?? '(unset)'}`);
    lines.push(`**Window:** ${mfs.free_gift_offer_start ?? '?'} → ${mfs.free_gift_offer_end ?? '?'} (inclusive, store TZ)`);
  }
  if (!collection) {
    lines.push('Gift collection: does not exist yet');
  } else {
    lines.push(`**Gifts** (${GIFT_COLLECTION_HANDLE}): ${collection.products.nodes.length}`);
    for (const p of collection.products.nodes) {
      const v = p.variants.nodes[0] || {};
      lines.push(`- ${p.title} [${p.status}] $${v.price} (compare at $${v.compareAtPrice ?? '—'}) SKU=${v.sku || '(none)'}`);
    }
  }
  return lines.join('\n');
}

const tools = [
  {
    name: 'manage_free_offer',
    description: 'Manage the free-gift-with-purchase offer (hidden $0 twin products auto-added by the storefront cart, NOT discount-engine based, so it never conflicts with discount codes). Actions: "create" makes a $0 twin of a product and adds it to the gift pool (source_handle required; product must be single-variant); "remove" takes a twin out of the pool but keeps it as draft for reuse; "enable" turns the offer on (minimum in USD, 0 = every order; start_date/end_date YYYY-MM-DD inclusive, store timezone — the theme switches itself on/off on those dates); "disable" turns the offer off (twins go draft, config cleared); "delete" permanently deletes one twin (source_handle) or everything (all=true) — destructive, requires confirmed=true; "status" shows current config and gift pool. One gift in the pool = auto-added to qualifying carts; multiple = customer picks in the cart drawer.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'remove', 'enable', 'disable', 'delete', 'status'],
          description: 'The lifecycle action to perform.',
        },
        source_handle: {
          type: 'string',
          description: 'Handle of the REAL product (e.g. "progress-pride-earings"). Required for create/remove and delete of a single twin. The twin handle is derived as <source_handle>-free-gift.',
        },
        minimum: {
          type: 'number',
          description: 'Minimum cart subtotal in USD to qualify (enable only). 0 = every order. Below the minimum the cart shows a "you are $X away" teaser.',
        },
        start_date: {
          type: 'string',
          description: 'Offer start date YYYY-MM-DD, inclusive, store timezone (enable only).',
        },
        end_date: {
          type: 'string',
          description: 'Offer end date YYYY-MM-DD, inclusive, store timezone (enable only).',
        },
        all: {
          type: 'boolean',
          description: 'For delete: tear down everything (all twins + gift collection + config metafields).',
        },
        confirmed: {
          type: 'boolean',
          description: 'Required true to execute a delete (two-phase confirmation; delete is permanent).',
        },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const logs = [];
      const log = (msg) => logs.push(msg);
      try {
        switch (input.action) {
          case 'create':
            if (!input.source_handle) {
              return { content: [{ type: 'text', text: 'source_handle is required for create.' }], isError: true };
            }
            await createTwin(input.source_handle, log);
            break;
          case 'remove':
            if (!input.source_handle) {
              return { content: [{ type: 'text', text: 'source_handle is required for remove.' }], isError: true };
            }
            await removeTwin(input.source_handle, log);
            break;
          case 'enable':
            await enableOffer(
              {
                minimum: input.minimum != null ? String(input.minimum) : '0',
                start: input.start_date,
                end: input.end_date,
              },
              log
            );
            break;
          case 'disable':
            await disableOffer(log);
            break;
          case 'delete': {
            if (!input.all && !input.source_handle) {
              return { content: [{ type: 'text', text: 'delete requires source_handle or all=true.' }], isError: true };
            }
            if (!input.confirmed) {
              const target = input.all
                ? 'ALL gift twins, the gift collection, and the offer config metafields'
                : `the gift twin for "${input.source_handle}"`;
              return {
                content: [{
                  type: 'text',
                  text: `**Delete Preview — Awaiting Confirmation**\n\nThis will permanently delete ${target}. Past orders keep their line-item snapshots, but product links in reports break and a future campaign needs a fresh create.\n\n_To confirm, call manage_free_offer again with the same arguments plus confirmed=true._`,
                }],
              };
            }
            await deleteTwin({ source: input.source_handle, all: input.all }, log);
            break;
          }
          case 'status': {
            const text = formatStatus(await getStatus());
            return { content: [{ type: 'text', text }] };
          }
          default:
            return { content: [{ type: 'text', text: `Unknown action "${input.action}".` }], isError: true };
        }
        return { content: [{ type: 'text', text: logs.join('\n') || 'Done.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `manage_free_offer failed: ${err.message}\n${logs.join('\n')}` }], isError: true };
      }
    },
  },
];

module.exports = tools;
