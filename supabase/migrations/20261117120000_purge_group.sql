-- #77: the purge of a main group leaves no Project behind with Sub groups pointing at it.
--
-- Before this, purgeGroup deleted only the groups row (a DELETE with the due check in its
-- WHERE). The group's own rows cascade, but when the group was a Project's main group:
--   * its Sub groups kept project_id pointing at a Project with no main group;
--   * the projects row stayed (groups.project_id is ON DELETE RESTRICT the other way round),
--     and with it the drive_connections history.
--
-- purge_group does the purge in one transaction:
--   1. Locks the group row; it is due only when delete_after <= p_now (a re-invite since the
--      list cleared delete_after, so the group stays). Not due: purged false, nothing else.
--   2. When it is a main group, every other group of its Project detaches, with the same
--      columns as the #31 take-over expiry (detachExpiredTakeovers) and #30 part B: no
--      Project, no take-over question, no Drive folder ID (it pointed into the Project's
--      Drive), and a fresh 7-day Owner count with no nominee, so any live Member can claim the
--      role and the bot leaves after 7 days without one. Sub groups the bot already left
--      detach too and are purged on their own date.
--   3. Deletes the group row (its messages, Tasks, files rows and the rest cascade).
--   4. Deletes the projects row once no group points at it AND no saved file record points at
--      one of its drive_connections rows. The rule "no code deletes a connection row that a
--      file record points to" wins: while a detached Sub group still holds files saved
--      through the Project's Drive, the Project row stays as that history, with no groups.
-- Drive is never called: files stay in the Owner's Drive (#11).
--
-- Answer: {"purged": bool, "project_deleted": bool,
--          "detached": [{"id", "line_group_id", "name", "bot_in"}]}; the app posts the
-- owner_needed card in each detached group the bot is still in.

create function public.purge_group(p_group_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_project   uuid;
  v_main      boolean;
  v_detached  jsonb := '[]'::jsonb;
  v_deleted   boolean := false;
begin
  select g.project_id, g.is_main
    into v_project, v_main
    from public.groups g
   where g.id = p_group_id
     and g.delete_after is not null
     and g.delete_after <= p_now
   for update;
  if not found then
    return jsonb_build_object('purged', false, 'project_deleted', false, 'detached', '[]'::jsonb);
  end if;

  if v_main and v_project is not null then
    with moved as (
      update public.groups s
         set project_id = null,
             takeover_asked_at = null,
             drive_folder_id = null,
             owner_left_at = p_now,
             nominated_owner_line_user_id = null,
             owner_nominated_by_line_user_id = null,
             owner_nominated_at = null
       where s.project_id = v_project
         and s.id <> p_group_id
      returning s.id, s.line_group_id, s.name, s.left_at
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id, 'line_group_id', m.line_group_id, 'name', m.name, 'bot_in', m.left_at is null)
             order by m.id), '[]'::jsonb)
      into v_detached
      from moved m;
  end if;

  delete from public.groups where id = p_group_id;

  if v_project is not null
     and not exists (select 1 from public.groups g where g.project_id = v_project)
     and not exists (
       select 1 from public.files f
         join public.drive_connections c on c.id = f.drive_connection_id
        where c.project_id = v_project
     ) then
    delete from public.projects where id = v_project;
    v_deleted := true;
  end if;

  return jsonb_build_object('purged', true, 'project_deleted', v_deleted, 'detached', v_detached);
end;
$$;

revoke all on function public.purge_group(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.purge_group(uuid, timestamptz) to service_role;
