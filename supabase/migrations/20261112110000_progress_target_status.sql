-- Track progress (#7): the "อัปเดตงานนี้ไหม?" card can move a Task to Done or
-- to In Process ("ต้น รับงานนี้ใช่ไหม?", Figma UI v4 frames #5). The card is a
-- task_prompts row of kind mark_done; target_status says which status a Yes
-- moves the Task to. Answers stay yes / no.
--
-- subject_line_user_id on a mark_done card is the sender of the progress line.
-- Only that person or the Task's assignee may answer (decided 2026-11-12).
--
-- Applies after the initial schema (PR #34).

alter table public.task_prompts
  add column target_status public.task_status;

alter table public.task_prompts
  add constraint task_prompts_mark_done_needs_target
    check (kind <> 'mark_done' or target_status in ('in_process', 'done'));

alter table public.task_prompts
  add constraint task_prompts_target_only_on_mark_done
    check (kind = 'mark_done' or target_status is null);

-- At most one open progress card per Task, so a chatty group does not get the
-- same question twice.
create unique index task_prompts_one_open_mark_done
  on public.task_prompts (task_id)
  where kind = 'mark_done' and answer is null;

-- A person's Yes on a progress card (#7): the answer and the Task's status change in
-- one transaction, so a failed write leaves the card open and usable.
-- The card row is locked first (FOR UPDATE), so two presses cannot both win:
--   * card missing or about another Task          -> 'task_changed'
--   * card already answered                        -> 'already_answered'
--   * Task deleted or no longer in p_from_status   -> 'task_changed' (card stays open)
--   * otherwise the Task moves and the card gets 'yes' -> 'updated'
-- Done sets done_at; p_assign_to (when not null) becomes the assignee; every move
-- bumps last_activity_at and last_edited_by (drives the 5-day gap flag, #8).
create function public.answer_progress_yes(
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
  v_answer  text;
  v_task    uuid;
begin
  if p_to_status not in ('in_process', 'done') then
    raise exception 'bad target status %', p_to_status using errcode = 'check_violation';
  end if;

  select p.answer into v_answer
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
