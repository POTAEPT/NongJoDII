# Plan: #31 Project Owner change: Sub group take-over or detach

Issue: https://github.com/POTAEPT/NongJoDII/issues/31
Status: blocked by #30 (not built). #6 is closed.
Estimate: about half a day after #30.

## Goal

When the main group of a Project gets a new Owner, that Owner chooses whether to take over the Project's Sub groups. Take-over moves the plan, Fair-use cap and Drive to the new Owner. Sub groups not taken over detach and need their own setup and Owner.

## Steps

1. Check that the database functions are applied to nongjodiiDB: `change_project_owner()`, `answer_subgroup_takeover()` and `groups.takeover_asked_at` with its 7-day expiry index (schema commit 246c4ec). If not applied, stop for the user.
2. After a new Owner confirms for the main group (#30 flow), call `change_project_owner()` and ask the take-over question (a LIFF view or a card with two buttons).
3. Take-over: call `answer_subgroup_takeover()`. The Sub groups' plan, Fair-use cap and Drive switch to the new Owner; old files stay in the old Owner's Drive.
4. Detach: the Sub groups leave the Project and need their own setup and Owner (the setup card from #52).
5. No answer: the Sub groups wait paused for 7 days, then detach. Add a tick job that reads the expiry index.
6. While the change is pending, the main group may name a new Owner who has not confirmed yet.
7. Usage from before the change stays on the old Owner's Fair-use cap.

## Tests (event seam, fake clock)

- Take-over, detach, no answer after 7 days, and a pending Owner.
- Usage before the change is not moved to the new Owner.

## Done when

`npm test`, `npx tsc --noEmit` and `npm run lint` pass; PR to `development` with "Refs #31".
