import type { GooglePort, GoogleTokenResult } from '@/server/ports'

export class FakeGoogle implements GooglePort {
  exchangedCodes: string[] = []
  /** What exchangeCode answers; an Error makes it reject. */
  exchangeResult: GoogleTokenResult | Error = {
    refreshToken: 'rt-1',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'],
    subject: 'g-sub-1',
    email: 'owner@example.com',
  }

  buildAuthUrl(state: string): string {
    return `https://accounts.example/auth?state=${encodeURIComponent(state)}`
  }

  async exchangeCode(code: string): Promise<GoogleTokenResult> {
    this.exchangedCodes.push(code)
    if (this.exchangeResult instanceof Error) throw this.exchangeResult
    return { ...this.exchangeResult, scopes: [...this.exchangeResult.scopes] }
  }
}
