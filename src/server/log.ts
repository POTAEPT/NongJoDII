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

/** Logs an AdapterError's message; any other error logs only its name, because
 *  its message may quote chat-derived input. */
export function logError(event: string, fields: Fields, err: unknown): void {
  const error = err instanceof AdapterError ? err.message : err instanceof Error ? err.name : 'unknown'
  console.error(JSON.stringify({ event, ...fields, error }))
}
