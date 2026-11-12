// Real services are never called in tests: any code path that reaches the
// global fetch fails loudly. Adapters take an injected fetchImpl instead.
globalThis.fetch = (() => {
  throw new Error('Real network call in a test. Inject a fake port or fetchImpl.')
}) as typeof fetch
