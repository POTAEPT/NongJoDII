-- answer_progress_yes now rechecks who may answer (Greptile review of PR #46).
--
-- The handler checks that the presser is the Task's assignee or the card's subject
-- (the progress-line sender), then calls this function. A concurrent edit can
-- reassign the Task between that check and this write, and the stale permission
-- would still move the Task. The rule (decided 2026-11-12: only the assignee or the
-- progress-line sender may answer) is therefore repeated here, inside the same
-- UPDATE that writes the Task, so READ COMMITTED re-evaluates it against the latest
-- row after any lock wait.
--
-- Outcomes are unchanged: a presser who no longer qualifies gets 'task_changed'
-- and the card stays open.
create or replace function public.answer_progress_yes(
  p_prompt_id    uuid,
  p_task_id      uuid,
  p_from_status  public.task_status,
  p_to_status    public.task_status,
  p_by           text,
  p_assign_to    text,
  p_at           timestamptz
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_answer   text;
  v_subject  text;
  v_task     uuid;
begin
  if p_to_status not in ('in_process', 'done') then
    raise exception 'bad target status %', p_to_status using errcode = 'check_violation';
  end if;

  select p.answer, p.subject_line_user_id into v_answer, v_subject
    from public.task_prompts p
   where p.id = p_prompt_id and p.task_id = p_task_id and p.kind = 'mark_done'
   for update;
  if not found then
    return 'task_changed';
  end if;
  if v_answer is not null then
    return 'already_answered';
  end if;

  update public.tasks t
     set status = p_to_status,
         done_at = case when p_to_status = 'done' then p_at else t.done_at end,
         assignee_line_user_id = coalesce(p_assign_to, t.assignee_line_user_id),
         last_edited_by_line_user_id = p_by,
         last_activity_at = p_at
   where t.id = p_task_id and t.status = p_from_status and t.deleted_at is null
     and (t.assignee_line_user_id = p_by or v_subject = p_by)
  returning t.id into v_task;
  if v_task is null then
    return 'task_changed';
  end if;

  update public.task_prompts
     set answer = 'yes', answered_by_line_user_id = p_by, answered_at = p_at
   where id = p_prompt_id;
  return 'updated';
end;
$$;

revoke all on function public.answer_progress_yes(
  uuid, uuid, public.task_status, public.task_status, text, text, timestamptz
) from public, anon, authenticated;

-- Only the server (service_role) calls it, like confirm_candidate.
grant execute on function public.answer_progress_yes(
  uuid, uuid, public.task_status, public.task_status, text, text, timestamptz
) to service_role;
