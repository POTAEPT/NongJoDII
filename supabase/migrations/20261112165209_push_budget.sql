-- Push budget claims (#16 "Tasks created" push). LINE's quota API reports the
-- month's usage, but two announces that read it at the same moment could both
-- pass the reserve check and together spend into the reserve. claim_push_budget
-- serializes callers with a transaction advisory lock and counts the push_log
-- rows of the last 10 minutes on top of LINE's figure (LINE's count may not
-- include them yet), then inserts this push's row in the same transaction. A
-- recent push may be counted twice: the check errs toward skipping, never
-- toward spending the reserve. The app deletes the row when the push fails.
create function public.claim_push_budget(
  p_purpose         text,
  p_line_target_id  text,
  p_message_count   integer,
  p_line_used       bigint,
  p_allowed         bigint
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  recent  bigint;
  row_id  uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('nongjodii_push_budget', 0));

  select coalesce(sum(p.message_count), 0)::bigint
    into recent
    from public.push_log p
   where p.sent_at > now() - interval '10 minutes';

  if p_line_used + recent + p_message_count > p_allowed then
    return null;
  end if;

  insert into public.push_log (purpose, line_target_id, message_count)
  values (p_purpose, p_line_target_id, p_message_count)
  returning id into row_id;
  return row_id;
end;
$$;

revoke all on function public.claim_push_budget(text, text, integer, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.claim_push_budget(text, text, integer, bigint, bigint)
  to service_role;
