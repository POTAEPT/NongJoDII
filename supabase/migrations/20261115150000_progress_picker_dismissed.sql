-- #7 fix: "ไม่ใช่การอัปเดตงาน" closes the picker for good.
--
-- The picker card ("อัปเดตนี้หมายถึงงานไหน?") is tied to the chat message it asks about
-- (its Task buttons carry that messages.id). Before this, "ไม่ใช่การอัปเดตงาน" only replied
-- and stored nothing, so a later press on one of the same card's Task buttons still
-- closed the Task. Now the dismissal is stored on the message, and a pick from that
-- message's picker is refused once it is set.
--
-- Only the sender of the message may dismiss (the app checks it). The first dismissal
-- wins: the app writes only where progress_dismissed_at is null.

alter table public.messages
  add column progress_dismissed_at              timestamptz,
  add column progress_dismissed_by_line_user_id text references public.line_users (line_user_id);

alter table public.messages
  add constraint messages_progress_dismissed_by_needs_at
    check (progress_dismissed_by_line_user_id is null or progress_dismissed_at is not null);
