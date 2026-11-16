# Test notes: end-to-end scenarios

Status: 2026-11-16, read from `origin/development` at `84ce233`. These notes come before the scenario suite in `e2e/`. They record what the bot does today, which scenarios the unit tests already cover, and which scenarios to build next.

Sources, in order of trust: the code, the merged PRs, the issues, then `docs/PROJECT.md`. `docs/PROJECT.md` describes the 11 Nov target, and several later decisions differ from it (see "Docs that disagree with the code").

## How the suite works

- **Fake users are personas.** Each scenario is a JSON file in `e2e/scenarios/`. It holds the personas (LINE name, role, fake LINE user ID), the chat lines with minute offsets, the Summary command, the expected Tasks, and a scripted model answer. Claude Code writes the files; people read and correct them. The file is the ground truth for pass or fail.
- **Delivery.** The runner sends each line as a signed LINE webhook event into `handleWebhookRequest`. The `Transport` interface in `e2e/transport.ts` is where a real-LINE delivery can be added later (see "Real LINE delivery").
- **Database.** The real `SupabaseStore` on a local Supabase stack in Docker. The runner refuses any host other than `127.0.0.1` or `localhost`.
- **LINE, Google.** Fakes from `test/fakes/`. Replies and pushes are captured, never sent.
- **Model.** Fake by default (the scripted answer). `E2E_REAL_LLM=1` uses OpenRouter with the dev key, for task-extraction checks.

Why not test bots in the group: LINE allows only one Official Account in a group chat at a time ("At any time, only one LINE Official Account can be in a group chat or multi-person chat", LINE Developers, Group chats). A second bot cannot sit next to NongJoDII.

Why a JSON file and not a `test_messages` table: a table needs a migration on the shared database, and the file already records who said what, when, and the expected Task.

### Run it

```bash
supabase start            # once; first run pulls images
supabase db reset --local # applies all migrations to the local stack only
npm run test:e2e          # fake model
E2E_REAL_LLM=1 infisical run --env=dev -- npm run test:e2e   # real model
```

`npm run test:e2e` is not part of `npm test` or CI, because it needs Docker.

### Real chats (#118)

A LINE chat export (in the chat: ☰ → Settings → Export chat history) becomes a scenario:

```bash
npm run import-chat -- chat.txt --name real-team1 --from 2026-06-24 --to 2026-06-25 --rename "ฟ้า=แบงค์"
E2E_SCENARIOS=private E2E_SCENARIO=real-team1 E2E_REAL_LLM=1 infisical run --env=dev -- npm run test:e2e
```

- **Where it goes:** the output goes to `e2e/private/`, which git ignores. `<name>.json` holds personas only. `<name>.names.json` maps real names to personas and must never be shared.
- **Names:** sender names and `@mentions` are replaced. Nicknames inside the text are not, so read the output and add them with `--rename`.
- **Dates:** `startAt` is the chat's real date, so "ศุกร์นี้" means what it meant then.
  - Keep one or two days with `--from` and `--to`: the Summary reads at most 100 new messages.
  - The tool warns about anything over 100 messages or 7 days.
- **Expected Tasks:** `expectedTasks` starts empty. Fill it in by reading the chat, then the real-model run compares against it.
- **Pitch script:** `--pitch --start 2026-11-18T03:00:00Z --max-lines 8` keeps the first lines and places them one minute apart from that time.
- **Format checked so far:** the Thai app's export (2026-11-16). The tool also reads English and year-first date lines and AM/PM times. A line it cannot place is reported with its line number, never guessed.

### Local database facts

- All 21 migrations apply cleanly to a fresh local stack (checked 2026-11-16, Supabase CLI 2.119.0, Postgres 17). 20 public tables.
- `20261113085308_scheduler_ticks.sql` installs `pg_cron` and `pg_net` and schedules `nongjodii-tick` every 15 minutes. The Vault secrets `nongjodii_tick_url` and `nongjodii_tick_secret` are read only when the job runs, so the migration applies without them. Locally the job then fails every 15 minutes with "Vault secrets ... are missing". That is harmless: the suite calls handlers directly and never depends on the tick.

## What the bot does today

### Webhook events (`src/server/webhook/ingest.ts`)

| Event | Effect |
|---|---|
| group text | Stores the message, upserts the sender and group membership. Commands run; other text may be checked as a progress update when the group has open Tasks |
| group image or file | Stores it; saves to the Owner's Drive (#4) |
| sticker, video, audio | Stored with no text; no reply |
| unsend | Deletes the stored copy and keeps a tombstone so a late delivery is never stored |
| join | Purges and recreates the group row, replies with the setup card |
| leave | Marks the bot left; deletion after 7 days |
| memberJoined | Adds the Member, replies with a welcome (or "welcome back") |
| memberLeft | Releases open Tasks, posts one card; Owner leaving pauses saving and Summaries |
| postback | Card buttons (reminders, progress, task card, Owner confirm) |
| follow, 1:1 text | Rich Menu words: Dashboard, Settings, else the Drive card |

Duplicate deliveries are ignored by `webhookEventId` and by the message row's unique key.

### Typed commands (`src/server/commands/parse.ts`)

Form: `NongJoDII` or `น้องจดดี` (optional `@`, any case), optional `,` or `:`, the command, optional polite words (ให้ หน่อย ด้วย ครับ คับ ค่ะ คะ ค่า นะ น้า จ้า จ้ะ please pls), optional `! . ? ~ ๆ`. Any other extra word means no command.

| Command | Words | Notes |
|---|---|---|
| Summary | `summarize`, `สรุป` | Needs a reply token |
| Done | `done` | English only; reminder fallback |
| Need time | `need time` | English only |
| Settings | `settings`, `ตั้งค่า` | Settings card |
| File request | `ขอไฟล์` | Only as a quote-reply to a saved file |

### Summary path (`src/server/summary/run-summary.ts`)

1. Group missing: silent. `feature_summarize` off: a text, no model call.
2. No confirmed Owner: the "no Owner" text, plus the setup card if setup is open; or the Owner-needed card if the Owner left. No model call.
3. Fair-use capped: the cap message, no model call.
4. Last 100 text messages (commands and "Tasks created" lines dropped). None: "ยังไม่มีข้อความให้สรุป".
5. Prompt: members as `mN` with LINE name, nicknames and role; chat lines as `msgN [YYYY-MM-DD HH:mm] mN: text`, Bangkok time.
6. Model `openai/gpt-oss-20b`, metered through `claim_ai_usage` / settle / release RPCs.
7. Output: JSON `{summary, tasks[{title, details, assignee: "mN", due: ISO +07:00, source: "msgN"}]}`, at most 10 tasks.
8. `summaries` row, then `task_candidates` rows (two writes, not one transaction).
9. One reply. With tasks: a text plus a Flex card with the button "ตรวจและยืนยันงาน" to `https://liff.line.me/<liffId>?view=review&id=<summaryId>`. With none: one text ending "ไม่พบงานใหม่ในแชตช่วงนี้". A Task exists only after someone confirms in the LIFF review form.

Failures reply with a reason and a code, for example `SUM-AI-BUSY 14:01` (#105).

### Rules a scenario must respect

- **Roles.** The confirmed Owner saves Settings, Stop using, Drive changes. A Member sees their own Tasks, may take unowned Tasks, answers their own reminders. A person who left, or an outsider, gets 403 on LIFF endpoints.
- **Fair-use cap.** $0.50 per Owner per month (6,000,000 tokens as the claim limit); a warning at 80%, once per group per month.
- **Push budget.** Counts per recipient (a push to a 5-person group counts 5). Pushes stop inside the last 10% (Tasks created, weekly, saved file, leave cards) or 2% (reminders, setup, Owner-needed) of the monthly quota; the Dashboard still shows the items.
- **Schedule.** Tick every 15 minutes. Daily reminder at the group's time (default 09:00 Bangkok); weekly insight default Monday 09:00; member check 08:00; Google access check 10:30; purge 03:00.
- **Reminders and gap flags.** Due today or tomorrow, overdue, no assignee, no update for more than 5 days. At most 11 Tasks per carousel.
- **Owner leaves.** File saving, Summaries and the weekly insight pause; Tasks, reminders and the Dashboard keep working. No new Owner in 7 days: the bot leaves a main group (a claim in progress holds the exit up to 24 h); a Sub group detaches instead.
- **Removal.** A leave sets `delete_after` 7 days ahead; a re-invite clears it. Drive files are never deleted.
- **Language.** UI copy is Thai. Both bot names work in commands. Nicknames are for the model only; screens show LINE names. The model is told to write Thai.
- **Time in tests.** Handlers take `deps.now()`, so a scenario moves time by setting the clock. Scheduled jobs are called through the tick handler with a moved clock, never by waiting.

## The doc's 21 scenarios against existing tests

"Unit" means the existing Vitest suite with the in-memory `FakeStore`. "E2E" means this suite with the real database.

| # | Scenario | Unit coverage | Plan |
|---|---|---|---|
| 1 | Clear task chat, then Summary | Covered (`summary.test.ts`, `feature-create-tasks.test.ts`) | **E2E built**: `01-clear-task` |
| 2 | Casual chat, no task | Partly (`summary.test.ts` 14) | **E2E built**: `02-casual-no-task` |
| 3 | Several tasks in one chat | Covered (`feature-create-tasks.test.ts`, `review.test.ts`) | E2E next, real model |
| 4 | Unsend, then a corrected message | Partly (`webhook.test.ts`, unsend store test); no corrected-message test | E2E next |
| 5 | Create Task (confirm) | Covered (`review.test.ts` 5) | E2E: call the review submit handler |
| 6 | No confirm, no Task | Covered (`review.test.ts`, `summary.test.ts` 9) | Assert in 01 (no `tasks` row) |
| 7 | Confirm twice, one Task | Covered (`review.test.ts` 11) | E2E with 5 |
| 8 | Edit title before confirm | Covered (`review.test.ts` 6, `task-edit.test.ts`) | E2E with 5 |
| 9 | Full onboarding | Covered (`setup.test.ts`) | E2E: join event, setup submit, Owner confirm |
| 10 | Skip tags | **Not built**: there is no tag feature | Drop |
| 11 | Invalid tag input | **Not built** | Drop |
| 12 | Non-Owner tries onboarding | Partly (`setup.test.ts` refusals) | E2E with 9 |
| 13 | Auto tags | **Not built** | Drop |
| 14 | Tagging failure | **Not built**; the model-failure path exists for Summaries | Replace with "model fails, Summary says why" |
| 15 | Status change | Covered (`reminder-answers.test.ts`, `progress.test.ts`) | E2E: progress line, then the Yes postback |
| 16 | Dashboard sign-in | Covered (`dashboard-access.test.ts`) | Browser; needs a LIFF login decision |
| 17 | Task appears on the Dashboard | Covered | E2E: call the dashboard load handler |
| 18 | Cross-group view | Covered (`dashboard-access.test.ts`, `dashboard-model.test.ts`) | E2E with 17 |
| 19 | Weekly insight counts | Covered (`weekly-insight.test.ts`, `supabase-store-weekly.test.ts`) | E2E: tick with a moved clock |
| 20 | Web edit | Covered (`task-edit.test.ts`) | E2E with 17 |
| 21 | Whole journey | None | Last |

Already covered by unit tests and not repeated end to end unless the real database matters: duplicate webhook delivery (`webhook.test.ts` 4), fair-use cap (`fair-use*.test.ts`, `meter.test.ts`), push budget (`push-budget.test.ts`), Owner leaves and the 7-day rule (`owner-leaves`, `owner-exit`), removal and recovery (`removal.test.ts`), daily reminders and the member check.

The real gap the unit tests cannot see is the database itself: column names, PostgREST embeds, RPCs, triggers and constraints. The Summary bug fixed in #103 (`PGRST201` on an ambiguous `line_users` embed) passed every unit test and failed on the real database. That is what this suite is for.

## Scenario list, next

| Order | Scenario | Method |
|---|---|---|
| 1 | 01 clear task, 02 casual chat | Signed events + database check (built) |
| 2 | 03 several tasks, Thai and English mixed | Signed events, real model |
| 3 | 04 unsend then correct | Signed events (`unsend` event) + database check |
| 4 | 05-08 confirm, twice, edit, none | Review handlers + database check |
| 5 | 09, 12 onboarding and a non-Owner | Join event + setup handlers |
| 6 | 15 progress from chat | Signed events + postback |
| 7 | 19 weekly insight | Tick handler with a moved clock |
| 8 | 17, 18, 20 Dashboard data | Dashboard handlers + database check |
| 9 | 21 whole journey | All of the above |
| Later | Real LINE delivery, pitch demo | `beeper/line` bridge (below) |

## Real LINE delivery (later)

Candidate found 2026-11-16: [`beeper/line`](https://github.com/beeper/line), MIT, a Matrix bridge (mautrix-go bridgev2) that logs in as a LINE personal account. It sends text, images, files, mentions and replies in group chats, and can unsend. A script talks to the bridge through the Matrix client API, so each persona can be a real LINE account in the real test group with no phone clicking. It would become a `BridgeTransport` behind the same `Transport` interface; the scenario files stay as they are.

What it needs and what to watch:

- One real LINE account per persona, each with an email set (the bridge logs in by email and password, or QR). Use test accounts, never a personal account.
- A Matrix homeserver (Synapse, Conduit or Dendrite in Docker) or a Beeper account, plus the bridge container.
- It identifies itself as the LINE Chrome Extension client. LINE allows one Chrome Extension session per account, so logging into LINE for Chrome on that account drops the bridge.
- It is not an official LINE API. An unofficial client may break the LINE terms of use, and LINE could suspend accounts that use it. Keep it to throwaway accounts and the test group.
- Not tried yet. Unknowns: whether LINE delivers bridge-sent messages to the bot's webhook exactly like app-sent ones (they should, since they are ordinary user messages), and whether the persona can tap postback buttons or open LIFF (the bridge does not do either; those steps still need the review handler or a phone).

### Limits of the first two scenarios

- `task_candidates` has no source-message column, so `expectedTasks[].sourceMessage` is recorded in the script but cannot be checked against the database.
- Both scenarios share persona IDs and one Project owner, so each run removes the other's rows first. Run them in order, never in parallel (`fileParallelism: false`).
- The fair-use RPCs run for real, but the 80% warning and the cap branches are not exercised yet.
- Real-model mode (`E2E_REAL_LLM=1`) is wired but not run yet.

## Open questions

1. **LIFF identity in tests.** Every LIFF endpoint takes a LINE ID token and verifies it with LINE (`src/server/liff-auth.ts`). With `FakeLine` the runner can return any user for `verifyIdToken`, so handler-level scenarios work. A browser test against the deployed app needs a real LINE login. Decide whether browser tests are needed at all.
2. **Real LINE delivery.** Try `beeper/line` with test accounts (above), or keep real LINE only for the pitch demo.
3. **#108.** A second Summary re-reads old chat and proposes Tasks that are already closed. A scenario "Summary twice" will show it; write it once the fix lands, or now as a known failure.

## Docs that disagree with the code

Merged PRs are newer and win.

| Topic | `docs/PROJECT.md` or issue | Code and PRs |
|---|---|---|
| File reply window | about 50 s (#4) | 25 s reply window, 28 s save cap (PR #96) |
| Owner leaves | saving and Summaries pause (PROJECT.md); saving and weekly (#30) | saving, Summaries and weekly all pause (PR #74) |
| Push budget | one push, one count (#25) | counted per recipient (PRs #40, #48, #49) |
| Weekly insight with no Tasks | a post (#10, #21) | nothing is posted (PR #49) |
| Members on the Dashboard | no unowned Tasks, no insight (#90, #91) | both shown (PR #93) |
| Project members | people named in the setup form | the form only updates live Members (PR #53) |
| Issue list | "#1 to #22 hold the work items" | issues run to #108; #2, #3, #4, #9, #11, #13, #14, #17-#19, #30-#33 are open although their PRs merged ("Refs", not "Closes") |
