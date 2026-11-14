import { AdapterError, GoogleTokenRevoked } from '@/server/log'
import type { DriveFolderState, GooglePort, GoogleTokenResult } from '@/server/ports'

/** createdWith: the access token that made it, so a test can tell which Google account
 *  a folder belongs to ('at:' + that account's refresh token). */
export type FakeFolder = { id: string; name: string; parentId: string | null; trashed: boolean; createdWith: string }

/** The test clock (makeTestDeps wires the harness clock in). */
export type FakeClock = { now(): Date; advance(ms: number): void }

export class FakeGoogle implements GooglePort {
  // ---- time (#13 time limit) ----
  /** How long every Google call takes on `clock`; 0 (the default) = instant. */
  callMs = 0
  clock: FakeClock | null = null
  /** Every Google call with the clock time (ms) it started at, in order: 'exchange',
   *  'refresh:<refresh token>' or the Drive call ('create:NongJoDII', 'get:folder-1', ...). */
  callLog: { call: string; at: number }[] = []
  private holds = new Map<string, { parked(): void; gate: Promise<void> }>()

  /** Test aid for interleaving two runs: the next call named `call` (as callLog names it)
   *  waits before it runs until `release()`. `reached` resolves once it is waiting. */
  hold(call: string): { reached: Promise<void>; release(): void } {
    let release = () => {}
    let parked = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reached = new Promise<void>((resolve) => { parked = resolve })
    this.holds.set(call, { parked, gate })
    return { reached, release }
  }

  /** Waits at a hold, if any; then records the call's start and lets `callMs` pass: the
   *  answer comes back that much later. */
  private async spend(call: string): Promise<void> {
    const held = this.holds.get(call)
    if (held) {
      this.holds.delete(call)
      held.parked()
      await held.gate
    }
    this.callLog.push({ call, at: this.clock?.now().getTime() ?? 0 })
    if (this.callMs > 0) this.clock?.advance(this.callMs)
  }

  exchangedCodes: string[] = []
  /** What exchangeCode answers; an Error makes it reject. */
  exchangeResult: GoogleTokenResult | Error = {
    refreshToken: 'rt-1',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'],
    subject: 'g-sub-1',
    email: 'owner@example.com',
  }

  // ---- Drive (#13): one in-memory Drive shared by every account ----
  folders = new Map<string, FakeFolder>()
  /** permissions.create calls, in order. */
  shares: { fileId: string; role: 'reader'; type: 'anyone' }[] = []
  refreshCalls: string[] = []
  /** Every Drive call, e.g. 'create:NongJoDII', 'get:folder-1', 'share:folder-2'. */
  driveCalls: string[] = []
  /** Refresh tokens Google answers invalid_grant for. */
  revokedRefreshTokens = new Set<string>()
  /** When set, every Drive call (not the refresh) rejects with it. */
  driveError: Error | null = null
  /** When set, only the share rejects with it (e.g. a Google Workspace policy that blocks link sharing). */
  shareError: Error | null = null
  private seq = 0

  buildAuthUrl(state: string): string {
    return `https://accounts.example/auth?state=${encodeURIComponent(state)}`
  }

  async exchangeCode(code: string): Promise<GoogleTokenResult> {
    this.exchangedCodes.push(code)
    await this.spend('exchange')
    if (this.exchangeResult instanceof Error) throw this.exchangeResult
    return { ...this.exchangeResult, scopes: [...this.exchangeResult.scopes] }
  }

  async accessToken(refreshToken: string): Promise<string> {
    this.refreshCalls.push(refreshToken)
    await this.spend(`refresh:${refreshToken}`)
    if (this.revokedRefreshTokens.has(refreshToken)) throw new GoogleTokenRevoked()
    return `at:${refreshToken}`
  }

  private async drive(call: string, accessToken: string): Promise<void> {
    this.driveCalls.push(call)
    await this.spend(call)
    if (this.driveError) throw this.driveError
    if (!accessToken.startsWith('at:')) throw new AdapterError('google drive 401')
  }

  async createFolder(accessToken: string, name: string, parentId: string | null): Promise<string> {
    await this.drive(`create:${name}`, accessToken)
    if (parentId !== null && !this.folders.has(parentId)) throw new AdapterError('google drive create 404')
    const id = `folder-${++this.seq}`
    this.folders.set(id, { id, name, parentId, trashed: false, createdWith: accessToken })
    return id
  }

  /** Like Drive, a folder inside a trashed folder reads as trashed too. */
  async getFolder(accessToken: string, folderId: string): Promise<DriveFolderState> {
    await this.drive(`get:${folderId}`, accessToken)
    let f = this.folders.get(folderId)
    if (!f) return 'missing'
    while (f) {
      if (f.trashed) return 'trashed'
      f = f.parentId === null ? undefined : this.folders.get(f.parentId)
    }
    return 'ok'
  }

  async shareAnyoneReader(accessToken: string, fileId: string): Promise<void> {
    await this.drive(`share:${fileId}`, accessToken)
    if (this.shareError) throw this.shareError
    if (!this.folders.has(fileId)) throw new AdapterError('google drive share 404')
    this.shares.push({ fileId, role: 'reader', type: 'anyone' })
  }

  // ---- test helpers ----
  /** Folders, live or trashed, with this name and parent (undefined = any parent). */
  foldersNamed(name: string, parentId?: string | null): FakeFolder[] {
    return [...this.folders.values()].filter((f) => f.name === name && (parentId === undefined || f.parentId === parentId))
  }
  trash(folderId: string): void {
    const f = this.folders.get(folderId)
    if (!f) throw new Error(`FakeGoogle: no folder ${folderId}`)
    f.trashed = true
  }
  /** Deleted for good (emptied from the trash): Drive answers 404. */
  remove(folderId: string): void {
    this.folders.delete(folderId)
  }
}
