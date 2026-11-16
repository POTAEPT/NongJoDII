import type { LineEvent } from '@/server/line/types'
import type { Defer, Deps } from '@/server/ports'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { signedRequest, webhookBody } from '../test/harness'

/** The seam between a scenario and the bot. Today the events go straight into the webhook
 *  handler as a signed request (no network). A real-LINE or phone transport can be added
 *  later by implementing send() and posting the same body to a live webhook URL. */
export interface Transport {
  send(events: LineEvent[]): Promise<Response>
}

export class SignedEventTransport implements Transport {
  constructor(
    private readonly deps: Deps,
    private readonly defer: Defer,
  ) {}

  send(events: LineEvent[]): Promise<Response> {
    return handleWebhookRequest(signedRequest(webhookBody(...events)), this.deps, this.defer)
  }
}
