# /demo simulator contract

Shared contract between the demo server (`src/server/demo/*`, `src/app/demo/api/**`) and the demo UI (`src/app/demo/*` pages and `_components`). Plan: `/Users/mac/.claude/plans/read-this-https-claude-ai-artifact-qm9pi-dapper-deer.md`.

## Gate

Every `/demo` page and `/demo/api/**` route answers 404 unless `process.env.DEMO_MODE === '1'`, and also on any Vercel deployment: `process.env.VERCEL === '1'`, or `VERCEL_ENV` is `production` or `preview`. The simulator runs on a developer's machine only. Helper: `src/server/demo/gate.ts` exports `demoEnabled(): boolean`.

## Constants

- Demo LIFF ID: `demo-liff`. Bot LIFF links therefore look like `https://liff.line.me/demo-liff?view=<view>&id=<id>`.
- The UI opens such a link in the LIFF drawer with that view and id. The page `/demo?view=<view>&id=<id>` opens the drawer on load (used by the Google callback page).
- Demo ID token: `demo:<lineUserId>`. Only the demo LINE port accepts it.
- Groups: the world holds several LINE groups. Group IDs are `Cdemo` + zeros + a number, 33 characters; the first is `Cdemo0000000000000000000000000001`, name `ทีมพิตช์ NongJoDII`. One group is **selected** (the one the phone shows); every sim route that acts on a group takes an optional `group` (a lineGroupId) and defaults to the selected group.
- Seeded personas: `nont` (Nont, manager, Owner), `tae` (Tae, developer), `bomb` (Bomb, designer), `jeff` (Jeff, marketing). LINE user IDs: `Udemo...a01`, `a02`, `a03`, `a04`, padded to 33 characters.

## Same-path API for the LIFF views

`/demo/api/<path>` has the same body and answer as `/api/<path>` for: dashboard/load, me/load, me/save, review/load, review/notify, review/submit, settings/load, settings/stop-using, settings/submit, setup/confirm-owner, setup/load, setup/resend-card, setup/submit, takeover/answer, takeover/load, tasks/load, tasks/update, progress/answer, google/start, google/status, google/disconnect. It also serves `GET /demo/api/google/callback`, and its "back to LINE" link points to `<origin>/demo?view=google&id=done|back`.

## Sim API (`/demo/api/sim/*`, JSON in and out)

| Route | Body | Effect |
| --- | --- | --- |
| `GET state` | none | `DemoState` (below). Reading it changes nothing |
| `POST select-group` | `{group}` | Selects (opens) that group; its unread count goes to 0. Unknown group: 404 |
| `POST create-group` | `{name, members: string[] /* persona keys */, mode: 'new-project' \| 'sub-group', parentGroup?: string}` | Creates the group, selects it, the bot joins (setup card) and learns the members silently. `sub-group` then attaches it to `parentGroup`'s Project (below). Also saves it as a group file (see "Groups"). Answers `{lineGroupId, file /* e.g. '04-group.json'; null: not saved */}` |
| `POST delete-group` | `{group}` (a lineGroupId, required) | Deletes the group's file and removes the group from the world and the store (see "Groups"). 400 while another file names it as `parent`, or when it is the only group; 404 for an unknown group. Answers `{deleted, file, selectedGroup}` |
| `POST send` | `{group?, persona, type:'text', text, quotedMessageId?, mentions?: string[] /* persona keys */}` or `{persona, type:'image', fileName, contentType, dataBase64, imageSet?: {id, index, total}}` or `{persona, type:'file', fileName, contentType, dataBase64}` or `{persona, type:'sticker'}` | Builds a LINE message event, signs it, calls `handleWebhookRequest`. Answers `{messageId}` |
| `POST message` | `{group?, persona, text}` | External injection API; same as a text `send` |
| `POST postback` | `{group?, persona, data, params?: {date?: string, time?: string, datetime?: string}}` | Postback event |
| `POST unsend` | `{group?, persona, messageId}` | Unsend event; the chat item gets `unsent: true` |
| `POST join` | `{group?}` | Bot joins the group (join event) |
| `POST leave-bot` | `{group?}` | Bot is removed (leave event) |
| `POST member-join` | `{group?, persona}` | memberJoined event |
| `POST member-leave` | `{group?, persona}` | memberLeft event |
| `POST clock` | `{advance: '1h' \| '1d' \| 'next0900' \| 'nextMon0900' \| {ms: number}, runTick?: boolean /* default true */}` | Moves the demo clock, then runs `runTick` |
| `POST tick` | `{}` | Runs `runTick` at the current demo time |
| `POST quota` | `{limit?: number \| null, used?: number}` | Sets the push quota |
| `POST persona` | `{key, lineName, role?, owner?}` | Adds or updates a persona (does not join it to the group) |
| `POST reset` | `{setup?: boolean}` | Wipes everything and reseeds (see "Seed" below) |
| `POST weekly` | `{group?}` | The weekly post on demand: moves the demo clock to the next weekly slot (`weekly_summary_weekday` / `weekly_summary_time`; no schedule row = Monday 09:00) of `group`'s Project main group (a group with no Project: the main group whose slot comes first), then runs `runTick`. The main group posts its weekly card (#21) and the Project's Owner gets the per-person card (#120) in their 1:1 chat (`direct.<owner>`, cost 1). "Now" when the slot is reached today and not yet run. A week that already ran (the main group's `weekly_insights` row or the `owner_insight:<projectId>:<weekStart>` ledger row) is skipped, so a second call gives the next week's card. Every other group whose slot the new time reaches posts too, as on a real tick. The clock never moves back. Answers `{now, group /* the main group */, owner /* persona key or null */, ownerCards /* new items in direct.<owner> */}`; 400 when no Project main group has a confirmed Owner |
| `POST send` with `direct: true` | `{persona, type:'text', text, direct: true}` | A text in the persona's **1:1 chat** with the bot (`source: {type:'user', userId}`), through `handleWebhookRequest`; the Rich Menu tiles send their words this way. The bubble goes to `direct.<persona>`; the reply to that event's token lands in the same 1:1 thread (DemoLine maps 1:1 reply tokens to the persona), never in a group. Text only (400 otherwise). Answers `{messageId}`. `POST message {persona, text, direct: true}` is the same |
| `POST postback` with `direct: true` | `{persona, data, direct: true}` | A 1:1 postback (for example the Drive card's "ไว้ทีหลัง"). The bot records 1:1 postbacks and answers none |
| `POST follow` | `{persona}` | The persona adds the OA as a friend: a system line in `direct.<persona>`, then a follow event; the bot answers with the Google Drive card |
| `POST open-direct` | `{persona: string \| null}` | The phone shows that persona's 1:1 chat (its unread goes to 0 and stays 0 while open); `null`: none. `select-group` also clears it. The selected group does not change |
| `POST load-script` | `{name: string}` (a file in `src/app/demo/scripts/`) or `{script: DemoScript}`; `delayMs?` (default 1200); `group?` | Plays the script's messages into that group (fixed at the call) in the background, one per delay, then the summary command if present. Answers `{steps, delayMs, group, joined}` |

Errors: `{error: string}` with 400 or 404.

## DemoState

```ts
type DemoState = {
  now: string                // demo clock, ISO
  liffId: 'demo-liff'
  group: { lineGroupId: string; name: string; botInGroup: boolean }   // the selected group (kept for compatibility)
  groups: Array<{
    lineGroupId: string; name: string; botInGroup: boolean
    projectName: string | null   // the Project's main group name; null = not set up
    isSubGroup: boolean
    members: number              // people + the bot, as LINE's header counts
    lastMessage: { text: string; at: string } | null   // "Nont: ..." preview
    unread: number               // non-system items since the group was last open; 0 for the selected one
    file: string | null          // its file in src/app/demo/groups/ (comes back after Reset); null: none
  }>
  selectedGroup: string      // lineGroupId
  personas: Array<{ key: string; lineUserId: string; lineName: string; role: string | null; owner: boolean; inGroup: boolean /* in the selected group */ }>
  quota: { limit: number | null; used: number }
  ai: {
    model: string | null; lastCallFallback: boolean; busy: boolean
    calls: Array<{ id: string; at: string; kind: 'summary' | 'progress' | 'tags' | 'other'; model: string
      inputTokens: number; outputTokens: number; costUsd: number | null; estimated: boolean; fallback: boolean }>  // last 50, oldest first
    totalUsd: number         // every call since the last reset
  }
  google: { connected: boolean; email: string | null }
  chat: ChatItem[]           // the selected group's chat, oldest first
  direct: Record<string, ChatItem[]>   // the bot's 1:1 chat per persona key, oldest first: 1:1 messages, replies, pushes (the Owner card)
  directChats: Array<{       // one row per persona, empty threads included: the phone's "NongJoDII (แชตส่วนตัว)" entry for "me"
    persona: string
    lastMessage: { text: string; at: string } | null   // no name prefix (a 1:1 chat)
    unread: number           // non-system items since the thread was last open; 0 while open
  }>
  openDirect: string | null  // the 1:1 thread open on the phone (persona key)
  log: Array<{ at: string; kind: 'event' | 'reply' | 'push' | 'error' | 'tick'; summary: string }>  // newest last, max 200
}

type ChatItem = {
  id: string                 // chat item id
  at: string                 // demo time, ISO
  from: 'user' | 'bot' | 'system'
  persona?: string           // persona key, for from = 'user'
  messageId?: string         // LINE message id, for user messages (used by reply-quote and unsend)
  unsent?: boolean
  via?: 'reply' | 'push'     // for bot messages
  message:
    | { type: 'text'; text: string; quotedMessageId?: string }
    | { type: 'image'; url: string; fileName: string }            // url = /demo/api/sim/content/<messageId>
    | { type: 'file'; url: string; fileName: string; size: number }
    | { type: 'sticker' }
    | { type: 'system'; text: string }                            // e.g. "Tae joined", "NongJoDII left"
    | LineMessage                                                  // bot output: text | flex | template, see src/server/line/types.ts
}
```

`GET /demo/api/sim/content/<messageId>` serves the bytes of an uploaded image or file.

## Server additions (implemented, compatible with the above)

- **Seed.** `POST reset` default (`setup: true`) seeds the groups of `src/app/demo/groups/` (see "Groups"). The three shipped files seed three groups with Nont in all, the bot in each, Nont the confirmed Owner of each, and every person a live Member with nicknames นนท์ / เต้ / บอม / เจฟ and their roles:
  - `ทีมพิตช์ NongJoDII` (`...0001`): main group of Project A; nont, tae, bomb, jeff. Selected.
  - `ทีม Dev` (`...0002`): Sub group of Project A; nont, tae.
  - `ลูกค้า ร้านกาแฟ` (`...0003`): main group of Project B; nont, bomb, jeff.

  Each has 3 to 4 Thai Tasks in the store (assignees, dues relative to now, open, done and exactly one overdue) and a few chat lines; the two other groups start with 2 unread. For the Owner card (#120) every count shows: Tasks in process, one done this week per group (done_at earlier this Bangkok week), the overdue one, and one stale Task (last update 6 days ago) in each main group. The weekly slot of each **main group** is set near the reset, so "done this week" usually holds when the card fires (not for `ลูกค้า ร้านกาแฟ` after a Sunday reset: its slot falls in the next week): `ทีมพิตช์ NongJoDII` on the reset day's weekday, `ลูกค้า ร้านกาแฟ` the next day, both at the next full Bangkok hour (23:00 at the latest). The Sub group keeps the default (Monday 09:00). The Dashboard as Nont lists all three. `{setup: false}` keeps one fresh group (`...0001`, the four personas, the bot not in it, no store row) for the onboarding demo (join, setup card, setup LIFF, Owner confirm).
- **Replies and pushes** land in the chat of the group they target: DemoLine maps each reply token to the group of the event that carried it, and a push goes to the group named by `to`. Push cost counts that group's members.
- **Sub group path.** The bot code has no user-facing way for a group to join an existing Project (the "Sub group attach flow" is referenced but not built; confirming an Owner always creates a new Project). So `create-group` with `mode: 'sub-group'` writes the store after the join, as the seed does: the group's `projectId` is the parent's Project, its Owner is that Project's Owner (one admin per Project), confirmed now, and `isMain` is false. It answers 400 when the parent has no Project with a confirmed Owner, or the Project's Owner is not in `members`.
- **AI calls.** Each finished call of the demo AI is recorded: the cost OpenRouter reported (`usage.costUsd`), else the tokens at the app's price (`src/server/usage/pricing.ts`, `estimated: true`), else `null` ("n/a"). A canned fallback costs 0 and has `fallback: true`. `kind` comes from the schema (`summary`, `progress_decision`) or a prompt that mentions tags. The UI shows one Sonner toast per call id (kept until closed, stacked), remembered in `localStorage` so a reload does not repeat them, and lists the calls in the AI tab.
- `GET scripts` lists the playable scripts: `{scripts: [{name, description, messages}]}`, read from `src/app/demo/scripts/*.json` on every request, sorted by file name. `load-script` accepts the name with or without `.json`; a name that is not a plain file name (letters, digits, `-`, `_`) answers 400, an unknown one 404. A file with invalid JSON or no `messages[]` is left out of the list and logged as `error`.
- `join` on a group that is not set up (no Project, no confirmed Owner): after the join event, every persona in the group that is not yet a live Member is written to the store as a live Member (LINE name only, no role: roles come from the setup form). No chat item and no message event; the log says "members learned silently". So the setup form lists everyone at once. (In real LINE the bot learns a Member from their first message.)
- While the bot is not in a group, `send`, `postback`, `unsend` and member events still change that group's chat and members, but no event reaches the bot (as in LINE); the log says "not delivered".
- `load-script` into a group that lacks a speaker: before the first message, each such persona joins the group (a memberJoined event, so the bot's welcome card shows) and gets their nicknames and role in the store, as if they filled in "ข้อมูลของฉัน". The answer's `joined` lists them.
- `join` on a set-up group still gets the real join reply (the setup card); that is the bot's own behaviour.
- Push cost: one per member in the group, per push call. A push that would pass `quota.limit` is refused like LINE's 429 (logged as `error`).
- The canned AI answer (no key, error, or over 20 s) is built from the prompt: a short Thai summary of the chat, and a task only for a line with ฝาก / รบกวน / ช่วย / ขอให้ that names another member. `ai.model` is `demo/canned` after a fallback.
- Types: `src/server/demo/types.ts` exports `DemoState`, `ChatItem`, `ChatMessage`, `DemoPersona`, `DemoScript` (import them type-only from the UI).
- Scripts use relative deadlines ("พรุ่งนี้ห้าโมงเย็น", "วันศุกร์นี้") so they never go stale; their `expectedTasks[].due` and `fakeModelAnswer` dues are words, not ISO instants.

## Groups

The set-up seed is a folder of group files, `src/app/demo/groups/*.json`, one group per file. `POST reset` (default `setup: true`) and the first build after a server start read the folder, so a group saved there comes back after every Reset and every restart. `{setup: false}` (the onboarding demo) ignores the folder and keeps its single fresh group. Code: `src/server/demo/group-files.ts` (read, write, delete) and `seedSetUpWorld` in `src/server/demo/demo-deps.ts`.

- **Reading.** Files are read in file-name order; the groups appear in that order and the first is selected (the others keep their last two chat lines unread). A file name is letters, digits, `-` and `_` only. A file that is not valid JSON, misses a required field, reuses another group's `lineGroupId`, has an owner who is not a member, or names a parent that is missing, skipped or not a main group is skipped and logged as `error`. Unknown persona keys are left out (logged). A Sub group listed before its parent waits until the parent is seeded.
- **Fallback.** Only when the folder does not exist (or holds no usable file) does the seed use the built-in definitions (`FALLBACK_GROUPS`, the same as the three shipped files).
- **Shipped files.** `01-main.json` (`ทีมพิตช์ NongJoDII`), `02-dev.json` (`ทีม Dev`, Sub group of `01-main.json`), `03-cafe.json` (`ลูกค้า ร้านกาแฟ`).

Each seeded group is set up: the bot is in it, its Owner is confirmed, every member is a live Member with their nicknames and role, and it gets the file's Tasks and chat lines.

### File shape

```jsonc
{
  "name": "ทีม Dev",                                  // 1-50 characters
  "lineGroupId": "Cdemo0000000000000000000000000002", // stable: C + letters or digits
  "members": ["nont", "tae"],                         // persona keys
  "owner": "nont",                                    // persona key, a member
  "mode": "sub-group",                                // "new-project" | "sub-group"
  "parent": "01-main.json",                           // sub-group only: the parent's file name
  "workDescription": "พัฒนาแอปเดโม NongJoDII ให้พร้อมพิตช์", // optional
  "weekly": { "dayOffset": 0 },                       // optional; or {"weekday": 1, "time": "09:00"}
  "dailyReminderTime": "18:00",                       // optional
  "tasks": [                                          // optional
    { "title": "...", "assignee": "tae", "due": { "days": 2 }, "status": "in_process" },
    { "title": "...", "assignee": "tae", "due": { "days": -1 }, "status": "done", "doneAt": { "hours": -2, "thisWeek": true } },
    { "title": "...", "assignee": "jeff", "due": { "days": -1, "hour": 17 }, "status": "in_process", "lastUpdate": { "days": -6 } }
  ],
  "chat": [ { "persona": "tae", "text": "...", "minutesAgo": 70 } ] // optional, oldest first
}
```

- **Offsets** (`due`, `doneAt`, `lastUpdate`) are relative to the reset instant: `days`, `hours`, `minutes` are added; `hour` then pins that day's Bangkok hour (minute 0). `doneAt.thisWeek` keeps it at or after this Bangkok week's Monday 00:00 (the Owner card's "done this week"). No `due`: no deadline. A done Task without `doneAt`: an hour ago, or its due if earlier. Last update: `doneAt` for a done Task, else `lastUpdate` (6+ days back is stale), else the announce time (3 hours ago).
- **`weekly.dayOffset`**: the slot that many days after the reset day, at the next full Bangkok hour (23:00 at the latest). No `weekly`: the schema default (Monday 09:00).
- A `sub-group`'s Owner is always its parent Project's Owner (one admin per Project); a different `owner` is logged and replaced.

### Create and delete

- **Create.** `create-group` writes `NN-<slug>.json`: `NN` one past the highest number in the folder, `<slug>` the name in lowercase ascii letters and digits (a Thai name gives `group`). The file holds `name`, `lineGroupId`, `members`, `owner`, `mode` and, for a Sub group, `parent` (the parent group's file). No Tasks, no chat: after a Reset the group is back set up with an empty chat. The Owner of a new Project is the owner-flagged persona (Nont) when a member, else the first member. The new group's `lineGroupId` is never one a group file holds. The folder is never created: when it is missing, or the parent group has no file, the group is not saved (logged).
- **Delete.** `delete-group {group}` deletes the file, then removes the group from the world and every store row with its group id (and its Project when no other group is in it), so the Dashboard no longer lists it. If it was selected, the first group is selected. Refused (400) while another file has it as `parent`: delete the Sub group first. The presenter panel's group picker has a delete button (with a confirm dialog) for the selected group.
- **Tests** never touch the shipped folder: `test/setup.ts` points `DEMO_GROUPS_DIR` at a temp folder holding the three built-in groups, and `setGroupsDir(dir)` overrides it per test. One test checks that the shipped files equal the built-in definitions.
- **Built-in groups** (the fallback) have `file: null`: there is no file to delete.

## How to add a scenario

See `docs/demo-scenarios.md`.

## 1:1 chat on the phone

The chat list has one more row, **NongJoDII (แชตส่วนตัว)**: the bot's 1:1 chat with the persona chosen as sender ("me"), with its last message, time and unread badge, shown even when empty ("ยังไม่มีข้อความ"). The UI keeps the server's `openDirect` equal to what the phone shows ("me" in the 1:1 view, else `null`), calling `open-direct` whenever `state.openDirect` differs (after a reset or a reload too). The thread uses the group chat's renderer, without read counts, reply or unsend. Under it is the OA's Rich Menu (#84): a "เมนู" bar that folds the team's Rich Menu image (`public/demo/rich-menu.png`, 2000x1349) with three tap areas: the top half sends "Dashboard", the bottom left "เชื่อมต่อ Google Drive", the bottom right "ตั้งค่า", and a keyboard button that swaps in a text composer. Buttons in the thread act as in groups (uri buttons open the LIFF drawer), but their postbacks and message actions go out as 1:1 events. Any persona can be "me" there. The presenter's "ส่งสรุปรายสัปดาห์" (Clock tab, and "สรุปรายสัปดาห์" in the header) calls `weekly` for the selected group, then opens the Owner's 1:1 chat and shows a toast.
