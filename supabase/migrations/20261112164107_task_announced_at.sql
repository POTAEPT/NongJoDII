-- When the group was told that this Task was created (#16). The announce step
-- claims Tasks with one conditional UPDATE (announced_at is null -> now()), so a
-- Task is announced at most once even if the LIFF page calls twice; a failed
-- push clears it again. Null = not announced (or announced by the member's own
-- LIFF message, which the server cannot see).
alter table public.tasks add column announced_at timestamptz;
