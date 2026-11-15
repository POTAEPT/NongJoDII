// Structured logs. IDs and event types only: never tokens, secrets, chat text,
// Task titles or names.

type Fields = Record<string, string | number | boolean | null>

export function log(event: string, fields: Fields = {}): void {
  console.info(JSON.stringify({ event, ...fields }))
}

/** The only error adapters throw. Its message is a fixed prefix plus an HTTP
 *  status or error code (e.g. 'line reply 500', 'supabase insertMessage: 23503'),
 *  so it is safe to log. */
export class AdapterError extends Error {
  name = 'AdapterError'
}

/** LINE answered a push with a 4xx: it did not accept the request, so nothing was sent
 *  (LINE's retry docs: "4xx: Problem with the request. Retries don't change the result").
 *  Any other push failure (a 5xx, a timeout, a network error) leaves the outcome unknown:
 *  LINE may have delivered the push. The message stays `line push <status>`. */
export class LinePushRejected extends AdapterError {
  name = 'LinePushRejected'
  readonly status: number

  constructor(status: number) {
    super(`line push ${status}`)
    this.status = status
  }
}

/** Google answered a refresh with invalid_grant: the Owner revoked access or the grant
 *  expired, so retrying cannot help. #14 marks the account and asks for a new sign-in. */
export class GoogleTokenRevoked extends AdapterError {
  name = 'GoogleTokenRevoked'

  constructor() {
    super('google refresh invalid_grant')
  }
}

/** Logs an AdapterError's message; any other error logs only its name, because
 *  its message may quote chat-derived input. */
export function logError(event: string, fields: Fields, err: unknown): void {
  const error = err instanceof AdapterError ? err.message : err instanceof Error ? err.name : 'unknown'
  console.error(JSON.stringify({ event, ...fields, error }))
}
