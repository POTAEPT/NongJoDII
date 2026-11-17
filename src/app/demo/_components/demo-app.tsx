'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { readLiffParams } from '@/app/liff/params'
import { demoApi, type AiCall, type DemoDirectInfo, type DemoState, type PostbackParams, type WeeklyResult } from '../_lib/api'
import { AI_KIND, usd } from '../_lib/ai'
import { BOT_NAME } from './avatars'
import { ChatList } from './chat-list'
import { ChatThread, type ThreadItem } from './chat-thread'
import { Composer, SenderSwitcher } from './composer'
import { DirectBottom } from './direct-chat'
import {
  DemoContext, parseDemoLiff, type DemoCtx, type FlexActionLike, type LiffTarget, type LocalEcho,
} from './demo-context'
import { LiffDrawer } from './liff-drawer'
import { ChatHeader, PhoneFrame, StatusBar } from './phone-frame'
import { PresenterPanel } from './presenter-panel'

const POLL_MS = 1000
/** localStorage key: AI call ids already shown as a toast (survives a reload). */
const SEEN_AI_KEY = 'nongjodii-demo-ai-seen'

function readSeen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_AI_KEY)
    const ids: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeSeen(seen: Set<string>): void {
  try {
    // The server keeps the last 50 calls; 200 ids cover them with room to spare.
    window.localStorage.setItem(SEEN_AI_KEY, JSON.stringify([...seen].slice(-200)))
  } catch {
    // Private mode or blocked storage: the toasts may repeat after a reload, nothing else.
  }
}

/** One toast per new AI call (keyed by its id), kept until closed, stacked by Sonner. */
function useAiToasts(calls: AiCall[] | undefined, totalUsd: number | undefined): void {
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!calls) return
    if (seen.current === null) seen.current = readSeen()
    const known = seen.current
    const fresh = calls.filter((c) => !known.has(c.id))
    if (fresh.length === 0) return
    // The running total after each new call, counted back from the server's total.
    let after = (totalUsd ?? 0) - fresh.slice(1).reduce((n, c) => n + (c.costUsd ?? 0), 0)
    fresh.forEach((c, i) => {
      if (i > 0) after += c.costUsd ?? 0
      known.add(c.id)
      const cost = c.fallback ? 'fallback $0' : usd(c.costUsd, c.estimated)
      toast(`AI · ${AI_KIND[c.kind]} · ${cost} · รวม ${usd(after)}`, {
        id: c.id,
        description: `${c.model} · ${c.inputTokens.toLocaleString()} in / ${c.outputTokens.toLocaleString()} out tokens`,
        duration: Infinity,
        closeButton: true,
      })
    })
    writeSeen(known)
  }, [calls, totalUsd])
}

export function DemoApp() {
  const [state, setState] = useState<DemoState | null>(null)
  const [offline, setOffline] = useState(false)
  const [meKey, setMeKey] = useState<string | null>(null)
  const [liffTarget, setLiffTarget] = useState<LiffTarget | null>(null)
  const [replyTo, setReplyTo] = useState<ThreadItem | null>(null)
  const [echoes, setEchoes] = useState<LocalEcho[]>([])
  /** chat: the selected group; direct: the bot's 1:1 chat with "me"; list: the chat list. */
  const [phoneView, setPhoneView] = useState<'chat' | 'list' | 'direct'>('chat')
  const inFlight = useRef(false)

  const refresh = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    demoApi.state()
      .then((s) => {
        setState(s)
        setOffline(false)
      })
      .catch(() => setOffline(true))
      .finally(() => {
        inFlight.current = false
      })
  }, [])

  // Poll the sim state every second.
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  // /demo?view=..&id=.. opens the LIFF drawer on load (the Google callback page links here).
  useEffect(() => {
    const p = readLiffParams(window.location.search)
    if (!p.view) return
    const t = setTimeout(() => setLiffTarget({ view: p.view as string, id: p.id }), 0)
    window.history.replaceState(null, '', window.location.pathname)
    return () => clearTimeout(t)
  }, [])

  // "Me" is the chosen persona while they are in the selected group (in the 1:1 chat: anyone);
  // else the Owner (or the first one in the group).
  const me = useMemo(() => {
    const ps = state?.personas ?? []
    const chosen = ps.find((p) => p.key === meKey && (p.inGroup || phoneView === 'direct'))
    return chosen ?? ps.find((p) => p.owner && p.inGroup) ?? ps.find((p) => p.inGroup) ?? ps[0] ?? null
  }, [state, meKey, phoneView])
  const meKeyNow = me?.key ?? null

  // The server's open 1:1 thread follows the phone: "me"'s while the 1:1 view shows, else
  // none. Reconciled against state.openDirect, so a reset or a reload cannot leave it stale
  // (a stale one keeps a read card unread, or new cards read).
  const directOpen = phoneView === 'direct'
  const wantOpen = directOpen && meKeyNow ? meKeyNow : null
  const serverOpen = state?.openDirect
  const asked = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (serverOpen === undefined) return
    if (serverOpen === wantOpen) {
      asked.current = undefined
      return
    }
    if (asked.current === wantOpen) return
    asked.current = wantOpen
    demoApi.openDirect(wantOpen).catch(() => undefined).finally(() => {
      asked.current = undefined
      refresh()
    })
  }, [serverOpen, wantOpen, refresh])

  const openDirect = useCallback((personaKey?: string) => {
    if (personaKey) setMeKey(personaKey)
    setPhoneView('direct')
  }, [])
  const leaveDirect = useCallback(() => setPhoneView('list'), [])

  // "ส่งสรุปรายสัปดาห์": open the Owner's 1:1 chat with the new card.
  const onWeekly = useCallback((r: WeeklyResult) => {
    const owner = r.owner ? state?.personas.find((p) => p.key === r.owner) : undefined
    if (owner) openDirect(owner.key)
    if (r.ownerCards > 0) toast.success(`ส่งสรุปรายสัปดาห์แล้ว: การ์ดรายคนเข้าแชตส่วนตัวของ ${owner?.lineName ?? r.owner}`)
    else toast.warning('เลื่อนเวลาแล้ว แต่ไม่มีการ์ดรายคนใหม่ (ดูเหตุผลในแท็บ Log)')
  }, [state, openDirect])

  // Another group opened: the reply quote and the local echoes belonged to the old one.
  const selectedGroup = state?.selectedGroup ?? null
  useEffect(() => {
    const t = setTimeout(() => {
      setReplyTo(null)
      setEchoes([])
    }, 0)
    return () => clearTimeout(t)
  }, [selectedGroup])

  const openGroup = useCallback((lineGroupId: string) => {
    setPhoneView('chat')
    demoApi.selectGroup(lineGroupId)
      .catch((e: unknown) => toast.error(`เปิดกลุ่มไม่ได้: ${e instanceof Error ? e.message : String(e)}`))
      .finally(refresh)
  }, [refresh])

  useAiToasts(state?.ai.calls, state?.ai.totalUsd)

  const personaName = useCallback((key: string | undefined) => (
    state?.personas.find((p) => p.key === key)?.lineName ?? key ?? '?'
  ), [state])

  const runAction = useCallback((action: FlexActionLike, params?: PostbackParams) => {
    if (action.type === 'uri' && action.uri) {
      const t = parseDemoLiff(action.uri)
      if (t) setLiffTarget(t)
      else window.open(action.uri, '_blank', 'noopener')
      return
    }
    if (directOpen && me) {
      // The 1:1 chat: the event's source is the person, never the selected group.
      if ((action.type === 'postback' || action.type === 'datetimepicker') && action.data) {
        demoApi.postbackDirect(me.key, action.data)
          .catch((e: unknown) => toast.error(`กดปุ่มไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`))
          .finally(refresh)
      } else if (action.type === 'message' && action.label) {
        void demoApi.sendDirect(me.key, action.label).finally(refresh)
      }
      return
    }
    if ((action.type === 'postback' || action.type === 'datetimepicker') && action.data && me) {
      if (action.displayText) {
        const echo: LocalEcho = { id: `echo-${Date.now()}`, persona: me.key, text: action.displayText, at: state?.now ?? new Date().toISOString() }
        setEchoes((e) => [...e, echo])
      }
      demoApi.postback(me.key, action.data, params)
        .catch((e: unknown) => toast.error(`กดปุ่มไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`))
        .finally(refresh)
      return
    }
    if (action.type === 'message' && action.label && me) {
      void demoApi.sendText(me.key, action.label).finally(refresh)
    }
  }, [me, state?.now, refresh, directOpen])

  const ctx: DemoCtx = useMemo(() => ({
    state, me, personaName, refresh, openLiff: setLiffTarget, runAction,
  }), [state, me, personaName, refresh, runAction])

  // Server chat plus the local displayText echoes the server has not shown (yet).
  const items: ThreadItem[] = useMemo(() => {
    const chat = state?.chat ?? []
    const live = echoes.filter((e) => !chat.some((c) => c.from === 'user' && c.persona === e.persona
      && c.message.type === 'text' && 'text' in c.message && c.message.text === e.text && c.at >= e.at))
    const local: ThreadItem[] = live.map((e) => ({
      id: e.id, at: e.at, from: 'user', persona: e.persona, local: true, message: { type: 'text', text: e.text },
    }))
    return [...chat, ...local].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  }, [state, echoes])

  // A reset clears the chat; the local echoes go with it.
  const chatLen = state?.chat.length ?? 0
  useEffect(() => {
    if (chatLen === 0) {
      const t = setTimeout(() => setEchoes([]), 0)
      return () => clearTimeout(t)
    }
  }, [chatLen])

  const onUnsend = useCallback((item: ThreadItem) => {
    if (!me || !item.messageId) return
    demoApi.unsend(me.key, item.messageId)
      .catch((e: unknown) => toast.error(`ยกเลิกไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`))
      .finally(refresh)
  }, [me, refresh])

  const members = (state?.personas.filter((p) => p.inGroup).length ?? 0) + (state?.group.botInGroup ? 1 : 0)
  const directInfo: DemoDirectInfo | null = me
    ? state?.directChats.find((d) => d.persona === me.key) ?? { persona: me.key, lastMessage: null, unread: 0 }
    : null
  const groupUnread = (state?.groups ?? []).reduce((n, g) => n + g.unread, 0)
  const otherUnread = groupUnread + (directOpen ? 0 : directInfo?.unread ?? 0)
  const directItems = (me && state?.direct[me.key]) || []
  const closeLiff = useCallback(() => setLiffTarget(null), [])

  return (
    <DemoContext.Provider value={ctx}>
      <TooltipProvider delayDuration={300}>
        <div className="demo-root flex min-h-dvh w-full items-center justify-center gap-8 px-6 py-6 text-[#12294D]">
          <PhoneFrame>
            <StatusBar now={state?.now ?? null} />
            {phoneView === 'list' && (
              <ChatList groups={state?.groups ?? []} direct={directInfo} now={state?.now ?? null} onOpen={openGroup} onOpenDirect={() => openDirect()} />
            )}
            {phoneView === 'chat' && (
              <ChatHeader name={state?.group.name ?? 'กลุ่ม LINE'} members={members} unread={otherUnread} onBack={() => setPhoneView('list')} />
            )}
            {phoneView === 'direct' && <ChatHeader name={BOT_NAME} unread={otherUnread} onBack={leaveDirect} />}
            {offline && (
              <div className="bg-[#FDE8DD] px-3 py-1.5 text-center text-[12px] text-[#C2410C]">ติดต่อเซิร์ฟเวอร์เดโมไม่ได้ กำลังลองใหม่…</div>
            )}
            {phoneView === 'chat' && (
              <>
                <ChatThread items={items} onReply={setReplyTo} onUnsend={onUnsend} />
                <SenderSwitcher selected={me?.key ?? null} onSelect={setMeKey} />
                <Composer replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSent={refresh} />
              </>
            )}
            {phoneView === 'direct' && (
              <>
                <ChatThread items={directItems} onReply={() => undefined} onUnsend={() => undefined} direct />
                <SenderSwitcher selected={me?.key ?? null} onSelect={setMeKey} allowAll />
                <DirectBottom onSent={refresh} />
              </>
            )}
            <div className="flex h-6 shrink-0 items-center justify-center bg-white">
              <span className="h-[5px] w-[134px] rounded-full bg-black" />
            </div>
            <LiffDrawer target={liffTarget} lineUserId={me?.lineUserId ?? null} onNavigate={setLiffTarget} onClose={closeLiff} />
          </PhoneFrame>
          <section className="flex h-[min(852px,calc(100dvh-48px))] max-w-[760px] min-w-[520px] flex-1 flex-col">
            <PresenterPanel onOpenLiff={(view, id) => setLiffTarget({ view, id })} onOpenGroup={openGroup} onWeekly={onWeekly} />
          </section>
        </div>
        <Toaster theme="light" position="bottom-right" richColors closeButton visibleToasts={6} />
      </TooltipProvider>
    </DemoContext.Provider>
  )
}
