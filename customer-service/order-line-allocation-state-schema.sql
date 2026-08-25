-- Per-line warehouse allocation state, observed over time.
--
-- WHY THIS TABLE EXISTS
--
-- The unnotified pre-order drafter answers "is this customer waiting on an item
-- nobody told them about?" from a single point-in-time read. That works for the
-- case it was built for — an order placed through the Shop App, which never
-- stamps the `Pre-order` line attribute, so the line was never allocated and is
-- detectable within minutes of purchase.
--
-- It is structurally blind to the other route to the same state: a line that WAS
-- allocated and stops being allocated, when a stock recount comes up short and
-- the warehouse de-allocates. Nothing about that is visible at order time, and
-- the drafter's 14-day staleness gate is measured from the ORDER date, so by the
-- time the event happens the order is often already outside the window. Order
-- #32951 (placed 2026-08-08, Serena de-allocated 2026-08-24, 16 days later) sat
-- undetected and the customer was never told.
--
-- The signal for that case is a TRANSITION, and a transition needs a prior
-- observation to compare against. reports/lib/orderAllocation.js reconstructs
-- the full per-line index on every call and throws it away; this table is where
-- the previous observation lives.
--
-- WHY NOT THE ORDER-LEVEL FLAG
--
-- Warehance publishes `not_ready_to_ship_types.has_unallocated_products`, which
-- would be far cheaper to watch. It is too coarse: measured 2026-08-25, it reads
-- true on 161 of 179 open orders, because any single unallocated line sets it for
-- the whole order. On #32951 it had been true since the day the order was placed
-- (the Evey sports bra has never had stock), so a false -> true watch would never
-- have fired for the Serena going away. Per-line is the granularity of the
-- question.

CREATE TABLE IF NOT EXISTS order_line_allocation_state (
  order_number   integer     NOT NULL,
  sku            text        NOT NULL,
  -- Reconstructed verdict from orderAllocation.buildAllocationIndex: has the
  -- warehouse reserved this line's full open quantity for this order.
  allocated      boolean     NOT NULL,
  -- Carried for diagnosis, not for detection: when a flip is investigated later,
  -- the pair (on_hand then, on_hand now) is what distinguishes "stock vanished"
  -- from "an older order took the unit".
  on_hand        integer,
  quantity       integer,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_number, sku)
);

-- The sweep reads back only the lines it is about to observe, by order number.
CREATE INDEX IF NOT EXISTS idx_order_line_allocation_state_order
  ON order_line_allocation_state (order_number);

-- Cleanup pass drives off this: rows for orders that have left the open book
-- stop being refreshed and age out.
CREATE INDEX IF NOT EXISTS idx_order_line_allocation_state_last_seen
  ON order_line_allocation_state (last_seen_at);
