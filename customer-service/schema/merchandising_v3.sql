-- Merchandising v3 — production lots (split a produced order line by quality + disposition).
--
-- A production issue (e.g. the June 2026 thin-black-swimwear-fabric mistake) means a
-- single ordered SKU splits into lots handled differently: some ship now with a physical
-- marker (pink-dot sticker) as a test batch, the rest are held in storage. `production_lots`
-- is the canonical record of that partition. Standard (no-issue) lines are simply one lot
-- (quality='standard', disposition='ship'); nothing changes for them.
-- (We deliberately track only ship vs held — suppliers rarely tell us which held units are
-- finished vs to-be-remade, so a finer "remake" split isn't worth the complexity.)
--
-- Run in the Supabase SQL editor. Idempotent.

CREATE TABLE IF NOT EXISTS production_lots (
  id SERIAL PRIMARY KEY,
  production_order_id INTEGER REFERENCES production_orders(id) ON DELETE CASCADE NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  -- 'standard' or a short quality label, e.g. 'thin_black_fabric'
  quality TEXT NOT NULL DEFAULT 'standard',
  -- physical identifier on the garment/hangtag, e.g. 'pink_sticker'
  marker TEXT,
  -- what happens to this lot
  disposition TEXT NOT NULL DEFAULT 'ship'
    CHECK (disposition IN ('ship', 'hold_storage')),
  -- set when the lot physically ships in (ties the lot to its inbound shipment)
  inbound_shipment_id INTEGER REFERENCES inbound_shipments(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
  -- Idempotency is handled in code by a tightly-scoped delete-then-insert (ship lots by
  -- inbound_shipment_id; hold/remake lots by (order, sku, disposition)). Receiving is
  -- operator-driven, not a concurrent webhook path, so no unique constraint is needed.
);

CREATE INDEX IF NOT EXISTS idx_production_lots_order ON production_lots(production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_lots_shipment ON production_lots(inbound_shipment_id);
