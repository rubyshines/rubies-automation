-- Virtual Closet schema. Idempotent; run in the Supabase SQL editor or via
-- scripts/apply-sql.js when SUPABASE_DATABASE_URL is set.
-- Design record: .claude/plans/org-closet-programme.md
-- Build spec:    .claude/memory/project_virtual_closet.md

create table if not exists vc_centres (
  id                  bigserial primary key,
  slug                text not null unique,
  name                text not null,
  website             text,
  logo_url            text,
  address             jsonb not null default '{}'::jsonb,          -- {street, city, region, postal, country, hours, phone}
  programmes          jsonb not null default '{"closet": true, "pass_it_on": false}'::jsonb,
  sizes               text[] not null default '{XS,S,M,L,1X,2X,3X,4X}',
  kids_sizes          boolean not null default false,
  items_per_request   integer not null default 2 check (items_per_request between 1 and 6),
  requests_per_year   integer not null default 2 check (requests_per_year between 1 and 12),
  goal_cents          integer not null default 30000 check (goal_cents >= 30000),
  approval_mode       text not null default 'automatic' check (approval_mode in ('automatic','by_hand')),
  ship_to_door        boolean not null default true,
  requests_paused_at  timestamptz,
  map_listed          boolean not null default true,
  map_pin_to_closet   boolean not null default true,
  pass_it_on_paused_at timestamptz,
  statements_email    text,
  pickup_note         text,
  delivery_note       text,
  status              text not null default 'pending' check (status in ('pending','active','paused','left')),
  approved_at         timestamptz,
  approved_by         text,
  paused_reason       text,
  left_at             timestamptz,
  donation_partner_id integer references donation_partners(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists vc_users (
  id                bigserial primary key,
  email             text not null unique,                             -- stored lower-cased
  name              text,
  role_title        text,
  password_hash     text,                                             -- scrypt: salt$hash, null for invited-not-yet-joined
  email_verified_at timestamptz,
  created_at        timestamptz not null default now(),
  last_active_at    timestamptz
);

create table if not exists vc_memberships (
  centre_id   bigint not null references vc_centres(id) on delete cascade,
  user_id     bigint not null references vc_users(id) on delete cascade,
  role        text not null default 'member' check (role in ('admin','member')),
  created_at  timestamptz not null default now(),
  primary key (centre_id, user_id)
);

create table if not exists vc_invitations (
  id          bigserial primary key,
  centre_id   bigint not null references vc_centres(id) on delete cascade,
  email       text not null,
  role        text not null default 'member' check (role in ('admin','member')),
  token_hash  text not null unique,
  invited_by  bigint references vc_users(id) on delete set null,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- Single-use tokens for every emailed link: verify, reset, change email,
-- confirm a request, approve/decline a request by hand.
create table if not exists vc_tokens (
  id          bigserial primary key,
  purpose     text not null check (purpose in ('verify_email','reset_password','change_email','request_verify','request_answer')),
  token_hash  text not null unique,
  user_id     bigint references vc_users(id) on delete cascade,
  email       text,
  payload     jsonb not null default '{}'::jsonb,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists vc_sessions (
  id          text primary key,                                       -- random, referenced by the signed cookie
  user_id     bigint not null references vc_users(id) on delete cascade,
  acting_as   jsonb,                                                  -- {operator: email} when the operator opens a centre's Home as them
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index if not exists vc_sessions_user_idx on vc_sessions (user_id) where revoked_at is null;

create table if not exists vc_boxes (
  id              bigserial primary key,
  centre_id       bigint not null references vc_centres(id) on delete cascade,
  number          integer not null,
  status          text not null default 'open' check (status in ('open','sent','shipped','delivered')),
  goal_cents      integer not null default 30000,                     -- the centre's goal when the box opened
  opened_at       timestamptz not null default now(),
  sent_at         timestamptz,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  carrier         text,
  tracking_number text,
  fill_mode       text check (fill_mode in ('auto','chosen')),
  fill_plan       jsonb,                                              -- [{style, size, qty}]
  pickup_note     text,
  delivery_note   text,
  items_count     integer,
  unique (centre_id, number)
);
create index if not exists vc_boxes_open_idx on vc_boxes (centre_id) where status = 'open';

-- Every dollar in and out of a box, in cents. Raised = order_credit + sponsor +
-- centre_add + carry_in + adjustment. match, door_shipping and carry_out are
-- written when the box is sent. Idempotent on (kind, source_type, source_id).
create table if not exists vc_ledger (
  id           bigserial primary key,
  centre_id    bigint not null references vc_centres(id) on delete cascade,
  box_id       bigint references vc_boxes(id) on delete set null,
  kind         text not null check (kind in ('order_credit','sponsor','centre_add','carry_in','adjustment','match','door_shipping','carry_out')),
  amount_cents integer not null,
  source_type  text,                                                  -- 'shopify_order' | 'shopify_line_item' | 'box' | 'operator'
  source_id    text,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create unique index if not exists vc_ledger_source_uniq on vc_ledger (kind, source_type, source_id) where source_id is not null;
create index if not exists vc_ledger_box_idx on vc_ledger (box_id);

create table if not exists vc_requests (
  id               bigserial primary key,
  centre_id        bigint not null references vc_centres(id) on delete cascade,
  box_id           bigint references vc_boxes(id) on delete set null,
  email            text not null,
  name             text not null,                                     -- the name they go by, never a legal name
  items            jsonb not null,                                    -- [{style, colour, size}]
  delivery         text not null check (delivery in ('pickup','ship')),
  address          jsonb,                                             -- ship only; operator-visible only
  words            text,
  words_shareable  boolean not null default false,
  words_published_at timestamptz,
  published_by     bigint references vc_users(id) on delete set null,
  status           text not null default 'unverified' check (status in ('unverified','needs_answer','approved','waiting','declined','in_box','shipped','ready','collected','ended','cancelled')),
  decided_by       text,
  decided_at       timestamptz,
  decline_counts   boolean not null default false,
  decline_note     text,
  verified_at      timestamptz,
  swap             jsonb,                                             -- {from, to, at} when an out-of-stock item was swapped at packing
  reminded_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists vc_requests_centre_idx on vc_requests (centre_id, status);
create index if not exists vc_requests_email_idx on vc_requests (email);

create table if not exists vc_requester_emails (
  email        text primary key,
  verified_at  timestamptz not null default now()
);

create table if not exists vc_discount_codes (
  id         bigserial primary key,
  centre_id  bigint not null references vc_centres(id) on delete cascade,
  code       text not null unique,
  issued_at  timestamptz not null default now(),
  order_id   text,
  used_at    timestamptz
);

create table if not exists vc_visits (
  id         bigserial primary key,
  centre_id  bigint not null references vc_centres(id) on delete cascade,
  lead       text,
  source     text not null default 'link',
  visited_at timestamptz not null default now()
);
create index if not exists vc_visits_centre_idx on vc_visits (centre_id, visited_at);

create table if not exists vc_events (
  id         bigserial primary key,
  centre_id  bigint references vc_centres(id) on delete cascade,
  actor      text not null,                                           -- 'user:<id>' | 'operator:<email>' | 'system' | 'visitor'
  kind       text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists vc_events_centre_idx on vc_events (centre_id, created_at desc);

create table if not exists vc_word_reports (
  id          bigserial primary key,
  request_id  bigint not null references vc_requests(id) on delete cascade,
  reported_at timestamptz not null default now(),
  resolution  text check (resolution in ('unpublish','keep')),
  resolved_at timestamptz
);

create table if not exists vc_statements (
  id         bigserial primary key,
  centre_id  bigint not null references vc_centres(id) on delete cascade,
  month      text not null,                                           -- 'YYYY-MM'
  payload    jsonb not null,
  sent_at    timestamptz,
  unique (centre_id, month)
);
