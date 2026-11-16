# /demo simulator contract

Shared contract between the demo server (`src/server/demo/*`, `src/app/demo/api/**`) and the demo UI (`src/app/demo/*` pages and `_components`). Plan: `/Users/mac/.claude/plans/read-this-https-claude-ai-artifact-qm9pi-dapper-deer.md`.

## Gate

Every `/demo` page and `/demo/api/**` route answers 404 unless `process.env.DEMO_MODE === '1'`, and also when `process.env.VERCEL_ENV === 'production'`. Helper: `src/server/demo/gate.ts` exports `demoEnabled(): boolean`.

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
| `POST create-group` | `{name, members: string[] /* persona keys */, mode: 'new-project' \| 'sub-group', parentGroup?: string}` | Creates the group, selects it, the bot joins (setup card) and learns the members silently. `sub-group` then attaches it to `parentGroup`'s Project (below). Answers `{lineGroupId}` |
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

- **Seed.** `POST reset` default (`setup: true`) seeds three groups with Nont in all, the bot in each, Nont the confirmed Owner of each, and every person a live Member with nicknames นนท์ / เต้ / บอม / เจฟ and their roles:
  - `ทีมพิตช์ NongJoDII` (`...0001`): main group of Project A; nont, tae, bomb, jeff. Selected.
  - `ทีม Dev` (`...0002`): Sub group of Project A; nont, tae.
  - `ลูกค้า ร้านกาแฟ` (`...0003`): main group of Project B; nont, bomb, jeff.

  Each has 3 to 4 Thai Tasks in the store (assignees, dues relative to now, open, done and exactly one overdue) and a few chat lines; the two other groups start with 2 unread. The Dashboard as Nont lists all three. `{setup: false}` keeps one fresh group (`...0001`, the four personas, the bot not in it, no store row) for the onboarding demo (join, setup card, setup LIFF, Owner confirm).
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

## How to add a scenario

See `docs/demo-scenarios.md`.
