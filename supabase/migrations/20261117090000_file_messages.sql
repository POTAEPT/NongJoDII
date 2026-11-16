-- #140: every message that carried a saved file stays linked to it.
--
-- files keeps one row per content (files_one_per_hash) and files.message_id names the
-- message it was first saved from. A re-sent file used to move files.message_id to the
-- newest message (linkFileToMessage), so "น้องจดดี ขอไฟล์" quoting the first message
-- found no file. Now a re-send adds a row here and files.message_id stays.
--
-- No backfill: links moved before this migration cannot be told apart; the first message
-- of such a file keeps answering "no file" until it is sent again.

create table public.file_messages (
  file_id     uuid not null references public.files (id) on delete cascade,
  -- An unsend deletes the message row and its link; the saved file stays.
  message_id  uuid not null references public.messages (id) on delete cascade,
  linked_at   timestamptz not null default now(),
  primary key (file_id, message_id)
);

-- findQuotedFile looks a message up by message_id.
create index file_messages_message_id_idx on public.file_messages (message_id);

comment on table public.file_messages is
  'Later messages that carried an already saved file (same hash), so a quote-reply to any of them finds the Drive link (#140).';

alter table public.file_messages enable row level security;
