-- AI usage claims (#6). Every AI call first claims a conservative estimate of
-- its usage, then the call runs, then the claim is settled with the real token
-- counts from the response (or released when the call fails).
--
-- Why: the Fair-use cap check and the paid call cannot share a lock (the model
-- call takes up to 45 s), so two webhook requests for one Owner could both read
-- usage below the cap and both spend. claim_ai_usage serializes per Owner with a
-- transaction advisory lock, re-reads the month's usage and inserts the claim
-- row in the same transaction, so a later claim always sees earlier claims.
--
-- settled_at null = open claim holding the estimate. owner_monthly_usage keeps
-- summing every row, claims included, so open claims count toward the cap. A
-- claim that is never settled keeps its estimate: usage is over-counted, never
-- under-counted.

alter table public.ai_usage add column settled_at timestamptz;

-- Rows written before claims existed are real charges.
update public.ai_usage set settled_at = created_at;

-- Claims the estimate for one AI call. Returns the claim id, or null when the
-- Owner's Bangkok-month usage (same month expression as owner_monthly_usage)
-- has reached the cap in tokens or dollars. The caps come from the app
-- (FAIR_USE_CAP_TOKENS / FAIR_USE_CAP_USD) so code stays the single source.
create function public.claim_ai_usage(
  p_owner_line_user_id  text,
  p_project_id          uuid,
  p_group_id            uuid,
  p_purpose             text,
  p_model               text,
  p_input_tokens        integer,
  p_output_tokens       integer,
  p_cost_usd            numeric,
  p_created_at          timestamptz,
  p_cap_tokens          bigint,
  p_cap_cost_usd        numeric
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  used_tokens  bigint;
  used_cost    numeric;
  claim_id     uuid;
begin
  -- Held until the transaction ends: one claim per Owner at a time.
  perform pg_advisory_xact_lock(hashtextextended(p_owner_line_user_id, 0));

  select coalesce(sum(u.input_tokens + u.output_tokens), 0)::bigint,
         coalesce(sum(u.cost_usd), 0)
    into used_tokens, used_cost
    from public.ai_usage u
   where u.owner_line_user_id = p_owner_line_user_id
     and date_trunc('month', u.created_at at time zone 'Asia/Bangkok')
       = date_trunc('month', p_created_at at time zone 'Asia/Bangkok');

  if used_tokens >= p_cap_tokens or used_cost >= p_cap_cost_usd then
    return null;
  end if;

  insert into public.ai_usage (
    owner_line_user_id, project_id, group_id, purpose, model,
    input_tokens, output_tokens, cost_usd, created_at, settled_at
  ) values (
    p_owner_line_user_id, p_project_id, p_group_id, p_purpose, p_model,
    p_input_tokens, p_output_tokens, p_cost_usd, p_created_at, null
  )
  returning id into claim_id;

  return claim_id;
end;
$$;

revoke all on function public.claim_ai_usage(text, uuid, uuid, text, text, integer, integer, numeric, timestamptz, bigint, numeric)
  from public, anon, authenticated;
grant execute on function public.claim_ai_usage(text, uuid, uuid, text, text, integer, integer, numeric, timestamptz, bigint, numeric)
  to service_role;

-- Settles a claim with the real numbers. An UPDATE by id, never an INSERT, so a
-- retry after an unknown outcome leaves one row with the same values.
-- Returns false when no row has that id.
create function public.settle_ai_usage(
  p_id             uuid,
  p_model          text,
  p_input_tokens   integer,
  p_output_tokens  integer,
  p_cost_usd       numeric
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.ai_usage
     set model = p_model,
         input_tokens = p_input_tokens,
         output_tokens = p_output_tokens,
         cost_usd = p_cost_usd,
         settled_at = coalesce(settled_at, now())
   where id = p_id;
  return found;
end;
$$;

revoke all on function public.settle_ai_usage(uuid, text, integer, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.settle_ai_usage(uuid, text, integer, integer, numeric)
  to service_role;

-- Releases an open claim after the AI call failed (no response, nothing to
-- charge). A settled row is never deleted.
create function public.release_ai_usage(p_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.ai_usage
   where id = p_id
     and settled_at is null;
end;
$$;

revoke all on function public.release_ai_usage(uuid)
  from public, anon, authenticated;
grant execute on function public.release_ai_usage(uuid)
  to service_role;
