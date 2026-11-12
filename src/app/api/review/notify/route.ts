import { getDeps } from '@/server/deps'
import { notifyReview } from '@/server/review/notify'

// Shorter than the 2-minute stale window in notify.ts, so a live request's claim
// is never taken over.
export const maxDuration = 60

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const result = await notifyReview(getDeps(), body)
  return Response.json(result.body, { status: result.status })
}
