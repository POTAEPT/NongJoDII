# Plan: #33 File request by quote-reply

Issue: https://github.com/POTAEPT/NongJoDII/issues/33
Status: blocked by #4 File saver (natakron-oss), which has no code, branch or PR yet. #1 and #24 are done.
Estimate: about 2 hours after #4 merges. Steps 1 and 2 can start now.

## Goal

A person quote-replies to a saved file's message with "NongJoDII ขอไฟล์". The bot replies (no push) with that file's Drive link. LINE never returns quoted content, so the bot finds the file through `quotedMessageId` and its stored copy of the quoted message.

## Steps

1. Command parse (can start now): add "NongJoDII ขอไฟล์" to `src/server/commands/parse.ts` and its tests (`test/command-parse.test.ts`).
2. Read `quotedMessageId` from the text message event (`src/server/line/types.ts`). It exists only on text and sticker replies.
3. After #4: look up the stored message by `quotedMessageId`, then the `files` row by `message_id`, then the Drive link.
4. Reply with the link. Bots cannot send LINE file messages, so the answer is the link. The link opens without a Google account (the Project folder is shared as "anyone with the link can view", #13).
5. Short replies for: a quote of a message with no saved file; the command with no quote (how to use it); a quoted message that was unsent (#24 deleted it).

## Tests (event seam)

- Quoted saved file, quoted non-file, no quote, unknown quoted message, unsent message.

## Done when

`npm test`, `npx tsc --noEmit` and `npm run lint` pass; PR to `development` with "Refs #33".
