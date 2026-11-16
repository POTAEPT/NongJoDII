import { loadDashboard } from '@/server/dashboard/load'
import { finishGoogleSignIn, renderCallbackPage } from '@/server/google/callback'
import { disconnectGoogle } from '@/server/google/disconnect'
import { startGoogleSignIn } from '@/server/google/start'
import { googleStatus } from '@/server/google/status'
import { loadMyProfile, saveMyProfile } from '@/server/members/profile'
import { answerTakeover, loadTakeover } from '@/server/owner-change/answer'
import type { Defer, Deps } from '@/server/ports'
import { answerProgressFromLiff } from '@/server/progress/liff'
import { loadReview } from '@/server/review/load'
import { notifyReview } from '@/server/review/notify'
import { submitReview } from '@/server/review/submit'
import { loadSettings, stopUsing, submitSettings } from '@/server/settings/settings'
import { confirmOwner } from '@/server/setup/confirm'
import { loadSetup } from '@/server/setup/load'
import { resendSetupCard, submitSetup } from '@/server/setup/submit'
import { loadTask } from '@/server/tasks/load'
import { updateTaskFromLiff } from '@/server/tasks/update'
import { getDemo } from './demo-deps'

// /demo/api/<path>: the same body and answer as /api/<path>, through the same server
// functions, with the demo composition (and its background defer instead of after()).

type Handler = (deps: Deps, body: unknown, defer: Defer) => Promise<{ status: number; body: unknown }>

const POST_ROUTES: Record<string, Handler> = {
  'dashboard/load': (d, b) => loadDashboard(d, b),
  'me/load': (d, b) => loadMyProfile(d, b),
  'me/save': (d, b) => saveMyProfile(d, b),
  'review/load': (d, b) => loadReview(d, b),
  'review/notify': (d, b) => notifyReview(d, b),
  'review/submit': (d, b) => submitReview(d, b),
  'settings/load': (d, b) => loadSettings(d, b),
  'settings/stop-using': (d, b) => stopUsing(d, b),
  'settings/submit': (d, b) => submitSettings(d, b),
  'setup/confirm-owner': (d, b, defer) => confirmOwner(d, b, defer),
  'setup/load': (d, b) => loadSetup(d, b),
  'setup/resend-card': (d, b) => resendSetupCard(d, b),
  'setup/submit': (d, b, defer) => submitSetup(d, b, defer),
  'takeover/answer': (d, b, defer) => answerTakeover(d, b, defer),
  'takeover/load': (d, b) => loadTakeover(d, b),
  'tasks/load': (d, b) => loadTask(d, b),
  'tasks/update': (d, b) => updateTaskFromLiff(d, b),
  'progress/answer': (d, b) => answerProgressFromLiff(d, b),
  'google/start': (d, b) => startGoogleSignIn(d, b),
  'google/status': (d, b) => googleStatus(d, b),
  'google/disconnect': (d, b, defer) => disconnectGoogle(d, b, defer),
}

export const DEMO_LIFF_PATHS = Object.keys(POST_ROUTES)

/** null = no such demo API path (the route answers 404). */
export async function demoLiffPost(path: string, request: Request): Promise<Response | null> {
  const handler = POST_ROUTES[path]
  if (!handler) return null
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const demo = getDemo()
  const result = await handler(demo.deps, body, demo.defer)
  return Response.json(result.body, { status: result.status })
}

/** GET /demo/api/google/callback: the real callback page, whose "back to LINE" link goes
 *  to the simulator's Google view instead of liff.line.me. */
export async function demoGoogleCallback(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const demo = getDemo()
  const page = renderCallbackPage(await finishGoogleSignIn(demo.deps, url.searchParams, demo.defer), demo.deps.config.liffId)
  const html = (await page.text()).split(`https://liff.line.me/${demo.deps.config.liffId}?`).join(`${url.origin}/demo?`)
  return new Response(html, { status: page.status, headers: page.headers })
}
