import { describe, expect, it } from 'vitest'
import { readLiffParams } from '@/app/liff/params'

describe('readLiffParams', () => {
  it('reads view and id from the query', () => {
    expect(readLiffParams('?view=review&id=u1')).toEqual({ view: 'review', id: 'u1' })
  })
  it('decodes liff.state when view and id are absent', () => {
    expect(readLiffParams('?liff.state=%3Fview%3Dtask%26id%3Dt1')).toEqual({ view: 'task', id: 't1' })
  })
  it('decodes liff.state that is a path plus a query', () => {
    expect(readLiffParams('?liff.state=%2Fliff%3Fview%3Dgoogle')).toEqual({ view: 'google', id: null })
  })
  it('gives null for an unknown view', () => {
    expect(readLiffParams('?view=bogus')).toEqual({ view: null, id: null })
  })
  it('gives nulls for an empty string', () => {
    expect(readLiffParams('')).toEqual({ view: null, id: null })
  })
})
