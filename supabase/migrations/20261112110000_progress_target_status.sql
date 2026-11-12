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
