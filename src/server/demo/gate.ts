/** The /demo simulator runs only when DEMO_MODE=1, and only on a developer's machine: never
 *  on any Vercel deployment (production or preview; Vercel sets VERCEL=1 on both). A preview
 *  link with DEMO_MODE set would otherwise let anyone spend the real OpenRouter key and use
 *  the Google client. Every demo page and route answers 404 otherwise. Read per call, so a
 *  test can flip the env. */
export function demoEnabled(): boolean {
  const env = process.env.VERCEL_ENV
  return process.env.DEMO_MODE === '1' && process.env.VERCEL !== '1' && env !== 'production' && env !== 'preview'
}

export function demoNotFound(): Response {
  return new Response('Not Found', { status: 404 })
}
