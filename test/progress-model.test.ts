import { describe, expect, it } from 'vitest'
import { finishSend, initialPage, startSend, type ProgressPage } from '@/app/liff/progress-model'

// The LIFF progress page (#7): Task choices must survive a failed or refused pick.

const CHOICES = [
  { label: 'ทำโลโก้', data: 'a=pk&m=1&t=2&s=d' },
  { label: 'ทำสไลด์ปัญหา', data: 'a=pk&m=1&t=3&s=d' },
]
const picker: ProgressPage = {
  sending: false, notice: null, fatal: null,
  body: { result: 'picker', text: 'อัปเดตนี้หมายถึงงานไหน?', choices: CHOICES },
}

describe('LIFF progress page state', () => {
  it('a failed first send has nothing to retry from: it shows the error alone', () => {
    const page = finishSend(startSend(initialPage), { ok: false, message: 'บันทึกไม่สำเร็จ' })
    expect(page).toEqual({ sending: false, body: null, notice: null, fatal: 'บันทึกไม่สำเร็จ' })
  })

  it('a failed pick keeps the choices and shows the error above them', () => {
    const page = finishSend(startSend(picker), { ok: false, message: 'บันทึกไม่สำเร็จ กรุณาลองใหม่' })
    expect(page.body?.choices).toEqual(CHOICES)
    expect(page.notice).toBe('บันทึกไม่สำเร็จ กรุณาลองใหม่')
    expect(page.fatal).toBeNull()
    expect(page.sending).toBe(false)
  })

  it('a refused pick keeps the choices, so another Task can be picked', () => {
    const page = finishSend(startSend(picker), {
      ok: true, body: { result: 'refused', text: 'เฉพาะ บิว ที่ยืนยันงานนี้ได้', choices: [] },
    })
    expect(page.body?.choices).toEqual(CHOICES)
    expect(page.notice).toBe('เฉพาะ บิว ที่ยืนยันงานนี้ได้')
  })

  it('a pick that goes through replaces the picker with the result', () => {
    const page = finishSend(startSend(picker), {
      ok: true, body: { result: 'updated', text: '“ทำโลโก้” เสร็จแล้ว', choices: [] },
    })
    expect(page.body).toEqual({ result: 'updated', text: '“ทำโลโก้” เสร็จแล้ว', choices: [] })
    expect(page.notice).toBeNull()
  })

  it('a new send clears the old notice', () => {
    const page = startSend({ ...picker, notice: 'บันทึกไม่สำเร็จ' })
    expect(page.notice).toBeNull()
    expect(page.sending).toBe(true)
    expect(page.body?.choices).toEqual(CHOICES)
  })
})
