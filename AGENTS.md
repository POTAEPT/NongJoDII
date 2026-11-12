<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Secrets (Infisical)

Product context, terms and decisions: `docs/PROJECT.md`.

The team keeps secrets in Infisical: the LINE channel keys, the LIFF ID and the other app keys. Agents handle secret names only; values reach code only inside the child process of `infisical run`. Commands that print values or put them in shell history are for humans only: bare `infisical secrets`, `infisical secrets get`, `infisical export` and `infisical secrets set NAME=value`.

Set up once per developer, in the repo root:

1. `infisical login` (browser sign-in).
2. `infisical init` in the repo root. It writes a link file that holds only the project ID. The environments are `dev`, `staging` and `prod`.

Run the app from the repo root:

- `infisical run --env=dev -- npm run dev`.
- Wrap `npm run build` the same way: Next.js inlines `NEXT_PUBLIC_*` values (the LIFF ID, the Clarity project ID) at build time.
- Infisical values override `.env` files for the same key.

## Database migrations (Supabase)

- A migration file's name starts with its version, and that version must equal the version recorded in the live database (`supabase_migrations.schema_migrations`, or `list_migrations` in the Supabase MCP). If they differ, `supabase db push` refuses to run, and a forced run tries to apply every file again.
- Apply migrations with `supabase db push`, which records the file's own version. The Supabase MCP `apply_migration` tool stamps the time it ran instead: right after using it, rename the file (`git mv`) to the version it recorded.
- A file that is not applied yet keeps a version later than every applied one (for example `20261112180000_scheduler_ticks.sql`), so it never sorts before applied history.
- Do not run `supabase migration repair` on the shared database without the team agreeing: it rewrites the live history table.
