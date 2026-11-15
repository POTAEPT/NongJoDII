# Plan: #32 Daily member check for lost leave events

Issue: https://github.com/POTAEPT/NongJoDII/issues/32
Status: ready. Blockers #29 (merged in PRs #60, #62, #64) and #8 (tick and daily reminders merged) are met in code.
Estimate: 2 to 3 hours. No migration expected.

## Goal

Once a day, the tick asks LINE for the profile of each live member of each group. A 404 means the person left, and the bot runs the same steps as a leave event. Nothing else is posted.

## Steps

1. Extract the leave path into one shared function. Today a leave event marks the person left inside `src/server/webhook/ingest.ts`, then calls `handleMemberLeft` (`src/server/members/left.ts`). Move both steps into one function (for example `applyMemberLeft(deps, { groupId, lineUserId, at })`) and call it from `ingest.ts`. Existing tests must stay green.
2. Add a tick job `memberCheckJob` in `src/server/members/daily-check.ts` and add it to `TICK_JOBS` in `src/server/tick/run-tick.ts`, after `dailyRemindersJob` so reminders keep the push reserve first.
3. Run once per Bangkok day per group. Reuse the claim pattern from the daily reminder claim (`20261113120000_daily_reminder_claim.sql`). If a new column is needed, stop and ask for a migration go-ahead.
4. For each live member (`left_at` is null), call `deps.line.getGroupMemberProfile` (`src/server/line/client.ts:62`). It returns `null` on 404 and throws on any other status.
   - `null`: call the shared leave function from step 1.
   - Profile returned: change nothing.
   - Throw: log it, mark nobody, and retry on the next day's run.
5. Stay inside the 60 s route limit. Use the deadline pattern from `driveSetupJob` (`src/server/google/drive-folders.ts`): check the time before each call and leave the rest for the next tick.
6. A member whose leave event already arrived has `left_at` set and is skipped, so the leave is never handled twice.

## Tests (event seam, fake clock, fake LINE)

- A profile reply (200) changes nothing.
- A 404 marks the person left and posts one leave card.
- A 404 followed by a late leave event gives one card, not two.
- A non-404 error marks nobody and the next day's run checks again.
- Several 15-minute ticks in one day run the check once.
- The run stops at the deadline and the next tick finishes the rest.

## Done when

`npm test`, `npx tsc --noEmit` and `npm run lint` pass; PR to `development` with "Refs #32"; CI, Vercel and Greptile pass.

## Notes

- A live test needs pg_cron to call the tick route (the pg_cron box in #8 is still unchecked).
