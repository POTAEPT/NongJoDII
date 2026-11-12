import { getDeps } from '@/server/deps'
import { answerProgressFromLiff } from '@/server/progress/liff'

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const result = await answerProgressFromLiff(getDeps(), body)
  return Response.json(result.body, { status: result.status })
}
