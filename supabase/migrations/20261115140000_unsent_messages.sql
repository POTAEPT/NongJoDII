-- #24 follow-up: an unsent message must not come back.
--
-- Before this, an unsend deleted the stored row and left nothing behind. When LINE then
-- delivered the original message event late (a redelivery after a 500, or a first delivery
-- that arrived after the unsend), insertMessage stored the text again, and it could reach a
-- later Summary. Now:
--   * unsent_messages keeps the LINE message ID of every unsent message (no text, no
--     sender, no group), as a tombstone;
--   * a BEFORE INSERT trigger on messages skips any row whose line_message_id has a
--     tombstone, so a late delivery stores nothing (the upsert answers no row, so the
--     webhook runs no Job for it);
--   * unsend_message writes the tombstone and deletes the row in one transaction.
-- Both take the same transaction-scoped advisory lock on the message ID, so an insert and an
-- unsend of one message run one after the other: either the insert commits first and the
-- unsend deletes it, or the tombstone commits first and the insert is skipped.

create table public.unsent_messages (
  line_message_id  text primary key,
  unsent_at        timestamptz not null default now()
);

comment on table public.unsent_messages is
  'LINE message IDs the sender unsent (#24). Only the ID: a late delivery of the message is not stored again.';

alter table public.unsent_messages enable row level security;

create function public.messages_skip_unsent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('unsend:' || new.line_message_id, 0));
  if exists (select 1 from public.unsent_messages u where u.line_message_id = new.line_message_id) then
    return null; -- skip: the sender unsent this message
  end if;
  return new;
end;
$$;

create trigger messages_skip_unsent
  before insert on public.messages
  for each row execute function public.messages_skip_unsent();

-- Returns true when a stored copy was deleted. Idempotent: a repeat or an unknown message
-- only (re)writes the tombstone.
create function public.unsend_message(p_line_message_id text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('unsend:' || p_line_message_id, 0));
  insert into public.unsent_messages (line_message_id) values (p_line_message_id)
    on conflict (line_message_id) do nothing;
  delete from public.messages where line_message_id = p_line_message_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function public.unsend_message(text) from public, anon, authenticated;
grant execute on function public.unsend_message(text) to service_role;
