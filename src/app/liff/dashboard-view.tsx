'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { liffUrl } from '@/server/liff-links'
import type { TaskStatus } from '@/server/ports'
import { post } from './api'
import { track } from './analytics'
import {
  FALLBACK_MEMBER, FILES_TEXT, FILTERS, INSIGHT_TEXT, fileLine, STATUS_LABEL, STATUS_ORDER, TABS, calendarWeek, canCompare, countByStatus, dayHeading, dueLabel,
  errorCopy, filterTasks, groupName, guideHref, hhmm, initialOf, initialScope, insightTiles, isNoGroups, liveTiles, isOverdue, memberCards, memberName,
  overviewGroups, overviewLine, scopeAfterRefresh, summarizeGroups, tasksDueOn, tasksOf, unownedTasks,
  type DashboardData, type DashboardFile, type DashboardGroup, type DashboardInsight, type DashboardTab, type DashboardTask, type GroupSummary,
  type Scope, type StatusCounts, type TaskFilter, WELCOME_TEXT,
} from './dashboard-model'
import type { LiffViewProps } from './liff-sdk'

// #18 Dashboard screen (Figma 6b). Read-only: it shows LINE names, status counts, progress
// and owners from /api/dashboard/load (#17), which limits the data to what the requester
// may see. The server takes the person from the verified LIFF ID token. `id` is the group
// the weekly insight's button opened (groups.id), if any. Tapping a Task opens the Task
// edit page (view=task), where assigning and editing already live.

// Colors follow the bot's cards (insight/card.ts, reminders/card.ts).
const BADGE: Record<TaskStatus, string> = {
  not_assigned: 'bg-[#FCEFC7] text-[#7A4B00]',
  in_process: 'bg-[#DCE8F7] text-[#1F5BAD]',
  done: 'bg-[#DDF3E6] text-[#17703F]',
}
const DOT: Record<TaskStatus, string> = {
  not_assigned: 'bg-[#E0A100]',
  in_process: 'bg-[#1F5BAD]',
  done: 'bg-[#17A05D]',
}
const RING: Record<TaskStatus, string> = { not_assigned: '#F0B429', in_process: '#4C8DDB', done: '#3DD68C' }

type Load =
  | { kind: 'loading' } | { kind: 'error'; status: number } | { kind: 'welcome' } | { kind: 'ready'; data: DashboardData }

export function DashboardView({ liff, liffId, idToken, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [scope, setScope] = useState<Scope>('all')
  const [tab, setTab] = useState<DashboardTab>('overview')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [weekOffset, setWeekOffset] = useState(0)
  const [pickedDate, setPickedDate] = useState<string | null>(null)
  const [memberId, setMemberId] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)
  const started = useRef(false)

  const refreshing = useRef(false)

  const fetchData = useCallback(async () => {
    setLoad({ kind: 'loading' })
    try {
      const { status, json } = await post('/api/dashboard/load', { idToken, groupId: id })
      if (isNoGroups(status, json)) return setLoad({ kind: 'welcome' })
      if (status !== 200) return setLoad({ kind: 'error', status })
      const data = json as DashboardData
      setScope(initialScope(data, id))
      setLoad({ kind: 'ready', data })
    } catch {
      setLoad({ kind: 'error', status: 0 })
    }
  }, [idToken, id])

  // A Task opens in another window; on return the data may have changed. Reload quietly:
  // the screen keeps showing the old data, and the selected group, tab and filters stay.
  // A failed or refused reload keeps the old data too, except a 403 (the person left).
  const refresh = useCallback(async () => {
    if (refreshing.current || document.visibilityState !== 'visible') return
    refreshing.current = true
    try {
      const { status, json } = await post('/api/dashboard/load', { idToken, groupId: id })
      if (isNoGroups(status, json)) return setLoad({ kind: 'welcome' })
      if (status === 403) return setLoad({ kind: 'error', status })
      if (status !== 200) return
      const data = json as DashboardData
      setScope((current) => scopeAfterRefresh(data, current, id))
      setLoad({ kind: 'ready', data })
    } catch {
      // keep what is on screen
    } finally {
      refreshing.current = false
    }
  }, [idToken, id])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not load twice
    started.current = true
    void fetchData()
  }, [fetchData])

  useEffect(() => {
    if (load.kind !== 'ready') return
    const onReturn = () => void refresh()
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('focus', onReturn)
    return () => {
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('focus', onReturn)
    }
  }, [load.kind, refresh])

  const back = () => liff.closeWindow()
  const openTask = (taskId: string) => {
    track('dashboard_task_open') // #19
    liff.openWindow({ url: liffUrl(liffId, 'task', taskId), external: false })
  }
  const openMember = (memberId: string) => {
    track('dashboard_member_open') // #19
    setMemberId(memberId)
  }

  if (load.kind === 'loading') {
    return <Shell><p className="p-6 text-center text-sm text-[#8A94A6]">กำลังโหลด...</p></Shell>
  }
  if (load.kind === 'welcome') {
    // #145: a first-time user in no group yet. Not an access error.
    return (
      <Shell>
        <Notice tone="doc" title={WELCOME_TEXT.title} text={WELCOME_TEXT.body}>
          <ol className="mb-2 flex flex-col gap-2 text-left text-sm">
            {WELCOME_TEXT.steps.map((s, i) => (
              <li key={s} className="flex items-start gap-3 rounded-xl bg-white px-3 py-2.5">
                <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#DCE8F7] text-xs font-bold text-[#1F5BAD]">
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          <Primary onClick={() => liff.openWindow({ url: guideHref(window.location.origin), external: false })}>
            {WELCOME_TEXT.guide}
          </Primary>
          <Secondary onClick={back}>กลับไปที่แชต</Secondary>
        </Notice>
      </Shell>
    )
  }
  if (load.kind === 'error') {
    const retryable = load.status !== 401 && load.status !== 403
    return (
      <Shell>
        <Notice
          tone={load.status === 403 ? 'user' : load.status === 401 ? 'user' : 'refresh'}
          title={load.status === 403 ? 'คุณไม่ใช่สมาชิกกลุ่มนี้' : load.status === 401 ? 'ยืนยันตัวตนไม่สำเร็จ' : 'โหลดข้อมูลไม่สำเร็จ'}
          text={errorCopy(load.status)}
        >
          {retryable && <Primary onClick={() => void fetchData()}>ลองใหม่</Primary>}
          <Secondary onClick={back}>กลับไปที่แชต</Secondary>
        </Notice>
      </Shell>
    )
  }

  const { data } = load
  const now = new Date()
  const compare = canCompare(data)
  const group = data.groups.find((g) => g.groupId === scope) ?? null
  const comparing = scope === 'all' && compare

  if (data.groups.length === 0 || (!comparing && !group)) {
    return (
      <Shell>
        <Notice tone="doc" title="ยังไม่มีงานในกลุ่มนี้" text="เมื่อน้องจดดีสรุปแชตและทีมยืนยัน งานจะแสดงที่นี่">
          <Secondary onClick={back}>กลับไปที่แชต</Secondary>
        </Notice>
      </Shell>
    )
  }

  const pick = (next: Scope) => {
    setScope(next)
    setTab('overview')
    setFilter('all')
    setWeekOffset(0)
    setPickedDate(null)
    setMemberId(null)
    setSheet(false)
  }
  const summaries = summarizeGroups(data.groups)
  const compared = summarizeGroups(overviewGroups(data)) // #90: only groups seen whole
  const current = summaries.find((s) => s.groupId === scope)

  return (
    <Shell>
      <div className="flex flex-col gap-3 p-4">
        <button
          type="button"
          onClick={() => setSheet(true)}
          className="flex items-center gap-3 rounded-2xl bg-white p-3 text-left shadow-sm ring-1 ring-[#E6EAF0]"
        >
          <Avatar name={comparing ? 'ทั้ง' : groupName(group!)} dark />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold text-[#14213D]">
              {comparing ? 'ภาพรวมทั้งหมด' : groupName(group!)}
            </span>
            <span className="block text-xs text-[#8A94A6]">
              {comparing ? `มีทั้งหมด ${compared.length} กลุ่ม` : current ? summaryLine(current) : ''}
            </span>
          </span>
          <Chevron />
        </button>

        {comparing ? (
          <Compare summaries={compared} onOpen={(gid) => { track('dashboard_compare_open_group'); pick(gid); setTab('tasks') }} />
        ) : (
          <>
            <Tabs tab={tab} onChange={(t) => { track(`dashboard_tab_${t}`); setTab(t); setMemberId(null) }} />
            {group!.tasks.length === 0 && group!.members.length === 0 ? (
              <EmptyGroup insight={group!.insight} showInsight={tab === 'overview'} files={group!.files} />
            ) : tab === 'overview' ? (
              memberId ? (
                <MemberDetail group={group!} memberId={memberId} now={now} onBack={() => setMemberId(null)} onOpen={openTask} />
              ) : group!.access === 'mine' ? (
                <MineOverview group={group!} now={now} onOpen={openTask} />
              ) : (
                <Overview group={group!} now={now} onMember={openMember} onOpen={openTask} />
              )
            ) : tab === 'calendar' ? (
              <Calendar
                tasks={group!.tasks} now={now} offset={weekOffset} picked={pickedDate}
                onOffset={(o) => { setWeekOffset(o); setPickedDate(null) }} onPick={setPickedDate} onOpen={openTask}
              />
            ) : (
              <AllTasks group={group!} now={now} filter={filter} onFilter={setFilter} onOpen={openTask} />
            )}
          </>
        )}
      </div>

      {sheet && (
        <GroupSheet
          compareCount={compared.length} summaries={summaries} scope={scope} compare={compare}
          onPick={pick} onClose={() => setSheet(false)}
        />
      )}
    </Shell>
  )
}

// ---------- Layout pieces ----------

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F4F6FA] text-[#14213D]">
      <header className="bg-[#13294B] px-4 pb-3 pt-4 text-base font-bold text-white">Dashboard</header>
      {children}
    </div>
  )
}

function Avatar({ name, dark = false, size = 'md' }: { name: string; dark?: boolean; size?: 'md' | 'sm' }) {
  const box = size === 'sm' ? 'h-7 w-7 text-xs' : 'h-10 w-10 text-sm'
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ${box} ${
        dark ? 'bg-[#13294B] text-white' : 'bg-[#DCE8F7] text-[#1F5BAD]'
      }`}
    >
      {initialOf(name)}
    </span>
  )
}

function Chevron() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" className="shrink-0 text-[#8A94A6]">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Tabs({ tab, onChange }: { tab: DashboardTab; onChange: (t: DashboardTab) => void }) {
  return (
    <div role="tablist" className="grid grid-cols-3 rounded-full bg-[#E3E9F3] p-1">
      {TABS.map((t) => (
        <button
          key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => onChange(t.key)}
          className={`rounded-full py-2 text-xs font-bold ${tab === t.key ? 'bg-white text-[#14213D] shadow-sm' : 'text-[#6B7690]'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** A group with no Tasks and no known Members (a PM can still see it after its last known
 *  Member left). Its saved weekly insight still shows on the overview (#22). */
export function EmptyGroup({ insight, showInsight, files = [] }: {
  insight: DashboardInsight | null; showInsight: boolean; files?: DashboardFile[]
}) {
  return (
    <>
      {showInsight && insight && <InsightCard insight={insight} />}
      {showInsight && files.length > 0 && <FilesCard files={files} />}
      <Notice tone="doc" title="ยังไม่มีงานในกลุ่มนี้" text="เมื่อน้องจดดีสรุปแชตและทีมยืนยัน งานจะแสดงที่นี่" />
    </>
  )
}

/** #22: the group's latest weekly insight. A week that never reached the group (near the
 *  LINE quota, a failed push, or no Tasks) says so: the Dashboard is where it shows. */
function InsightCard({ insight }: { insight: DashboardInsight | null }) {
  if (!insight) {
    return <p className="rounded-2xl bg-white p-3 text-xs text-[#8A94A6] ring-1 ring-[#E6EAF0]">{INSIGHT_TEXT.none}</p>
  }
  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-white p-3 ring-1 ring-[#E6EAF0]">
      <h2 className="text-sm font-bold">{INSIGHT_TEXT.title(insight.weekStart)}</h2>
      <StatusTiles tiles={insightTiles(insight)} />
      {!insight.posted && <p className="text-xs text-[#8A94A6]">{INSIGHT_TEXT.notPosted}</p>}
    </section>
  )
}

/** The PM overview's top card: counts of the group's Tasks right now (the payload holds every
 *  Task for an 'overview' group), with the last weekly insight as one line under them. A
 *  Member's payload holds only some Tasks, so their overview keeps InsightCard. */
export function LiveCountsCard({ tasks, insight }: { tasks: DashboardTask[]; insight: DashboardInsight | null }) {
  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-white p-3 ring-1 ring-[#E6EAF0]">
      <h2 className="text-sm font-bold">{INSIGHT_TEXT.liveTitle}</h2>
      <StatusTiles tiles={liveTiles(tasks)} />
      <p className="text-xs text-[#8A94A6]">{insight ? INSIGHT_TEXT.weeklyLine(insight) : INSIGHT_TEXT.none}</p>
    </section>
  )
}

function StatusTiles({ tiles }: { tiles: { status: TaskStatus; count: number }[] }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {tiles.map((t) => (
        <div key={t.status} className="flex flex-col gap-1 rounded-xl p-2 ring-1 ring-[#E6EAF0]">
          <span className="flex items-center gap-1 text-[11px] text-[#6B7690]">
            <span className={`h-1.5 w-1.5 rounded-full ${DOT[t.status]}`} />
            {STATUS_LABEL[t.status]}
          </span>
          <span className="text-xl font-bold">{t.count}</span>
        </div>
      ))}
    </div>
  )
}

/** #4: the group's saved files, newest first. Each link opens in Drive (without a Google
 *  account when the Project folder is shared by link). A card skipped near the LINE quota
 *  leaves the file here only. */
export function FilesCard({ files }: { files: DashboardFile[] }) {
  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-white p-3 ring-1 ring-[#E6EAF0]">
      <h2 className="text-sm font-bold">{FILES_TEXT.title}</h2>
      {files.length === 0 ? (
        <p className="text-xs text-[#8A94A6]">{FILES_TEXT.none}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((f) => (
            <li key={f.fileId} className="min-w-0">
              <a href={f.driveLink} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-bold text-[#1F5BAD]">
                {f.fileName}
              </a>
              <span className="block text-xs text-[#8A94A6]">{fileLine(f)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${BADGE[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} />
      {STATUS_LABEL[status]}
    </span>
  )
}

function Primary({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full rounded-xl bg-[#1F5BAD] px-4 py-3 text-sm font-bold text-white">
      {children}
    </button>
  )
}
function Secondary({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full rounded-xl bg-[#DCE8F7] px-4 py-3 text-sm font-bold text-[#1F5BAD]">
      {children}
    </button>
  )
}

/** Empty, not-a-member and load-failed screens (Figma 6b, last row). */
function Notice({ tone, title, text, children }: { tone: 'doc' | 'user' | 'refresh'; title: string; text: string; children?: ReactNode }) {
  const icon = tone === 'doc' ? '▤' : tone === 'user' ? '☺' : '↻'
  const bg = tone === 'doc' ? 'bg-[#DCE8F7] text-[#1F5BAD]' : tone === 'user' ? 'bg-[#FCEFC7] text-[#7A4B00]' : 'bg-[#FDE4DC] text-[#C2410C]'
  return (
    <div role={tone === 'refresh' ? 'alert' : undefined} className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span aria-hidden className={`flex h-12 w-12 items-center justify-center rounded-full text-xl ${bg}`}>{icon}</span>
      <h2 className="text-base font-bold">{title}</h2>
      <p className="text-sm text-[#8A94A6]">{text}</p>
      <div className="mt-3 flex w-full flex-col gap-2">{children}</div>
    </div>
  )
}

// ---------- Overview tab ----------

/** "4 สมาชิก · 9 งาน". In a 'mine' group (#90) only the overview groups' count is the
 *  whole group's, so a Member's row leaves the Task count out. */
function summaryLine(s: GroupSummary): string {
  return s.access === 'mine' ? `${s.memberCount} สมาชิก` : `${s.memberCount} สมาชิก · ${s.taskCount} งาน`
}

/** #90: a Member's overview of a group ("งานของฉัน"). Their payload holds their own Tasks,
 *  the unowned ones and the weekly insight, so it shows those, the saved files and who is
 *  in the group, never the per-Member status cards (everyone else would look idle). An
 *  unowned Task opens the Task page, where they can take it. */
function MineOverview({ group, now, onOpen }: { group: DashboardGroup; now: Date; onOpen: (taskId: string) => void }) {
  const open = filterTasks(group.tasks.filter((t) => t.assigneeLineUserId !== null), 'all')
  const unowned = unownedTasks(group.tasks)
  return (
    <>
      <InsightCard insight={group.insight} />
      <div>
        <h2 className="text-base font-bold">งานของฉัน {open.length} งาน</h2>
        <p className="text-xs text-[#8A94A6]">เจ้าของบอทเห็นภาพรวมงานของทั้งกลุ่ม</p>
      </div>
      {open.length === 0 ? (
        <p className="rounded-2xl bg-white p-4 text-sm text-[#8A94A6] ring-1 ring-[#E6EAF0]">ยังไม่มีงานที่มอบให้คุณในกลุ่มนี้</p>
      ) : (
        <div className="flex flex-col gap-2">
          {open.map((t) => <TaskRow key={t.taskId} task={t} now={now} onOpen={onOpen} />)}
        </div>
      )}
      {unowned.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-base font-bold">ยังไม่มีคนรับ {unowned.length} งาน</h2>
          {unowned.map((t) => (
            <div key={t.taskId} className="flex items-center gap-3 rounded-2xl border border-dashed border-[#E0A100] bg-[#FFFBEB] p-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">{t.title}</span>
                <span className="block text-xs text-[#B45309]">ยังไม่มีคนทำ{t.dueAt ? ` · ส่ง ${dueLabel(t.dueAt, now)}` : ''}</span>
              </span>
              <button type="button" onClick={() => onOpen(t.taskId)} className="shrink-0 rounded-xl bg-[#DCE8F7] px-4 py-2 text-sm font-bold text-[#1F5BAD]">
                รับงานนี้
              </button>
            </div>
          ))}
        </div>
      )}
      <FilesCard files={group.files} />
      <div>
        <h2 className="text-base font-bold">สมาชิก {group.members.length} คน</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {group.members.map((m) => (
            <span key={m.lineUserId} className="flex items-center gap-2 rounded-full bg-white py-1 pl-1 pr-3 text-sm ring-1 ring-[#E6EAF0]">
              <Avatar name={memberName(m)} size="sm" />
              {memberName(m)}
              {m.lineUserId === group.ownerLineUserId && (
                <span className="rounded-full bg-[#DCE8F7] px-2 text-[11px] font-bold text-[#1F5BAD]">เจ้าของบอท</span>
              )}
            </span>
          ))}
        </div>
      </div>
    </>
  )
}

function Overview({ group, now, onMember, onOpen }: {
  group: DashboardGroup; now: Date; onMember: (id: string) => void; onOpen: (taskId: string) => void
}) {
  const cards = memberCards(group)
  const unowned = unownedTasks(group.tasks)
  return (
    <>
      <LiveCountsCard tasks={group.tasks} insight={group.insight} />
      <FilesCard files={group.files} />
      <div>
        <h2 className="text-base font-bold">สมาชิก {cards.length} คน</h2>
        <p className="text-xs text-[#8A94A6]">{overviewLine(cards)}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {cards.map((c) => (
          <button
            key={c.lineUserId} type="button" onClick={() => onMember(c.lineUserId)}
            className="flex flex-col gap-2 rounded-2xl bg-white p-3 text-left shadow-sm ring-1 ring-[#E6EAF0]"
          >
            <span className="flex items-center gap-2">
              <Avatar name={c.name} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-bold">{c.name}</span>
            </span>
            <span>
              {c.state === 'idle' ? (
                <span className="inline-flex rounded-full bg-[#EEF1F6] px-2.5 py-1 text-xs font-bold text-[#6B7690]">ว่าง</span>
              ) : (
                <StatusPill status={c.state === 'working' ? 'in_process' : 'done'} />
              )}
            </span>
            <span className="min-h-[2.5rem]">
              {c.task ? (
                <>
                  <span className="block truncate text-xs font-bold">{c.task.title}</span>
                  <span className={`block text-xs ${c.state === 'working' && isOverdue(c.task, now) ? 'text-[#B42318]' : 'text-[#8A94A6]'}`}>
                    {c.state === 'done' ? '✓ เสร็จแล้ว' : dueLabel(c.task.dueAt, now)}
                  </span>
                </>
              ) : (
                <span className="block text-xs text-[#8A94A6]">ยังไม่มีงาน</span>
              )}
            </span>
          </button>
        ))}
      </div>
      {unowned[0] && (
        <div className="flex items-center gap-3 rounded-2xl border border-dashed border-[#E0A100] bg-[#FFFBEB] p-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold">{unowned[0].title}</span>
            <span className="block text-xs text-[#B45309]">
              ยังไม่มีคนทำ{unowned[0].dueAt ? ` · ส่ง ${dueLabel(unowned[0].dueAt, now)}` : ''}
              {unowned.length > 1 ? ` · และอีก ${unowned.length - 1} งาน` : ''}
            </span>
          </span>
          <button type="button" onClick={() => onOpen(unowned[0].taskId)} className="shrink-0 rounded-xl bg-[#DCE8F7] px-4 py-2 text-sm font-bold text-[#1F5BAD]">
            เลือกคนทำ
          </button>
        </div>
      )}
    </>
  )
}

/** One member's page: their counts and Tasks (Figma 6b, person screens). */
function MemberDetail({ group, memberId, now, onBack, onOpen }: {
  group: DashboardGroup; memberId: string; now: Date; onBack: () => void; onOpen: (taskId: string) => void
}) {
  const member = group.members.find((m) => m.lineUserId === memberId)
  const name = memberName(member)
  const { working, done } = tasksOf(group, memberId)
  const counts: StatusCounts = { not_assigned: 0, in_process: working.length, done: done.length }
  const state = working.length ? 'in_process' : done.length ? 'done' : null
  return (
    <>
      <button type="button" onClick={onBack} className="flex items-center gap-1 self-start text-xs text-[#6B7690]">
        <span aria-hidden>‹</span> กลับไปหน้าภาพรวม
      </button>
      <div className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-[#E6EAF0]">
        <Avatar name={name} />
        <span className="min-w-0 flex-1 truncate text-base font-bold">{name}</span>
        {state ? <StatusPill status={state} /> : <span className="rounded-full bg-[#DDF3E6] px-2.5 py-1 text-xs font-bold text-[#17703F]">ว่างงาน</span>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {STATUS_ORDER.map((s) => (
          <div key={s} className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-[#E6EAF0]">
            <span className="block text-[11px] text-[#8A94A6]">{STATUS_LABEL[s]}</span>
            <span className="block text-2xl font-bold">{counts[s]}</span>
          </div>
        ))}
      </div>
      <Section title="งานที่กำลังทำ" empty="ไม่มีงานที่ต้องทำ" tasks={working} now={now} onOpen={onOpen} />
      <Section title="งานที่ทำเสร็จแล้ว" empty="ยังไม่มีงานที่เสร็จ" tasks={done} now={now} onOpen={onOpen} />
    </>
  )
}

function Section({ title, empty, tasks, now, onOpen }: {
  title: string; empty: string; tasks: DashboardTask[]; now: Date; onOpen: (taskId: string) => void
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-bold">{title}</h3>
      {tasks.length === 0 ? <p className="py-3 text-center text-xs text-[#8A94A6]">{empty}</p> : tasks.map((t) => (
        <TaskRow key={t.taskId} task={t} now={now} onOpen={onOpen} />
      ))}
    </section>
  )
}

// ---------- Calendar tab ----------

function Calendar({ tasks, now, offset, picked, onOffset, onPick, onOpen }: {
  tasks: DashboardTask[]; now: Date; offset: number; picked: string | null
  onOffset: (o: number) => void; onPick: (d: string | null) => void; onOpen: (taskId: string) => void
}) {
  const counts = countByStatus(tasks)
  const week = calendarWeek(tasks, now, offset)
  const shown = picked ? [picked] : week.days.map((d) => d.date)
  const byDay = shown.map((date) => ({ date, tasks: tasksDueOn(tasks, date) })).filter((d) => d.tasks.length > 0)
  const name = (t: DashboardTask) => t.assigneeName?.trim() || FALLBACK_MEMBER
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {STATUS_ORDER.map((s) => (
          <span key={s} className={`rounded-full px-3 py-1 text-xs font-bold ${BADGE[s]}`}>
            {STATUS_LABEL[s]} {counts[s]}
          </span>
        ))}
      </div>
      <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-[#E6EAF0]">
        <div className="flex items-center justify-between">
          <button type="button" aria-label="สัปดาห์ก่อน" onClick={() => onOffset(offset - 1)} className="px-2 text-lg text-[#6B7690]">‹</button>
          <span className="text-center">
            <span className="block text-sm font-bold">{offset === 0 ? 'สัปดาห์นี้' : 'สัปดาห์'} · {week.range}</span>
            <span className="block text-xs text-[#8A94A6]">{week.dueCount} งานครบกำหนด</span>
          </span>
          <button type="button" aria-label="สัปดาห์ถัดไป" onClick={() => onOffset(offset + 1)} className="px-2 text-lg text-[#6B7690]">›</button>
        </div>
        <div className="mt-3 grid grid-cols-7 gap-1 text-center">
          {week.days.map((d) => {
            const on = picked === d.date
            return (
              <button
                key={d.date} type="button" aria-pressed={on} onClick={() => onPick(on ? null : d.date)}
                className={`flex flex-col items-center gap-1 rounded-xl py-2 ${on || (d.isToday && !picked) ? 'bg-[#13294B] text-white' : ''}`}
              >
                <span className="text-[11px] opacity-70">{d.weekday}</span>
                <span className="text-sm font-bold">{d.day}</span>
                <span className="flex h-1.5 gap-0.5">
                  {d.statuses.slice(0, 3).map((s, i) => <span key={i} className={`h-1.5 w-1.5 rounded-full ${DOT[s]}`} />)}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {byDay.length === 0 ? (
        <p className="py-6 text-center text-sm text-[#8A94A6]">ไม่มีงานครบกำหนดในช่วงนี้</p>
      ) : (
        byDay.map((d) => (
          <section key={d.date} className="flex flex-col gap-2">
            <h3 className="text-xs font-bold text-[#6B7690]">{dayHeading(d.date)}</h3>
            {d.tasks.map((t) => (
              <TaskRow key={t.taskId} task={t} now={now} onOpen={onOpen} sub={`${t.assigneeLineUserId ? name(t) : STATUS_LABEL.not_assigned} · ${hhmm(new Date(t.dueAt!))}`} />
            ))}
          </section>
        ))
      )}
    </>
  )
}

// ---------- All Tasks tab ----------

function AllTasks({ group, now, filter, onFilter, onOpen }: {
  group: DashboardGroup; now: Date; filter: TaskFilter; onFilter: (f: TaskFilter) => void; onOpen: (taskId: string) => void
}) {
  const rows = filterTasks(group.tasks, filter)
  const name = (t: DashboardTask) => t.assigneeName?.trim() || FALLBACK_MEMBER
  return (
    <>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => onFilter(f.key)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-xs font-bold ${filter === f.key ? 'bg-[#1F5BAD] text-white' : 'bg-white text-[#6B7690] ring-1 ring-[#E6EAF0]'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-[#8A94A6]">{rows.length} งาน</p>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-[#8A94A6]">ไม่มีงานในสถานะนี้</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((t) => {
            const owner = t.assigneeLineUserId ? `คนทำ ${name(t)}` : STATUS_LABEL.not_assigned
            const due = t.status === 'done' ? 'เสร็จเรียบร้อย' : t.dueAt ? `ส่ง ${dueLabel(t.dueAt, now)}` : ''
            return <TaskRow key={t.taskId} task={t} now={now} onOpen={onOpen} sub={[owner, due].filter(Boolean).join(' · ')} />
          })}
        </div>
      )}
    </>
  )
}

function TaskRow({ task, now, onOpen, sub }: { task: DashboardTask; now: Date; onOpen: (taskId: string) => void; sub?: string }) {
  const late = isOverdue(task, now)
  return (
    <button
      type="button" onClick={() => onOpen(task.taskId)}
      className="flex items-center gap-3 rounded-2xl bg-white p-3 text-left shadow-sm ring-1 ring-[#E6EAF0]"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">{task.title}</span>
        <span className={`block text-xs ${late ? 'text-[#B42318]' : 'text-[#8A94A6]'}`}>
          {sub ?? (task.dueAt ? `ส่ง ${dueLabel(task.dueAt, now)}` : STATUS_LABEL[task.status])}
        </span>
        {task.tags.length > 0 && (
          // #109: the Task's tags.
          <span className="mt-1 flex flex-wrap gap-1">
            {task.tags.map((t) => (
              <span key={t} className="rounded-full bg-[#EAF1FB] px-2 py-0.5 text-[11px] font-semibold text-[#1F5BAD]">{t}</span>
            ))}
          </span>
        )}
      </span>
      <StatusPill status={task.status} />
    </button>
  )
}

// ---------- PM comparison across groups ----------

function Compare({ summaries, onOpen }: { summaries: GroupSummary[]; onOpen: (groupId: string) => void }) {
  return (
    <>
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-bold">งานของแต่ละกลุ่ม</h2>
      </div>
      {summaries.map((s) => (
        <section key={s.groupId} className="rounded-2xl bg-[#13294B] p-4 text-white">
          <div className="flex items-center justify-between gap-2">
            <h3 className="min-w-0 truncate text-sm font-bold">{s.name}</h3>
            <button type="button" onClick={() => onOpen(s.groupId)} className="shrink-0 text-xs text-[#8DB6EC]">ดูงานทั้งหมด</button>
          </div>
          <div className="mt-3 flex items-center gap-4">
            <Ring counts={s.counts} percent={s.percent} />
            <div className="min-w-0">
              <p className="text-[11px] text-[#9FB0CC]">ความคืบหน้ากลุ่ม</p>
              <p className="text-base font-bold">เสร็จ {s.counts.done} จาก {s.taskCount} งาน</p>
              <p className="text-[11px] text-[#9FB0CC]">
                {s.nextDue ? `งานถัดไปครบกำหนด ${dueLabel(s.nextDue.dueAt, new Date())}` : 'ไม่มีงานค้างที่มีกำหนดส่ง'}
              </p>
            </div>
          </div>
          <p className="mt-3 flex flex-wrap gap-x-3 text-[11px] text-[#CBD6E8]">
            {(['done', 'in_process', 'not_assigned'] as const).map((st) => (
              <span key={st} className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: RING[st] }} />
                {STATUS_LABEL[st]} {s.counts[st]}
              </span>
            ))}
          </p>
        </section>
      ))}
    </>
  )
}

/** Progress ring: the Done share in green, the rest as a track. */
function Ring({ counts, percent }: { counts: StatusCounts; percent: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  const total = counts.done + counts.in_process + counts.not_assigned
  return (
    <svg role="img" aria-label={`เสร็จ ${percent}%`} width="64" height="64" viewBox="0 0 64 64" className="shrink-0">
      <circle cx="32" cy="32" r={r} fill="none" stroke="#2A4470" strokeWidth="6" />
      {total > 0 && (
        <circle
          cx="32" cy="32" r={r} fill="none" stroke={RING.done} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${(c * percent) / 100} ${c}`} transform="rotate(-90 32 32)"
        />
      )}
      <text x="32" y="36" textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff">{percent}%</text>
    </svg>
  )
}

// ---------- Group picker sheet ----------

function GroupSheet({ compareCount, summaries, scope, compare, onPick, onClose }: {
  compareCount: number; summaries: GroupSummary[]; scope: Scope; compare: boolean
  onPick: (s: Scope) => void; onClose: () => void
}) {
  const row = (on: boolean, key: string, avatar: string, title: string, sub: string, dark: boolean) => (
    <button
      key={key} type="button" aria-pressed={on} onClick={() => onPick(key)}
      className={`flex w-full items-center gap-3 rounded-2xl p-3 text-left ring-1 ${on ? 'bg-[#EAF1FB] ring-[#1F5BAD]' : 'bg-white ring-[#E6EAF0]'}`}
    >
      <Avatar name={avatar} dark={dark} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">{title}</span>
        <span className="block text-xs text-[#8A94A6]">{sub}</span>
      </span>
      <span aria-hidden className={`h-5 w-5 rounded-full border-2 ${on ? 'border-[#1F5BAD] bg-[#1F5BAD]' : 'border-[#CBD3E0]'}`} />
    </button>
  )
  return (
    <div className="fixed inset-0 z-10 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div role="dialog" aria-label="เลือกกลุ่ม" className="max-h-[75vh] overflow-y-auto rounded-t-3xl bg-[#F4F6FA] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold">เลือกกลุ่ม</h2>
          <button type="button" aria-label="ปิด" onClick={onClose} className="px-2 text-xl text-[#6B7690]">×</button>
        </div>
        <div className="flex flex-col gap-2">
          {compare && row(scope === 'all', 'all', 'ทั้ง', 'ภาพรวมกลุ่มทั้งหมด', `${compareCount} กลุ่ม`, true)}
          {compare && <p className="mt-1 text-[11px] text-[#8A94A6]">กลุ่มทั้งหมด</p>}
          {summaries.map((s) => row(scope === s.groupId, s.groupId, s.name, s.name, summaryLine(s), false))}
        </div>
      </div>
    </div>
  )
}
