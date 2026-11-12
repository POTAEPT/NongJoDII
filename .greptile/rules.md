# Review rules for NongJoDII

Product context, terms and decisions: `docs/PROJECT.md`.

Apply each rule to the code a pull request adds or changes. The code is still a scaffold and the issues land in order, so a PR is not at fault for behavior that belongs to a still-open issue. Each rule names its source. Rules marked "decided 2026-11-11" are newer than the issue text and win until the issues are updated; otherwise, when an issue's acceptance criteria differ from a rule, the issue wins.

## Webhook (#1)

- The LINE signature is checked before anything else uses the request. Compute HMAC-SHA256 over the exact request body string (UTF-8), keyed with the Messaging API channel secret, Base64-encode it, and compare it with the `x-line-signature` header. Parse, reformat or unescape the body only after the check passes.
- A missing or wrong signature ends the request with an error, and nothing is stored or processed.
- Each event is stored once, keyed on `webhookEventId`. LINE can deliver the same event again with the same ID (`deliveryContext.isRedelivery` is then true), and events can arrive out of order, so ordering uses the event `timestamp`.
- The handler returns 200 right after storing the event. AI calls, Drive uploads and pushes run after the response (for example in `after()` from `next/server`). There is no queue.

## Tasks and AI (#5, #6, #7)

- Model output is a proposal. A Task is created only after a person confirms it (#5), and its status changes only on a person's explicit answer: Yes to "Mark as Done?" (#7) or an answer to a reminder (#8). No code path writes a Task straight from model output.
- Editing, assigning and deleting a Task are person actions too. Delete asks for a confirm and offers undo (decided 2026-11-11).
- A button press in a group (such as I'll take it) is never assigned to a person from a missing `userId`: LINE guarantees `userId` only on message events, for iOS and Android users, so when it is absent the bot opens a LIFF page and LINE login identifies the presser (decided 2026-11-11).
- A new Task gets the tagged person as owner, otherwise Not Assigned, and the confirmer is recorded as creator (#5). Status values are Not Assigned, In Process and Done (#7).
- Summarize answers both "NongJoDII summarize" and "NongJoDII สรุปหน่อย". Reminder answers come from buttons, with "NongJoDII done" and "NongJoDII need time" as typed fallbacks (decided 2026-11-11).
- Every AI call records the token counts from its response against the Owner's usage, summed across every group the Owner admins, in tokens and dollars (#6).
- At the Fair-use cap, the group gets a message with the reset time, and summarizing stops until the month resets (#6).
- When the decision model fails, the bot falls back to the text model or asks the user, and the message is kept (#7).

## Google Drive and files (#3, #4, #11)

- Google sign-in requests the `drive.file` scope (#3).
- Drive folders are stored and looked up by ID, never by name (#3).
- The Google refresh token is stored encrypted (#3).
- When Drive access is lost, Tasks stay and the Owner is asked to sign in again (#3).
- A file is downloaded from LINE as soon as its message arrives; a duplicate (same hash) is saved once (#4).
- No code deletes files in the Owner's Drive, the removal job included (#11).
- When the Owner connects Google Drive, each Project folder is shared once as "anyone with the link can view" and saved files rely on that inherited sharing; no code shares files one by one or with named accounts (decided 2026-11-11).
- A reply that quotes a saved file message with the command "NongJoDII ขอไฟล์" is answered with that file's Drive link as a reply, never a push. The file is found from the reply's `quotedMessageId` through the stored copy of the quoted message, never from quoted content, which LINE does not return; the answer is the link, not a LINE file message (decided 2026-11-11).
- The "saved" card is sent as a reply when the file is saved within about 50 seconds of the webhook, and as a push otherwise; the push adds to the push count and is skipped near the monthly quota limit (decided 2026-11-11).
- The LINE `imageSet` ID is stored on each image message, and photos sharing it get one "saved N photos" card per batch, never one card per photo and not dependent on webhook arrival order (decided 2026-11-11).
- The folder the bot creates in the Owner's Drive is named "NongJoDII" (decided 2026-11-11).
- Drive connections are kept as history, with at most one active connection per Project, and each saved file record stores the Drive connection it was saved through; no code overwrites or deletes a connection row that a file record points to (decided 2026-11-11).

## Groups, Owner and access (#2, #9)

- The Owner role takes effect only after the person the setup form names confirms with LINE login. The Owner is that group's admin (decided 2026-11-11).
- The picker that attaches groups to a Project lists only the groups the requesting user admins (decided 2026-11-11).
- Project members are the people named in the setup form plus anyone who sent a message in one of its groups, opened the LIFF from one, or joined one after the bot; a member who left a group has no access (decided 2026-11-11).
- On a LINE `memberLeft` event, the person's open Tasks in that group are set back to Not Assigned and one push posts a card listing them with Assign and I'll take it buttons; Done Tasks keep the person's name; the person is marked as left and the Dashboard refuses them (decided 2026-11-11).
- On a LINE `memberJoined` event, the person is stored as a Member at once, named from their LINE profile, and the bot answers with a reply (never a push) carrying a short welcome and a button to the setup form for nickname and role; the Owner can edit nicknames and roles in Settings (decided 2026-11-11).
- When the Owner leaves a group, file saving and Summaries stop for that group while Tasks, reminders and the Dashboard keep working; the bot posts a card asking someone to become Owner, and the role changes only after that person confirms with LINE login and connects their Drive; files already saved stay in the old Owner's Drive (decided 2026-11-11).
- If no new Owner is confirmed within 7 days after the Owner left, the bot leaves the group, which starts the 7-day deletion in "Removal and unsend"; a re-invite inside those 7 days clears the mark (decided 2026-11-11).
- When the main group gets a new Owner, the Project's Sub groups change Owner only after that Owner confirms the take-over; with it, their plan, Fair-use cap and Drive follow and old files stay in the old Owner's Drive, and without it the Sub groups detach from the Project and need their own setup and Owner. If the new Owner confirms but never answers the take-over question, the Sub groups wait paused for 7 days, then detach from the Project and need their own setup and Owner (decided 2026-11-11).
- While a Project's Owner change is pending, the main group may name a new Owner who has not confirmed yet (decided 2026-11-11).
- Re-inviting the bot to a group that still has no confirmed Owner restarts the 7-day count (decided 2026-11-11).
- On an Owner change the old Drive connection is retired (kept as history) and the folder IDs are cleared, so the new Owner connects their own Drive; old files stay in the old Drive (decided 2026-11-11).
- Nicknames from the setup form are used only by the AI to work out who a chat message is about; pickers, cards and the Dashboard show LINE names, never nicknames (decided 2026-11-11).
- The daily tick checks each known member of a group with LINE's group member profile API; a 404 marks the person as left and applies the `memberLeft` rule above, in case the leave event was lost (decided 2026-11-11).
- Dashboard data is limited to what the requester may see: a PM sees all groups of the Project, a Member only their own groups and Tasks, and an outsider is refused (#9).

## Scheduling and pushes (#8, #10)

- The scheduler tick comes from Supabase `pg_cron` every 15 minutes and enters the same handler as the webhook (#8, decided 2026-11-11).
- Daily reminders and the weekly insight go out at the group's own chosen time, not at a fixed system time; each tick serves the groups whose chosen time has come (decided 2026-11-11).
- Reminders and flags are posted in the group where the Task lives, never in a 1:1 chat (#8, decided 2026-11-11).
- Every push adds to the push count kept against the LINE monthly quota. Near the limit, the bot stops pushing and the items show on the Dashboard only (#8, decided 2026-11-11).
- The "Tasks created" message goes out as the member's own LIFF message (liff.sendMessages) when possible; otherwise `/api/review/notify` pushes it once per Task (claimed through `tasks.announced_at`), checks LINE's quota API first and skips the push when it would use the last 10% of the monthly quota (the 10% reserve is an agent choice, 2026-11-12). The LIFF page uses sendMessages only when it was opened from a group chat.
- Message refs in the Summary prompt (msg1, msg2...) never reach text people read; leaked ones are stripped (decided 2026-11-12).
- The weekly insight is counts from code, posted to the group; it makes no AI call (decided 2026-11-11, replaces the AI paragraph in #10).
- Every onboarding setting (what the group works on, members' nicknames and roles, the features in use, the Owner, and the reminder and weekly summary times) is editable later in Settings (decided 2026-11-11).

## Removal and unsend (#11)

- When the bot leaves a group, that group's data is marked for deletion 7 days later; the scheduler tick purges only past-due rows, and a re-invite inside 7 days clears the mark (#11).
- Stop using in Settings makes the bot leave the group, so the rule above applies (decided 2026-11-11).
- When the bot leaves a group by itself (no new Owner after 7 days, or Stop using), the 7-day deletion mark is set as soon as the leave API call is accepted, not when a `leave` event arrives (decided 2026-11-11).
- An unsend event deletes the stored copy of that message; confirmed Tasks stay (decided 2026-11-11).

## Tests

- New behavior ships with the test cases its issue lists.
- Tests assert external behavior through the two seams in `docs/PROJECT.md`: replies, pushes, stored rows, Drive uploads, usage and Dashboard data. A test that checks which internal function ran, or the exact prompt text, gets a comment.

## Cost and terms

- A new external service or dependency that would bill the team gets a comment: the project must create no running cost (course rule).
- Plan screens are a static mock; payment code gets a comment (decided 2026-11-11).
- Domain names in code and comments use the terms in `docs/PROJECT.md` (Project, Sub group, Owner, Member, PM, Dashboard, Summary, Task) rather than synonyms such as workspace, admin, todo or ticket. LINE and Google API field names, such as `userId`, keep their own names.

## Baseline (security practice, not from an issue)

- Signatures are compared with a constant-time check, never with `===`.
- The Dashboard server takes the user from a LIFF ID token it verified itself; a user ID sent by the client is never trusted.
- The tick route accepts only calls that carry the scheduler's secret.
- Secrets come from environment variables and are never committed; `.env*` stays git-ignored.
- Server secrets never carry the `NEXT_PUBLIC_` prefix. Client code reads only `NEXT_PUBLIC_*` values, such as the LIFF ID and the Clarity project ID.
- Logs carry IDs and event types, never tokens, secrets or chat text.
- Routes, query strings and page titles carry IDs only, never Task titles, names or chat text: Clarity records URLs and titles outside the `<body>` text mask.
