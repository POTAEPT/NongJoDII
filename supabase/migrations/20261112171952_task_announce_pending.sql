-- A pending self-announcement (#16): the LIFF page reserves Tasks before it posts
-- the "Tasks created" message as the member (liff.sendMessages), then confirms.
-- The page makes the token, so a claim whose response was lost can be retried with
-- the same token. A reservation older than 2 minutes counts as abandoned (the page
-- closed or failed) and may be taken over by another claim or by the bot's push.
-- announced_at stays the only "done" marker; nothing ever clears it once a
-- self-announcement is confirmed.
alter table public.tasks
  add column announce_pending_token uuid,
  add column announce_pending_at    timestamptz;
