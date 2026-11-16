'use client'

import { useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { bangkokDate, dateFromYmd, ymdFromDate } from '../_lib/time'
import { useDemo, type FlexActionLike } from './demo-context'

// Renders the LINE Flex subset the bot sends (src/server/line/flex-ui.ts and the card
// builders): bubble and carousel; box (vertical, horizontal, baseline) with spacing,
// padding, colours, radius, border, width/height and an action; text, button, separator,
// spacer, filler, image and icon. Sizes follow the LINE Flex spec.

type Json = Record<string, unknown>

const SIZE_PX: Record<string, number> = {
  none: 0, xs: 2, sm: 4, md: 8, lg: 12, xl: 16, xxl: 20,
}
const TEXT_PX: Record<string, number> = {
  xxs: 11, xs: 13, sm: 14, md: 16, lg: 19, xl: 22, xxl: 29, '3xl': 35, '4xl': 48, '5xl': 74,
}
const BORDER_PX: Record<string, number> = { none: 0, light: 0.5, normal: 1, medium: 2, 'semi-bold': 3, bold: 4 }
const BUBBLE_W: Record<string, number> = { nano: 120, micro: 160, deca: 220, hecto: 241, kilo: 260, mega: 300, giga: 386 }
const IMG_PX: Record<string, string> = {
  xxs: '40px', xs: '60px', sm: '80px', md: '100px', lg: '120px', xl: '140px', xxl: '160px',
  '3xl': '180px', '4xl': '200px', '5xl': '240px', full: '100%',
}
const ICON_PX: Record<string, number> = { xxs: 11, xs: 13, sm: 14, md: 16, lg: 19, xl: 22, xxl: 29, '3xl': 35 }

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** A spacing value: a keyword, '12px' or '10%'. */
function len(v: unknown, table: Record<string, number> = SIZE_PX): string | undefined {
  if (typeof v !== 'string') return undefined
  if (v in table) return `${table[v]}px`
  return v
}

function textPx(v: unknown, fallback = 16): number {
  if (typeof v === 'string') {
    if (v in TEXT_PX) return TEXT_PX[v]
    const n = parseFloat(v)
    if (!Number.isNaN(n)) return n
  }
  return fallback
}

const ALIGN: Record<string, CSSProperties['textAlign']> = { start: 'left', center: 'center', end: 'right' }
const GRAVITY: Record<string, CSSProperties['alignSelf']> = { top: 'flex-start', center: 'center', bottom: 'flex-end' }

type Parent = 'vertical' | 'horizontal' | 'baseline'

/** LINE's flex: in a horizontal box children share the width (default 1); in a vertical
 *  box they take their natural height (default 0). */
function flexStyle(node: Json, parent: Parent): CSSProperties {
  const f = num(node.flex)
  const grow = f ?? (parent === 'vertical' ? 0 : 1)
  const s: CSSProperties = grow > 0 ? { flex: `${grow} 1 0%`, minWidth: 0 } : { flex: '0 0 auto' }
  if (parent === 'vertical' && grow > 0) s.minHeight = 0
  return s
}

function marginStyle(node: Json, parent: Parent, first: boolean): CSSProperties {
  const m = len(node.margin)
  if (!m || first) return {}
  return parent === 'vertical' ? { marginTop: m } : { marginLeft: m }
}

function positionStyle(node: Json): CSSProperties {
  const s: CSSProperties = {}
  if (node.position === 'absolute') s.position = 'absolute'
  else if (node.offsetTop || node.offsetStart || node.offsetBottom || node.offsetEnd) s.position = 'relative'
  if (node.offsetTop) s.top = len(node.offsetTop)
  if (node.offsetBottom) s.bottom = len(node.offsetBottom)
  if (node.offsetStart) s.left = len(node.offsetStart)
  if (node.offsetEnd) s.right = len(node.offsetEnd)
  return s
}

export function FlexMessage({ contents }: { contents: Json }) {
  if (contents.type === 'carousel' && Array.isArray(contents.contents)) {
    return (
      // LINE: a carousel runs past the message column and scrolls sideways; every bubble keeps
      // its own fixed width (never squeezed by the row) and the row's bubbles share one height.
      <div data-flex-carousel className="demo-scroll flex w-full items-stretch gap-2 overflow-x-auto pb-1">
        {(contents.contents as Json[]).map((b, i) => <FlexBubble key={i} bubble={b} inCarousel />)}
      </div>
    )
  }
  return <FlexBubble bubble={contents} />
}

export function FlexBubble({ bubble, inCarousel = false }: { bubble: Json; inCarousel?: boolean }) {
  const width = BUBBLE_W[str(bubble.size) ?? 'mega'] ?? 300
  const styles = (bubble.styles ?? {}) as Record<string, Json | undefined>
  const section = (name: 'header' | 'hero' | 'body' | 'footer') => {
    const node = bubble[name] as Json | undefined
    if (!node) return null
    const st = styles[name] ?? {}
    return (
      <div key={name} style={{ backgroundColor: str(st.backgroundColor) }}
        className={cn(st.separator === true && 'border-t')}>
        <FlexNode node={node} parent="vertical" first />
      </div>
    )
  }
  return (
    <Card data-flex-bubble
      className="shrink-0 gap-0 overflow-hidden rounded-[18px] border-0 bg-white p-0 py-0 text-[#12294D] shadow-none ring-0"
      style={inCarousel
        ? { width: `${width}px`, minWidth: `${width}px`, flex: '0 0 auto' }
        : { width: `min(${width}px, 100%)`, maxWidth: '100%' }}>
      {section('header')}
      {section('hero')}
      {section('body')}
      {section('footer')}
    </Card>
  )
}

function FlexNode({ node, parent, first }: { node: Json; parent: Parent; first: boolean }): ReactNode {
  const base: CSSProperties = { ...flexStyle(node, parent), ...marginStyle(node, parent, first), ...positionStyle(node) }
  switch (node.type) {
    case 'box': return <FlexBox node={node} style={base} />
    case 'text': return <FlexText node={node} style={base} />
    case 'button': return <FlexButton node={node} style={base} />
    case 'separator':
      return <div style={{ ...marginStyle(node, parent, first), flex: '0 0 auto', alignSelf: 'stretch',
        ...(parent === 'vertical' ? { borderTop: `1px solid ${str(node.color) ?? '#D5E2F3'}` } : { borderLeft: `1px solid ${str(node.color) ?? '#D5E2F3'}` }) }} />
    case 'spacer':
      return <div style={{ flex: '0 0 auto', height: len(node.size) ?? '8px', width: len(node.size) ?? '8px' }} />
    case 'filler': return <div style={{ flex: `${num(node.flex) ?? 1} 1 0%` }} />
    case 'image': return <FlexImage node={node} style={base} />
    case 'icon': {
      const px = ICON_PX[str(node.size) ?? 'md'] ?? 16
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={str(node.url)} alt="" style={{ ...base, flex: '0 0 auto', width: px, height: px }} />
    }
    case 'span': return <span>{str(node.text)}</span>
    default: return null
  }
}

function FlexBox({ node, style }: { node: Json; style: CSSProperties }) {
  const { runAction } = useDemo()
  const layout = (str(node.layout) ?? 'vertical') as Parent
  const kids = Array.isArray(node.contents) ? (node.contents as Json[]) : []
  const gap = len(node.spacing)
  const action = node.action as FlexActionLike | undefined
  const s: CSSProperties = {
    ...style,
    display: 'flex',
    flexDirection: layout === 'vertical' ? 'column' : 'row',
    alignItems: layout === 'baseline' ? 'baseline' : str(node.alignItems) ?? (layout === 'vertical' ? 'stretch' : 'stretch'),
    justifyContent: str(node.justifyContent),
    gap,
    backgroundColor: str(node.backgroundColor),
    borderRadius: len(node.cornerRadius),
    borderWidth: len(node.borderWidth, BORDER_PX),
    borderStyle: node.borderWidth ? 'solid' : undefined,
    borderColor: str(node.borderColor),
    // Longhands only: a `padding` shorthand next to undefined longhands gets dropped.
    paddingTop: len(node.paddingTop) ?? len(node.paddingAll),
    paddingBottom: len(node.paddingBottom) ?? len(node.paddingAll),
    paddingLeft: len(node.paddingStart) ?? len(node.paddingAll),
    paddingRight: len(node.paddingEnd) ?? len(node.paddingAll),
  }
  if (node.width) { s.width = str(node.width); s.flex = '0 0 auto' }
  if (node.height) s.height = str(node.height)
  if (node.maxWidth) s.maxWidth = str(node.maxWidth)
  if (node.position !== 'absolute' && kids.some((k) => k.position === 'absolute')) s.position = s.position ?? 'relative'
  const children = kids.map((k, i) => <FlexNode key={i} node={k} parent={layout} first={i === 0} />)

  if (action?.type === 'datetimepicker') {
    return <DatePickerAction action={action} render={(open) => (
      <div role="button" tabIndex={0} style={s} onClick={open}
        className="cursor-pointer transition-[filter,transform] select-none hover:brightness-95 active:scale-[0.98]">{children}</div>
    )} />
  }
  if (action) {
    return (
      <div role="button" tabIndex={0} style={s} onClick={() => runAction(action)}
        onKeyDown={(e) => { if (e.key === 'Enter') runAction(action) }}
        className="cursor-pointer transition-[filter,transform] select-none hover:brightness-95 active:scale-[0.98]">
        {children}
      </div>
    )
  }
  return <div style={s}>{children}</div>
}

function FlexText({ node, style }: { node: Json; style: CSSProperties }) {
  const size = textPx(node.size)
  const wrap = node.wrap === true
  const maxLines = num(node.maxLines)
  const s: CSSProperties = {
    ...style,
    fontSize: size,
    lineHeight: str(node.lineSpacing) ? `calc(1.35em + ${node.lineSpacing})` : 1.4,
    fontWeight: node.weight === 'bold' ? 700 : 400,
    fontStyle: node.style === 'italic' ? 'italic' : undefined,
    textDecoration: node.decoration === 'underline' ? 'underline' : node.decoration === 'line-through' ? 'line-through' : undefined,
    color: str(node.color) ?? '#111111',
    textAlign: ALIGN[str(node.align) ?? 'start'],
    alignSelf: GRAVITY[str(node.gravity) ?? ''] ?? style.alignSelf,
    whiteSpace: wrap ? 'pre-wrap' : 'nowrap',
    overflow: 'hidden',
    textOverflow: wrap ? undefined : 'ellipsis',
    overflowWrap: 'anywhere',
  }
  if (wrap && maxLines) {
    Object.assign(s, { display: '-webkit-box', WebkitLineClamp: maxLines, WebkitBoxOrient: 'vertical' })
  }
  const spans = Array.isArray(node.contents) && node.contents.length > 0 ? (node.contents as Json[]) : null
  return (
    <p style={s}>
      {spans
        ? spans.map((sp, i) => (
          <span key={i} style={{ color: str(sp.color), fontWeight: sp.weight === 'bold' ? 700 : undefined,
            fontSize: sp.size ? textPx(sp.size) : undefined }}>{str(sp.text)}</span>
        ))
        : str(node.text)}
    </p>
  )
}

function FlexButton({ node, style }: { node: Json; style: CSSProperties }) {
  const { runAction } = useDemo()
  const action = node.action as FlexActionLike | undefined
  const kind = str(node.style) ?? 'link'
  const color = str(node.color)
  const h = node.height === 'sm' ? 40 : 52
  const look: CSSProperties = kind === 'primary'
    ? { backgroundColor: color ?? '#17C950', color: '#fff' }
    : kind === 'secondary'
      ? { backgroundColor: color ?? '#DCDFE5', color: '#111' }
      : { backgroundColor: 'transparent', color: color ?? '#42659A' }
  const btn = (onClick: () => void) => (
    <Button type="button" variant="ghost" onClick={onClick}
      style={{ ...style, ...look, height: h }}
      className="w-full rounded-lg px-3 text-[15px] font-bold whitespace-normal hover:opacity-90 hover:brightness-95">
      {action?.label ?? ''}
    </Button>
  )
  if (!action) return btn(() => {})
  if (action.type === 'datetimepicker') return <DatePickerAction action={action} render={(open) => btn(open)} />
  return btn(() => runAction(action))
}

function FlexImage({ node, style }: { node: Json; style: CSSProperties }) {
  const size = str(node.size) ?? 'md'
  const ratio = str(node.aspectRatio) ?? '1:1'
  const [w, h] = ratio.split(':').map(Number)
  const width = IMG_PX[size] ?? size
  return (
    <div style={{ ...style, display: 'flex', justifyContent: node.align === 'start' ? 'flex-start' : node.align === 'end' ? 'flex-end' : 'center' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={str(node.url)} alt="" style={{
        width, maxWidth: '100%', aspectRatio: w && h ? `${w} / ${h}` : undefined,
        objectFit: node.aspectMode === 'cover' ? 'cover' : 'contain', backgroundColor: str(node.backgroundColor),
      }} />
    </div>
  )
}

/** LINE's date picker for a datetimepicker action (mode 'date'): a calendar in a popover,
 *  then a postback with params.date as 'YYYY-MM-DD'. */
export function DatePickerAction({ action, render }: { action: FlexActionLike; render: (open: () => void) => ReactNode }) {
  const { runAction, state } = useDemo()
  const [open, setOpen] = useState(false)
  const today = state ? bangkokDate(state.now) : undefined
  const initial = dateFromYmd(action.initial ?? today ?? '')
  const min = dateFromYmd(action.min ?? '')
  const max = dateFromYmd(action.max ?? '')
  const disabled = [...(min ? [{ before: min }] : []), ...(max ? [{ after: max }] : [])]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The trigger toggles the popover; the rendered element is the anchor. */}
      <PopoverTrigger asChild>{render(() => {})}</PopoverTrigger>
      <PopoverContent className="w-auto p-0" side="top" align="center">
        <div className="border-b px-3 py-2 text-sm font-semibold">{action.label ?? 'เลือกวันที่'}</div>
        <Calendar mode="single" defaultMonth={initial} selected={initial} disabled={disabled}
          onSelect={(d) => {
            if (!d) return
            setOpen(false)
            runAction(action, { date: ymdFromDate(d) })
          }} />
      </PopoverContent>
    </Popover>
  )
}

/** A template "buttons" message: text and uri buttons, LINE style. */
export function TemplateButtons({ template }: { template: { text?: string; title?: string; actions?: FlexActionLike[] } }) {
  const { runAction } = useDemo()
  return (
    <Card className="w-[260px] max-w-full gap-0 overflow-hidden rounded-[18px] border-0 bg-white p-0 py-0 shadow-none ring-0">
      <div className="px-4 py-3">
        {template.title && <p className="mb-1 text-[15px] font-bold text-[#111]">{template.title}</p>}
        <p className="text-[14px] leading-snug whitespace-pre-wrap text-[#333]">{template.text}</p>
      </div>
      {(template.actions ?? []).map((a, i) => (
        <button key={i} type="button" onClick={() => runAction(a)}
          className="border-t border-[#E5E8EE] px-4 py-3 text-center text-[15px] font-semibold text-[#42659A] hover:bg-[#F4F6F9]">
          {a.label}
        </button>
      ))}
    </Card>
  )
}
