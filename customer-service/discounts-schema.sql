-- managed_discounts — registry of the automatic discounts WE manage (volume + sales).
-- Replaces the old Google Sheet that drove rubies-utilities/scripts/core/manage-discounts.js.
--
-- Only the discounts Jamie hand-manages live here. Smile.io loyalty codes, Klaviyo code
-- pools, and comp codes are machine-generated and are NOT tracked in this table.
--
-- Natural key: name (the base name, e.g. "AJ Volume Discount" / "Spring Sale"). Tiered
-- discounts are ONE row whose shopify_node_ids holds one DiscountAutomaticNode id per tier
-- (Shopify needs a separate node per tier; the per-tier node title is "<pct>% <name>").
--
-- Run in the Supabase SQL editor.

create table if not exists managed_discounts (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('volume', 'sale')),
  name              text not null unique,
  sku_prefixes      text[] not null default '{}',   -- volume only: SKU prefixes the discount applies to
  collection_handle text,                            -- sale only: collection the sale applies to (default 'discounts')
  tiers             jsonb not null,                  -- [{threshold:int, percentage:number}] threshold = qty (volume) | subtotal $ (sale)
  shopify_node_ids  text[] not null default '{}',    -- DiscountAutomaticNode numeric ids, one per tier (ordered with tiers)
  free_gift_handle  text,                            -- sale only: source product handle of an attached free-gift twin (optional)
  status            text not null default 'active' check (status in ('active', 'ended')),
  starts_at         timestamptz,
  ends_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists managed_discounts_kind_status_idx on managed_discounts (kind, status);
