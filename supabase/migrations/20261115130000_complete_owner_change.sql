-- #30 part A: a new Owner after the Owner left the main group, in one transaction.
--
-- Flow (decided 2026-11-11): when the confirmed Owner leaves, the app sets
-- groups.owner_left_at (groups_owner_rules then clears owner_confirmed_at, so file
-- saving and Summaries pause) and posts one owner_needed card. A live Member who
-- presses it, with their LIFF login as the LINE login, becomes the main group's
-- nominee (app code, a compare-and-set on groups.nominated_owner_line_user_id;
-- check_same_owner allows an unconfirmed nominee on a main group). The role takes
-- effect only once that person also has a usable Google sign-in (the Drive
-- connection). This function is that last step.
--
-- complete_owner_change locks the group row first (FOR UPDATE) and makes every
-- check under that lock, so the confirm page and the Google callback, which both
-- call it, cannot both run the change, and a run after the change changes
-- nothing. When every check passes it calls change_project_owner (initial schema),
-- which in the same transaction makes the person the Project's owner, confirms the
-- main group (groups_owner_rules then clears owner_left_at), clears the Project's
-- and the main group's Drive folder IDs, retires the active Drive connection
-- ('replaced', kept as history: old files stay in the old Owner's Drive) and starts
-- the Sub group take-over question (#31). Then it answers the open owner_needed
-- card with 'owner_confirmed'.
--
-- Outcomes:
--   'changed'        the change ran now.
--   'already_owner'  the person is already the group's confirmed Owner.
--   'not_pending'    no Owner change is pending here (no Owner left, a confirmed
--                    Owner, not a main group, or the bot left the group).
--   'not_nominee'    another person holds the nomination.
--   'not_member'     the person is not a live Member of the group.
--   'needs_drive'    the person's latest Google account (connected_at) is missing
--                    or not 'valid'; nothing changes until they sign in.
--
-- Neither function touches left_at or delete_after (#11). The 7-day rule (no new
-- Owner within 7 days of owner_left_at, the bot leaves) is #30 part B.

create function public.complete_owner_change(
  p_group_id      uuid,
  p_line_user_id  text,
  p_at            timestamptz
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_project    uuid;
  v_main       boolean;
  v_nominee    text;
  v_confirmed  timestamptz;
  v_owner_left timestamptz;
  v_left       timestamptz;
  v_token      text;
begin
  select g.project_id, g.is_main, g.nominated_owner_line_user_id, g.owner_confirmed_at,
         g.owner_left_at, g.left_at
    into v_project, v_main, v_nominee, v_confirmed, v_owner_left, v_left
    from public.groups g
   where g.id = p_group_id
   for update;
  if not found then
    raise exception 'unknown group %', p_group_id using errcode = 'no_data_found';
  end if;

  if v_confirmed is not null and v_nominee = p_line_user_id then
    return 'already_owner';
  end if;
  if v_project is null or not v_main or v_owner_left is null or v_confirmed is not null
     or v_left is not null then
    return 'not_pending';
  end if;
  if v_nominee is distinct from p_line_user_id then
    return 'not_nominee';
  end if;
  if not exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.line_user_id = p_line_user_id and m.left_at is null
  ) then
    return 'not_member';
  end if;

  -- The Drive connection: the person's latest Google sign-in must be usable.
  select a.token_status into v_token
    from public.google_accounts a
   where a.line_user_id = p_line_user_id
   order by a.connected_at desc
   limit 1;
  if v_token is distinct from 'valid' then
    return 'needs_drive';
  end if;

  perform public.change_project_owner(v_project, p_line_user_id);

  update public.task_prompts
     set answer = 'owner_confirmed',
         answered_by_line_user_id = p_line_user_id,
         answered_at = p_at
   where group_id = p_group_id
     and kind = 'owner_needed'
     and answer is null;
  return 'changed';
end;
$$;

revoke all on function public.complete_owner_change(uuid, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.complete_owner_change(uuid, text, timestamptz)
  to service_role;

-- change_project_owner (initial schema) was only revoked from public, anon and
-- authenticated. complete_owner_change runs as its caller, so the caller needs
-- EXECUTE on it as well; granted explicitly, as the later functions are.
grant execute on function public.change_project_owner(uuid, text)
  to service_role;
