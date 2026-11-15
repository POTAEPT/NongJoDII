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

-- Calls the tick route once. The route decides what is due; the body only says
-- it is a scheduled tick. SECURITY DEFINER so cron can read Vault; execute is
-- revoked from everyone else because the function reaches decrypted secrets.
create or replace function public.call_tick()
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
  select decrypted_secret into tick_url
    from vault.decrypted_secrets where name = 'nongjodii_tick_url';
  select decrypted_secret into tick_secret
    from vault.decrypted_secrets where name = 'nongjodii_tick_secret';

  if tick_url is null or tick_secret is null then
    raise exception 'Vault secrets nongjodii_tick_url / nongjodii_tick_secret are missing';
  end if;

  select net.http_post(
    url                  := tick_url,
    body                 := jsonb_build_object('kind', 'tick'),
    headers              := jsonb_build_object(
                              'Content-Type', 'application/json',
                              'x-tick-secret', tick_secret),
    timeout_milliseconds := 10000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function public.call_tick() from public, anon, authenticated;

-- One job, every 15 minutes (pg_cron standard 5-field syntax, UTC). Reminder and
-- summary times are chosen per group in onboarding (groups.daily_reminder_time,
-- weekly_summary_weekday, weekly_summary_time; Asia/Bangkok wall-clock, on the
-- quarter hour), so there are no fixed daily or weekly jobs. Re-running
-- cron.schedule with the same job name replaces the job.
--
-- What each tick does with the schema (the route holds the logic):
--   * Daily reminders: live groups with feature_track_remind whose
--     daily_reminder_time has passed today (Bangkok) and whose
--     daily_reminder_last_sent_on is null or before today (groups_daily_due_idx).
--     The route claims the slot first (update ... set daily_reminder_last_sent_on
--     = today where it is null or older, returning id) and sends only if a row
--     came back, so a group never gets two in one day.
--   * Weekly summaries: same with feature_weekly_summary, weekly_summary_weekday
--     equal to today's ISO weekday, weekly_summary_time passed and
--     weekly_summary_last_sent_on (groups_weekly_due_idx).
--   * Purge groups past delete_after (groups_delete_after_idx).
--   * No new Owner: groups with owner_left_at older than 7 days,
--     owner_confirmed_at null and left_at null (groups_owner_left_idx). The bot
--     leaves each one; when LINE's leave call succeeds the app sets left_at = now()
--     and delete_after = now() + 7 days at once, without waiting for the leave
--     event.
--   * Unanswered Sub group take-over: Sub groups with takeover_asked_at older than
--     7 days (groups_takeover_expiry_idx) detach from the Project, in one update:
--       update public.groups set project_id = null, takeover_asked_at = null
--        where takeover_asked_at < now() - interval '7 days';
--     They then need their own setup and Owner.
-- The purge and 7-day checks are cheap and idempotent, so they run on every tick.
select cron.schedule(
  'nongjodii-tick',
  '*/15 * * * *',
  $$select public.call_tick()$$
);
