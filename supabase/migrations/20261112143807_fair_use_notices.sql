-- Fair-use cap notices (#6). One row per Owner, group, Bangkok month and kind,
-- claimed with INSERT ... ON CONFLICT DO NOTHING RETURNING (supabase-js upsert
-- with ignoreDuplicates) before the notice is sent, so a group gets the 80%
-- warning once per month even when two Summaries finish at the same time.
-- month_start_bkk uses the same Bangkok month as the owner_monthly_usage view.
-- Cascades with the group (#11 purge).
create table public.fair_use_notices (
  owner_line_user_id  text not null references public.line_users (line_user_id),
  group_id            uuid not null references public.groups (id) on delete cascade,
  month_start_bkk     date not null,   -- first day of the Asia/Bangkok month
  kind                text not null check (kind in ('warn_80')),
  sent_at             timestamptz not null default now(),
  primary key (owner_line_user_id, group_id, month_start_bkk, kind)
);

alter table public.fair_use_notices enable row level security;
