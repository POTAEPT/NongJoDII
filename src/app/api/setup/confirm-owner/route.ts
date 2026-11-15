import { after } from 'next/server'
import { getDeps } from '@/server/deps'
import { confirmOwner } from '@/server/setup/confirm'

// The Drive folders (#13) are made inside after(), within this limit.
export const maxDuration = 60

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const result = await confirmOwner(getDeps(), body, after)
  return Response.json(result.body, { status: result.status })
}
