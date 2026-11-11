-- NongJoDII initial schema (issue #1 scope: messages, groups, Projects, Tasks,
-- files, usage, insights). Terms follow docs/PROJECT.md.
--
-- Access model: the Next.js server is the only client. It uses the Supabase
-- secret (service role) key, which bypasses RLS. RLS is enabled on every table
-- with NO policies, so the publishable/anon key can read nothing (chat text,
-- Google tokens). The Dashboard server checks the LIFF ID token itself and
-- filters by membership in code (#9).
--
-- Owner (decided 2026-11-11): the setup form names an Owner for each group. The
-- role takes effect only after that person confirms with LINE login. The Owner
-- is that group's admin; their plan, Fair-use cap and Google Drive cover every
-- group they admin. The group picker lists only groups the user admins.
-- There are no plan or payment tables: the plan screens are a static mock.
--
-- Removal (#11): deleting a row in `groups` cascades to that group's messages,
-- Summaries, Tasks, files, members and insights. Usage, push counts and webhook
-- event IDs do NOT cascade, so a purge cannot reset the Fair-use cap, the push
-- count or event dedupe.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

-- Every LINE user the bot has seen (sender, LIFF login, tagged person).
-- LINE user IDs are per provider: both LINE channels must sit under one provider.
create table public.line_users (
  line_user_id   text primary key,
  display_name   text,
  first_seen_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger line_users_updated_at before update on public.line_users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Projects and groups (#2)
-- ---------------------------------------------------------------------------

-- A Project is represented by its main group (groups.is_main = true).
-- The Owner is identified from the LIFF login, never from the join event.
-- owner_line_user_id is the Project's admin: the Owner named in the setup form
-- for its main group. Every group of the Project must name this same person as
-- its Owner (enforced by groups_owner_rules below). The role is effective for a
-- group only once groups.owner_confirmed_at is set.
create table public.projects (
  id                        uuid primary key default gen_random_uuid(),
  owner_line_user_id        text not null references public.line_users (line_user_id),
  -- Drive folder ID, never a name (#3). Null until Drive is connected.
  -- The root "NongJoDII" folder is per Google account: see google_accounts.
  drive_project_folder_id   text,   -- this Project's folder
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index projects_owner_idx on public.projects (owner_line_user_id);

create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

-- Every LINE group the bot is in. The bot joins before setup finishes, so
-- project_id is null until the group is made a Project (main) or attached as
-- a Sub group. A group belongs to at most one Project (single FK column).
create table public.groups (
  id                 uuid primary key default gen_random_uuid(),
  line_group_id      text not null unique,
  project_id         uuid references public.projects (id) on delete restrict,
  is_main            boolean not null default false,
  name               text,
  -- Main group: "Main group files" folder. Sub group: its own folder.
  drive_folder_id    text,
  joined_at          timestamptz not null default now(),
  left_at            timestamptz,
  -- Set to left_at + 7 days on leave; cleared on re-invite (#11).
  delete_after       timestamptz,
  -- Owner (admin) of this group. Two states:
  --   nominated: nominated_owner_line_user_id set, owner_confirmed_at null.
  --              The person has no admin rights yet.
  --   confirmed: owner_confirmed_at set (the nominee confirmed with LINE login).
  --              The nominee is now this group's admin.
  -- Changing the nominee clears owner_confirmed_at (trigger below).
  nominated_owner_line_user_id    text references public.line_users (line_user_id),
  owner_nominated_by_line_user_id text references public.line_users (line_user_id),
  owner_nominated_at              timestamptz,
  owner_confirmed_at              timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint groups_main_needs_project check (not is_main or project_id is not null),
  constraint groups_delete_after_needs_leave check (delete_after is null or left_at is not null),
  constraint groups_confirmed_needs_nominee
    check (owner_confirmed_at is null or nominated_owner_line_user_id is not null)
);

-- "Groups this user admins" (the group picker, the Fair-use cap): confirmed
-- Owners only, one index lookup. The app also filters left_at is null.
create index groups_admin_idx on public.groups (nominated_owner_line_user_id)
  where owner_confirmed_at is not null;

-- Same-admin grouping rule, kept simple: a group attached to a Project must
-- name the Project's owner as its Owner. A new nominee resets the confirmation.
-- The picker (app code) additionally lists only groups the requester admins,
-- i.e. owner_confirmed_at is not null.
create function public.groups_owner_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.nominated_owner_line_user_id is distinct from old.nominated_owner_line_user_id then
    new.owner_confirmed_at := null;
  end if;
  if new.project_id is not null
     and new.nominated_owner_line_user_id is distinct from
         (select p.owner_line_user_id from public.projects p where p.id = new.project_id) then
    raise exception 'group Owner must be the Project owner'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger groups_owner_rules before insert or update on public.groups
  for each row execute function public.groups_owner_rules();

-- Exactly one main group per Project.
create unique index groups_one_main_per_project on public.groups (project_id) where is_main;
create index groups_project_idx on public.groups (project_id);
create index groups_delete_after_idx on public.groups (delete_after) where delete_after is not null;

create trigger groups_updated_at before update on public.groups
  for each row execute function public.set_updated_at();

-- Members per group. Nicknames and role come from the setup form (Figma #2c)
-- so the AI knows who the chat means.
-- PROPOSAL (open decision 3): rows come from senders seen and LIFF visits;
-- is_pm marks who sees all groups of the Project on the Dashboard.
create table public.group_members (
  group_id       uuid not null references public.groups (id) on delete cascade,
  line_user_id   text not null references public.line_users (line_user_id),
  nicknames      text[] not null default '{}',
  role           text,
  is_pm          boolean not null default false,
  source         text not null default 'message'
                   check (source in ('message', 'liff', 'setup_form')),
  first_seen_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (group_id, line_user_id)
);

create index group_members_user_idx on public.group_members (line_user_id);

create trigger group_members_updated_at before update on public.group_members
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Google Drive connection (#3)
-- ---------------------------------------------------------------------------

-- A Google account signed in through OAuth (drive.file scope), linked to the
-- LINE user who signed in from LIFF. One Google account serves all Projects
-- of that person, so they sign in once. The "NongJoDII" root folder lives in
-- that account's Drive, so its ID is kept here (one per account).
-- If sign-in runs through Supabase Auth (Google provider), auth_user_id links
-- the auth.users row. Supabase Auth does not keep the provider refresh token,
-- so the app stores it here either way, encrypted before insert.
create table public.google_accounts (
  id                        uuid primary key default gen_random_uuid(),
  line_user_id              text not null references public.line_users (line_user_id),
  auth_user_id              uuid unique references auth.users (id) on delete set null,
  google_subject            text not null unique,   -- Google "sub" claim, stable ID
  email                     text,
  granted_scopes            text[] not null default '{}',
  refresh_token_ciphertext  text,                   -- null after revoke
  drive_root_folder_id      text,                   -- "NongJoDII" folder; null until created
  token_status              text not null default 'valid'
                              check (token_status in ('valid', 'revoked', 'expired')),
  connected_at              timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index google_accounts_line_user_idx on public.google_accounts (line_user_id);

create trigger google_accounts_updated_at before update on public.google_accounts
  for each row execute function public.set_updated_at();

-- Which Google account holds a Project's files. One active row per Project;
-- the connected account can change (#3), so old rows stay as 'replaced'.
-- A revoked token shows on google_accounts.token_status; Tasks stay and the
-- Owner is asked to sign in again.
create table public.drive_connections (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete cascade,
  google_account_id  uuid not null references public.google_accounts (id),
  status             text not null default 'active'
                       check (status in ('active', 'replaced')),
  connected_at       timestamptz not null default now(),
  status_changed_at  timestamptz
);

create unique index drive_connections_one_active
  on public.drive_connections (project_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- Webhook events and messages (#1)
-- ---------------------------------------------------------------------------

-- Dedupe ledger keyed on LINE's webhookEventId. No chat text here, and no FK
-- to groups, so it survives a purge. Insert with ON CONFLICT DO NOTHING.
create table public.webhook_events (
  webhook_event_id  text primary key,
  event_type        text not null,
  line_group_id     text,
  event_timestamp   timestamptz not null,   -- order by this, not arrival
  is_redelivery     boolean not null default false,
  received_at       timestamptz not null default now()
);

create index webhook_events_timestamp_idx on public.webhook_events (event_timestamp);

-- Group chat messages, with sender and send time for AI context.
-- Unsend (decided 2026-11-11) DELETEs the row. Every FK that points at
-- messages (task_prompts.trigger_message_id, files.message_id) is ON DELETE SET
-- NULL, so the referencing row survives; confirmed Tasks stay. messages itself
-- points at webhook_events, not the reverse, so the dedupe ledger is untouched.
create table public.messages (
  id                    uuid primary key default gen_random_uuid(),
  group_id              uuid not null references public.groups (id) on delete cascade,
  webhook_event_id      text not null unique references public.webhook_events (webhook_event_id),
  line_message_id       text not null unique,
  sender_line_user_id   text references public.line_users (line_user_id),
  message_type          text not null,   -- text, image, file, video, audio, sticker, ...
  text                  text,
  sent_at               timestamptz not null
);

create index messages_group_sent_idx on public.messages (group_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- Summaries and Tasks (#5, #7, #8)
-- ---------------------------------------------------------------------------

create table public.summaries (
  id                        uuid primary key default gen_random_uuid(),
  group_id                  uuid not null references public.groups (id) on delete cascade,
  requested_by_line_user_id text references public.line_users (line_user_id),
  summary_text              text not null,
  first_message_at          timestamptz,
  last_message_at           timestamptz,
  created_at                timestamptz not null default now()
);

create index summaries_group_idx on public.summaries (group_id, created_at desc);

-- Model output lives here as a proposal. A Task row is written only when a
-- person confirms a candidate; model output never writes `tasks` directly.
create table public.task_candidates (
  id                              uuid primary key default gen_random_uuid(),
  summary_id                      uuid not null references public.summaries (id) on delete cascade,
  title                           text not null,
  details                         text,
  suggested_assignee_line_user_id text references public.line_users (line_user_id),
  suggested_due_at                timestamptz,
  state                           text not null default 'proposed'
                                    check (state in ('proposed', 'confirmed', 'declined')),
  decided_by_line_user_id         text references public.line_users (line_user_id),
  decided_at                      timestamptz,
  created_at                      timestamptz not null default now()
);

create index task_candidates_summary_idx on public.task_candidates (summary_id);

create type public.task_status as enum ('not_assigned', 'in_process', 'done');

create table public.tasks (
  id                       uuid primary key default gen_random_uuid(),
  group_id                 uuid not null references public.groups (id) on delete cascade,
  candidate_id             uuid unique references public.task_candidates (id) on delete set null,
  title                    text not null,
  details                  text,
  status                   public.task_status not null default 'not_assigned',
  assignee_line_user_id    text references public.line_users (line_user_id),
  created_by_line_user_id  text not null references public.line_users (line_user_id),
  due_at                   timestamptz,          -- date + time, shown in Asia/Bangkok
  -- Bumped on any human update; drives the "no update in 5 days" flag (#8).
  last_activity_at         timestamptz not null default now(),
  done_at                  timestamptz,
  -- Who last edited the Task (title, details, owner, due date and time).
  last_edited_by_line_user_id text references public.line_users (line_user_id),
  -- Soft delete ("Not a task" after a confirm). Undo clears both columns.
  -- Live Tasks are deleted_at is null; every Task read must filter on it.
  deleted_at               timestamptz,
  deleted_by_line_user_id  text references public.line_users (line_user_id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint tasks_deleted_by_needs_deleted_at
    check (deleted_by_line_user_id is null or deleted_at is not null)
);

-- Partial indexes over live (not soft-deleted) Tasks.
create index tasks_group_status_idx on public.tasks (group_id, status) where deleted_at is null;
create index tasks_assignee_idx on public.tasks (assignee_line_user_id) where deleted_at is null;
create index tasks_due_idx on public.tasks (due_at) where status <> 'done' and deleted_at is null;

create trigger tasks_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

-- "Mark as Done?" questions (#7) and reminder answers (#8). Status changes
-- only when a person answers.
create table public.task_prompts (
  id                       uuid primary key default gen_random_uuid(),
  task_id                  uuid not null references public.tasks (id) on delete cascade,
  kind                     text not null check (kind in ('mark_done', 'reminder', 'gap_flag')),
  trigger_message_id       uuid references public.messages (id) on delete set null,
  asked_at                 timestamptz not null default now(),
  answer                   text check (answer in ('yes', 'no', 'done', 'need_time')),
  answered_by_line_user_id text references public.line_users (line_user_id),
  answered_at              timestamptz
);

create index task_prompts_task_idx on public.task_prompts (task_id, asked_at desc);
create index task_prompts_open_idx on public.task_prompts (task_id) where answer is null;

-- ---------------------------------------------------------------------------
-- Files (#4)
-- ---------------------------------------------------------------------------

create table public.files (
  id                   uuid primary key default gen_random_uuid(),
  group_id             uuid not null references public.groups (id) on delete cascade,
  message_id           uuid references public.messages (id) on delete set null,
  sender_line_user_id  text references public.line_users (line_user_id),
  file_name            text not null,
  content_sha256       text not null,
  drive_file_id        text not null,
  drive_link           text not null,
  sent_at              timestamptz not null,
  saved_at             timestamptz not null default now(),
  -- Duplicate (same hash) in the same group is saved once.
  constraint files_one_per_hash unique (group_id, content_sha256)
);

create index files_group_saved_idx on public.files (group_id, saved_at desc);

-- ---------------------------------------------------------------------------
-- Fair-use cap (#6) and push quota (#8)
-- ---------------------------------------------------------------------------

-- One row per AI call, keyed on the Owner (the admin of the group at call time;
-- the cap sums across every group they admin). project_id/group_id are set null on
-- purge so the month's total stays intact.
create table public.ai_usage (
  id                  uuid primary key default gen_random_uuid(),
  owner_line_user_id  text not null references public.line_users (line_user_id),
  project_id          uuid references public.projects (id) on delete set null,
  group_id            uuid references public.groups (id) on delete set null,
  purpose             text not null check (purpose in ('summary', 'progress_decision')),
  model               text not null,
  input_tokens        integer not null check (input_tokens >= 0),
  output_tokens       integer not null check (output_tokens >= 0),
  cost_usd            numeric(12, 6) not null check (cost_usd >= 0),
  created_at          timestamptz not null default now()
);

create index ai_usage_owner_time_idx on public.ai_usage (owner_line_user_id, created_at);

-- Monthly totals per Owner. Month boundary in Asia/Bangkok time.
create view public.owner_monthly_usage
with (security_invoker = true) as
select
  owner_line_user_id,
  date_trunc('month', created_at at time zone 'Asia/Bangkok') as month_start_bkk,
  sum(input_tokens + output_tokens)::bigint as total_tokens,
  sum(cost_usd) as total_cost_usd
from public.ai_usage
group by owner_line_user_id, date_trunc('month', created_at at time zone 'Asia/Bangkok');

-- Every push message, counted against the LINE monthly quota. No FK.
-- One push per event. Pushes go to groups only (decided 2026-11-11): no 1:1
-- pushes, reminders and flags are posted in the group where the Task lives.
-- Near the quota the bot stops pushing and the items show on the Dashboard only.
create table public.push_log (
  id               uuid primary key default gen_random_uuid(),
  purpose          text not null,   -- reminder, gap_flag, weekly_insight, cap_notice, ...
  line_target_id   text not null,   -- LINE group ID the push went to (groups only)
  message_count    integer not null default 1 check (message_count > 0),
  sent_at          timestamptz not null default now()
);

create index push_log_sent_idx on public.push_log (sent_at);

-- Pushes counted so far in the current calendar month, Asia/Bangkok time.
-- Always returns one row (0 when nothing was sent). The app compares it with
-- the LINE monthly quota before every push.
create view public.push_count_current_month
with (security_invoker = true) as
select
  date_trunc('month', now() at time zone 'Asia/Bangkok') as month_start_bkk,
  coalesce(sum(message_count), 0)::bigint as push_count
from public.push_log
where sent_at >= (date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')
  and sent_at <  ((date_trunc('month', now() at time zone 'Asia/Bangkok') + interval '1 month') at time zone 'Asia/Bangkok');

-- ---------------------------------------------------------------------------
-- Weekly insight (#10)
-- ---------------------------------------------------------------------------

-- Counts come from code, over live (not soft-deleted) Tasks; there is no AI
-- paragraph (decided 2026-11-11). The post also lists the unowned Tasks, which
-- the app reads live. "Awaiting an owner" = status not_assigned.
create table public.weekly_insights (
  id                     uuid primary key default gen_random_uuid(),
  group_id               uuid not null references public.groups (id) on delete cascade,
  week_start             date not null,
  tasks_done             integer not null default 0,
  tasks_in_process       integer not null default 0,
  tasks_awaiting_owner   integer not null default 0,
  posted_at              timestamptz,
  created_at             timestamptz not null default now(),
  constraint weekly_insights_once_per_week unique (group_id, week_start)
);

-- ---------------------------------------------------------------------------
-- Row Level Security: on everywhere, no policies (server-only access).
-- ---------------------------------------------------------------------------

alter table public.line_users        enable row level security;
alter table public.projects          enable row level security;
alter table public.groups            enable row level security;
alter table public.group_members     enable row level security;
alter table public.google_accounts   enable row level security;
alter table public.drive_connections enable row level security;
alter table public.webhook_events    enable row level security;
alter table public.messages          enable row level security;
alter table public.summaries         enable row level security;
alter table public.task_candidates   enable row level security;
alter table public.tasks             enable row level security;
alter table public.task_prompts      enable row level security;
alter table public.files             enable row level security;
alter table public.ai_usage          enable row level security;
alter table public.push_log          enable row level security;
alter table public.weekly_insights   enable row level security;
