import { after } from 'next/server'
import { getDeps } from '@/server/deps'
import { finishGoogleSignIn, renderCallbackPage } from '@/server/google/callback'

// The Drive folders (#13) are made inside after(), within this limit.
export const maxDuration = 60

// Reading request.url makes this GET handler run at request time under Cache
// Components (01-app/01-getting-started/15-route-handlers.md).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const deps = getDeps()
  return renderCallbackPage(await finishGoogleSignIn(deps, params, after), deps.config.liffId)
}
