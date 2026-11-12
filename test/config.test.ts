import { describe, expect, test } from 'vitest'
import { loadConfig } from '@/server/config'

const KEY_32 = Buffer.alloc(32, 1).toString('base64')

function fullEnv(): Record<string, string | undefined> {
  return {
    LINE_MESSAGING_CHANNEL_SECRET: 'secret-value-aaa',
    LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: 'access-token-bbb',
    LINE_MINIAPP_CHANNEL_ID: '1650000000',
    NEXT_PUBLIC_LIFF_ID: '2000000000-abcdefgh',
    APP_BASE_URL: 'https://nongjodii.example.app',
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_SECRET_KEY: 'sb-secret-ccc',
    OPENROUTER_API_KEY: 'or-key-ddd',
    GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'gsecret-eee',
    TOKEN_ENCRYPTION_KEY: KEY_32,
  }
}

describe('loadConfig', () => {
  test('a full env returns the config with a 32-byte key buffer', () => {
    const config = loadConfig(fullEnv())
    expect(config).toMatchObject({
      lineChannelSecret: 'secret-value-aaa',
      lineChannelAccessToken: 'access-token-bbb',
      lineLoginChannelId: '1650000000',
      liffId: '2000000000-abcdefgh',
      appBaseUrl: 'https://nongjodii.example.app',
      supabaseUrl: 'https://proj.supabase.co',
      supabaseSecretKey: 'sb-secret-ccc',
      openRouterApiKey: 'or-key-ddd',
      googleClientId: 'gid.apps.googleusercontent.com',
      googleClientSecret: 'gsecret-eee',
    })
    expect(Buffer.isBuffer(config.tokenEncryptionKey)).toBe(true)
    expect(config.tokenEncryptionKey.length).toBe(32)
    expect(config.tokenEncryptionKey.equals(Buffer.alloc(32, 1))).toBe(true)
  })

  test('missing names are listed together, without any values', () => {
    const env = fullEnv()
    delete env.LINE_MESSAGING_CHANNEL_SECRET
    env.OPENROUTER_API_KEY = undefined
    let message = ''
    try {
      loadConfig(env)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('Missing env:')
    expect(message).toContain('LINE_MESSAGING_CHANNEL_SECRET')
    expect(message).toContain('OPENROUTER_API_KEY')
    for (const value of Object.values(env)) {
      if (value) expect(message).not.toContain(value)
    }
  })

  test('a 16-byte key throws', () => {
    const env = { ...fullEnv(), TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }
    expect(() => loadConfig(env)).toThrow('TOKEN_ENCRYPTION_KEY must be 32 bytes base64')
  })

  test('a trailing slash on APP_BASE_URL is stripped', () => {
    const config = loadConfig({ ...fullEnv(), APP_BASE_URL: 'https://x.app/' })
    expect(config.appBaseUrl).toBe('https://x.app')
  })
})
