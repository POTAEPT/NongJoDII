-- Review follow-ups for #71, #72, #73 and #74 (written 2026-11-15, not applied yet).
-- The app code that ships with this file also runs against the schema before it: each
-- part below says what changes once it is applied.

-- ---------------------------------------------------------------------------
-- #11 (#73): groups.joined_at is the time of the latest join EVENT applied.
--
-- The initial schema filled it with now() at insert, so a row first stored by a message
-- or postback event carried its processing time, later than the events it came from. A
-- leave event stamped before that time was then ignored by markBotLeft (joined_at <= at),
-- and a late-processed join could keep a later leave from marking the group. From now on
-- a new row has no joined_at until its first join event sets it to that event's time
-- (markBotJoined: where joined_at is null or older); markBotLeft takes any leave while it
-- is null. Existing rows keep their value.
alter table public.groups
  alter column joined_at drop default,
  alter column joined_at drop not null;
