-- NongJoDII scheduler: Supabase pg_cron calls the app's tick route through
-- pg_net (decided 2026-11-11). Apply this AFTER the tick route is deployed.
--
-- Syntax checked on 2026-11-11 against Supabase docs: guides/cron/quickstart
-- (cron.schedule(name, schedule, command); same name overwrites the job),
-- guides/database/extensions/pg_net (net.http_post(url, body, params, headers,
-- timeout_milliseconds), async, JSON body only) and guides/database/vault
-- (vault.create_secret, view vault.decrypted_secrets).
--
-- Nothing is hard-coded. Before applying, store two secrets in Vault (SQL
-- Editor, once per environment; values are not in git):
--   select vault.create_secret('<full tick route URL>',  'nongjodii_tick_url');
--   select vault.create_secret('<shared tick secret>',   'nongjodii_tick_secret');
-- The app's tick route must accept only calls that carry the same secret in
-- the x-tick-secret header (.greptile/rules.md, Baseline).
--
-- Vault is enabled by default on Supabase; this file does not create it.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Calls the tick route once. kind is 'daily' or 'weekly'; the route decides
-- what to do. SECURITY DEFINER so cron can read Vault; execute is revoked
-- from everyone else because the function reaches decrypted secrets.
create or replace function public.call_tick(kind text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  tick_url    text;
  tick_secret text;
  request_id  bigint;
begin
  if kind not in ('daily', 'weekly') then
    raise exception 'unknown tick kind: %', kind;
  end if;

  select decrypted_secret into tick_url
    from vault.decrypted_secrets where name = 'nongjodii_tick_url';
  select decrypted_secret into tick_secret
    from vault.decrypted_secrets where name = 'nongjodii_tick_secret';

  if tick_url is null or tick_secret is null then
    raise exception 'Vault secrets nongjodii_tick_url / nongjodii_tick_secret are missing';
  end if;

  select net.http_post(
    url                  := tick_url,
    body                 := jsonb_build_object('kind', kind),
    headers              := jsonb_build_object(
                              'Content-Type', 'application/json',
                              'x-tick-secret', tick_secret),
    timeout_milliseconds := 10000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function public.call_tick(text) from public, anon, authenticated;

-- pg_cron schedules in UTC. Bangkok is UTC+7 all year (no daylight saving),
-- so 09:00 Asia/Bangkok = 02:00 UTC.
--
-- PLACEHOLDERS: the real daily and weekly times are NOT decided yet. Change
-- the two cron expressions below (re-running cron.schedule with the same job
-- name replaces the job) once the team decides.

-- PLACEHOLDER: daily 09:00 Asia/Bangkok = 02:00 UTC.
select cron.schedule(
  'nongjodii-daily-tick',
  '0 2 * * *',
  $$select public.call_tick('daily')$$
);

-- PLACEHOLDER: weekly, Monday 09:00 Asia/Bangkok = Monday 02:00 UTC.
select cron.schedule(
  'nongjodii-weekly-tick',
  '0 2 * * 1',
  $$select public.call_tick('weekly')$$
);
