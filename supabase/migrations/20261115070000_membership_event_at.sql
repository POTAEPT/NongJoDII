-- #29: membership events in timestamp order.
--
-- LINE does not promise the order of memberLeft and memberJoined events, and a leave we
-- answered with 500 comes back later as a redelivery. Before this, a join cleared left_at
-- only when left_at was older than the join, and a leave set left_at only on a live row.
-- So with leave T1, rejoin T2 and leave T3 arriving as T1, T3, T2, the late T2 join undid
-- the T3 leave; and a leave first delivered after a newer rejoin removed a current Member.
--
-- Now each leave and join records its event time here, and the app applies an event only
-- when it is newer than the one recorded. A row from before this column (null) falls back
-- to left_at, which is the time of the last leave applied to it.
alter table public.group_members
  add column membership_event_at timestamptz;

comment on column public.group_members.membership_event_at is
  'Timestamp of the latest memberLeft or memberJoined event applied to this row; null when none has been.';
