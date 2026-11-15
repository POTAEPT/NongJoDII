-- Review follow-ups for #71, #72, #73 and #74 (written 2026-11-15, not applied yet).
-- The app code that ships with this file also runs against the schema before it: each
-- part below says what changes once it is applied.

-- ---------------------------------------------------------------------------
-- #11 (#73): groups.joined_at is the time of the latest join EVENT applied.
--
-- The initial schema filled it with now() at insert, so a row first stored by a message
-- or postback event carried its processing time, later than the events it came from. A
-- leave event stamped before that time was then ignored by markBotLeft (joined_at <= at),
-- and a late-processed join could keep a later leave from marking the group. From now on
-- a new row has no joined_at until its first join event sets it to that event's time
-- (markBotJoined: where joined_at is null or older); markBotLeft takes any leave while it
-- is null. Existing rows keep their value.
alter table public.groups
  alter column joined_at drop default,
  alter column joined_at drop not null;

-- ---------------------------------------------------------------------------
-- #31 (#72), decision D1 and finding #74-4: change_project_owner asks only the Sub groups
-- that still need the new Owner's answer.
--
-- The initial version put every Sub group of the Project back on the take-over question,
-- so a second Owner change paused Sub groups already taken over and restarted the 7 days.
-- Now a Sub group is asked (again) only when
--   * it still waits for an answer (takeover_asked_at set): asked again by the new Owner,
--     with a fresh 7 days; or
--   * it does not run on the new Owner yet (another nominee, or not confirmed).
-- A Sub group already confirmed on the new Owner keeps its Owner, its folder and runs on.
--
-- A Sub group that names a different Owner cannot keep running: check_same_owner (initial
-- schema, at COMMIT) requires every attached group to name the Project's owner unless it
-- waits on the question. So after a change from B to C, Sub groups B took over are asked
-- by C; keeping them on B would need a change to the same-admin rule, which this migration
-- does not make.
--
-- An asked Sub group's drive_folder_id is cleared: it points into the old Owner's Drive.
-- answer_subgroup_takeover (below) and the 7-day detach (app code,
-- SupabaseStore.detachExpiredTakeovers) clear it on detach too.
create or replace function public.change_project_owner(
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

  -- D1: only Sub groups still waiting, or not running on the new Owner yet.
  update public.groups
     set takeover_asked_at = now(),
         owner_confirmed_at = null,
         drive_folder_id = null
   where project_id = p_project_id
     and not is_main
     and (takeover_asked_at is not null
          or nominated_owner_line_user_id is distinct from p_new_owner
          or owner_confirmed_at is null);

  update public.drive_connections
     set status = 'replaced', status_changed_at = now()
   where project_id = p_project_id and status = 'active';
end;
$$;

-- ---------------------------------------------------------------------------
-- #31 (#72): no take-over answer after the 7 days, and detached Sub groups lose the old
-- Owner's folder ID.
--
-- The 7-day rule detaches Sub groups whose question is older than 7 days, but only on the
-- next tick. An answer that arrived in between still went through. Now, after the locks
-- (20261112143751), a waiting Sub group of the Project asked more than 7 days ago makes
-- the call raise SQLSTATE NJ409 with nothing written; the app answers 409 expired, and the
-- tick detaches the groups as usual. Same cutoff as the detach (takeover_asked_at <
-- now() - 7 days). Everything else is the 20261112143751 version.
create or replace function public.answer_subgroup_takeover(
  p_project_id          uuid,
  p_takeover_group_ids  uuid[] default '{}'
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  new_owner  text;
  takeover   uuid[];
  confirmed  integer;
begin
  select coalesce(array_agg(distinct t.id), '{}') into takeover
    from unnest(coalesce(p_takeover_group_ids, '{}'::uuid[])) as t(id)
   where t.id is not null;

  select p.owner_line_user_id into new_owner
    from public.projects p
   where p.id = p_project_id
   for update;
  if new_owner is null then
    raise exception 'unknown Project %', p_project_id
      using errcode = 'check_violation';
  end if;

  -- Lock first, then check: the checks below read the locked, current rows.
  perform 1
     from public.groups g
    where g.id = any (takeover)
       or (g.project_id = p_project_id and g.takeover_asked_at is not null)
    order by g.id
      for update;

  if exists (
    select 1 from public.groups g
     where g.project_id = p_project_id
       and g.takeover_asked_at is not null
       and g.takeover_asked_at < now() - interval '7 days'
  ) then
    raise exception 'the take-over question of Project % expired', p_project_id
      using errcode = 'NJ409';
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
  -- groups_takeover_pending_rules). The folder ID pointed into the old Owner's Drive.
  update public.groups
     set project_id = null,
         takeover_asked_at = null,
         drive_folder_id = null
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
   where id = any (takeover)
     and project_id = p_project_id
     and takeover_asked_at is not null;

  update public.groups
     set owner_confirmed_at = now(),
         drive_folder_id = null
   where id = any (takeover)
     and project_id = p_project_id
     and nominated_owner_line_user_id = new_owner;
  get diagnostics confirmed = row_count;
  if confirmed <> cardinality(takeover) then
    raise exception 'takeover groups changed while the answer was saved'
      using errcode = 'serialization_failure';
  end if;
end;
$$;

-- create or replace keeps each function's grants: change_project_owner and
-- answer_subgroup_takeover stay revoked from public, anon and authenticated.
