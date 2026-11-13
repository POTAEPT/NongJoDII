import { getDeps } from '@/server/deps'
import { confirmOwner } from '@/server/setup/confirm'

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const result = await confirmOwner(getDeps(), body)
  return Response.json(result.body, { status: result.status })
}
