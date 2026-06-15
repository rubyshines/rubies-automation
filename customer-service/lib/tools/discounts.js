/**
 * MCP tool for managing RUBIES's automatic discounts: volume discounts and sales.
 *
 * Wraps promotions/discounts.js + the managed_discounts Supabase registry (which
 * replaced the old Google Sheet). Encodes the no-stacking / highest-wins combination
 * rules so they never have to be re-derived. Smile loyalty codes, Klaviyo code pools,
 * and comp codes are machine-generated and are NOT managed here.
 */

const {
  addVolumeDiscount, removeVolumeDiscount,
  startSale, extendSale, endSale,
  listRegistry, auditAutomatic,
} = require('../../../promotions/discounts');

// Each tier is a separate automatic-discount page in Shopify admin.
const STORE_HANDLE = (process.env.SHOPIFY_STORE_URL || '').replace('.myshopify.com', '') || 'rubies-active-wear';
const adminDiscountUrl = (nodeId) => `https://admin.shopify.com/store/${STORE_HANDLE}/discounts/${nodeId}`;

function fmtRegistryRow(r) {
  const tierStr = (r.tiers || []).map((t) => r.kind === 'volume'
    ? `${t.threshold}+@${t.percentage}%`
    : (t.threshold === 0 ? `${t.percentage}%` : `$${t.threshold}+@${t.percentage}%`)).join(', ');
  const window = `${r.starts_at ? r.starts_at.slice(0, 10) : 'now'} → ${r.ends_at ? r.ends_at.slice(0, 10) : 'no end'}`;
  const target = r.kind === 'volume' ? `SKUs ${(r.sku_prefixes || []).join(', ')}` : `collection "${r.collection_handle}"`;
  const gift = r.free_gift_handle ? ` +gift(${r.free_gift_handle})` : '';
  // Admin link per tier node (tiers[i] aligns with shopify_node_ids[i]), labeled by %.
  const links = (r.shopify_node_ids || [])
    .map((id, i) => `[${r.tiers && r.tiers[i] ? `${r.tiers[i].percentage}%` : `#${i + 1}`}](${adminDiscountUrl(id)})`)
    .join(', ');
  const admin = links ? ` | admin: ${links}` : '';
  return `- [${r.kind} · ${r.status}] **${r.name}** — ${tierStr} | ${target} | ${window}${gift}${admin}`;
}

const tools = [
  {
    name: 'manage_discount',
    description: 'Manage RUBIES automatic discounts (volume discounts + sales) — the discounts Jamie hand-runs. Backed by the managed_discounts registry; replaces the old script+spreadsheet. Volume discounts are product-level (by SKU prefix) on quantity tiers; sales are collection-level on subtotal tiers (or a flat %). Both auto-apply highest-wins (never stack) and combine with the Smile loyalty reward + free-gift offer. Actions: "add_volume" (name, sku_prefixes, tiers like "3+@10%,5+@15%"); "start_sale" (name, tiers like "20%" or "$100+@15%,$200+@20%", optional collection_handle [default "discounts"], start_date/end_date YYYY-MM-DD ET inclusive, optional free_gift_handle to attach a free gift); "extend_sale" (name, end_date); "end_sale" (name — deletes the sale discount, clears the theme banner, disables any attached gift); "remove" (name — removes a volume discount; to change tiers, remove then add_volume); "list" (all managed discounts); "audit" (read-only reconcile of live automatic discounts vs the registry — flags orphans, missing nodes, combinesWith drift). NOTE: this does NOT manage Smile/Klaviyo/comp codes, and audit does not scan the 16k code-discount pool (that is a separate cleanup script).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add_volume', 'start_sale', 'extend_sale', 'end_sale', 'remove', 'list', 'audit'],
          description: 'The operation to perform.',
        },
        name: {
          type: 'string',
          description: 'Discount name (the base name; tier nodes get a "<pct>% <name>" title). e.g. "AJ Volume Discount", "Spring Sale". Required for all actions except list/audit.',
        },
        sku_prefixes: {
          type: 'array',
          items: { type: 'string' },
          description: 'add_volume: SKU prefix(es) the volume discount applies to (e.g. ["AJ"]). Matches any variant whose SKU starts with a prefix.',
        },
        tiers: {
          type: 'string',
          description: 'add_volume: quantity tiers "3+@10%,5+@15%". start_sale: a flat "20%" or subtotal tiers "$100+@15%,$200+@20%".',
        },
        collection_handle: {
          type: 'string',
          description: 'start_sale: collection the sale applies to. Defaults to "discounts" (the standard sale collection).',
        },
        start_date: { type: 'string', description: 'start_sale: YYYY-MM-DD (Eastern Time, inclusive). Optional — omit to start now.' },
        end_date: { type: 'string', description: 'start_sale / extend_sale: YYYY-MM-DD (Eastern Time, inclusive last day).' },
        free_gift_handle: { type: 'string', description: 'start_sale: source product handle of a free gift to attach (routes through the free-gift offer, which is not discount-engine based).' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const logs = [];
      const log = (m) => logs.push(m);
      const needName = (a) => { if (!input.name) throw new Error(`${a} requires a name.`); };
      try {
        switch (input.action) {
          case 'add_volume':
            needName('add_volume');
            if (!input.sku_prefixes || input.sku_prefixes.length === 0) throw new Error('add_volume requires sku_prefixes.');
            if (!input.tiers) throw new Error('add_volume requires tiers (e.g. "3+@10%,5+@15%").');
            await addVolumeDiscount({ name: input.name, skuPrefixes: input.sku_prefixes, tiers: input.tiers, startDate: input.start_date, endDate: input.end_date }, log);
            break;
          case 'start_sale':
            needName('start_sale');
            if (!input.tiers) throw new Error('start_sale requires tiers (e.g. "20%" or "$100+@15%,$200+@20%").');
            await startSale({ name: input.name, tiers: input.tiers, collectionHandle: input.collection_handle, startDate: input.start_date, endDate: input.end_date, freeGiftHandle: input.free_gift_handle }, log);
            break;
          case 'extend_sale':
            needName('extend_sale');
            if (!input.end_date) throw new Error('extend_sale requires end_date.');
            await extendSale(input.name, input.end_date, log);
            break;
          case 'end_sale':
            needName('end_sale');
            await endSale(input.name, log);
            break;
          case 'remove':
            needName('remove');
            await removeVolumeDiscount(input.name, log);
            break;
          case 'list': {
            const rows = await listRegistry();
            if (rows.length === 0) return { content: [{ type: 'text', text: 'No managed discounts in the registry yet.' }] };
            const volume = rows.filter((r) => r.kind === 'volume');
            const sales = rows.filter((r) => r.kind === 'sale');
            const out = ['**Managed Discounts**', ''];
            if (volume.length) { out.push('**Volume:**'); volume.forEach((r) => out.push(fmtRegistryRow(r))); out.push(''); }
            if (sales.length) { out.push('**Sales:**'); sales.forEach((r) => out.push(fmtRegistryRow(r))); }
            return { content: [{ type: 'text', text: out.join('\n') }] };
          }
          case 'audit': {
            const { live, registry, flags } = await auditAutomatic();
            const out = [`**Discount Audit** — ${live.length} live automatic discount(s), ${registry.length} registry row(s).`, ''];
            if (flags.length === 0) out.push('✅ No issues — live automatic discounts reconcile with the registry.');
            else { out.push(`⚠️ ${flags.length} flag(s):`); flags.forEach((f) => out.push(`- ${f}`)); }
            out.push('', '_Note: this reconciles automatic discounts only. The ~16k Smile/Klaviyo/comp codes are a separate cleanup pass (scripts/_auditDiscounts.js)._');
            return { content: [{ type: 'text', text: out.join('\n') }] };
          }
          default:
            return { content: [{ type: 'text', text: `Unknown action "${input.action}".` }], isError: true };
        }
        return { content: [{ type: 'text', text: logs.join('\n') || 'Done.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `manage_discount failed: ${err.message}\n${logs.join('\n')}` }], isError: true };
      }
    },
  },
];

module.exports = tools;
