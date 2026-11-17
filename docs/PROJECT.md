# NongJoDII project overview

Status (2026-11-11): planned design. The code is still an early scaffold, so this file describes the target, not existing code. The GitHub issues (#1 to #22) hold the work items and acceptance criteria. The decisions dated 2026-11-11 below are newer than the issue text and win until the issues are updated; otherwise, when an issue and this file differ, the issue wins.

## What it is

NongJoDII (Thai name น้องจดดี) is a LINE bot plus a LIFF Dashboard. Teams run their work in several LINE group chats, where decisions, assignments and files get lost, and files expire in LINE. The bot joins those groups, saves their files to the Owner's Google Drive, turns chat into Tasks that a person confirms, tracks progress from normal chat, reminds and flags gaps, and posts a weekly insight. A PM sees every group of a Project on one Dashboard; a Member sees only their own groups.

## Terms

Use these words in code, comments and UI copy.

- **Project**: one unit of work, represented by its main LINE group.
- **Sub group**: any other LINE group the bot joins; it belongs to exactly one Project.
- **Owner**: the member the setup form names as Owner, who then confirms with their own LINE login. The Owner is that group's admin; their plan, Fair-use cap and Google Drive cover every group they admin.
- **Member**: anyone else in the Project's groups.
- **PM**: a role, not a person type: the Member or Owner who sees all groups of a Project on the Dashboard.
- **Dashboard**: the cross-group LIFF screen with Tasks and progress.
- **Summary**: the bot's short account of a group chat, proposed for a person to confirm.
- **Task**: a unit of work created only after a person confirms (or edits) a Summary item. Status is Not Assigned, In Process or Done.
- **Fair-use cap**: the AI limit per Owner on the free tier, $0.50 per month.

## Features

| # | Feature | Issues |
|---|---|---|
| 1 | File saver: files and images sent in a group go to that group's Drive folder; the bot replies with the link | #4 |
| 2 | Create tasks: a Summary lists Task candidates; a Member edits and confirms them; a Task can later be edited, assigned or deleted | #5, #15, #16 |
| 3 | Track progress: a normal chat line passes a free keyword gate in code first; only a line with a progress word goes to the decision model, which proposes "Mark as Done?" for one Task or a picker of open Tasks; only a person's answer changes the status | #7, #132 |
| 4 | Follow-up and gap checks: daily reminders before due dates; flags for no assignee, overdue, or no update in 5 days | #8 |
| 5 | Insight and Dashboard: cross-group Dashboard (5a) and a weekly insight per group (5b) | #9, #17-#19, #10, #20-#22 |

Shared plumbing: the webhook walking skeleton (#1); setup with join, Owner login, Project and Sub groups (#2); Google sign-in and Drive folders (#3, #12-#14); the Fair-use cap (#6); removal and recovery (#11).

Summarize with "NongJoDII summarize" or "NongJoDII สรุปหน่อย". Get a saved file's Drive link back by quote-replying to the file message with "NongJoDII ขอไฟล์". Reminders are answered with buttons (Done, Postpone), with "NongJoDII done" and "NongJoDII need time" as typed fallbacks. UI copy is in Thai.

## Decided 2026-11-11

From the team's Figma prototype (page Final-Prototype, flow v4) and the user's answers. These are newer than the issue text.

- Setup form: what the group works on, each member's nicknames and role, which features to use, who the Owner is, the time of the daily reminder and the day and time of the weekly summary. The person setting up the group chooses these times; the form is prefilled with daily 09:00 and weekly Monday 09:00 (Asia/Bangkok). Everything set in the setup form can be changed later in Settings. The nicknames are used only by the AI, to work out who the chat is talking about; every screen (pickers, cards, Dashboard) shows LINE names. The Owner role takes effect only after that person confirms with LINE login. The Owner connects Google Drive from the 1:1 chat with the OA.
- Grouping: the picker that attaches groups to a Project lists only the groups the user admins.
- Project members: the people named in the setup form, plus anyone who sends a message in one of its groups, opens the LIFF from one, or joins one after the bot. A member who leaves a group loses access.
- Member and Owner changes: when a member leaves (memberLeft), their open Tasks go back to Not Assigned and the bot posts one card in the group listing them with Assign and I'll take it buttons (one push); Done Tasks keep the name for history, and the person is marked as left and loses Dashboard access. When a member joins (memberJoined), they count as a Member at once, named from their LINE profile, and the bot replies (no push) with a short welcome and a button to set their nickname and role in the setup form; the Owner can edit nicknames and roles anytime in Settings. When the Owner leaves the group, file saving and summaries pause there while Tasks, reminders and the Dashboard keep working; the bot posts a card asking someone to become Owner, who confirms with LINE login and connects their Drive, and files already saved stay in the old Owner's Drive; on the change the old Drive connection is retired and the folder IDs are cleared, so the new Owner connects their own Drive. If no new Owner appears within 7 days, the bot leaves the group, which starts the 7-day deletion (#11); a re-invite within those 7 days cancels it, and a re-invite to a group that still has no confirmed Owner restarts the 7-day count. When the bot leaves a group by itself (no new Owner after 7 days, or Stop using), the 7-day deletion timer starts as soon as LINE accepts the leave call, without waiting for the leave event, which LINE's docs do not confirm in that case. When the main group gets a new Owner, that Owner confirms whether to take over the Project's Sub groups too: with that confirm their plan, Fair-use cap and Drive switch to the new Owner and old files stay in the old Owner's Drive; Sub groups not taken over detach from the Project and need their own setup and Owner. If the new Owner confirms but never answers the take-over question, those Sub groups wait paused for 7 days, then detach from the Project and need their own setup and Owner. While a Project's Owner change is pending, the main group may name a new Owner who has not confirmed yet. The daily tick checks each known member of a group with LINE's group member profile API; a 404 means the person left, in case a leave event was lost, and the member-left rules above then apply.
- Tasks: a Summary opens a form to pick, edit and confirm several candidates at once. After a confirm creates Tasks, the bot pushes one "✅ สร้างงานแล้ว" message to the group listing them, once per Task; the push is skipped inside the last 10% of the monthly quota. Summaries skip these messages. A created Task can be edited (title, details, owner, due date and time). An unowned Task card in the group offers Assign, I'll take it, and Not a task; Not a task deletes the Task after a confirm, with undo. If an I'll take it press arrives without the presser's LINE user ID (LINE guarantees userId only on message events, for iOS and Android users), the bot opens a LIFF page so LINE login identifies the person, instead of assigning blindly.
- Summary Task candidates are project or study work only (decided 2026-11-17 after a live run made "555 เดี๋ยวสั่งชานมด้วย" a Task). Snacks, drinks, food orders, jokes (a line with 555 or a laugh), social plans and a member's personal errands are not Tasks, do not count toward Jev's `task_count`, and the summary text never calls them unassigned work. Booking a meeting room, printing or sending a file for the project is work. The rule lives in the prompts (`PROJECT_WORK_ONLY` in `src/server/summary/prompt.ts`, `NOT_WORK` in `precheck.ts`), and the count hint and the retry say the count is of project work only; code never drops a Task by keyword.
- Summary due dates: a deadline that names a day but no time is due 23:59 Asia/Bangkok that day, never 00:00 (a Task due at the start of its day looks overdue all day and reminders fire early). The text model answers such a deadline as a date only (`YYYY-MM-DD`) and code makes it 23:59 +07:00, the same instant the LIFF form saves for a blank time. A model answer of exactly 00:00 also becomes 23:59, unless the Task's source message (or, with no source, the chat) says midnight: เที่ยงคืน, หกทุ่ม, ตีศูนย์, midnight, 00:00 or 24:00. A stated time is kept ("ห้าโมงเย็น" stays 17:00). Cards have no date-only style, so such a due shows as "ศ. 20 พ.ย. 23:59"; no flag is stored (`src/server/summary/parse-output.ts`).
- Summary weekday dates: the prompt carries a calendar of today and the next 14 days, one per line, each with its English and Thai weekday, Thai short form and week ("- 2026-11-19 Thu พฤหัสบดี (พฤ.) this week"), with today and tomorrow marked วันนี้ and พรุ่งนี้. The rule (#161): a weekday word ("วันพฤหัส", "ศุกร์นี้", "Fri") is the first such day on or after today; with หน้า, สัปดาห์หน้า or next week it is that day of the following week (weeks start on Monday). After parsing, code checks each Task's due against its own source message: when the message names exactly one weekday (Thai, with or without วัน: จันทร์ อังคาร พุธ พฤหัส/พฤหัสบดี/พฤ ศุกร์/ศ เสาร์ อาทิตย์/อา; or English) and the due falls on another weekday or before today, the due moves to the right day by the same rule, keeping its time (23:59 for a date-only due); for the following week the exact date must match. The short forms พฤ, ศ, อา count only on their own or after วัน, so ศึกษา, อาหาร and พฤศจิกายน are not days; a bare อาทิตย์ before หน้า/นี้ is "week". The check leaves the due alone when the Task has no source message, or the message names two weekdays, writes a date out ("20 พ.ย.", "20/11", "วันที่ 20"), names another day (วันนี้, พรุ่งนี้, มะรืน, ที่แล้ว) or puts ก่อน/หลัง before the weekday (`findWeekday` in `src/server/time/bangkok.ts`, `settleWeekdayDue` in `src/server/summary/parse-output.ts`).
- Reminders and flags are posted in the group where the Task lives, never in a 1:1 chat.
- Weekly insight: a group post with counts from code (done, in progress, awaiting an owner), the unowned Tasks and an Open Dashboard button. No AI paragraph.
- Pushes: one per event, each counted against the monthly LINE quota. Near the limit the bot stops pushing and shows the items on the Dashboard only.
- Unsend: the bot deletes its stored copy of the message; confirmed Tasks stay.
- Plans: the Settings screens show a static Free and Team plan mock. There is no payment code.
- Stop using (in Settings) makes the bot leave the group, so the 7-day deletion (#11) applies. The Owner can instead delete the group's data at once, behind a typed confirm (#147).
- Deleting a Project's main group (the daily purge, or Stop using with delete now) detaches the Project's other groups: each gets a fresh 7-day Owner count and, where the bot still is, the owner_needed card. The Project row goes once no group and no saved file points at it; while a detached group still holds files saved through the Project's Drive, the row stays as that history (#77).
- File links: when the Owner connects Google Drive, the bot shares each Project folder once as "anyone with the link can view"; saved files inherit that sharing, so Members open links without a Google account. When someone wants a file back (for example because the LINE file has expired), they reply to (quote) that file's message with the command "NongJoDII ขอไฟล์", and the bot answers with that file's Drive link as a reply (no push). It finds the file from the reply's `quotedMessageId` through its stored copy of the quoted message, because LINE never returns quoted content. Bots cannot send LINE file messages, so the answer is the Drive link.
- Saved card: LINE's free reply must go out within one minute of the webhook, and saving a big file can take longer. If the file is saved within about 50 seconds, the "saved" card is a reply (no push); otherwise it is a push, which counts against the monthly quota and stops near the limit. Several photos sent together arrive as one webhook per photo, in any order, sharing LINE's `imageSet` ID, which is stored on each message; the bot sends one "saved N photos" card per batch, grouped by that ID.
- Drive root folder: the folder the bot creates in the Owner's Google Drive is named "NongJoDII".
- Drive history: the database keeps Drive connections as history, with one active connection per Project, and each saved file record names the Drive connection it was saved through, so it is always known which Drive holds a file.
- Dashboard access (#17): the Dashboard server (`src/server/dashboard/load.ts`) takes the person only from the verified LIFF ID token. A person is a member of a Project's group when they are named in the setup form, send a message in it, open the LIFF from it (the weekly insight's button carries the group; LINE's member profile API must list the person), or join it after the bot; each path writes a `group_members` row. A **Member** sees only the groups where they are a live member, with those groups' Tasks. A **PM** (the Project's Owner, or a member with `group_members.is_pm` set) sees every group of the Project, except a group they left. A person with no live membership in any group of a Project is refused (403). A member who leaves (`left_at` set) loses access to that group at once; their Done Tasks keep their LINE name. Groups the bot has left, and groups not yet in a Project, are never shown. Nothing sets `is_pm` yet: until the team adds a way to mark a PM (open decision 3 in the initial schema), the Project's Owner is the PM.
- UI status labels: รอรับ or ยังไม่มีผู้รับ (Not Assigned), กำลังทำ (In Process), เสร็จ (Done). The bot warns the group at 80% of the Fair-use cap.

## Stack

- One Next.js app in TypeScript: webhook, Drive calls, AI calls and the LIFF pages.
- LINE Messaging API for the bot. LIFF pages for setup, Task review and the Dashboard; the design calls them the Mini App, with the tabs My tasks, Dashboard and Settings. Publishing a LINE MINI App, which needs LINE review, is out of scope.
- Supabase (Postgres) for messages, groups, Projects, Tasks, file records, usage and insights. Supabase `pg_cron` runs a scheduler tick every 15 minutes by calling the app's tick route over HTTP; each group is served at the reminder and weekly summary times it chose.
- Google Drive API with the `drive.file` scope, writing to the Owner's own Drive.
- OpenRouter for two model roles: a text model (Summaries, Task splitting) through chat completions, and a decision model (tagging progress updates). The decision model is TypeSafe Jev (`typesafe/jev-1.14`), called through OpenRouter's Decisions API (`POST /api/alpha/decisions`, `src/server/llm/openrouter-decisions.ts`, the `DecisionsPort` in `src/server/ports.ts`); it answers typed questions with probabilities, not text (decided 2026-11-17). It sees only chat lines that pass the keyword gate (`src/server/progress/keywords.ts`); other lines make no AI call (#132). When it does not answer (refusal, error, Fair-use cap), the group gets the free picker; there is no chat-model fallback. Jev also reads a Summary's chat first (#157, `src/server/summary/precheck.ts`): with no work in it (`has_task` < 0.5) the text model writes the summary only, with no Task candidates; otherwise the prompt carries Jev's count (one, 2 to 3, 4 or more), and a first answer with fewer Tasks than the count's minimum (one 1, 2 to 3 needs 2, 4 or more needs 3, since Jev often calls a 3-Task chat "many") gets one retry. The retry merges: every Task of the first answer stays, and a retry Task is added only when it is not already there (same title after trim, space collapse and lowercase, and the same source message when both name one); a card still short says "อาจมีงานเพิ่ม". At most one Jev call and two text calls per Summary; a Jev failure keeps the single text call. The whole Summary runs in one 50 s budget (`SUMMARY_BUDGET_MS`), counted from the start of its work, inside the webhook route's 60 s `maxDuration` and the reply token's life: each AI call gets the smaller of its own cap (Jev 15 s, text 45 s) and the time left. Jev is skipped below 30 s left (the old single text call runs), and the second text call (retry or plain prompt) below 15 s left; a short first answer then still says "อาจมีงานเพิ่ม". A budget spent before the first text call fails like a timed-out call (SUM-AI-TIME).
- Microsoft Clarity on the LIFF pages for usage funnels.
- Secrets come from environment variables; `.env*` is git-ignored. Only `NEXT_PUBLIC_*` values reach the browser.

## Review rules

The rules that code must follow live in `.greptile/rules.md`, the single source for people, agents and Greptile.

## Tests

Tests run through two in-process seams with fakes for LINE, OpenRouter, Google Drive and Supabase:

1. Event seam: webhook payloads and scheduled ticks go in; replies, pushes, stored rows, Drive uploads and usage come out.
2. Dashboard read seam: the Dashboard data as seen by a PM, a Member and an outsider.

Each issue lists its required test cases.

## Constraints

- No running cost for the team: free tiers, files in the Owner's Drive, AI capped per Owner.
- Every team member must be able to explain all the code, including AI-written code.
- The free Supabase project pauses after a week without use.

## Out of scope

Payments and paid plans (the plan screens are a static mock), organization features, publishing a LINE MINI App, any surface outside LINE, a message queue, and importing chat from before the bot joined.

## Open decisions

None right now. The ten open decisions of the first draft were settled on 2026-11-11; see "Decided 2026-11-11".
