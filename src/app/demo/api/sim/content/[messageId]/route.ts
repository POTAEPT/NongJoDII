import { demoEnabled, demoNotFound } from '@/server/demo/gate'
import { simContent } from '@/server/demo/sim'

// The bytes of an image or file sent in the simulator.
export async function GET(_request: Request, ctx: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await ctx.params
  if (!demoEnabled()) return demoNotFound()
  return simContent(messageId)
}
