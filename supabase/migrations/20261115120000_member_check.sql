-- #32: the daily member check, a backup for lost memberLeft events.
--
-- Once a Bangkok day the tick asks LINE for the profile of each live Member of each group
-- the bot is in; a 404 means the person left, and the app applies the same leave as the webhook.
-- The check is claimed per group like the daily reminder (20261113120000_daily_reminder_claim):
-- member_check_claimed_at holds a live attempt (it expires after 10 minutes, shorter than the
-- 15-minute tick), and member_check_on is set to the Bangkok date only once every Member of
-- the group was checked. Each Member checked is stamped with group_members.member_checked_on,
-- so a tick that runs out of time clears its claim without setting the group's date, and the
-- next tick resumes with the Members not checked yet that day.
alter table public.groups
  add column member_check_on date,
  add column member_check_claimed_at timestamptz;

alter table public.group_members
  add column member_checked_on date;

comment on column public.groups.member_check_on is
  'Bangkok date the daily member check last completed for this group (#32); null when never.';
comment on column public.groups.member_check_claimed_at is
  'Live daily member check attempt (expires after 10 minutes); null when no attempt holds the group.';
comment on column public.group_members.member_checked_on is
  'Bangkok date the daily member check last asked LINE about this person in this group (#32); null when never.';
