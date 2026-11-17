import { noteDemoOrigin } from '@/server/demo/demo-deps'
import { demoEnabled, demoNotFound } from '@/server/demo/gate'
import { demoGoogleCallback, demoLiffPost } from '@/server/demo/liff-api'

// /demo/api/<path>: the LIFF API of /api/<path>, with the demo composition. The explicit
// sim routes (/demo/api/sim/...) have static segments and win over this catch-all.

type Ctx = { params: Promise<{ path: string[] }> }

const notDemoPath = (path: string) => Response.json({ error: `no demo api path ${path}` }, { status: 404 })

export async function GET(request: Request, ctx: Ctx) {
  const path = (await ctx.params).path.join('/')
  if (!demoEnabled()) return demoNotFound()
  noteDemoOrigin(request)
  if (path === 'google/callback') return demoGoogleCallback(request)
  return notDemoPath(path)
}

export async function POST(request: Request, ctx: Ctx) {
  const path = (await ctx.params).path.join('/')
  if (!demoEnabled()) return demoNotFound()
  noteDemoOrigin(request)
  return (await demoLiffPost(path, request)) ?? notDemoPath(path)
}
