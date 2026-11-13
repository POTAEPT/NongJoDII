import { getDeps } from '@/server/deps'
import { resendSetupCard } from '@/server/setup/submit'

// Room for the LINE calls (access check, push budget, push), each cut at 10 s.
export const maxDuration = 60

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const result = await resendSetupCard(getDeps(), body)
  return Response.json(result.body, { status: result.status })
}
