// Server configuration. The only reader of server env besides src/server/deps.ts,
// which passes process.env in. Pure: errors name missing vars, never their values.

export type AppConfig = {
  lineChannelSecret: string
  lineChannelAccessToken: string
  lineLoginChannelId: string
  liffId: string
  appBaseUrl: string            // no trailing slash
  supabaseUrl: string
  supabaseSecretKey: string
  openRouterApiKey: string
  googleClientId: string
  googleClientSecret: string
  tokenEncryptionKey: Buffer    // exactly 32 bytes
}

const NAMES = [
  'LINE_MESSAGING_CHANNEL_SECRET',
  'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN',
  'LINE_MINIAPP_CHANNEL_ID',
  'NEXT_PUBLIC_LIFF_ID',
  'APP_BASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
] as const

type Name = (typeof NAMES)[number]

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const missing = NAMES.filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`Missing env: ${missing.join(', ')}`)
  const get = (name: Name) => env[name] as string

  const tokenEncryptionKey = Buffer.from(get('TOKEN_ENCRYPTION_KEY'), 'base64')
  if (tokenEncryptionKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes base64')

  return {
    lineChannelSecret: get('LINE_MESSAGING_CHANNEL_SECRET'),
    lineChannelAccessToken: get('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN'),
    lineLoginChannelId: get('LINE_MINIAPP_CHANNEL_ID'),
    liffId: get('NEXT_PUBLIC_LIFF_ID'),
    appBaseUrl: get('APP_BASE_URL').replace(/\/+$/, ''),
    supabaseUrl: get('SUPABASE_URL'),
    supabaseSecretKey: get('SUPABASE_SECRET_KEY'),
    openRouterApiKey: get('OPENROUTER_API_KEY'),
    googleClientId: get('GOOGLE_CLIENT_ID'),
    googleClientSecret: get('GOOGLE_CLIENT_SECRET'),
    tokenEncryptionKey,
  }
}
