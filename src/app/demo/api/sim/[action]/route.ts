import { demoEnabled, demoNotFound } from '@/server/demo/gate'
import { runSimAction } from '@/server/demo/sim'

// The /demo simulator's sim API (docs/demo-contract.md). A static `sim` segment, so it wins
// over the catch-all /demo/api/[...path].

type Ctx = { params: Promise<{ action: string }> }

export async function GET(_request: Request, ctx: Ctx) {
  // Awaiting params first makes the handler run at request time (cacheComponents).
  const { action } = await ctx.params
  if (!demoEnabled()) return demoNotFound()
  const result = await runSimAction(action, 'GET', null)
  return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request, ctx: Ctx) {
  const { action } = await ctx.params
  if (!demoEnabled()) return demoNotFound()
  let body: unknown = {}
  const raw = await request.text()
  if (raw.trim() !== '') {
    try {
      body = JSON.parse(raw)
    } catch {
      return Response.json({ error: 'body is not JSON' }, { status: 400 })
    }
  }
  const result = await runSimAction(action, 'POST', body)
  return Response.json(result.body, { status: result.status })
}
