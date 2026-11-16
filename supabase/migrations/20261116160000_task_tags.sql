-- #109: tags on Tasks, suggested by the Summary's model and confirmed by a person.
--
--   * tasks.tags: the Task's tags. Empty by default, so every existing Task and every
--     insert that does not name tags (confirm_candidate, the Task page before this
--     change) stays valid.
--   * task_candidates.suggested_tags: the model's suggestion for a candidate; the review
--     page shows it, and the person keeps, edits or removes it before confirming.
--
-- The app cleans each tag (src/server/tasks/tags.ts: trimmed, no leading "#", at most 20
-- characters, no duplicates). The database caps only the count, the rule that matters
-- for screen space; a CHECK cannot read each array element without a function.
alter table public.tasks
  add column tags text[] not null default '{}',
  add constraint tasks_tags_max check (cardinality(tags) <= 5);

alter table public.task_candidates
  add column suggested_tags text[] not null default '{}',
  add constraint task_candidates_suggested_tags_max check (cardinality(suggested_tags) <= 5);
