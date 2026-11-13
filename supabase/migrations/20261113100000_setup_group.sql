-- Setup form and Owner confirm (#52, part of #2), each in one transaction.
--
-- setup_group saves the setup form of a group that is not set up yet: what the
-- group works on, the feature toggles, the reminder and weekly summary times, the
-- nicknames and role of the listed live Members, and the nominated Owner. When the
-- sender names themselves, their LIFF login is the LINE login, so the same
-- transaction confirms them (confirm_group_owner below).
--
-- confirm_group_owner: the nominee confirms with LINE login. It creates the
-- Project with the nominee as owner and makes the group its main group.
--
-- Both lock the group row first (FOR UPDATE) and make every check under that
-- lock, so a concurrent confirm, re-nomination or second form cannot slip in
-- between a check and the write.
--
-- A group that already has a confirmed Owner, or that already belongs to a
-- Project (for example a main group whose Owner left), is 'closed': later edits
-- belong to Settings (#28), and an Owner change of a Project goes through
-- change_project_owner. Neither function touches left_at or delete_after (#11).
--
-- Trigger notes (initial schema):
--   * groups_owner_rules clears owner_confirmed_at whenever the nominee changes,
--     so the nominee is written first and the confirmation in a later statement
--     that does not change the nominee.
--   * check_same_owner is deferred to COMMIT: the main group then names the
--     Project's owner and is confirmed, so it passes.

create function public.confirm_group_owner(
  p_group_id      uuid,
  p_line_user_id  text,
  p_at            timestamptz
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_nominee    text;
  v_confirmed  timestamptz;
  v_project    uuid;
begin
  select g.nominated_owner_line_user_id, g.owner_confirmed_at, g.project_id
    into v_nominee, v_confirmed, v_project
    from public.groups g
   where g.id = p_group_id
   for update;
  if not found then
    raise exception 'unknown group %', p_group_id using errcode = 'no_data_found';
  end if;

  if v_nominee is distinct from p_line_user_id then
    return 'not_nominee';
  end if;
  -- Idempotent: a repeated confirm by the confirmed Owner changes nothing.
  if v_confirmed is not null then
    return 'already_confirmed';
  end if;
  if v_project is not null then
    return 'closed';
  end if;
  if not exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.line_user_id = p_line_user_id and m.left_at is null
  ) then
    return 'not_member';
  end if;

  insert into public.projects (owner_line_user_id)
  values (p_line_user_id)
  returning id into v_project;

  -- The nominee does not change here, so groups_owner_rules keeps the confirmation.
  update public.groups
     set project_id = v_project,
         is_main = true,
         owner_confirmed_at = p_at
   where id = p_group_id;
  return 'confirmed';
end;
$$;

revoke all on function public.confirm_group_owner(uuid, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.confirm_group_owner(uuid, text, timestamptz)
  to service_role;

-- p_members: [{"line_user_id": text, "nicknames": [text], "role": text|null}].
-- Only rows of live Members of this group are updated (nicknames and role only;
-- source, left_at and is_pm stay), so the form can never add a person to a group.
-- Outcomes: 'confirmed' (the sender named themselves), 'pending' (another Member
-- was named and must confirm), 'closed' (see above), 'owner_not_member' (the
-- named Owner is not a live Member of the group; nothing is saved).
create function public.setup_group(
  p_group_id                uuid,
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
  p_owner                   text,
  p_at                      timestamptz
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_confirmed  timestamptz;
  v_project    uuid;
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
     where m.group_id = p_group_id and m.line_user_id = p_owner and m.left_at is null
  ) then
    return 'owner_not_member';
  end if;

  -- Settings and the nominee. The table CHECKs guard the times and the weekday.
  update public.groups
     set work_description = p_work_description,
         feature_summarize = p_feature_summarize,
         feature_draft_tasks = p_feature_draft_tasks,
         feature_save_files = p_feature_save_files,
         feature_track_remind = p_feature_track_remind,
         feature_weekly_summary = p_feature_weekly_summary,
         daily_reminder_time = p_daily_reminder_time,
         weekly_summary_weekday = p_weekly_summary_weekday,
         weekly_summary_time = p_weekly_summary_time,
         nominated_owner_line_user_id = p_owner,
         owner_nominated_by_line_user_id = p_by,
         owner_nominated_at = p_at
   where id = p_group_id;

  update public.group_members m
     set nicknames = coalesce(x.nicknames, '{}'),
         role = x.role
    from jsonb_to_recordset(coalesce(p_members, '[]'::jsonb))
           as x(line_user_id text, nicknames text[], role text)
   where m.group_id = p_group_id
     and m.line_user_id = x.line_user_id
     and m.left_at is null;

  -- The sender named themselves: confirmed at once, in this transaction.
  if p_owner = p_by then
    return public.confirm_group_owner(p_group_id, p_owner, p_at);
  end if;
  return 'pending';
end;
$$;

revoke all on function public.setup_group(
  uuid, text, text, boolean, boolean, boolean, boolean, boolean, time, smallint, time, jsonb, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.setup_group(
  uuid, text, text, boolean, boolean, boolean, boolean, boolean, time, smallint, time, jsonb, text, timestamptz
) to service_role;
