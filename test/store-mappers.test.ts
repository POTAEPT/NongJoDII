import { describe, expect, it } from 'vitest'
import { toCandidateRow, toGroupRow, toMember, toStoredMessage, toTaskRow } from '@/server/store/mappers'

const groupRow = {
  id: 'g1', line_group_id: 'C1', project_id: null, name: null, nominated_owner_line_user_id: 'U1',
  owner_confirmed_at: '2026-11-12T03:00:00+00:00', feature_summarize: true, feature_draft_tasks: false,
  work_description: null,
}

describe('toGroupRow', () => {
  it('maps owner_confirmed_at ISO to a Date', () => {
    expect(toGroupRow(groupRow)).toEqual({
      id: 'g1', lineGroupId: 'C1', projectId: null, name: null, nominatedOwnerLineUserId: 'U1',
      ownerConfirmedAt: new Date('2026-11-12T03:00:00Z'), featureSummarize: true, featureDraftTasks: false,
      workDescription: null,
    })
  })

  it('maps a null owner_confirmed_at to null', () => {
    expect(toGroupRow({ ...groupRow, owner_confirmed_at: null }).ownerConfirmedAt).toBeNull()
  })
})

describe('toStoredMessage', () => {
  const row = { id: 'm1', sender_line_user_id: 'U1', text: 'hi', sent_at: '2026-11-12T03:00:00+00:00' }

  it('takes senderDisplayName from the nested line_users object', () => {
    expect(toStoredMessage({ ...row, line_users: { display_name: 'Pim' } })).toEqual({
      id: 'm1', senderLineUserId: 'U1', senderDisplayName: 'Pim', text: 'hi',
      sentAt: new Date('2026-11-12T03:00:00Z'),
    })
  })

  it('gives null when there is no sender row or no name', () => {
    expect(toStoredMessage({ ...row, sender_line_user_id: null, line_users: null }).senderDisplayName).toBeNull()
    expect(toStoredMessage({ ...row, line_users: { display_name: null } }).senderDisplayName).toBeNull()
  })
})

describe('toCandidateRow', () => {
  const row = {
    id: 'c1', summary_id: 's1', state: 'proposed' as const, title: 'T', details: null,
    suggested_assignee_line_user_id: null, suggested_due_at: '2026-11-20T10:00:00+00:00',
  }

  it('maps suggested_due_at to a Date', () => {
    expect(toCandidateRow(row)).toEqual({
      id: 'c1', summaryId: 's1', state: 'proposed', title: 'T', details: null,
      suggestedAssigneeLineUserId: null, suggestedDueAt: new Date('2026-11-20T10:00:00Z'),
    })
  })

  it('keeps a null suggested_due_at null', () => {
    expect(toCandidateRow({ ...row, suggested_due_at: null }).suggestedDueAt).toBeNull()
  })
})

describe('toTaskRow', () => {
  it('maps timestamps and the embedded group', () => {
    expect(toTaskRow({
      id: 't1', group_id: 'g1', candidate_id: 'c1', title: 'T', details: null, status: 'in_process',
      assignee_line_user_id: 'U2', created_by_line_user_id: 'U1', due_at: '2026-11-20T10:00:00+00:00',
      deleted_at: null, groups: { line_group_id: 'C1' },
    })).toEqual({
      id: 't1', groupId: 'g1', lineGroupId: 'C1', candidateId: 'c1', title: 'T', details: null,
      status: 'in_process', assigneeLineUserId: 'U2', createdByLineUserId: 'U1',
      dueAt: new Date('2026-11-20T10:00:00Z'), deletedAt: null,
    })
  })
})

describe('toMember', () => {
  it('takes displayName from line_users and defaults nicknames', () => {
    expect(toMember({ line_user_id: 'U1', nicknames: ['p'], role: null, line_users: { display_name: 'Pim' } }))
      .toEqual({ lineUserId: 'U1', displayName: 'Pim', nicknames: ['p'], role: null })
    expect(toMember({ line_user_id: 'U1', nicknames: null, role: 'design', line_users: null }))
      .toEqual({ lineUserId: 'U1', displayName: null, nicknames: [], role: 'design' })
  })
})
