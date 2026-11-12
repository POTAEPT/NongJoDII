-- Fix a race in answer_subgroup_takeover (initial schema, already applied).
--
-- The first version checked that the chosen Sub groups were still waiting for
-- the take-over answer without locking them, then updated them by ID only. If
-- the daily tick detached an expired Sub group between that check and the
-- updates, the call still confirmed the new Owner on a group that had left the
-- Project (project_id null) and returned without an error.
--
-- This version locks every row it will touch (the chosen ids and the Project's
-- waiting Sub groups), in id order, before the check, and holds the locks to
-- the end of the transaction. The tick's detach is one UPDATE on the same rows,
-- so the two now run one after the other:
--   * tick first: the lock waits for it, the row no longer belongs to the
--     Project, and the check raises an error;
--   * answer first: the tick's UPDATE waits, re-reads the row, finds
--     takeover_asked_at cleared and skips it.
-- The updates also repeat the Project and waiting-state conditions, and the
-- confirmation step raises if it did not reach every chosen group.
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

  -- Lock first, then check: the check below reads the locked, current rows.
  perform 1
     from public.groups g
    where g.id = any (takeover)
       or (g.project_id = p_project_id and g.takeover_asked_at is not null)
    order by g.id
      for update;

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

revoke all on function public.answer_subgroup_takeover(uuid, uuid[])
  from public, anon, authenticated;
