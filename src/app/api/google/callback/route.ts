import { getDeps } from '@/server/deps'
import { finishGoogleSignIn, renderCallbackPage } from '@/server/google/callback'

// Reading request.url makes this GET handler run at request time under Cache
// Components (01-app/01-getting-started/15-route-handlers.md).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  return renderCallbackPage(await finishGoogleSignIn(getDeps(), params))
}
