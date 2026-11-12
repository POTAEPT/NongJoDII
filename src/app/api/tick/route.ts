import { after } from 'next/server'
import { getDeps } from '@/server/deps'
import { handleTickRequest } from '@/server/tick/handle-request'

// The tick's jobs run inside after(); keep them inside the route's limit.
export const maxDuration = 60

export async function POST(request: Request) {
  return handleTickRequest(request, getDeps(), after)
}
