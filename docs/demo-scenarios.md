# Writing a /demo scenario

A **scenario** is one JSON file in `src/app/demo/scripts/`. The `/demo` LINE simulator plays it into the **selected group** (the one open on the phone, or the `group` given to `load-script`): people talk, then someone asks NongJoDII for a Summary, and the real bot code answers. The simulator reads the folder on every request, so a new file appears in the Scripts tab with no code change and no restart.

Scripts play into the selected group, which may be any group in the picker, including one saved as a file in `src/app/demo/groups/` (a group made with "สร้างกลุ่ม"; see "Groups" in `docs/demo-contract.md`).

The full simulator API is in `docs/demo-contract.md`. The shape the player reads is `DemoScript` in `src/server/demo/types.ts`.

## Steps

1. **Pick the point.** Write one sentence: which feature the scenario shows and what the bot must do (for example: "two tasks for different people, one without a deadline"). Done when the sentence names the expected number of Task candidates (0 or more), and who each one is for.
2. **Copy an existing file.** Use `01-clear-task.json` for a scenario that produces Tasks, `02-casual-no-task.json` for one that should not. Name the copy `<NN>-<short-name>.json`, using only letters, digits, `-` and `_`. `NN` sets the order in the Scripts tab, so take the next free number.
3. **Write the chat** (rules below). Done when every Task in step 1 has an asking line and an accepting line, and no other line reads as an assignment.
4. **Fill the fields** (table below). Set `description` to the step 1 sentence in Thai, ending with the expected result ("ผลที่คาด: ...").
5. **Check it live** (Verify below). Done when the bot's answer matches step 1: the same number of Task candidates, each for the right person.

## Fields

| Field | Required | What it holds |
| --- | --- | --- |
| `name` | yes | The file name without `.json`. |
| `description` | yes | One Thai sentence: what happens, then "ผลที่คาด:" and the expected result. The Scripts tab shows it. |
| `messages[]` | yes | The chat, in order. Each item: `id` (`m1`, `m2`, ...), `persona` (a persona key), `minute` (0, 1, 2, ...: order only, not real time), `text`. |
| `summaryCommand` | usually | `{persona, minute, text}`. It is sent after the last message. Use `NongJoDII สรุปหน่อย`. Leave it out only when the scenario stops before the Summary. |
| `personas` | no | The four seeded people exist in every reset. List a new key here only to bring in an extra person (a new persona). |
| `feature`, `startAt`, `group`, `expectedTasks`, `fakeModelAnswer`, `expect` | no | Notes in the e2e scenario shape. The player ignores them. Keep `expectedTasks` accurate anyway: people read it to know what the scenario should produce. |

People (persona keys):

| Key | LINE name | Thai nickname in chat | Role |
| --- | --- | --- | --- |
| `nont` | Nont | นนท์ | manager, Owner (the PM) |
| `tae` | Tae | เต้ | developer |
| `bomb` | Bomb | บอม | designer |
| `jeff` | Jeff | เจฟ | marketing |

Any speaker who is not in the target group joins it before the first message (a memberJoined event, then their nicknames and role are set), so a script written for four people also plays in "ทีม Dev" (Nont and Tae only). The other groups' chats do not change.

## Chat rules

- **No overlap with seeded Tasks.** The Summary never proposes a Task the group already has, even worded differently (#108). Before writing a scenario, read the target group's `tasks` in `src/app/demo/groups/*.json` and pick work that is not there. Otherwise the expected Task silently disappears.

- Write natural Thai group chat: short lines, the way a student team talks in LINE. Let everyone speak at least once.
- **Deadlines in relative words** ("พรุ่งนี้ห้าโมงเย็น", "วันศุกร์นี้"), never a fixed date. The demo runs on the real clock, so a fixed date goes stale before pitch day.
- **An asking line** for each Task names the person by Thai nickname and uses ฝาก, รบกวน, ช่วย or ขอให้ ("ฝากบอมอัปเดตสไลด์..."). Follow it with that person accepting ("ได้ครับ"). This wording lets the canned AI find the Task when OpenRouter is down. With the real model it is simply clear chat.
- In a no-Task scenario, keep those asking words out of the chat. Use plans and opinions instead ("กินร้านไหนดี").

## Verify

The demo server must be running: `DEMO_MODE=1 infisical run --env=dev -- npm run dev` in the repo root.

1. `curl -s localhost:3000/demo/api/sim/scripts`. Your `name` is listed. If it is missing, the file is not valid JSON or has no `messages`: the Log tab shows the reason.
2. In `/demo`, press Reset (the set-up groups of `src/app/demo/groups/`), pick the group in the presenter panel's group picker, then press Play on your scenario. The same can be done by API: `POST /demo/api/sim/load-script {"name":"<NN>-<short-name>", "group":"<lineGroupId>"}` (without `group` it plays into the selected group).
3. Wait for the bot's Summary card. Press "ตรวจและยืนยันงาน", then compare the Task candidates with step 1: same count, right people, deadlines read correctly. The AI tab shows whether the answer came from OpenRouter or from the canned fallback.

## New group on stage

How a group joins the bot in the demo, the same steps as in LINE (#151, #159):

1. **สร้างกลุ่ม** in the presenter panel: a name and the members. The bot joins and posts its setup card, which asks everyone to say hi. The bot knows no one yet, and the group picker shows "ยังไม่ตั้งค่า".
2. **ให้ทุกคนทักทาย** (under the group picker, shown while the bot does not know some members): each of them sends one greeting, and the bot learns them.
3. Tap **ตั้งค่า** on the setup card. In the form, pick a new Project or "attach to your Project" (a Project Nont owns: the group becomes its Sub group), then send it.
4. A new Project waits for its Owner: when someone else is named Owner, that persona confirms on the card that follows. A Sub group attached by the Project's Owner is confirmed at once.
5. Open the Dashboard as Nont: the group is listed. Its file in `src/app/demo/groups/` now records the outcome, so Reset brings it back set up.

