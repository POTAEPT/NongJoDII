import { after } from 'next/server'
import { getDeps } from '@/server/deps'
import { handleWebhookRequest } from '@/server/webhook/handle-request'

// Summaries call the AI inside after(); keep the work inside the route's limit.
export const maxDuration = 60

export async function POST(request: Request) {
  return handleWebhookRequest(request, getDeps(), after)
}
