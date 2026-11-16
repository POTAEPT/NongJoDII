import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FILES_TEXT, INSIGHT_TEXT } from '@/app/liff/dashboard-model'
import { EmptyGroup, FilesCard } from '@/app/liff/dashboard-view'

// #22 on the Dashboard screen, rendered to HTML in Node (no browser): a group with no Tasks
// and no known Members still shows its saved weekly insight on the overview.

const insight = { weekStart: '2026-11-16', done: 4, inProcess: 2, awaitingOwner: 1, posted: false }
const html = (p: Parameters<typeof EmptyGroup>[0]) => renderToStaticMarkup(createElement(EmptyGroup, p))

describe('empty group on the Dashboard (#22)', () => {
  it('shows the saved insight above the empty notice on the overview', () => {
    const out = html({ insight, showInsight: true })
    expect(out).toContain(INSIGHT_TEXT.title(insight.weekStart))
    expect(out).toContain(INSIGHT_TEXT.notPosted)
    expect(out.indexOf(INSIGHT_TEXT.title(insight.weekStart))).toBeLessThan(out.indexOf('ยังไม่มีงานในกลุ่มนี้'))
  })

  it('shows only the empty notice on other tabs, or when there is no insight', () => {
    expect(html({ insight, showInsight: false })).not.toContain('สรุปรายสัปดาห์')
    expect(html({ insight: null, showInsight: true })).not.toContain('สรุปรายสัปดาห์')
    expect(html({ insight: null, showInsight: true })).toContain('ยังไม่มีงานในกลุ่มนี้')
  })
})

describe('saved files on the Dashboard (#4)', () => {
  const file = {
    fileId: 'f1', fileName: 'report.pdf', driveLink: 'https://drive.google.com/file/d/f1/view', sizeBytes: 2048,
    savedAt: '2026-11-12T03:00:00.000Z', senderName: 'Sender',
  }
  const filesHtml = (files: (typeof file)[]) => renderToStaticMarkup(createElement(FilesCard, { files }))

  it('lists each file with its Drive link, size, sender and time', () => {
    const out = filesHtml([file])
    expect(out).toContain(FILES_TEXT.title)
    expect(out).toContain('href="https://drive.google.com/file/d/f1/view"')
    expect(out).toContain('report.pdf')
    expect(out).toContain('2 KB · Sender · 12/11 10:00')
  })

  it('says so when the group has no saved file', () => {
    expect(filesHtml([])).toContain(FILES_TEXT.none)
  })
})
