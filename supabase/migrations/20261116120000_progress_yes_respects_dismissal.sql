-- #87: a Yes never lands on a message already marked "ไม่ใช่การอัปเดตงาน".
--
-- 20261115150000 stores the dismissal on messages.progress_dismissed_at, and the app
-- checks it before a pick. That check and the write were two steps, so a pick and a
-- "ไม่ใช่การอัปเดตงาน" pressed at the same moment could both win. Now the rule is also
-- inside answer_progress_yes: after locking the card, it takes a share lock on the card's
-- chat message (trigger_message_id) and refuses with 'dismissed' when it is dismissed.
--   * the dismissal (UPDATE messages ... where progress_dismissed_at is null) commits
--     first: the Yes waits for the row, then sees it and answers 'dismissed';
--   * the Yes commits first: the dismissal waits for the share lock, then commits, and
--     the app (which dismisses first and reads the Yes answers after) reports that the
--     Task was already updated.
-- Only a picker is ever dismissed, and a card whose message has a dismissed picker is
-- already answered (No, then "เลือกงานอื่น"), so no open real card is affected.
--
-- Everything else is unchanged from 20261113085336 (who may answer is rechecked in the
-- Task UPDATE). New outcome: 'dismissed'. App code before this change never sees it.
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
  v_answer     text;
  v_subject    text;
  v_trigger    uuid;
  v_dismissed  timestamptz;
  v_task       uuid;
begin
  if p_to_status not in ('in_process', 'done') then
    raise exception 'bad target status %', p_to_status using errcode = 'check_violation';
  end if;

  select p.answer, p.subject_line_user_id, p.trigger_message_id into v_answer, v_subject, v_trigger
    from public.task_prompts p
   where p.id = p_prompt_id and p.task_id = p_task_id and p.kind = 'mark_done'
   for update;
  if not found then
    return 'task_changed';
  end if;
  if v_answer is not null then
    return 'already_answered';
  end if;

  if v_trigger is not null then
    select m.progress_dismissed_at into v_dismissed
      from public.messages m
     where m.id = v_trigger
     for share;
    if v_dismissed is not null then
      return 'dismissed';
    end if;
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

grant execute on function public.answer_progress_yes(
  uuid, uuid, public.task_status, public.task_status, text, text, timestamptz
) to service_role;
