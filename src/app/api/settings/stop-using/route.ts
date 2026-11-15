import { getDeps } from '@/server/deps'
import { stopUsing } from '@/server/settings/settings'

// Stop using (#11): the access check and the leave call are LINE calls, each cut at 10 s.
export const maxDuration = 60

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const result = await stopUsing(getDeps(), body)
  return Response.json(result.body, { status: result.status })
}
