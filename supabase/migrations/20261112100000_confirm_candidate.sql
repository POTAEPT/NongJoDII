-- Confirm a Task candidate and create its Task in one transaction (#16).
--
-- Two Members can confirm and decline the same candidate at once. The candidate
-- row is locked first (FOR UPDATE), so the first decision wins:
--   * declined first: the confirm sees 'declined', creates no Task and answers
--     'already_decided' with no task id;
--   * confirm first: a racing decline (update ... where state = 'proposed')
--     waits for the lock, then matches no row and answers 'already_decided'.
-- A retry heals and never duplicates: tasks.candidate_id is unique, so an
-- existing Task is returned instead of a second one (created false), and a
-- candidate still 'proposed' next to such a Task is marked confirmed.
-- The creator (the confirming Member) is recorded as the decider too.
create function public.confirm_candidate(
  p_candidate_id  uuid,
  p_group_id      uuid,
  p_title         text,
  p_details       text,
  p_status        public.task_status,
  p_assignee      text,
  p_created_by    text,
  p_due_at        timestamptz,
  p_decided_at    timestamptz
)
returns table (outcome text, task_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_state    text;
  v_task_id  uuid;
  v_created  boolean := false;
begin
  select c.state into v_state
    from public.task_candidates c
   where c.id = p_candidate_id
   for update;
  if not found then
    raise exception 'unknown candidate %', p_candidate_id
      using errcode = 'no_data_found';
  end if;

  if v_state = 'declined' then
    return query select 'already_decided'::text, null::uuid;
    return;
  end if;

  insert into public.tasks (
    group_id, candidate_id, title, details, status,
    assignee_line_user_id, created_by_line_user_id, due_at
  ) values (
    p_group_id, p_candidate_id, p_title, p_details, p_status,
    p_assignee, p_created_by, p_due_at
  )
  on conflict (candidate_id) do nothing
  returning id into v_task_id;

  if v_task_id is null then
    select t.id into v_task_id
      from public.tasks t
     where t.candidate_id = p_candidate_id;
  else
    v_created := true;
  end if;

  if v_state = 'proposed' then
    update public.task_candidates
       set state = 'confirmed',
           decided_by_line_user_id = p_created_by,
           decided_at = p_decided_at
     where id = p_candidate_id;
  end if;

  return query
    select case when v_created then 'created' else 'already_decided' end, v_task_id;
end;
$$;

revoke all on function public.confirm_candidate(
  uuid, uuid, text, text, public.task_status, text, text, timestamptz, timestamptz
) from public, anon, authenticated;

-- Explicit, like the ai_usage claim functions: only the server (service_role) calls it.
grant execute on function public.confirm_candidate(
  uuid, uuid, text, text, public.task_status, text, text, timestamptz, timestamptz
) to service_role;
