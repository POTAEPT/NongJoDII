import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DemoContext } from '@/app/demo/_components/demo-context'
import { DirectBottom } from '@/app/demo/_components/direct-chat'
import { FlexMessage } from '@/app/demo/_components/flex-renderer'
import { PhoneFrame } from '@/app/demo/_components/phone-frame'

// Layout guards for the /demo phone. They render to static HTML (no DOM), so they check the
// structure that decides the layout, not pixels.

type Ctx = NonNullable<Parameters<typeof DemoContext.Provider>[0]['value']>
const ctx = {
  runAction: () => undefined,
  state: null,
  me: { key: 'nont', lineUserId: 'Udemo0000000000000000000000000a01', lineName: 'Nont' },
} as unknown as Ctx

function render(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(DemoContext.Provider, { value: ctx }, node))
}

const text = (t: string) => ({ type: 'text', text: t, wrap: true })
const bubble = (lines: number) => ({
  type: 'bubble',
  body: { type: 'box', layout: 'vertical', contents: Array.from({ length: lines }, (_, i) => text(`line ${i}`)) },
})

describe('/demo Flex carousel', () => {
  // Regression (16-17 Nov): bubbles in a carousel used width min(300px, 100%), so a short
  // message column squeezed the second bubble to a sliver or cut it off.
  it('gives every carousel bubble its own fixed width that the row cannot shrink', () => {
    const html = render(createElement(FlexMessage, {
      contents: { type: 'carousel', contents: [bubble(1), bubble(8), { ...bubble(2), size: 'kilo' }] },
    }))
    expect(html).toContain('data-flex-carousel')
    expect(html).toMatch(/data-flex-carousel[^>]*overflow-x-auto/)
    const styles = [...html.matchAll(/data-flex-bubble[^>]*style="([^"]*)"/g)].map((m) => m[1])
    expect(styles).toHaveLength(3)
    for (const s of styles) {
      expect(s).toMatch(/flex:0 0 auto/)
      expect(s).not.toMatch(/%/)
    }
    expect(styles[0]).toMatch(/min-width:300px/)
    expect(styles[2]).toMatch(/min-width:260px/)
  })

  it('keeps a single bubble within the message column', () => {
    const html = render(createElement(FlexMessage, { contents: bubble(2) }))
    expect(html).not.toContain('data-flex-carousel')
    expect(html).toMatch(/data-flex-bubble[^>]*style="[^"]*max-width:100%/)
  })
})

describe('/demo 1:1 Rich Menu', () => {
  it('puts the menu image above the เมนู bar, as in LINE', () => {
    const html = render(createElement(DirectBottom, { onSent: () => undefined }))
    const image = html.indexOf('data-rich-menu=')
    const bar = html.indexOf('data-rich-menu-bar')
    expect(image).toBeGreaterThan(-1)
    expect(bar).toBeGreaterThan(image)
  })
})

describe('/demo phone frame', () => {
  // Regression (17 Nov): with aspect-ratio alone, a wide carousel stretched the whole phone.
  it('has an explicit width, so wide content cannot stretch it', () => {
    const html = renderToStaticMarkup(createElement(PhoneFrame, null, createElement('div')))
    expect(html).toMatch(/style="[^"]*width:calc\(min\(852px/)
    expect(html).not.toMatch(/aspect-ratio/)
  })
})
