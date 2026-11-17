'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { cn } from 'cn'
import {
  Bot, CalendarClock, Clock3, Cloud, Crown, Gauge, LayoutDashboard, LogIn, LogOut, Play, Plus, RotateCcw, ScrollText, Sparkles, Trash2, UserPlus, Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AI_KIND, usd } from '../_lib/ai'
import { demoApi, type ClockAdvance, type DemoGroupInfo, type Persona, type ScriptInfo, type WeeklyResult } from '../_lib/api'
import { clockLabel, timeLabel } from '../_lib/time'
import { BotAvatar, PersonaAvatar } from './avatars'
import { useDemo } from './demo-context'

/** Short stage titles for the known scripts; others show their file name. */
const SCRIPT_TITLE: Record<string, string> = {
  '01-clear-task': 'งานชัดเจน 1 งาน',
  '02-casual-no-task': 'คุยเล่น ไม่มีงาน',
  '03-several-tasks': 'หลายงานในแชตเดียว',
}

const ROLES = ['manager', 'developer', 'designer', 'marketing', 'research', 'other']

/** Runs a sim call with a toast on failure, then refreshes the state. */
function useRun() {
  const { refresh } = useDemo()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key)
    try {
      await fn()
      if (done) toast.success(done)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      refresh()
    }
  }
  return { busy, run }
}

export function PresenterPanel({ onOpenLiff, onOpenGroup, onWeekly }: {
  onOpenLiff: (view: string, id: string | null) => void
  onOpenGroup: (lineGroupId: string) => void
  /** After POST weekly: open the Owner's 1:1 chat and toast. */
  onWeekly: (r: WeeklyResult) => void
}) {
  const { state, me } = useDemo()
  const { busy, run } = useRun()
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center gap-3">
        <BotAvatar className="size-11" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] leading-tight font-semibold text-[#12294D]">น้องจดดี · LINE simulator</h1>
          <p className="truncate text-[14px] text-[#5F6B7E]">{state ? `${state.groups.length} กลุ่ม · เปิดอยู่: ${state.group.name}` : 'กำลังโหลด...'}</p>
        </div>
        <Button size="lg" variant="outline" className="h-10 gap-2 px-3.5 text-[15px]" title={me ? `เปิดในชื่อ ${me.lineName}` : undefined}
          onClick={() => onOpenLiff('dashboard', null)}>
          <LayoutDashboard /> เปิด Dashboard
        </Button>
        <WeeklyButton onWeekly={onWeekly} compact />
        <ResetButton busy={busy === 'reset'}
          onConfirm={(setup) => run('reset', () => demoApi.reset(setup),
            setup ? 'รีเซ็ตแล้ว (กลุ่มที่บันทึกไว้ ตั้งค่าแล้ว)' : 'รีเซ็ตแล้ว (กลุ่มใหม่ สำหรับ onboarding)')} />
      </div>

      <GroupBar onOpenGroup={onOpenGroup} />

      <StatusStrip />

      <Tabs defaultValue="scripts" className="min-h-0 flex-1">
        <TabsList className="h-11! w-full">
          <Tab value="scripts" icon={<Play />}>Scripts</Tab>
          <Tab value="people" icon={<Users />}>People</Tab>
          <Tab value="clock" icon={<Clock3 />}>Clock</Tab>
          <Tab value="quota" icon={<Gauge />}>Quota</Tab>
          <Tab value="ai" icon={<Sparkles />}>AI</Tab>
          <Tab value="google" icon={<Cloud />}>Google</Tab>
          <Tab value="log" icon={<ScrollText />}>Log</Tab>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto pt-2 pb-32">
          <TabsContent value="scripts"><ScriptsTab /></TabsContent>
          <TabsContent value="people"><PeopleTab /></TabsContent>
          <TabsContent value="clock"><ClockTab onWeekly={onWeekly} /></TabsContent>
          <TabsContent value="quota"><QuotaTab /></TabsContent>
          <TabsContent value="ai"><AiTab /></TabsContent>
          <TabsContent value="google"><GoogleTab onConnect={() => onOpenLiff('google', null)} /></TabsContent>
          <TabsContent value="log" className="h-full"><LogTab /></TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

function Tab({ value, icon, children }: { value: string; icon: ReactNode; children: ReactNode }) {
  return (
    <TabsTrigger value={value} className="gap-1.5 text-[14px]">
      {icon}{children}
    </TabsTrigger>
  )
}

function StatusStrip() {
  const { state } = useDemo()
  if (!state) return null
  const c = clockLabel(state.now)
  const q = state.quota
  return (
    <div className="grid grid-cols-4 gap-2">
      <Stat label="เวลาเดโม (กรุงเทพ)" value={c.time} sub={c.date} />
      <Stat label="น้องจดดีในกลุ่ม" value={state.group.botInGroup ? 'อยู่' : 'ยังไม่อยู่'} tone={state.group.botInGroup ? 'good' : 'warn'} />
      <Stat label="Push quota" value={q.limit === null ? `${q.used}` : `${q.used}/${q.limit}`} sub={q.limit === null ? 'ไม่จำกัด' : undefined}
        tone={q.limit !== null && q.used >= q.limit ? 'bad' : undefined} />
      <Stat label="AI" value={state.ai.busy ? 'กำลังคิด…' : state.ai.lastCallFallback ? 'Fallback' : 'พร้อม'}
        tone={state.ai.lastCallFallback ? 'warn' : 'good'} />
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-xl bg-white px-3.5 py-2.5 ring-1 ring-[#DDE3EC]">
      <p className="text-[12px] text-[#5F6B7E]">{label}</p>
      <p className={cn('text-[20px] leading-tight font-semibold tabular-nums',
        tone === 'good' && 'text-[#1B7A43]', tone === 'warn' && 'text-[#A15C00]', tone === 'bad' && 'text-[#C2410C]')}>{value}</p>
      {sub && <p className="truncate text-[12px] text-[#5F6B7E]">{sub}</p>}
    </div>
  )
}

function ResetButton({ busy, onConfirm }: { busy: boolean; onConfirm: (setup: boolean) => void }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="lg" variant="destructive" className="h-10 gap-2 px-3.5 text-[15px]" disabled={busy}><RotateCcw /> Reset</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>รีเซ็ตเดโมทั้งหมด?</DialogTitle>
          <DialogDescription>
            แชต งาน และ log หายทั้งหมด เลือกแบบที่จะเริ่ม
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <DialogClose asChild>
            <Button variant="outline" className="h-auto flex-col items-start gap-0.5 px-4 py-3 text-left whitespace-normal" onClick={() => onConfirm(true)}>
              <span className="text-[15px] font-semibold">กลุ่มที่บันทึกไว้ ตั้งค่าแล้ว (พร้อมสรุป)</span>
              <span className="text-[13px] font-normal text-[#5F6B7E]">ทีมพิตช์, ทีม Dev (Sub group), ลูกค้า ร้านกาแฟ · Nont เป็น Owner · มีงานใน Dashboard แล้ว · กลุ่มที่สร้างเพิ่มกลับมาตามที่ตั้งค่าไว้ (หรือยังไม่ตั้งค่า)</span>
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="outline" className="h-auto flex-col items-start gap-0.5 px-4 py-3 text-left whitespace-normal" onClick={() => onConfirm(false)}>
              <span className="text-[15px] font-semibold">กลุ่มใหม่ (เดโม onboarding)</span>
              <span className="text-[13px] font-normal text-[#5F6B7E]">กลุ่มเดียว ยังไม่ตั้งค่า น้องจดดียังไม่อยู่ในกลุ่ม</span>
            </Button>
          </DialogClose>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="ghost">ยกเลิก</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Groups ----------

/** The selected group (scripts play into it, People shows its members) and "สร้างกลุ่ม". */
function GroupBar({ onOpenGroup }: { onOpenGroup: (lineGroupId: string) => void }) {
  const { state } = useDemo()
  if (!state) return null
  const selected = state.groups.find((g) => g.lineGroupId === state.selectedGroup)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[14px] text-[#5F6B7E]">กลุ่มที่เลือก</span>
        <Select value={state.selectedGroup} onValueChange={onOpenGroup}>
          <SelectTrigger className="h-10! min-w-0 flex-1 text-[15px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {state.groups.map((g) => (
              <SelectItem key={g.lineGroupId} value={g.lineGroupId}>
                {g.name}
                <span className="text-[#8A94A6]">
                  {g.projectName ? (g.isSubGroup ? ` · Sub group ของ ${g.projectName}` : ' · กลุ่มหลัก') : ' · ยังไม่ตั้งค่า'}
                </span>
                {g.unread > 0 && <Badge className="ml-1 h-5 rounded-full bg-(--line-green) px-1.5 text-[11px] text-white">{g.unread}</Badge>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected && !selected.botInGroup && <Badge variant="outline" className="text-[#A15C00]">บอทไม่อยู่</Badge>}
        {selected && <DeleteGroupDialog group={selected} onlyOne={state.groups.length <= 1} />}
        <CreateGroupDialog />
      </div>
      {selected && <GroupHints group={selected} />}
    </div>
  )
}

/** Under the picker: the Dashboard rule for a group with no Project yet, and "ให้ทุกคนทักทาย"
 *  while the bot does not know some members (it learns people from their messages, #151). */
function GroupHints({ group }: { group: DemoGroupInfo }) {
  const { busy, run } = useRun()
  const unknown = group.botInGroup ? group.unknownMembers.length : 0
  if (group.projectName !== null && unknown === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-[14px] text-[#5F6B7E]">
      {group.projectName === null && <span className="min-w-0 flex-1">กลุ่มนี้จะขึ้นใน Dashboard หลังส่งฟอร์มตั้งค่าและเจ้าของยืนยัน</span>}
      {unknown > 0 && (
        <Button size="sm" variant="outline" className="ml-auto h-9 gap-1.5 text-[14px]" disabled={busy !== null}
          title={`น้องจดดียังไม่รู้จัก ${unknown} คนในกลุ่มนี้`}
          onClick={() => run('say-hi', () => demoApi.sayHi(group.lineGroupId), 'ทุกคนทักทายแล้ว')}>
          👋 ให้ทุกคนทักทาย ({unknown})
        </Button>
      )}
    </div>
  )
}

/** Deletes the selected group and its file (it no longer comes back after Reset). */
function DeleteGroupDialog({ group, onlyOne }: { group: DemoGroupInfo; onlyOne: boolean }) {
  const { busy, run } = useRun()
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="lg" variant="outline" className="h-10 px-3 text-[#C2410C]" disabled={onlyOne || busy !== null}
          title={onlyOne ? 'ลบกลุ่มสุดท้ายไม่ได้' : `ลบกลุ่ม ${group.name}`} aria-label={`ลบกลุ่ม ${group.name}`}>
          <Trash2 />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>ลบกลุ่ม {group.name}?</DialogTitle>
          <DialogDescription>
            {group.file
              ? `ลบไฟล์ src/app/demo/groups/${group.file} ด้วย กลุ่มนี้จะไม่กลับมาหลัง Reset`
              : 'กลุ่มนี้ไม่มีไฟล์ จะหายจากเดโมตอนนี้เท่านั้น'}
            {' '}แชตและงานของกลุ่มหายทั้งหมด ถ้ามี Sub group ที่ใช้กลุ่มนี้เป็นกลุ่มหลัก ต้องลบ Sub group ก่อน
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild><Button variant="ghost">ยกเลิก</Button></DialogClose>
          <DialogClose asChild>
            <Button variant="destructive" onClick={() => run('delete-group', () => demoApi.deleteGroup(group.lineGroupId), `ลบกลุ่ม ${group.name} แล้ว`)}>
              <Trash2 /> ลบกลุ่ม
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateGroupDialog() {
  const { state } = useDemo()
  const { busy, run } = useRun()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>(['nont'])
  if (!state) return null
  const toggle = (key: string) => setMembers((m) => (m.includes(key) ? m.filter((k) => k !== key) : [...m, key]))
  const canSubmit = name.trim() !== '' && members.length > 0
  const submit = () => run('create-group', async () => {
    await demoApi.createGroup({ name: name.trim(), members })
    setOpen(false)
    setName('')
  }, `สร้างกลุ่ม ${name.trim()} แล้ว`)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="h-10 gap-2 px-3.5 text-[15px]"><Plus /> สร้างกลุ่ม</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>สร้างกลุ่ม LINE ใหม่</DialogTitle>
          <DialogDescription>น้องจดดีเข้ากลุ่มและส่งการ์ดตั้งค่า เหมือนใน LINE จากนั้นกด “ให้ทุกคนทักทาย” แล้วเปิดการ์ดเพื่อเลือกโปรเจกต์ใหม่หรือ Sub group ในฟอร์มตั้งค่า กลุ่มถูกบันทึกเป็นไฟล์ จึงกลับมาหลัง Reset</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(e) => {
          e.preventDefault()
          if (canSubmit) void submit()
        }}>
          <label className="flex flex-col gap-1.5 text-[14px]">
            ชื่อกลุ่ม
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} placeholder="เช่น ทีมอีเวนต์" className="h-10 text-[15px]" autoFocus />
          </label>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[14px]">สมาชิก</legend>
            <div className="grid grid-cols-2 gap-2">
              {state.personas.map((p) => (
                <label key={p.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ring-[#DDE3EC] has-checked:bg-[#EEF5FF] has-checked:ring-[#1F5FB0]">
                  <input type="checkbox" className="size-4 accent-[#1F5FB0]" checked={members.includes(p.key)} onChange={() => toggle(p.key)} />
                  <PersonaAvatar personaKey={p.key} name={p.lineName} className="size-7 text-[12px]" />
                  <span className="text-[15px]">{p.lineName}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="ghost">ยกเลิก</Button></DialogClose>
            <Button type="submit" disabled={!canSubmit || busy !== null}>สร้างกลุ่ม</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-[17px] font-semibold">{title}</CardTitle>
            {description && <CardDescription className="text-[14px]">{description}</CardDescription>}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

// ---------- Scripts ----------

function ScriptsTab() {
  const { state } = useDemo()
  const { busy, run } = useRun()
  const [scripts, setScripts] = useState<ScriptInfo[] | null>(null)
  useEffect(() => {
    demoApi.scripts().then((r) => setScripts(r.scripts)).catch(() => setScripts([]))
  }, [])
  return (
    <div className="flex flex-col gap-3">
      {scripts === null && <p className="text-[14px] text-[#5F6B7E]">กำลังโหลดสคริปต์...</p>}
      {scripts?.length === 0 && <p className="text-[14px] text-[#C2410C]">โหลดรายการสคริปต์ไม่ได้</p>}
      {state && (
        <p className="text-[14px] text-[#5F6B7E]">สคริปต์จะเล่นในกลุ่ม <span className="font-semibold text-[#12294D]">{state.group.name}</span> คนที่ยังไม่อยู่ในกลุ่มจะเข้ากลุ่มก่อน</p>
      )}
      {!state?.group.botInGroup && (
        <div className="rounded-xl bg-[#FFF4DB] px-4 py-3 text-[14px] text-[#7A4B00]">
          น้องจดดียังไม่อยู่ในกลุ่ม เพิ่มก่อนที่แท็บ People หรือกดปุ่มนี้
          <Button size="sm" className="ml-2" onClick={() => run('join', () => demoApi.join())}>เพิ่มน้องจดดีเข้ากลุ่ม</Button>
        </div>
      )}
      {(scripts ?? []).map((s, i) => (
        <Card key={s.name} className="flex-row items-center gap-4 px-4 py-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#DCEBFF] text-[17px] font-semibold text-[#1F5FB0]">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-semibold">{SCRIPT_TITLE[s.name] ?? s.name}</p>
            <p className="text-[14px] text-[#5F6B7E]">{s.description}</p>
            <p className="font-mono text-[12px] text-[#8A94A6]">{s.name} · {s.messages} ข้อความ</p>
          </div>
          <Button size="lg" className="h-10 gap-2 px-4 text-[15px]" disabled={busy !== null}
            onClick={() => run(s.name, () => demoApi.loadScript(s.name, { group: state?.selectedGroup }), `เริ่มเล่น ${s.name} ใน ${state?.group.name ?? ''}`)}>
            <Play /> เล่น
          </Button>
        </Card>
      ))}
    </div>
  )
}

// ---------- People ----------

function PeopleTab() {
  const { state } = useDemo()
  const { busy, run } = useRun()
  const personas = state?.personas ?? []
  const owners = personas.filter((p) => p.owner)
  const setOwner = (p: Persona) => run(`owner:${p.key}`, async () => {
    for (const o of owners) if (o.key !== p.key) await demoApi.persona({ key: o.key, lineName: o.lineName, role: o.role, owner: false })
    await demoApi.persona({ key: p.key, lineName: p.lineName, role: p.role, owner: true })
  }, `${p.lineName} เป็น Owner แล้ว`)

  return (
    <div className="flex flex-col gap-3">
      <Section title="น้องจดดี (บอท)" description={state?.group.botInGroup ? 'อยู่ในกลุ่ม' : 'ยังไม่อยู่ในกลุ่ม'}
        action={state?.group.botInGroup
          ? <Button variant="outline" disabled={busy !== null} onClick={() => run('leave-bot', () => demoApi.leaveBot())}><LogOut /> เอาออกจากกลุ่ม</Button>
          : <Button disabled={busy !== null} onClick={() => run('join', () => demoApi.join())}><Bot /> เพิ่มเข้ากลุ่ม</Button>}>
        <span />
      </Section>

      <Section title={`สมาชิก · ${state?.group.name ?? ''}`} description="เปลี่ยนชื่อ ตั้ง Owner และเข้า/ออกกลุ่มที่เลือก">
        <div className="flex flex-col divide-y">
          {personas.map((p) => <PersonaRow key={p.key} p={p} busy={busy !== null} run={run} onOwner={() => setOwner(p)} />)}
        </div>
      </Section>

      <AddPersona disabled={busy !== null} onAdd={(lineName, role) => {
        const key = lineName.toLowerCase().replace(/[^a-z0-9]+/g, '') || `p${Date.now().toString(36)}`
        void run('add', () => demoApi.persona({ key, lineName, role }), `เพิ่ม ${lineName} แล้ว (ยังไม่เข้ากลุ่ม)`)
      }} />
    </div>
  )
}

function PersonaRow({ p, busy, run, onOwner }: {
  p: Persona; busy: boolean
  run: (key: string, fn: () => Promise<unknown>, done?: string) => Promise<void>
  onOwner: () => void
}) {
  const [name, setName] = useState(p.lineName)
  const [editing, setEditing] = useState(false)
  return (
    <div className="flex items-center gap-3 py-2.5">
      <PersonaAvatar personaKey={p.key} name={p.lineName} className="size-10 text-[15px]" />
      <div className="min-w-0 flex-1">
        {editing ? (
          <form className="flex gap-2" onSubmit={(e) => {
            e.preventDefault()
            setEditing(false)
            if (name.trim() && name.trim() !== p.lineName) void run(`rename:${p.key}`, () => demoApi.persona({ key: p.key, lineName: name.trim(), role: p.role, owner: p.owner }))
          }}>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="h-9 text-[15px]" />
            <Button type="submit" size="lg">บันทึก</Button>
          </form>
        ) : (
          <button type="button" className="text-left" onClick={() => { setName(p.lineName); setEditing(true) }} title="คลิกเพื่อเปลี่ยนชื่อ">
            <span className="text-[16px] font-semibold hover:underline">{p.lineName}</span>
          </button>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {p.role && <Badge variant="secondary">{p.role}</Badge>}
          {p.owner && <Badge className="gap-1 bg-[#FFF1D6] text-[#A15C00]"><Crown className="size-3" /> Owner</Badge>}
          <Badge variant="outline" className={p.inGroup ? 'border-[#B9E5C8] text-[#1B7A43]' : 'text-[#8A94A6]'}>
            {p.inGroup ? 'อยู่ในกลุ่ม' : 'ไม่อยู่ในกลุ่ม'}
          </Badge>
        </div>
      </div>
      {!p.owner && <Button variant="ghost" size="sm" disabled={busy} onClick={onOwner}><Crown /> ตั้ง Owner</Button>}
      {p.inGroup
        ? <Button variant="outline" size="sm" disabled={busy} onClick={() => run(`leave:${p.key}`, () => demoApi.memberLeave(p.key))}><LogOut /> ออก</Button>
        : <Button size="sm" disabled={busy} onClick={() => run(`join:${p.key}`, () => demoApi.memberJoin(p.key))}><LogIn /> เข้ากลุ่ม</Button>}
    </div>
  )
}

function AddPersona({ disabled, onAdd }: { disabled: boolean; onAdd: (name: string, role: string) => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('developer')
  return (
    <Section title="เพิ่มคน" description="เพิ่มแล้วกด ‘เข้ากลุ่ม’ เพื่อให้ LINE ส่ง memberJoined">
      <form className="flex gap-2" onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        onAdd(name.trim(), role)
        setName('')
      }}>
        <Input placeholder="ชื่อ LINE เช่น Beam" value={name} onChange={(e) => setName(e.target.value)} className="h-10 flex-1 text-[15px]" />
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="h-10! w-40 text-[15px]"><SelectValue /></SelectTrigger>
          <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="submit" size="lg" className="h-10 gap-2" disabled={disabled || !name.trim()}><UserPlus /> เพิ่ม</Button>
      </form>
    </Section>
  )
}

// ---------- Clock ----------

const CLOCK: { advance: ClockAdvance; label: string }[] = [
  { advance: '1h', label: '+1 ชั่วโมง' },
  { advance: '1d', label: '+1 วัน' },
  { advance: 'next0900', label: '09:00 ถัดไป' },
  { advance: 'nextMon0900', label: 'จันทร์ 09:00 ถัดไป' },
]

/** "ส่งสรุปรายสัปดาห์": POST weekly for the selected group's Project, then the phone opens
 *  the Owner's 1:1 chat with the per-person card (#120). */
function WeeklyButton({ onWeekly, compact = false }: { onWeekly: (r: WeeklyResult) => void; compact?: boolean }) {
  const { state, refresh } = useDemo()
  const [busy, setBusy] = useState(false)
  const click = async () => {
    setBusy(true)
    try {
      onWeekly(await demoApi.weekly(state?.selectedGroup))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      refresh()
    }
  }
  return compact ? (
    <Button size="lg" variant="outline" className="h-10 gap-2 px-3.5 text-[15px]" disabled={busy || !state}
      title="เลื่อนเวลาไปรอบสรุปรายสัปดาห์ของโปรเจกต์ที่เลือก แล้วเปิดแชตส่วนตัวของ Owner" onClick={() => void click()}>
      <CalendarClock /> สรุปรายสัปดาห์
    </Button>
  ) : (
    <Button size="lg" className="mt-2 h-12 w-full gap-2 text-[16px]" disabled={busy || !state} onClick={() => void click()}>
      <CalendarClock /> ส่งสรุปรายสัปดาห์
    </Button>
  )
}

function ClockTab({ onWeekly }: { onWeekly: (r: WeeklyResult) => void }) {
  const { state } = useDemo()
  const { busy, run } = useRun()
  if (!state) return null
  const c = clockLabel(state.now)
  return (
    <Section title="นาฬิกาเดโม" description="เลื่อนเวลาแล้วรัน tick: การเตือน การเช็กงานค้าง และโพสต์ประจำสัปดาห์จะเด้งเข้าแชต">
      <div className="mb-4 rounded-2xl bg-[#12294D] px-6 py-5 text-white">
        <p className="text-[56px] leading-none font-semibold tabular-nums">{c.time}<span className="text-[28px] text-white/60">:{c.seconds}</span></p>
        <p className="mt-2 text-[18px] text-white/80">{c.date} · Asia/Bangkok</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {CLOCK.map((b) => (
          <Button key={String(b.advance)} size="lg" variant="secondary" className="h-12 text-[16px]" disabled={busy !== null}
            onClick={() => run(String(b.advance), () => demoApi.clock(b.advance))}>
            {b.label}
          </Button>
        ))}
      </div>
      <Button variant="outline" className="mt-2 w-full" disabled={busy !== null} onClick={() => run('tick', () => demoApi.tick(), 'รัน tick แล้ว')}>
        รัน tick ตอนนี้ (ไม่เลื่อนเวลา)
      </Button>
      <WeeklyButton onWeekly={onWeekly} />
      <p className="mt-1.5 text-[13px] text-[#5F6B7E]">
        เลื่อนเวลาไปรอบสรุปรายสัปดาห์ของกลุ่มหลักในโปรเจกต์ที่เลือก แล้วรัน tick: กลุ่มได้การ์ดสรุป และ Owner ได้การ์ดรายคนในแชตส่วนตัว
      </p>
    </Section>
  )
}

// ---------- Quota ----------

function QuotaTab() {
  const { state } = useDemo()
  const { busy, run } = useRun()
  if (!state) return null
  const { limit, used } = state.quota
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <Section title="Push quota ของเดือนนี้" description="ข้อความ push ใช้โควตา ส่วน reply ฟรี เมื่อใกล้เต็มบอทจะหยุด push">
      <p className="mb-2 text-[40px] leading-none font-semibold tabular-nums">
        {used}<span className="text-[22px] text-[#5F6B7E]"> / {limit ?? '∞'}</span>
      </p>
      <div className="mb-4 h-4 overflow-hidden rounded-full bg-[#EEF2F7]">
        <div className={cn('h-full rounded-full transition-all', pct >= 95 ? 'bg-[#C2410C]' : pct >= 75 ? 'bg-[#D97706]' : 'bg-(--line-green)')}
          style={{ width: `${limit ? pct : 0}%` }} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="lg" disabled={busy !== null}
          onClick={() => run('near', () => demoApi.quota(limit === null ? { limit: 500, used: 498 } : { used: Math.max(0, limit - 2) }), 'ตั้งให้ใกล้เต็มแล้ว')}>
          ตั้งให้ใกล้เต็ม (เหลือ 2)
        </Button>
        <Button size="lg" variant="outline" disabled={busy !== null} onClick={() => run('zero', () => demoApi.quota({ used: 0 }))}>ล้างที่ใช้ไป</Button>
        <Button size="lg" variant="outline" disabled={busy !== null} onClick={() => run('500', () => demoApi.quota({ limit: 500 }))}>limit 500</Button>
        <Button size="lg" variant="ghost" disabled={busy !== null} onClick={() => run('none', () => demoApi.quota({ limit: null }))}>ไม่จำกัด</Button>
      </div>
    </Section>
  )
}

// ---------- AI ----------

function AiTab() {
  const { state } = useDemo()
  if (!state) return null
  return (
    <Section title="AI (OpenRouter)" description="ถ้าเรียก AI ไม่สำเร็จ เดโมจะใช้คำตอบสำรอง (fallback) ที่มีรูปแบบเดียวกัน">
      <div className="flex flex-col gap-3 text-[16px]">
        <Row label="Model"><span className="font-mono text-[15px]">{state.ai.model ?? '—'}</span></Row>
        <Row label="ครั้งล่าสุด">
          {state.ai.lastCallFallback
            ? <Badge className="bg-[#FFF1D6] text-[14px] text-[#A15C00]">ใช้ fallback</Badge>
            : <Badge className="bg-[#E3F6E8] text-[14px] text-[#1B7A43]">AI จริง</Badge>}
        </Row>
        <Row label="สถานะ">{state.ai.busy ? <Badge variant="secondary" className="text-[14px]">กำลังคิด…</Badge> : <span className="text-[#5F6B7E]">ว่าง</span>}</Row>
        <Row label="ค่าใช้จ่ายรวมตั้งแต่รีเซ็ต"><span className="text-[20px] font-semibold tabular-nums">{usd(state.ai.totalUsd)}</span></Row>
      </div>
      <Separator className="my-3" />
      <p className="mb-2 text-[14px] text-[#5F6B7E]">การเรียก AI ({state.ai.calls.length} ครั้งล่าสุด)</p>
      {state.ai.calls.length === 0 && <p className="text-[14px] text-[#8A94A6]">ยังไม่มีการเรียก AI</p>}
      <div className="flex flex-col divide-y">
        {[...state.ai.calls].reverse().map((c) => (
          <div key={c.id} className="flex items-center gap-3 py-2 text-[14px]">
            <span className="w-12 shrink-0 text-[#8A94A6] tabular-nums">{timeLabel(c.at)}</span>
            <Badge variant="secondary" className="shrink-0">{AI_KIND[c.kind]}</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#5F6B7E]">
              {c.model} · {c.inputTokens.toLocaleString()} / {c.outputTokens.toLocaleString()} tokens
            </span>
            <span className={cn('shrink-0 font-semibold tabular-nums', c.fallback && 'text-[#A15C00]')}>
              {c.fallback ? 'fallback $0' : usd(c.costUsd, c.estimated)}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[#5F6B7E]">{label}</span>
      {children}
    </div>
  )
}

// ---------- Google ----------

function GoogleTab({ onConnect }: { onConnect: () => void }) {
  const { state } = useDemo()
  if (!state) return null
  return (
    <Section title="Google Drive" description="ไฟล์และรูปในกลุ่มจะถูกบันทึกลง Drive ของบัญชีเดโม">
      <div className="flex items-center justify-between gap-4">
        <div>
          {state.google.connected
            ? <Badge className="bg-[#E3F6E8] text-[14px] text-[#1B7A43]">เชื่อมแล้ว</Badge>
            : <Badge variant="outline" className="text-[14px]">ยังไม่เชื่อม</Badge>}
          <p className="mt-1.5 text-[16px]">{state.google.email ?? '—'}</p>
        </div>
        <Button size="lg" className="h-10 gap-2" onClick={onConnect}><Cloud /> {state.google.connected ? 'จัดการการเชื่อม' : 'เชื่อม Google'}</Button>
      </div>
      <p className="mt-3 text-[13px] text-[#5F6B7E]">เปิดหน้าเชื่อม Google ในมือถือ (ในชื่อคนที่เลือกอยู่) เฉพาะ Owner เท่านั้นที่เชื่อมได้</p>
    </Section>
  )
}

// ---------- Log ----------

const KIND: Record<string, string> = {
  event: 'bg-[#DCEBFF] text-[#1F5FB0]',
  reply: 'bg-[#E3F6E8] text-[#1B7A43]',
  push: 'bg-[#EDE4FF] text-[#6236C5]',
  error: 'bg-[#FDE8DD] text-[#C2410C]',
  tick: 'bg-[#FFF1D6] text-[#A15C00]',
}

function LogTab() {
  const { state } = useDemo()
  const log = [...(state?.log ?? [])].reverse()
  return (
    <Card className="h-full min-h-[320px] gap-0 py-0">
      <ScrollArea className="h-[calc(100dvh-330px)] min-h-[300px]">
        <div className="p-3 font-mono text-[13px] leading-relaxed">
          {log.length === 0 && <p className="p-3 text-[#8A94A6]">ยังไม่มี log</p>}
          {log.map((l, i) => (
            <div key={`${l.at}-${i}`}>
              <div className="flex items-start gap-2 py-1">
                <span className="shrink-0 text-[#8A94A6] tabular-nums">{timeLabel(l.at)}</span>
                <span className={cn('shrink-0 rounded px-1.5 text-[11px] leading-5 font-semibold uppercase', KIND[l.kind])}>{l.kind}</span>
                <span className="min-w-0 break-words text-[#12294D]">{l.summary}</span>
              </div>
              {i < log.length - 1 && <Separator />}
            </div>
          ))}
        </div>
      </ScrollArea>
    </Card>
  )
}
