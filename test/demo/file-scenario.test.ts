import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DemoLlm } from '@/server/demo/demo-llm'
import { resetDemo } from '@/server/demo/demo-deps'
import { readScripts, runSimAction, setScriptFilesDir, setScriptsDir } from '@/server/demo/sim'

// Scenarios that send files (#4) and quote-reply them (#33): `type: 'image' | 'file'` sends
// public/demo/files/<file>; `replyTo` quotes an earlier line of the same script.

const fresh = () => resetDemo({ llm: new DemoLlm({ inner: null }) })
const COFFEE = 'Cdemo0000000000000000000000000003'

afterEach(() => {
  setScriptsDir()
  setScriptFilesDir()
})

describe('/demo scenario with files', () => {
  it('04-file-saver plays a PDF and an image, then quote-replies the PDF with "ขอไฟล์"', async () => {
    const demo = fresh()
    const res = await runSimAction('load-script', 'POST', { name: '04-file-saver', delayMs: 0, group: COFFEE })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    await demo.idle()
    const chat = demo.world.groupById(COFFEE)!.chat
    const user = chat.filter((c) => c.from === 'user')
    const pdf = user.find((c) => c.message.type === 'file')!
    expect(pdf).toMatchObject({ persona: 'jeff', message: { type: 'file', fileName: 'ใบเสนอราคา-ร้านกาแฟ.pdf' } })
    expect(user.find((c) => c.message.type === 'image')).toMatchObject({ persona: 'bomb', message: { type: 'image', fileName: 'logo-v2.png' } })
    // The bytes are the shipped sample files.
    const bytes = demo.world.contents.get(pdf.messageId!)!
    expect(Buffer.from(bytes.data).subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.contentType).toBe('application/pdf')

    const ask = user.at(-1)!
    expect(ask.message).toEqual({ type: 'text', text: 'NongJoDII ขอไฟล์', quotedMessageId: pdf.messageId })
    // The bot answers the request (without Drive connected it explains instead of a link).
    expect(chat.slice(chat.indexOf(ask) + 1).some((c) => c.from === 'bot')).toBe(true)
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
  })

  it('refuses a scenario whose file is not a plain name, whose replyTo is unknown, or whose file is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'demo-scripts-'))
    const files = await mkdtemp(path.join(tmpdir(), 'demo-files-'))
    try {
      await writeFile(path.join(files, 'a.pdf'), '%PDF-1.4 test')
      const script = (messages: unknown[]) => JSON.stringify({ name: 'x', messages })
      await writeFile(path.join(dir, '10-ok.json'), script([
        { id: 'm1', persona: 'nont', type: 'file', file: 'a.pdf' },
        { id: 'm2', persona: 'nont', text: 'NongJoDII ขอไฟล์', replyTo: 'm1' },
      ]))
      await writeFile(path.join(dir, '20-traversal.json'), script([{ persona: 'nont', type: 'file', file: '../secret.pdf' }]))
      await writeFile(path.join(dir, '30-folder.json'), script([{ persona: 'nont', type: 'image', file: 'a/b.png' }]))
      await writeFile(path.join(dir, '40-bad-reply.json'), script([{ persona: 'nont', text: 'x', replyTo: 'm9' }]))
      await writeFile(path.join(dir, '50-no-text.json'), script([{ persona: 'nont' }]))
      await writeFile(path.join(dir, '60-missing.json'), script([{ persona: 'nont', type: 'file', file: 'nope.pdf' }]))
      const errors: string[] = []
      expect((await readScripts(dir, (m) => errors.push(m))).map((s) => s.name)).toEqual(['10-ok', '60-missing'])
      expect(errors).toHaveLength(4)

      const demo = fresh()
      setScriptsDir(dir)
      setScriptFilesDir(files)
      const missing = await runSimAction('load-script', 'POST', { name: '60-missing', delayMs: 0 })
      expect(missing.status).toBe(400)
      expect(JSON.stringify(missing.body)).toContain('nope.pdf')
      const before = demo.world.chat.length
      expect((await runSimAction('load-script', 'POST', { name: '10-ok', delayMs: 0 })).status).toBe(200)
      await demo.idle()
      const sent = demo.world.chat.slice(before).filter((c) => c.from === 'user')
      expect(sent.map((c) => c.message.type)).toEqual(['file', 'text'])
      expect(sent[1].message).toMatchObject({ quotedMessageId: sent[0].messageId })
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(files, { recursive: true, force: true })
    }
  })
})
