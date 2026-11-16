import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guard for PostgREST embeds (production bug 2026-11-16, PGRST201). A bare embed such as
// `line_users(display_name)` is ambiguous when the table has more than one foreign key to
// that table: PostgREST then refuses the whole request. messages gained a second key to
// line_users (progress_dismissed_by_line_user_id, 20261115150000), and the Summary's
// listRecentTextMessages broke. This reads the migrations for every foreign key, then
// checks that each embed in the Supabase adapter names its key (`target!column(...)`)
// whenever the source table has more than one key to that target.

const ROOT = join(__dirname, '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

/** source table -> target table -> number of foreign keys, from every migration. */
function foreignKeys(): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  const add = (source: string, target: string) => {
    const m = out.get(source) ?? new Map<string, number>()
    m.set(target, (m.get(target) ?? 0) + 1)
    out.set(source, m)
  }
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '')
    // create table public.x ( ... );
    for (const m of sql.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      for (const r of m[2].matchAll(/references public\.(\w+)/g)) add(m[1], r[1])
    }
    // alter table public.x add column ... references public.y
    for (const m of sql.matchAll(/alter table (?:only )?public\.(\w+)([\s\S]*?);/g)) {
      for (const r of m[2].matchAll(/add (?:column |constraint \w+ foreign key[^)]*\) )?[\s\S]*?references public\.(\w+)/g)) add(m[1], r[1])
    }
  }
  return out
}

/** Every `.from('table')` in the adapter with the select string that follows it. */
function selects(): { table: string; select: string }[] {
  const src = readFileSync(join(ROOT, 'src', 'server', 'store', 'supabase-store.ts'), 'utf8')
  const out: { table: string; select: string }[] = []
  for (const m of src.matchAll(/\.from\('(\w+)'\)([\s\S]{0,400}?)\.select\('([^']*)'/g)) {
    // Skip a select that belongs to a later .from( in the same window.
    if (m[2].includes('.from(')) continue
    out.push({ table: m[1], select: m[3] })
  }
  return out
}

describe('PostgREST embeds name their foreign key when one is ambiguous', () => {
  const fks = foreignKeys()

  it('reads the keys messages has to line_users (sender, and the picker dismissal)', () => {
    expect(fks.get('messages')?.get('line_users')).toBe(2)
  })

  it('every embed of a table reached by more than one key names the key', () => {
    const bad: string[] = []
    for (const { table, select } of selects()) {
      // An embed: `[alias:]target[!hint](...)`.
      for (const e of select.matchAll(/(?:\w+:)?(\w+)(!\w+)?\(/g)) {
        const target = e[1]
        const hinted = e[2] !== undefined
        if (!hinted && (fks.get(table)?.get(target) ?? 0) > 1) bad.push(`${table} -> ${target}: "${select}"`)
      }
    }
    expect(bad).toEqual([])
  })
})
