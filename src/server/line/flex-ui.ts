import type { LineDatePickerAction, LineMessage, LinePostbackAction, LineUriAction } from './types'

// Shared building blocks of the LINE Flex cards, after the Figma "UI v4" design system
// (file Yi9FCN94TrLPOmfw6f2kuT): the colour variables, the Card Header with its tone icon,
// the Status Badge, the Key Value box and the four button types. Flex has no custom fonts,
// so only colours, sizes and layout follow the design.

export const COLOR = {
  ink: '#12294D', // text/primary
  ink2: '#545454', // text/secondary
  ink3: '#5F6B7E', // text/tertiary (darker than Figma's #7A879C: 5.6:1 on white, UX review 6.2)
  primary: '#1F5FB0', // action/primary-bg
  primarySoft: '#DCE9F8', // action/secondary-bg
  line: '#D5E2F3', // border/default
  lineStrong: '#9DB8DC', // border/strong
  subtle: '#F4F6F9', // bg/subtle
  white: '#FFFFFF',
  danger: '#C2410C', // status/danger-text
  dangerSoft: '#FDE8DD', // status/danger-bg
} as const

export type BadgeStatus = 'not_assigned' | 'in_process' | 'done'

/** The agreed status labels: ยังไม่มีผู้รับ · กำลังทำ · เสร็จ. */
export const STATUS = {
  not_assigned: { label: 'ยังไม่มีผู้รับ', bg: '#FEF3C7', fg: '#92400E', dot: '#D97706' },
  in_process: { label: 'กำลังทำ', bg: '#DCE9F8', fg: '#1F5FB0', dot: '#3A84D6' },
  done: { label: 'เสร็จ', bg: '#DDF3E8', fg: '#1B6B47', dot: '#2E9E6B' },
} as const satisfies Record<BadgeStatus, { label: string; bg: string; fg: string; dot: string }>

export type Tone = 'success' | 'warning' | 'info' | 'danger' | 'reminder'

const TONE: Record<Tone, { glyph: string; bg: string; fg: string }> = {
  success: { glyph: '✓', bg: STATUS.done.bg, fg: STATUS.done.dot },
  warning: { glyph: '!', bg: STATUS.not_assigned.bg, fg: STATUS.not_assigned.dot },
  info: { glyph: '✦', bg: COLOR.primarySoft, fg: COLOR.primary },
  danger: { glyph: '✕', bg: COLOR.dangerSoft, fg: COLOR.danger },
  reminder: { glyph: '⏰', bg: STATUS.not_assigned.bg, fg: STATUS.not_assigned.dot },
}

type Json = Record<string, unknown>
export type FlexAction = LineUriAction | LinePostbackAction | LineDatePickerAction

export function text(t: string, extra: Json = {}): Json {
  return { type: 'text', text: t, wrap: true, color: COLOR.ink, size: 'sm', ...extra }
}

export function caption(t: string, extra: Json = {}): Json {
  return text(t, { size: 'xs', color: COLOR.ink3, ...extra })
}

export function title(t: string, extra: Json = {}): Json {
  return text(t, { weight: 'bold', size: 'lg', ...extra })
}

/** Card Header: a tone icon in a soft circle and a bold title. */
export function header(tone: Tone, t: string): Json {
  const s = TONE[tone]
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
    contents: [
      {
        type: 'box', layout: 'vertical', flex: 0, width: '22px', height: '22px', cornerRadius: '11px',
        backgroundColor: s.bg, justifyContent: 'center', alignItems: 'center',
        contents: [{ type: 'text', text: s.glyph, size: 'xxs', weight: 'bold', color: s.fg, align: 'center' }],
      },
      text(t, { weight: 'bold', size: 'md', flex: 1 }),
    ],
  }
}

/** Status Badge: a pill with a coloured dot. */
export function badge(status: BadgeStatus): Json {
  const s = STATUS[status]
  return {
    type: 'box', layout: 'horizontal', flex: 0, backgroundColor: s.bg, cornerRadius: 'xxl',
    paddingStart: 'md', paddingEnd: 'md', paddingTop: 'xs', paddingBottom: 'xs', spacing: 'xs', alignItems: 'center',
    contents: [
      { type: 'text', text: '●', flex: 0, size: 'xxs', color: s.dot },
      { type: 'text', text: s.label, flex: 0, size: 'xs', color: s.fg, weight: 'bold' },
    ],
  }
}

/** "from → to" status change, e.g. กำลังทำ › เสร็จ. */
export function statusChange(from: BadgeStatus, to: BadgeStatus): Json {
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
    contents: [badge(from), text('›', { flex: 0, color: COLOR.ink3, size: 'md' }), badge(to), filler()],
  }
}

export function filler(): Json {
  return { type: 'filler' }
}

export function row(...contents: Json[]): Json {
  return { type: 'box', layout: 'horizontal', spacing: 'sm', contents }
}

export function column(contents: Json[], extra: Json = {}): Json {
  return { type: 'box', layout: 'vertical', spacing: 'sm', contents, ...extra }
}

/** Grey rounded box (Figma "bg/subtle" panels). */
export function panel(contents: Json[], extra: Json = {}): Json {
  return {
    type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: COLOR.subtle, cornerRadius: 'md',
    paddingAll: 'md', contents, ...extra,
  }
}

/** Key Value row: grey key on the left, bold value on the right. */
export function keyValue(key: string, value: string, valueColor: string = COLOR.ink): Json {
  return {
    type: 'box', layout: 'horizontal', spacing: 'md',
    contents: [
      text(key, { size: 'sm', color: COLOR.ink3, flex: 2 }),
      text(value, { size: 'sm', weight: 'bold', color: valueColor, align: 'end', flex: 3 }),
    ],
  }
}

/** A number in a soft circle next to a label (the setup card's steps). */
export function numbered(n: number, label: string): Json {
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
    contents: [
      {
        type: 'box', layout: 'vertical', flex: 0, width: '20px', height: '20px', cornerRadius: '10px',
        backgroundColor: COLOR.primarySoft, justifyContent: 'center', alignItems: 'center',
        contents: [{ type: 'text', text: String(n), size: 'xxs', weight: 'bold', color: COLOR.primary, align: 'center' }],
      },
      text(label, { flex: 1 }),
    ],
  }
}

/** One line with a small glyph in front (Figma Icon Row). */
export function iconRow(glyph: string, t: string, color: string = COLOR.ink2): Json {
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: [text(glyph, { flex: 0, color, size: 'sm' }), text(t, { color, flex: 1 })],
  }
}

/** A command people can type (bold, primary colour) with what it does under it (UX review 1.1). */
export function commandRow(command: string, what: string): Json {
  return {
    type: 'box', layout: 'vertical', spacing: 'none',
    contents: [text(command, { weight: 'bold', color: COLOR.primary }), caption(what)],
  }
}

export function bullet(t: string, color: string = COLOR.ink2): Json {
  return iconRow('•', t, color)
}

/** Progress track with a filled part; `ratio` is 0..1. */
export function progressBar(ratio: number, fill: string): Json {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)))
  return {
    type: 'box', layout: 'vertical', height: '8px', backgroundColor: COLOR.subtle, cornerRadius: '4px',
    contents: [
      pct > 0
        ? { type: 'box', layout: 'vertical', width: `${pct}%`, height: '8px', backgroundColor: fill, cornerRadius: '4px', contents: [] }
        : filler(),
    ],
  }
}

export type ButtonType = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'

const BUTTON: Record<ButtonType, { bg?: string; fg: string; border?: string }> = {
  primary: { bg: COLOR.primary, fg: COLOR.white },
  secondary: { bg: COLOR.primarySoft, fg: COLOR.primary },
  outline: { bg: COLOR.white, fg: COLOR.ink, border: COLOR.lineStrong },
  ghost: { fg: COLOR.primary },
  danger: { bg: COLOR.danger, fg: COLOR.white },
}

/** A button drawn as a box, so secondary and outline buttons get the design's text colour
 *  (a Flex "secondary" button always has dark text). */
export function button(type: ButtonType, action: FlexAction, extra: Json = {}): Json {
  const s = BUTTON[type]
  return {
    type: 'box', layout: 'vertical', cornerRadius: 'md', paddingTop: '10px', paddingBottom: '10px',
    paddingStart: 'md', paddingEnd: 'md', justifyContent: 'center', action,
    ...(s.bg ? { backgroundColor: s.bg } : {}),
    ...(s.border ? { borderWidth: '1px', borderColor: s.border } : {}),
    contents: [{ type: 'text', text: action.label, size: 'sm', weight: 'bold', color: s.fg, align: 'center', wrap: true }],
    ...extra,
  }
}

/** Two or more buttons side by side, each taking an equal share. */
export function buttonRow(...buttons: Json[]): Json {
  return { type: 'box', layout: 'horizontal', spacing: 'sm', contents: buttons.map((b) => ({ ...b, flex: 1 })) }
}

export function postback(label: string, data: string, displayText: string = label): LinePostbackAction {
  return { type: 'postback', label, data, displayText }
}

export function uri(label: string, link: string): LineUriAction {
  return { type: 'uri', label, uri: link }
}

/** A kilo bubble with the design's padding. `footer` sits under a body without a line. */
export function bubble(body: Json[], footer?: Json[], extra: Json = {}): Json {
  return {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: body },
    ...(footer && footer.length > 0
      ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', paddingTop: 'none', contents: footer } }
      : {}),
    ...extra,
  }
}

/** UX review 2.1 / 2.3: something cannot happen yet. One line on why, an optional small note,
 *  and the one button that fixes it, so no notice leaves people without a next step. */
export function nextStepCard(p: {
  tone: Tone; title: string; body: string; note?: string; button?: FlexAction; altText?: string
}): LineMessage {
  const body = [header(p.tone, p.title), text(p.body, { color: COLOR.ink2 }), ...(p.note ? [caption(p.note)] : [])]
  return {
    type: 'flex',
    altText: p.altText ?? `${p.title}: ${p.body}`,
    contents: bubble(body, p.button ? [button('primary', p.button)] : undefined),
  }
}

export function separator(): Json {
  return { type: 'separator', color: COLOR.line }
}
