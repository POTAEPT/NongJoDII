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
-- Member and Owner changes (decided 2026-11-11):
--   * A Member who leaves keeps their group_members row with left_at set, so
--     names stay on Done Tasks; a rejoin clears left_at.
--   * An Owner who leaves: groups.owner_left_at is set and owner_confirmed_at is
--     cleared. Owner-backed features (file saving, Summaries) run only while
--     owner_confirmed_at is set; Tasks, reminders and the Dashboard keep working.
--   * No confirmed Owner 7 days after owner_left_at: the daily tick makes the
--     bot leave the group (see groups below).
--   * Owner change of a whole Project: the new main-group Owner confirms first;
--     the Sub group take-over question is answered separately. Unanswered for 7
--     days (takeover_asked_at), the Sub groups detach from the Project (see
--     groups, change_project_owner and answer_subgroup_takeover below).
--
-- Onboarding and schedule (decided 2026-11-11): the setup form collects what the
-- group works on, Members' nicknames and roles, the features to use, the Owner
-- and the reminder and summary times; all of it is editable later in Settings.
-- Homes: groups.work_description, group_members.nicknames and role, the
-- groups.feature_* toggles, groups.nominated_owner_line_user_id, and the
-- groups schedule columns (daily reminder time, weekly summary weekday and time,
-- always Asia/Bangkok) with their last-sent dates (see groups below).
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
  -- Bot left the group. The app sets left_at AND delete_after (now + 7 days)
  -- itself, as soon as LINE's leave call succeeds, without waiting for the
  -- leave event (decided 2026-11-11). That covers "Stop using" and the
  -- "no new Owner in 7 days" case. When LINE removes the bot instead, the
  -- leave event sets them. A leave event that arrives later must not move
  -- them (write only where left_at is null). A re-invite clears both (#11).
  left_at            timestamptz,
  -- left_at + 7 days; the daily job purges rows past it (#11).
  delete_after       timestamptz,
  -- Owner (admin) of this group. Two states:
  --   nominated: nominated_owner_line_user_id set, owner_confirmed_at null.
  --              The person has no admin rights yet.
  --   confirmed: owner_confirmed_at set (the nominee confirmed with LINE login).
  --              The nominee is now this group's admin.
  -- Changing the nominee clears owner_confirmed_at (trigger below).
  -- Owner-backed features (file saving, Summaries) run only while
  -- owner_confirmed_at is set; the app checks it before each of them.
  nominated_owner_line_user_id    text references public.line_users (line_user_id),
  owner_nominated_by_line_user_id text references public.line_users (line_user_id),
  owner_nominated_at              timestamptz,
  owner_confirmed_at              timestamptz,
  -- When the Owner left this group (LINE memberLeft for the confirmed Owner).
  -- Setting it clears owner_confirmed_at (trigger below), so the features above
  -- pause. The nominee column keeps the old Owner until a new one is named.
  -- A new nominee does not stop the clock: only a confirmed Owner does, and
  -- confirming clears owner_left_at (trigger below). Rule for the daily tick:
  -- a group with owner_left_at older than 7 days, owner_confirmed_at null and
  -- left_at null is one the bot leaves by itself; the app then sets left_at and
  -- delete_after as described above. If the bot is re-invited, the app clears
  -- left_at and delete_after and, if there is still no confirmed Owner, resets
  -- owner_left_at to the re-invite time so the group gets a fresh 7 days.
  owner_left_at                   timestamptz,
  -- Sub groups only. Set when the Project's main group got a confirmed new Owner
  -- and the take-over question for this Sub group is still unanswered
  -- (change_project_owner sets it, answer_subgroup_takeover clears it). While it
  -- is set the Sub group waits paused: owner_confirmed_at is null, so Owner-backed
  -- features stop, and it may still name its old Owner (check_same_owner). 7 days
  -- after it, the daily tick detaches the Sub group (project_id = null, this
  -- column cleared in the same update); it then needs its own setup and Owner.
  takeover_asked_at               timestamptz,
  -- Setup form, "what the group works on": free text the AI reads as context.
  -- Null until given; editable later in Settings.
  work_description                text
                                    check (work_description is null or char_length(work_description) <= 2000),
  -- Setup form, "features to use". Each is on unless the group turns it off
  -- (editable in Settings). The app checks the toggle before running the
  -- feature; the Owner checks above apply on top of it.
  feature_summarize               boolean not null default true,   -- Summary on request
  feature_draft_tasks             boolean not null default true,   -- Task candidates from a Summary
  feature_save_files              boolean not null default true,   -- save files to Drive
  feature_track_remind            boolean not null default true,   -- progress tracking, reminders, gap flags
  feature_weekly_summary          boolean not null default true,   -- weekly insight post
  -- Times chosen in the setup form (defaults prefilled), editable in Settings.
  -- Local Asia/Bangkok wall-clock time (UTC+7, no daylight saving), so no time
  -- zone column. The tick runs every 15 minutes, so times sit on a quarter hour.
  daily_reminder_time             time not null default '09:00',
  weekly_summary_weekday          smallint not null default 1,     -- ISO: 1 = Monday ... 7 = Sunday
  weekly_summary_time             time not null default '09:00',
  -- Once-only guards for the tick: the Bangkok calendar date a daily reminder
  -- or weekly summary was last sent for this group. A group is due when its
  -- time has passed today (Bangkok) and the date here is null or before today.
  -- The tick claims the slot BEFORE sending, in one statement, so two ticks
  -- that overlap cannot both send:
  --   update public.groups set daily_reminder_last_sent_on = <today BKK>
  --    where id = $1 and (daily_reminder_last_sent_on is null
  --                       or daily_reminder_last_sent_on < <today BKK>)
  --    returning id;
  -- (same for weekly_summary_last_sent_on). Send only if a row came back. A
  -- changed time later the same day does not send again. weekly_insights has
  -- its own unique (group_id, week_start) as a second guard for the weekly post.
  daily_reminder_last_sent_on     date,
  weekly_summary_last_sent_on     date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint groups_main_needs_project check (not is_main or project_id is not null),
  constraint groups_delete_after_needs_leave check (delete_after is null or left_at is not null),
  constraint groups_confirmed_needs_nominee
    check (owner_confirmed_at is null or nominated_owner_line_user_id is not null),
  -- A group with a confirmed Owner has no "Owner left" mark.
  constraint groups_owner_left_not_confirmed
    check (owner_left_at is null or owner_confirmed_at is null),
  -- A pending take-over question exists only for an attached Sub group, and
  -- a pending group has no confirmed Owner. A detach must clear the column.
  constraint groups_takeover_pending_rules
    check (takeover_asked_at is null
           or (project_id is not null and not is_main and owner_confirmed_at is null)),
  constraint groups_weekly_weekday_range check (weekly_summary_weekday between 1 and 7),
  -- On the quarter hour, no seconds: the 15-minute tick can hit it exactly.
  constraint groups_daily_time_quarter_hour
    check (extract(minute from daily_reminder_time)::int % 15 = 0
           and extract(second from daily_reminder_time) = 0),
  constraint groups_weekly_time_quarter_hour
    check (extract(minute from weekly_summary_time)::int % 15 = 0
           and extract(second from weekly_summary_time) = 0)
);

-- "Groups this user admins" (the group picker, the Fair-use cap): confirmed
-- Owners only, one index lookup. The app also filters left_at is null.
create index groups_admin_idx on public.groups (nominated_owner_line_user_id)
  where owner_confirmed_at is not null;

-- Owner bookkeeping (BEFORE trigger, runs for every insert/update):
--   * A new nominee resets the confirmation.
--   * Setting owner_left_at (the Owner left) clears owner_confirmed_at.
--   * Confirming an Owner clears owner_left_at.
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
  if new.owner_left_at is not null
     and (tg_op = 'INSERT' or old.owner_left_at is null) then
    new.owner_confirmed_at := null;
  elsif new.owner_confirmed_at is not null then
    new.owner_left_at := null;
  end if;
  return new;
end;
$$;

create trigger groups_owner_rules before insert or update on public.groups
  for each row execute function public.groups_owner_rules();

-- Same-admin grouping rule: every group attached to a Project names the
-- Project's owner (projects.owner_line_user_id) as its Owner. Two exceptions
-- while an Owner change is pending (see change_project_owner below): the
-- Project's main group may name a different, still unconfirmed nominee, and a
-- Sub group with an unanswered take-over question (takeover_asked_at) may still
-- name its old Owner.
-- This is a DEFERRABLE constraint trigger on both tables, checked at COMMIT:
-- it re-checks a group when its Project, nominee or confirmation changes, and
-- all of a Project's groups when projects.owner_line_user_id changes. So one
-- transaction can change the Project's owner and its groups together.
create function public.check_same_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  bad_group_id uuid;
begin
  if tg_table_name = 'projects' then
    select g.id into bad_group_id
      from public.groups g
     where g.project_id = new.id
       and g.nominated_owner_line_user_id is distinct from new.owner_line_user_id
       and not (g.is_main and g.owner_confirmed_at is null)
       and g.takeover_asked_at is null
     limit 1;
  else
    select g.id into bad_group_id
      from public.groups g
      join public.projects p on p.id = g.project_id
     where g.id = new.id
       and g.nominated_owner_line_user_id is distinct from p.owner_line_user_id
       and not (g.is_main and g.owner_confirmed_at is null)
       and g.takeover_asked_at is null
     limit 1;
  end if;
  if bad_group_id is not null then
    raise exception 'group Owner must be the Project owner'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger groups_same_owner
  after insert or update of project_id, is_main, nominated_owner_line_user_id, owner_confirmed_at,
                            takeover_asked_at
  on public.groups
  deferrable initially deferred
  for each row execute function public.check_same_owner();

create constraint trigger projects_same_owner
  after update of owner_line_user_id on public.projects
  deferrable initially deferred
  for each row execute function public.check_same_owner();

-- Exactly one main group per Project.
create unique index groups_one_main_per_project on public.groups (project_id) where is_main;
create index groups_project_idx on public.groups (project_id);
create index groups_delete_after_idx on public.groups (delete_after) where delete_after is not null;
-- Daily tick: Sub groups whose take-over question has waited 7 days
-- (takeover_asked_at < now() - interval '7 days'); see the scheduler migration.
create index groups_takeover_expiry_idx on public.groups (takeover_asked_at)
  where takeover_asked_at is not null;
-- Daily tick: groups whose Owner left and nobody confirmed since (the bot
-- leaves them once owner_left_at is more than 7 days old).
create index groups_owner_left_idx on public.groups (owner_left_at)
  where owner_left_at is not null and owner_confirmed_at is null and left_at is null;

-- Tick: groups that may be due for the daily reminder or the weekly summary.
-- Live groups (bot still in) with the feature on; the tick then compares the
-- time and last_sent_on with the current Bangkok time. Reminders keep working
-- without a confirmed Owner, so the Owner is not part of the filter.
create index groups_daily_due_idx on public.groups (daily_reminder_time, daily_reminder_last_sent_on)
  where left_at is null and feature_track_remind;
create index groups_weekly_due_idx
  on public.groups (weekly_summary_weekday, weekly_summary_time, weekly_summary_last_sent_on)
  where left_at is null and feature_weekly_summary;

create trigger groups_updated_at before update on public.groups
  for each row execute function public.set_updated_at();

-- Owner change of a whole Project (decided 2026-11-11), in two separate steps.
-- The new Owner is first named as the main group's nominee (app code, which sets
-- groups.nominated_owner_line_user_id on the main group).
--
-- Step 1, change_project_owner: when that person confirms with LINE login, the
-- app calls it once. In one transaction it
--   * makes projects.owner_line_user_id the new Owner and clears the Project's
--     folder ID;
--   * confirms the main group (owner_confirmed_at = now(), folder ID cleared);
--   * marks the active Drive connection 'replaced' (the old Owner's Drive keeps
--     the saved files; files.drive_connection_id says which), until the new
--     Owner connects their own Drive;
--   * starts the take-over question for every attached Sub group: takeover_asked_at
--     = now() and owner_confirmed_at = null. Those Sub groups wait paused, still
--     naming their old Owner.
-- Step 2, answer_subgroup_takeover: when the new Owner answers, the app calls it
-- with the Sub groups they agree to take over (see below). It may come in the
-- same request as step 1 or days later.
-- The same-admin rule is re-checked at COMMIT (check_same_owner).
--
-- No answer within 7 days (decided 2026-11-11): the daily tick detaches the
-- Sub groups still waiting, in one statement the route runs:
--   update public.groups
--      set project_id = null, takeover_asked_at = null
--    where takeover_asked_at < now() - interval '7 days';
-- (groups_takeover_expiry_idx finds them). A detached Sub group keeps its old
-- Owner nomination (unconfirmed) and Drive folder, and needs its own setup and
-- Owner. Until then the Project keeps working with the new Owner and the main
-- group.
create function public.change_project_owner(
  p_project_id  uuid,
  p_new_owner   text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  main_group_id uuid;
begin
  select g.id into main_group_id
    from public.groups g
   where g.project_id = p_project_id
     and g.is_main
     and g.nominated_owner_line_user_id = p_new_owner
   for update;
  if main_group_id is null then
    raise exception 'main group of the Project must name % as its nominee', p_new_owner
      using errcode = 'check_violation';
  end if;

  update public.projects
     set owner_line_user_id = p_new_owner,
         drive_project_folder_id = null
   where id = p_project_id;

  update public.groups
     set owner_confirmed_at = now(),
         drive_folder_id = null
   where id = main_group_id;

  -- Sub groups wait paused; the question restarts if an Owner change repeats.
  update public.groups
     set takeover_asked_at = now(),
         owner_confirmed_at = null
   where project_id = p_project_id
     and not is_main;

  update public.drive_connections
     set status = 'replaced', status_changed_at = now()
   where project_id = p_project_id and status = 'active';
end;
$$;

revoke all on function public.change_project_owner(uuid, text)
  from public, anon, authenticated;

-- Step 2: the new Owner answers the take-over question. p_takeover_group_ids are
-- the waiting Sub groups they take over; every other waiting Sub group of the
-- Project detaches. Taken-over Sub groups name the new Owner, are confirmed,
-- and clear their folder ID (old files stay in the old Owner's Drive). A Sub
-- group that already expired and detached is no longer waiting, so naming it
-- raises an error; the call with no ids detaches every waiting Sub group.
create function public.answer_subgroup_takeover(
  p_project_id          uuid,
  p_takeover_group_ids  uuid[] default '{}'
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  new_owner text;
  takeover  uuid[] := coalesce(p_takeover_group_ids, '{}');
begin
  select p.owner_line_user_id into new_owner
    from public.projects p
   where p.id = p_project_id
   for update;
  if new_owner is null then
    raise exception 'unknown Project %', p_project_id
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from unnest(takeover) as t(id)
     where not exists (
       select 1 from public.groups g
        where g.id = t.id
          and g.project_id = p_project_id
          and g.takeover_asked_at is not null)
  ) then
    raise exception 'takeover groups must be Sub groups of the Project waiting for the answer'
      using errcode = 'check_violation';
  end if;

  -- Detach first (project_id and takeover_asked_at together, see
  -- groups_takeover_pending_rules).
  update public.groups
     set project_id = null,
         takeover_asked_at = null
   where project_id = p_project_id
     and takeover_asked_at is not null
     and id <> all (takeover);

  -- Nominate first: the BEFORE trigger clears the confirmation whenever the
  -- nominee changes, so the confirmation is a second statement.
  update public.groups
     set nominated_owner_line_user_id = new_owner,
         owner_nominated_by_line_user_id = new_owner,
         owner_nominated_at = now(),
         takeover_asked_at = null
   where id = any (takeover);

  update public.groups
     set owner_confirmed_at = now(),
         drive_folder_id = null
   where id = any (takeover);
end;
$$;

revoke all on function public.answer_subgroup_takeover(uuid, uuid[])
  from public, anon, authenticated;

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
  -- 'member_join': the person joined the group after the bot (LINE memberJoined).
  source         text not null default 'message'
                   check (source in ('message', 'liff', 'setup_form', 'member_join')),
  -- Null while the person is in the group. Set on LINE memberLeft; the row is
  -- kept so names stay on Done Tasks. A left Member has no Dashboard access.
  -- A rejoin (memberJoined) clears it. Live Members: left_at is null.
  left_at        timestamptz,
  first_seen_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (group_id, line_user_id)
);

create index group_members_user_idx on public.group_members (line_user_id);
create index group_members_active_idx on public.group_members (group_id) where left_at is null;

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
-- the connected account can change (#3), so old rows stay as 'replaced' and
-- are history: files.drive_connection_id records which one holds each file.
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
  sent_at               timestamptz not null,
  -- Photos sent together (decided 2026-11-11): LINE sends one webhook per photo,
  -- in any order, all sharing message.imageSet.id. index and total come from the
  -- same object; total is missing for LINE 11.15 or earlier on Android. All three
  -- are null for a photo sent alone and for every non-image message.
  image_set_id          text,
  image_set_index       integer,
  image_set_total       integer,
  constraint messages_image_set_parts_need_id
    check (image_set_id is not null
           or (image_set_index is null and image_set_total is null)),
  constraint messages_image_set_index_nonneg check (image_set_index is null or image_set_index >= 0),
  constraint messages_image_set_total_nonneg check (image_set_total is null or image_set_total >= 0)
);

create index messages_group_sent_idx on public.messages (group_id, sent_at desc);
-- The photos of one set in one group (batch card, "saved N photos").
create index messages_image_set_idx on public.messages (group_id, image_set_id)
  where image_set_id is not null;

-- One row per photo batch whose "saved N photos" card was claimed. The webhooks
-- of one batch run at the same time and in any order, so "was the card already
-- sent?" must be decided by the database, not by reading messages. The app
-- claims the batch with
--   insert into public.image_set_cards (group_id, image_set_id) values (...)
--   on conflict do nothing returning image_set_id;
-- and posts the card only when a row came back. Reply or push (reply within
-- about 50 seconds of the file save, else push) is app logic; pushes are
-- counted in push_log as before. Cascades with the group (#11).
create table public.image_set_cards (
  group_id      uuid not null references public.groups (id) on delete cascade,
  image_set_id  text not null,
  claimed_at    timestamptz not null default now(),
  primary key (group_id, image_set_id)
);

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

-- Cards the bot posts in a group, and the answers to them. Status changes
-- only when a person answers. kind:
--   mark_done, reminder, gap_flag  Task questions (#7, #8).
--   assign        unowned Task card with Assign and I'll take it.
--   member_left   card listing a leaver's Tasks that went back to Not
--                 Assigned (the Tasks are in task_prompt_tasks).
--   owner_needed  card asking someone to become the group's Owner.
-- task_id is null for member_left and owner_needed, which are about a group,
-- not one Task; group_id is always set. subject_line_user_id is the person the
-- card is about (the leaver; the old Owner).
create table public.task_prompts (
  id                       uuid primary key default gen_random_uuid(),
  group_id                 uuid not null references public.groups (id) on delete cascade,
  task_id                  uuid references public.tasks (id) on delete cascade,
  kind                     text not null check (kind in (
                             'mark_done', 'reminder', 'gap_flag',
                             'assign', 'member_left', 'owner_needed')),
  subject_line_user_id     text references public.line_users (line_user_id),
  trigger_message_id       uuid references public.messages (id) on delete set null,
  asked_at                 timestamptz not null default now(),
  answer                   text check (answer in (
                             'yes', 'no', 'done', 'need_time',
                             'assigned', 'taken', 'not_a_task', 'owner_confirmed')),
  -- Nullable: a group postback may not carry the user ID.
  answered_by_line_user_id text references public.line_users (line_user_id),
  answered_at              timestamptz,
  constraint task_prompts_task_kinds_need_task
    check (kind in ('member_left', 'owner_needed') or task_id is not null),
  -- A member_left card is about one leaver; the open-card unique index below
  -- needs the person.
  constraint task_prompts_member_left_needs_subject
    check (kind <> 'member_left' or subject_line_user_id is not null),
  -- Which answers each kind of card allows (null = still open). Inferred from
  -- the buttons in docs/PROJECT.md: reminders answer Done or Postpone
  -- (need_time); a progress question answers yes or no; an unowned Task card
  -- offers Assign, I'll take it and Not a task; a member_left card lists Tasks
  -- with Assign and I'll take it; owner_needed is answered by the new Owner's
  -- confirm.
  constraint task_prompts_answer_fits_kind
    check (answer is null or case kind
      when 'mark_done'    then answer in ('yes', 'no')
      when 'reminder'     then answer in ('done', 'need_time')
      when 'gap_flag'     then answer in ('done', 'need_time')
      when 'assign'       then answer in ('assigned', 'taken', 'not_a_task')
      when 'member_left'  then answer in ('assigned', 'taken')
      when 'owner_needed' then answer = 'owner_confirmed'
    end)
);

create index task_prompts_task_idx on public.task_prompts (task_id, asked_at desc);
create index task_prompts_open_idx on public.task_prompts (task_id) where answer is null;
create index task_prompts_group_open_idx on public.task_prompts (group_id, kind) where answer is null;
-- An open card has answer null. At most one open owner_needed card per group,
-- and at most one open member_left card per group and leaving person.
create unique index task_prompts_one_open_owner_needed
  on public.task_prompts (group_id)
  where kind = 'owner_needed' and answer is null;
create unique index task_prompts_one_open_member_left
  on public.task_prompts (group_id, subject_line_user_id)
  where kind = 'member_left' and answer is null;

-- Tasks listed on a member_left card. Needed because the Tasks no longer name
-- the leaver once they are back to Not Assigned.
create table public.task_prompt_tasks (
  prompt_id  uuid not null references public.task_prompts (id) on delete cascade,
  task_id    uuid not null references public.tasks (id) on delete cascade,
  primary key (prompt_id, task_id)
);

create index task_prompt_tasks_task_idx on public.task_prompt_tasks (task_id);

-- ---------------------------------------------------------------------------
-- Files (#4)
-- ---------------------------------------------------------------------------

create table public.files (
  id                   uuid primary key default gen_random_uuid(),
  group_id             uuid not null references public.groups (id) on delete cascade,
  message_id           uuid references public.messages (id) on delete set null,
  sender_line_user_id  text references public.line_users (line_user_id),
  -- The Drive connection the file was saved through, so every file records
  -- which Drive holds it even after the Project's connection is replaced.
  drive_connection_id  uuid not null references public.drive_connections (id),
  file_name            text not null,
  content_sha256       text not null,
  drive_file_id        text not null,
  drive_link           text not null,
  sent_at              timestamptz not null,
  saved_at             timestamptz not null default now(),
  -- LINE file events carry fileSize in bytes; shown on the "saved" card. Null
  -- for an image when LINE gave no size.
  size_bytes           bigint check (size_bytes >= 0),
  -- Duplicate (same hash) in the same group is saved once.
  constraint files_one_per_hash unique (group_id, content_sha256)
);

-- The Drive connection must belong to the file's Project: the connection's
-- project_id equals the project of the file's group, and the connection must be
-- active when the row is inserted (or when drive_connection_id is changed).
-- Later the connection may become 'replaced'; that is the history this column
-- exists for, so only inserts and connection changes are checked.
create function public.files_check_drive_connection()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  group_project_id uuid;
  conn_project_id  uuid;
  conn_status      text;
begin
  select g.project_id into group_project_id
    from public.groups g where g.id = new.group_id;
  select c.project_id, c.status into conn_project_id, conn_status
    from public.drive_connections c where c.id = new.drive_connection_id
   for share;
  if group_project_id is null or conn_project_id is distinct from group_project_id then
    raise exception 'file Drive connection must belong to the Project of the file''s group'
      using errcode = 'check_violation';
  end if;
  if (tg_op = 'INSERT' or new.drive_connection_id is distinct from old.drive_connection_id)
     and conn_status <> 'active' then
    raise exception 'file Drive connection must be active'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger files_check_drive_connection
  before insert or update of group_id, drive_connection_id on public.files
  for each row execute function public.files_check_drive_connection();

create index files_group_saved_idx on public.files (group_id, saved_at desc);
create index files_drive_connection_idx on public.files (drive_connection_id);

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
alter table public.image_set_cards   enable row level security;
alter table public.summaries         enable row level security;
alter table public.task_candidates   enable row level security;
alter table public.tasks             enable row level security;
alter table public.task_prompts      enable row level security;
alter table public.task_prompt_tasks enable row level security;
alter table public.files             enable row level security;
alter table public.ai_usage          enable row level security;
alter table public.push_log          enable row level security;
alter table public.weekly_insights   enable row level security;
