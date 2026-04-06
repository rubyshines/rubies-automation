/**
 * Shopify inventory_levels/update webhook handler
 *
 * Updates inventory_quantity on the product_variants table.
 * Looks up variant by shopify_inventory_item_id.
 *
 * Webhook payload shape:
 * { inventory_item_id, location_id, available, updated_at }
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { toGid } = require('../lib/normalize');

async function handle(topic, payload) {
  const supabase = getSupabaseClient();
  const inventoryItemGid = toGid('InventoryItem', payload.inventory_item_id);
  const available = payload.available;

  if (available == null) {
    console.warn('[shopify-inventory] Skipping — no available quantity in payload');
    return;
  }

  console.log(`[shopify-inventory] ${topic} item=${payload.inventory_item_id} available=${available}`);

  // Look up variant by inventory item ID
  const { data: variant, error: lookupErr } = await supabase
    .from('product_variants')
    .select('shopify_variant_id, title, sku')
    .eq('shopify_inventory_item_id', inventoryItemGid)
    .maybeSingle();

  if (lookupErr) {
    throw new Error(`Variant lookup failed: ${lookupErr.message}`);
  }

  if (!variant) {
    // Variant not yet synced — will be caught by daily sync
    console.warn(`[shopify-inventory] No variant found for inventory_item_id=${payload.inventory_item_id} — skipping`);
    return;
  }

  const { error: updateErr } = await supabase
    .from('product_variants')
    .update({
      inventory_quantity: available,
      synced_at: new Date().toISOString(),
    })
    .eq('shopify_inventory_item_id', inventoryItemGid);

  if (updateErr) {
    throw new Error(`Inventory update failed: ${updateErr.message}`);
  }

  console.log(`[shopify-inventory] Updated ${variant.sku || variant.title} → ${available} units`);
}

module.exports = { handle };
