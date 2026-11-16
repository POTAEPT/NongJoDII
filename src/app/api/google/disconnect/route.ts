import { after } from 'next/server'
import { getDeps } from '@/server/deps'
import { disconnectGoogle } from '@/server/google/disconnect'

// The groups' "disconnected" cards are sent inside after(), within this limit.
export const maxDuration = 60

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const result = await disconnectGoogle(getDeps(), body, after)
  return Response.json(result.body, { status: result.status })
}
