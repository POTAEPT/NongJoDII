/** The /demo simulator runs only when DEMO_MODE=1, and never on a Vercel production
 *  deployment. Every demo page and route answers 404 otherwise. Read per call, so a test can
 *  flip the env. */
export function demoEnabled(): boolean {
  return process.env.DEMO_MODE === '1' && process.env.VERCEL_ENV !== 'production'
}

export function demoNotFound(): Response {
  return new Response('Not Found', { status: 404 })
}
