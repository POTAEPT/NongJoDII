-- #146: the setup form can attach a new group to a Project the sender already owns, as a
-- Sub group, instead of always making a new Project.
--
-- setup_sub_group saves the same form values as setup_group (20261113085415) and, in the
-- same transaction, attaches the group: project_id = the Project, is_main = false, the
-- sender as nominee and confirmed Owner. The sender is the Project's owner, so their LIFF
-- login is the LINE login and no separate confirm is needed (the same reason setup_group
-- confirms a sender who names themselves).
--
-- Checks, all under the group row lock (FOR UPDATE), each answering an outcome:
--   'closed'            the group already has a confirmed Owner or a Project (as setup_group)
--   'not_member'        the sender is not a live Member of the group
--   'not_project_owner' the Project is unknown, is not owned by the sender, or its main
--                       group is not confirmed by the sender or has no bot in it any more
--   'attached'          saved and attached
-- The Project row is locked too (FOR SHARE), so an Owner change of the Project
-- (change_project_owner) cannot run between the check and the attach.
--
-- Trigger notes (initial schema):
--   * groups_owner_rules clears owner_confirmed_at whenever the nominee changes, so the
--     nominee is written in the first update and the confirmation in the second.
--   * check_same_owner (deferred to COMMIT) holds: the Sub group names the Project's owner
--     and is confirmed.
-- Drive: the app lays out the Sub group's folder after the response (ensureGroupFolder).

create function public.setup_sub_group(
  p_group_id                uuid,
  p_project_id              uuid,
  p_by                      text,
  p_work_description        text,
  p_feature_summarize       boolean,
  p_feature_draft_tasks     boolean,
  p_feature_save_files      boolean,
  p_feature_track_remind    boolean,
  p_feature_weekly_summary  boolean,
  p_daily_reminder_time     time,
  p_weekly_summary_weekday  smallint,
  p_weekly_summary_time     time,
  p_members                 jsonb,
  p_at                      timestamptz
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_confirmed  timestamptz;
  v_project    uuid;
  v_owner      text;
begin
  select g.owner_confirmed_at, g.project_id
    into v_confirmed, v_project
    from public.groups g
   where g.id = p_group_id
   for update;
  if not found then
    raise exception 'unknown group %', p_group_id using errcode = 'no_data_found';
  end if;
  if v_confirmed is not null or v_project is not null then
    return 'closed';
  end if;
  if not exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.line_user_id = p_by and m.left_at is null
  ) then
    return 'not_member';
  end if;

  select p.owner_line_user_id into v_owner
    from public.projects p
   where p.id = p_project_id
   for share;
  if not found or v_owner is distinct from p_by then
    return 'not_project_owner';
  end if;
  if not exists (
    select 1 from public.groups mg
     where mg.project_id = p_project_id and mg.is_main
       and mg.nominated_owner_line_user_id = p_by and mg.owner_confirmed_at is not null
       and mg.left_at is null
  ) then
    return 'not_project_owner';
  end if;

  -- The form's values and the sender as nominee, as setup_group writes them.
  update public.groups g
     set work_description = p_work_description,
         feature_summarize = p_feature_summarize,
         feature_draft_tasks = p_feature_draft_tasks,
         feature_save_files = p_feature_save_files,
         feature_track_remind = p_feature_track_remind,
         feature_weekly_summary = p_feature_weekly_summary,
         daily_reminder_time = p_daily_reminder_time,
         weekly_summary_weekday = p_weekly_summary_weekday,
         weekly_summary_time = p_weekly_summary_time,
         nominated_owner_line_user_id = p_by,
         owner_nominated_by_line_user_id =
           case when g.nominated_owner_line_user_id is distinct from p_by
                then p_by else g.owner_nominated_by_line_user_id end,
         owner_nominated_at =
           case when g.nominated_owner_line_user_id is distinct from p_by
                then p_at else g.owner_nominated_at end
   where g.id = p_group_id;
  update public.group_members m
     set nicknames = coalesce(x.nicknames, '{}'),
         role = x.role
    from jsonb_to_recordset(coalesce(p_members, '[]'::jsonb))
           as x(line_user_id text, nicknames text[], role text)
   where m.group_id = p_group_id
     and m.line_user_id = x.line_user_id
     and m.left_at is null;

  -- The attach. The nominee does not change here, so groups_owner_rules keeps the confirmation.
  update public.groups
     set project_id = p_project_id,
         is_main = false,
         owner_confirmed_at = p_at
   where id = p_group_id;
  return 'attached';
end;
$$;

revoke all on function public.setup_sub_group(
  uuid, uuid, text, text, boolean, boolean, boolean, boolean, boolean, time, smallint, time, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.setup_sub_group(
  uuid, uuid, text, text, boolean, boolean, boolean, boolean, boolean, time, smallint, time, jsonb, timestamptz
) to service_role;
