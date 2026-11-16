import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// SQL checks that need no database for 20261116120000_progress_yes_respects_dismissal.sql
// (#87). The fake store cannot show lock order, so the order is checked in the function text:
// answer_progress_yes locks the chat message (share) before the card (for update), the order
// other writers use (an unsend deletes the message, whose ON DELETE SET NULL updates the card).

const FILE = '20261116120000_progress_yes_respects_dismissal.sql'
// Line endings normalized: a Windows checkout may turn the file into CRLF.
const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', FILE), 'utf8').replace(/\r\n/g, '\n')
/** The SQL without -- comments, lower-cased with whitespace collapsed. */
const code = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ').toLowerCase()

describe(`migration ${FILE}`, () => {
  it('closes its $$ body', () => {
    expect((sql.match(/\$\$/g) ?? []).length % 2).toBe(0)
  })

  it('locks the chat message before the card, and re-checks the card after', () => {
    const share = code.indexOf('from public.messages m where m.id = v_trigger for share')
    const card = code.indexOf("from public.task_prompts p where p.id = p_prompt_id and p.task_id = p_task_id and p.kind = 'mark_done' for update")
    expect(share).toBeGreaterThan(-1)
    expect(card).toBeGreaterThan(share)
    // Only one lock on the card, and it comes after the message.
    expect(code.split('for update').length - 1).toBe(1)
    // The card's trigger is re-read under its lock and must match the message locked first.
    expect(code.indexOf('if v_locked is distinct from v_trigger then return')).toBeGreaterThan(card)
  })

  it('refuses a Yes on a dismissed message before any write', () => {
    const dismissed = code.indexOf("if v_dismissed is not null then return 'dismissed'")
    expect(dismissed).toBeGreaterThan(-1)
    expect(code.indexOf('update public.tasks')).toBeGreaterThan(dismissed)
  })
})
