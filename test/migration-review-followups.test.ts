import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// SQL checks that need no database for 20261115150000_review_followups.sql (written, not
// applied): its version sorts after every other migration, every plpgsql body is closed,
// and the D1 predicate, the expiry guard and the folder clearing are in the functions the
// app calls. The fake store mirrors these rules (FakeStore.changeProjectOwnerRows,
// answerSubgroupTakeover).

const DIR = join(__dirname, '..', 'supabase', 'migrations')
const FILE = '20261115150000_review_followups.sql'
const sql = readFileSync(join(DIR, FILE), 'utf8')
/** The SQL without -- comments, lower-cased with whitespace collapsed. */
const code = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ').toLowerCase()

describe(`migration ${FILE}`, () => {
  it('sorts after every other migration (AGENTS.md: unapplied versions come last)', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
    expect(files[files.length - 1]).toBe(FILE)
    expect(new Set(files.map((f) => f.slice(0, 14))).size).toBe(files.length)
  })

  it('closes every $$ body and ends each statement', () => {
    expect((sql.match(/\$\$/g) ?? []).length % 2).toBe(0)
    expect(code.trim().endsWith(';')).toBe(true)
    expect(code.match(/create or replace function/g)).toHaveLength(2)
  })

  it('joined_at: no insert-time default, null until the first join', () => {
    expect(code).toContain('alter column joined_at drop default')
    expect(code).toContain('alter column joined_at drop not null')
  })

  it('change_project_owner asks only waiting Sub groups or those not on the new Owner, and clears their folder', () => {
    const fn = code.slice(code.indexOf('function public.change_project_owner'), code.indexOf('function public.answer_subgroup_takeover'))
    expect(fn).toContain('set takeover_asked_at = now(), owner_confirmed_at = null, drive_folder_id = null')
    expect(fn).toContain('and (takeover_asked_at is not null or nominated_owner_line_user_id is distinct from p_new_owner or owner_confirmed_at is null)')
  })

  it('answer_subgroup_takeover raises NJ409 for a question older than 7 days, after the locks; a detach clears the folder', () => {
    const fn = code.slice(code.indexOf('function public.answer_subgroup_takeover'))
    const lock = fn.indexOf('for update; if exists')
    const guard = fn.indexOf("g.takeover_asked_at < now() - interval '7 days'")
    expect(lock).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(lock)
    expect(fn).toContain("errcode = 'nj409'")
    expect(fn).toContain('set project_id = null, takeover_asked_at = null, drive_folder_id = null')
  })
})
