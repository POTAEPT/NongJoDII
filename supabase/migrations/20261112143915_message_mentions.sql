-- Mentions on group text messages (Summary assignee, #5/#15). LINE puts the tagged
-- people in message.mention.mentionees[]; the text only shows display names, which
-- two Members can share. Stored as a JSON array of
--   {"index": int, "length": int, "type": "user" | "all", "userId": string | null}
-- where index/length count UTF-16 code units of messages.text (the Messaging API's
-- character unit) and userId is null when LINE leaves it out (type "all", or the
-- tagged person has not consented to profile access). Null when nobody is tagged.
-- No foreign key: a tagged person may never have written in the group.
alter table public.messages
  add column mentions jsonb,
  add constraint messages_mentions_is_array
    check (mentions is null or jsonb_typeof(mentions) = 'array');
