# Plan: #30 Owner leaves: pause, new Owner, 7-day rule

Issue: https://github.com/POTAEPT/NongJoDII/issues/30
Status: part A is ready. Part B needs #11 (Removal and recovery, natakron-oss), which has no code, branch or PR yet.
Estimate: about 1 day for part A. Part B depends on #11.

## Goal

When the Owner leaves a group, file saving and weekly insights pause there, while Tasks, reminders and the Dashboard keep working. The bot asks for a new Owner, who confirms with LINE login and connects their own Drive. With no new Owner in 7 days, the bot leaves the group.

## Part A (buildable now)

1. In `handleMemberLeft` (`src/server/members/left.ts`), add an Owner branch. It has none today. When the leaver is the group's confirmed Owner, set `groups.owner_left_at` (column exists in the schema).
2. Pause file saving and weekly insights for a group with `owner_left_at` set. Check `weeklyInsightJob` (`src/server/insight/weekly.ts`) and the file-save path. Tasks, reminders and the Dashboard do not check this flag.
3. Post one `owner_needed` card (task prompt kind exists; one open card per group is enforced by the schema). The push counts against the push budget.
4. The card's button opens the Owner confirm page. Reuse `src/server/setup/confirm.ts`. The new Owner takes effect only after LINE login and a Drive connection.
5. On the change, retire the old Drive connection and clear the folder IDs. Reuse the retire code from #14 (PR #61). Files already saved stay in the old Owner's Drive.
6. The Owner can also be found as left by the daily member check (#32), which calls the same leave path.

## Part B (needs #11)

7. A tick job: 7 days after `owner_left_at` with no new Owner, the bot leaves the group. The 7-day deletion (#11) starts when LINE accepts the leave call.
8. A re-invite within those 7 days cancels the pending exit. A re-invite to a group that still has no confirmed Owner restarts the 7-day count.

## Tests (event seam, fake clock)

- The Owner leaves: pause applies, one card is posted, Tasks and reminders still run.
- A new Owner confirms and connects Drive: the pause ends, the old connection is retired, folder IDs are cleared.
- Someone other than the person on the card cannot confirm.
- Part B: no new Owner after 7 days, and re-invite within 7 days.

## Open question

Wait for natakron-oss on #11, or build the "bot leaves by itself" piece of #11 here?

## Done when

`npm test`, `npx tsc --noEmit` and `npm run lint` pass; PR to `development` with "Refs #30". Stop for the user before any migration.
