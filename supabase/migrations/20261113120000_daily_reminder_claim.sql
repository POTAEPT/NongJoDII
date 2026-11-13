-- Daily reminders: an expiring claim, separate from the completed day.
--
-- Before this, the tick claimed the day by setting daily_reminder_last_sent_on = today
-- before it read Tasks or pushed to LINE. A request that stopped after that write (or a
-- failed push whose release also failed) left the day marked sent, so every later tick
-- skipped the group until tomorrow.
--
-- Now the tick claims with daily_reminder_claimed_at = now() where the day is not complete
-- and no claim younger than the lease (10 minutes, shorter than the 15-minute tick) holds
-- the group. It sets daily_reminder_last_sent_on = today and clears the claim only after
-- the attempt finishes (posted, nothing to remind, or skipped near the quota). A failed
-- attempt clears the claim; a lost one expires, and the next tick retries with the same
-- LINE retry key, so the group never gets the same day's post twice.
alter table public.groups
  add column daily_reminder_claimed_at timestamptz;

comment on column public.groups.daily_reminder_claimed_at is
  'Live daily-reminder attempt (expires after 10 minutes); null when no attempt holds the group.';
