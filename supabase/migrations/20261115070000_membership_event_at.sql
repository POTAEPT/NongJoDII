-- #29: membership events in timestamp order.
--
-- LINE does not promise the order of memberLeft and memberJoined events, and a leave we
-- answered with 500 comes back later as a redelivery. Before this, a join cleared left_at
-- only when left_at was older than the join, and a leave set left_at only on a live row.
-- So with leave T1, rejoin T2 and leave T3 arriving as T1, T3, T2, the late T2 join undid
-- the T3 leave; and a leave first delivered after a newer rejoin removed a current Member.
--
-- Now each leave and join records its event time here, and the app applies an event only
-- when it is newer than the one recorded. A row from before this column (null) falls back
-- to left_at, which is the time of the last leave applied to it.
alter table public.group_members
  add column membership_event_at timestamptz;

comment on column public.group_members.membership_event_at is
  'Timestamp of the latest memberLeft or memberJoined event applied to this row; null when none has been.';

-- Releases a person's open Tasks in a group only while they are not a live Member, as one
-- step: the membership row is locked first, so a newer join cannot land between the check
-- and the release (markMemberJoined's UPDATE waits for this lock). Used after a leave and
-- after any write that assigns a Task to someone read as live a moment before. A person
-- with no row is not live either. Done and deleted Tasks keep their assignee.
-- last_activity_at is left alone: a person leaving is not progress on the Task.
create function public.release_tasks_if_left(p_group_id uuid, p_line_user_id text)
returns setof public.tasks
language plpgsql
set search_path = ''
as $$
declare
  v_left_at timestamptz;
begin
  select m.left_at into v_left_at
    from public.group_members m
   where m.group_id = p_group_id and m.line_user_id = p_line_user_id
   for update;
  if found and v_left_at is null then
    return;
  end if;
  return query
    update public.tasks t
       set assignee_line_user_id = null, status = 'not_assigned'
     where t.group_id = p_group_id
       and t.assignee_line_user_id = p_line_user_id
       and t.deleted_at is null
       and t.status <> 'done'
    returning t.*;
end;
$$;

revoke all on function public.release_tasks_if_left(uuid, text)
  from public, anon, authenticated;

grant execute on function public.release_tasks_if_left(uuid, text)
  to service_role;
