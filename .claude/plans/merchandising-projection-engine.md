# Merchandising: Projection Engine + Supplier Registry

**Initiative:** Production Pipeline  
**Phases covered:** Phase 1 (Inventory Projection Engine) + Phase 2 (Supplier Registry)  
**Done when:** `get_at_risk_skus` MCP tool returns a correct short list given a weeks horizon; `run_inventory_projection` stores results to Supabase; `create_production_order` generates a correctly-formatted CSV for a named supplier

---

## Why This Exists

RUBIES places large supplier orders twice a year. Two problems this solves:

1. **Stockout projection:** given current inventory + velocity, which SKUs run out in the next N weeks? Critical for decisions like the June 2026 fabric quality issue — "which swimwear SKUs do I run short on if this Kali order is delayed?"

2. **Production order generation:** once you know what to order, the system should produce the CSV for the supplier rather than manually recreating the Google Sheet format.

The existing `rubies-utilities/scripts/core/inventory-planning.js` does a version of (1) but has two problems:
- The OOS adjustment is calculated but never applied — the velocity always uses `units_sold / 52` (a comment in the code says "adjust this once the algorithm is working")
- It reads order history from local JSON files at a hardcoded Mac path — can't run on Railway, can't be called as an MCP tool

---

## How inventory-planning.js Works Today (reference)

The script uses two data sources:
1. **Historical order files** (`/Users/jamiealexander/Documents/shopifyOrderData`) — local JSON files used to calculate how many units of each SKU were sold over the past year. This is the velocity source.
2. **Pre-order/incoming spreadsheet** (`1m2efAIbrV_fSYhJEfyAghROwJb7_3Fm5PuwR6GYjLwo`) — tabs named `us-YYYY-MM-DD` list units already on order (e.g. `us-2025-06-30` means 200 units of AJ-BLK-M arriving June 30). These are added to current on-hand inventory so weeks-until-stockout accounts for already-inbound stock.

The same `1m2efAIbrV_...` spreadsheet is also read by `update-incoming-inventory.js` to set Shopify pre-order metafields. So the spreadsheet serves double duty: the planning script reads it to include inbound units in the projection, and the update script reads it to publish pre-orders on the website.

The new system replaces (1) with Supabase order data, keeps (2) unchanged for now.

---

## Decisions Made

### Data source: Supabase for order history
Historical sales data (for velocity) comes from Supabase order tables — not local files. Enables Railway scheduling and MCP tool access. Incoming inventory still read from the `1m2efAIbrV_...` spreadsheet (unchanged, since it's also the pre-order source).

### OOS-adjusted velocity algorithm

For each SKU, over a configurable window (default 365 days):

1. `oos_days_from_snapshots` = count of rows in `inventory_snapshots` where `inventory_quantity <= 0` for this SKU. (Column is `inventory_quantity`, not `available_quantity`. Snapshots started ~March 2026, so covers ~90 days of the year window.)
2. `oos_days_from_preorders` = estimated from pre-order property flags on order line items for the period **before** snapshots started. Detected from `order_line_items.custom_attributes` — Supabase equivalent of Shopify's `item.properties`. A pre-order item has `{key: 'Pre-order', ...}` in custom_attributes. Port period-detection algorithm from `detectOutOfStockPeriods()` in `inventory-planning.js`.
3. `effective_selling_weeks = (period_days - oos_days_from_snapshots - oos_days_from_preorders) / 7`
4. `adjusted_velocity = units_sold / effective_selling_weeks`
5. Fallback: if `effective_selling_weeks <= 4` (always-OOS or near-zero), use `units_sold / 52` to avoid divide-by-near-zero

**OOS threshold:** `inventory_quantity <= 0`. Committed inventory is as good as sold — if available is 0 the SKU couldn't generate new sales regardless of the reason.

### Projection parameters (same as existing script, kept as configurable constants)
- Growth factor: 1.3 (30% uplift)
- Target stock weeks: 78 (18 months)
- Qty to order: `max(0, (78 - weeks_until_no_stock) * velocity)` rounded to nearest 10
- Priority buckets: <13w = URGENT, <26w = NEEDS ATTENTION, <39w = WATCH, <52w = OK, <78w = GOOD, 78w+ = FULL STOCK

### Output: Supabase canonical, Google Sheets optional view
Projection results written to `inventory_projections` table (upsert by sku on each run — one row per SKU, latest run wins). This enables the `get_at_risk_skus` query tool. Optionally write "Sales Data by SKU" sheet to Google Sheets for eyeballing. Drop "Sales Summary by Color" and "Sales Summary by Product" sheets — main sheet only.

### Supplier registry: Supabase table
A `suppliers` table stores supplier info and the SKU prefixes they supply. Enables automatic supplier-filtered production order generation.

| Name | Company | Contact | Email | SKU Prefixes (explicit) |
|---|---|---|---|---|
| Kali | JINJIANG JIHE IMPORT AND EXPORT | Kali Lin | kali.lin@qq.com | AJ, BB, UNW, CKY, FLO, RUBY, HLA, SHS, SKY2, SPB, RHW, GAF, PAD3, EAR, FLAG, PIN (and catch-all) |
| Queenas | Queenas | Fandy | biz2@queenas.com | SB (product: AVA SEAMLESS SHAPING BRA — SKU prefix is SB, not AVA) |
| JustMax | JustMax | Maggie Chen | maggiechen@justmax.cn | SWS |
| Wumes | Wumes | Maggie | sales03@wumes.com | MPAD |

**Exclusions (skip entirely in projections and production orders):**
- `TADLT` — adult tee (no longer ordering)
- `RJL` — old stock, never ordering again

**Catch-all rule:** any SKU prefix not explicitly matching SB, SWS, or MPAD → Kali.

### Production order CSV format
Output matches the format of the 2026 production orders spreadsheet (`1kMZ-thv7pmBEvudlT_Ujw1z1wb-2zwjV5vT_TuNm87w`):
```
PRODUCT NAME - COLOR
SKU, qty
SKU, qty
(blank), subtotal
(blank)
```
Grouped by product + color, sorted by SKU prefix then color. Subtotal row per group, grand total at end.

### Production order lifecycle (partial — Phase 4 completes this)
The `create_production_order` tool creates a `production_orders` record with `status = 'placed'` and `production_order_items` rows. Status transitions (in_production → qc_inspection → shipped → received → reconciled) are manual for now and will get a full MCP tool set in Phase 4.

### Code location: customer-service module
MCP tools live in `customer-service/lib/tools/`. Core logic in a new `customer-service/lib/merchandising/` subdirectory (business logic separate from MCP wiring). Schema in `customer-service/schema/merchandising.sql`.

---

## Supabase Schema

```sql
-- Supplier registry
CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  company_name TEXT,
  contact_name TEXT,
  email TEXT,
  sku_prefixes TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Latest projection results (upsert on each run, one row per SKU)
CREATE TABLE inventory_projections (
  id SERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  sku TEXT NOT NULL,
  product_handle TEXT,
  product_name TEXT,
  color TEXT,
  size TEXT,
  age_range TEXT,
  current_inventory INTEGER,
  total_incoming INTEGER DEFAULT 0,
  total_inventory INTEGER,
  units_sold_year INTEGER,
  sales_per_week NUMERIC(8,2),
  weeks_until_no_stock NUMERIC(8,1),
  priority TEXT,
  qty_to_order INTEGER,
  weeks_unavailable INTEGER DEFAULT 0,
  oos_periods TEXT,
  growth_factor NUMERIC(4,2) DEFAULT 1.3,
  target_weeks INTEGER DEFAULT 78,
  supplier_id INTEGER REFERENCES suppliers(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sku)
);

-- Production orders (lifecycle tracking)
CREATE TABLE production_orders (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER REFERENCES suppliers(id) NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed','in_production','qc_inspection','shipped','received','reconciled')),
  placed_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_ship_date DATE,
  expected_delivery_date DATE,
  actual_ship_date DATE,
  actual_delivery_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-SKU items within a production order
CREATE TABLE production_order_items (
  id SERIAL PRIMARY KEY,
  production_order_id INTEGER REFERENCES production_orders(id) ON DELETE CASCADE NOT NULL,
  sku TEXT NOT NULL,
  qty_ordered INTEGER NOT NULL,
  qty_received INTEGER,
  notes TEXT,
  UNIQUE(production_order_id, sku)
);
```

Seed data for `suppliers` table is the four rows in the table above.

---

## MCP Tools

### Tool 1: `run_inventory_projection`
**Input:** `{ growth_factor?: number, target_weeks?: number, write_sheets?: boolean }`  
**What it does:**
1. Fetch all active variants from `product_variants` (Supabase) — skip tees, skip products with no valid SKU
2. Fetch 365 days of sales from Supabase order tables
3. Fetch all `inventory_snapshots` rows
4. Fetch incoming orders from pre-order spreadsheet (`1m2efAIbrV_...` `us-YYYY-MM-DD` tabs) — reuse `getIncomingOrders()` logic from existing script
5. For each SKU: run OOS-adjusted velocity algorithm
6. Calculate weeks_until_no_stock, qty_to_order, priority
7. Look up supplier_id by SKU prefix match against `suppliers.sku_prefixes`
8. Upsert all rows to `inventory_projections`
9. If `write_sheets=true`: write "Sales Data by SKU" tab to the Google Sheets output spreadsheet
**Returns:** `{ run_date, sku_count, at_risk_count, total_units_to_order }`

### Tool 2: `get_at_risk_skus`
**Input:** `{ weeks_horizon: number, supplier?: string, include_incoming?: boolean }`  
**What it does:** Query `inventory_projections` for SKUs where `weeks_until_no_stock < weeks_horizon`. Filter by supplier name if given. If `include_incoming=false`, recalculate using `current_inventory` only (answers "what if this shipment is fully delayed?").  
**Returns:** Short list sorted by urgency: `[{ sku, product_name, color, size, weeks_until_no_stock, current_inventory, total_incoming, qty_to_order, supplier }]`

**Primary use case:** "What swimwear SKUs run out in the next 6 months if the Kali order is delayed?"
→ `get_at_risk_skus({ weeks_horizon: 26, supplier: 'Kali', include_incoming: false })`

### Tool 3: `create_production_order`
**Input:** `{ supplier: string, notes?: string, expected_delivery_date?: string }`  
**What it does:**
1. Look up supplier in `suppliers` by name (case-insensitive)
2. Get latest `inventory_projections` for that supplier's SKUs where `qty_to_order > 0`
3. Group by product_name + color; apply same sort order as the reference spreadsheet
4. Generate CSV in the production order format (product header, SKU|qty rows, subtotals, grand total)
5. Write CSV to a configurable output path (default: `~/Downloads/production-order-{supplier}-{date}.csv`)
6. Insert `production_orders` record (status=`placed`) + all `production_order_items` rows
**Returns:** `{ order_id, supplier, sku_count, total_units, csv_path, items_preview }`

---

## Implementation Steps

### Step 1: Verify Supabase schema (before writing any code)
- Read `inventory-tracking/daily-inventory-tracking.js` to find exact column names in `inventory_snapshots` — specifically: what's the column for inventory quantity (`available_quantity`? `quantity`? something else?) and is it keyed by `sku` or `variant_id`?
- Find the order tables: check `customer-service/sync/` for what order sync writes. Is it `order_line_items` or something else?
- Check what `product_variants` looks like — does it have `available_quantity` or is that in a separate table?

### Step 2: Create schema + seed data
- Write `customer-service/schema/merchandising.sql` with the four tables above
- Run in Supabase SQL Editor
- Insert the four supplier rows

### Step 3: Build `customer-service/lib/merchandising/inventoryProjection.js`
Core export: `runProjection({ growthFactor, targetWeeks, lookbackDays })` → returns array of projection rows.

Sub-functions:
- `fetchOrderData(startDate, endDate)` → `Map<sku, unitsSold>`
- `fetchInventorySnapshots(startDate)` → `Map<sku, [{ date, available }]>`
- `fetchCurrentInventory()` → `Map<sku, quantity>` from `product_variants`
- `fetchIncomingOrders()` → `Map<sku, { incoming, date }>` from `1m2efAIbrV_...` spreadsheet (port `getIncomingOrders()` from existing script)
- `detectOosFromSnapshots(sku, snapshotRows)` → number of OOS days
- `detectOosFromPreorders(sku, orders, periodStart, periodEnd)` → number of OOS days (port `detectOutOfStockPeriods()` from existing script)
- `calculateVelocity(unitsSold, effectiveSellingWeeks)` → units/week
- `buildProjectionRow(sku, variant, velocity, currentInventory, incomingInventory, weeksUnavailable, growthFactor, targetWeeks)` → projection row object

### Step 4: Build `customer-service/lib/merchandising/supplierRegistry.js`
- `getSupplierBySku(sku)` → supplier row from `suppliers` table (match by prefix)
- `getSupplierByName(name)` → supplier row (case-insensitive)
- `shouldSkipSku(sku)` → true for tee prefixes

### Step 5: Build MCP tool files
- `customer-service/lib/tools/inventoryProjection.js` — wraps `run_inventory_projection` and `get_at_risk_skus`
- `customer-service/lib/tools/productionOrders.js` — wraps `create_production_order`
- Find where existing tools are registered and add the three new tools

### Step 6: Validate
- Run `run_inventory_projection` and verify `inventory_projections` populates correctly
- Compare a few SKUs against the existing spreadsheet output to sanity-check velocity numbers
- Run `get_at_risk_skus({ weeks_horizon: 26, supplier: 'Kali', include_incoming: false })` — this is the fabric QC question
- Run `create_production_order({ supplier: 'Kali' })` and open the CSV — verify it matches the structure of `1kMZ-...` reference spreadsheet

---

## Open Questions — RESOLVED

1. **`inventory_snapshots` columns** — `date` (YYYY-MM-DD), `sku`, `inventory_quantity`, `variant_id`, `product_handle`. Upsert key: `[date, variant_id]`.
2. **Order data** — `order_line_items` table: `sku`, `quantity`, `refunded_quantity`, `shopify_order_id`, `custom_attributes`. Join with `orders` (has `created_at`, `cancelled_at`) for date filtering. Velocity = `SUM(quantity - refunded_quantity)` by SKU, exclude `cancelled_at IS NOT NULL`.
3. **Exclusions** — `TADLT` (tee) + `RJL` (old stock). EAR/FLAG/PIN stay in (Kali catches them; Jamie wants to know when they run low).
4. **MCP registration** — `customer-service/server.js`: add `require('./lib/tools/inventoryProjection')` + `require('./lib/tools/productionOrders')` to imports, spread into `allTools`.
5. **CSV output** — `~/Downloads/production-order-{supplier}-{date}.csv` (confirmed).

---

## Out of Scope (future phases)

- Phase 4: Production order status transitions (in_production → qc_inspection → shipped → received → reconciled) with dedicated MCP tools
- Phase 5: Automated `us-YYYY-MM-DD` tab creation in `1m2efAIbrV_...` spreadsheet from a confirmed production order (currently manual)
- Phase 5: QC spreadsheet + 3PL inbound list generation
- Phase 5: Pre-order metafield update triggered from production order state
- Scheduling on Railway (after local validation)
- Migrating `api.rubyshines.com/api/v1/product-inventory` to read from Supabase
