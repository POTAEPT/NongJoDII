-- #110: the group's starting tag set, entered in the setup form (optional) and edited in
-- Settings by the Owner. The Summary's model picks from it first (#109) and may still
-- suggest other tags (decided 2026-11-16, option ก: the set guides, it does not restrict).
--
-- Per group, like every other setup-form value: the setup form saves before the group has a
-- Project. The app cleans each tag (src/server/tasks/tags.ts); the database caps the count.
alter table public.groups
  add column tag_set text[] not null default '{}',
  add constraint groups_tag_set_max check (cardinality(tag_set) <= 20);
