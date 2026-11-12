import { expect, test } from 'vitest'

test('global fetch is blocked in tests', () => {
  expect(() => fetch('https://example.com')).toThrow(
    'Real network call in a test. Inject a fake port or fetchImpl.',
  )
})
