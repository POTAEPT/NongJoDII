import { AdapterError, GoogleTokenRevoked } from '@/server/log'
import type { DriveFolderState, GooglePort, GoogleTokenResult } from '@/server/ports'

export type FakeFolder = { id: string; name: string; parentId: string | null; trashed: boolean }

export class FakeGoogle implements GooglePort {
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
  private seq = 0

  buildAuthUrl(state: string): string {
    return `https://accounts.example/auth?state=${encodeURIComponent(state)}`
  }

  async exchangeCode(code: string): Promise<GoogleTokenResult> {
    this.exchangedCodes.push(code)
    if (this.exchangeResult instanceof Error) throw this.exchangeResult
    return { ...this.exchangeResult, scopes: [...this.exchangeResult.scopes] }
  }

  async accessToken(refreshToken: string): Promise<string> {
    this.refreshCalls.push(refreshToken)
    if (this.revokedRefreshTokens.has(refreshToken)) throw new GoogleTokenRevoked()
    return `at:${refreshToken}`
  }

  private drive(call: string, accessToken: string): void {
    this.driveCalls.push(call)
    if (this.driveError) throw this.driveError
    if (!accessToken.startsWith('at:')) throw new AdapterError('google drive 401')
  }

  async createFolder(accessToken: string, name: string, parentId: string | null): Promise<string> {
    this.drive(`create:${name}`, accessToken)
    if (parentId !== null && !this.folders.has(parentId)) throw new AdapterError('google drive create 404')
    const id = `folder-${++this.seq}`
    this.folders.set(id, { id, name, parentId, trashed: false })
    return id
  }

  /** Like Drive, a folder inside a trashed folder reads as trashed too. */
  async getFolder(accessToken: string, folderId: string): Promise<DriveFolderState> {
    this.drive(`get:${folderId}`, accessToken)
    let f = this.folders.get(folderId)
    if (!f) return 'missing'
    while (f) {
      if (f.trashed) return 'trashed'
      f = f.parentId === null ? undefined : this.folders.get(f.parentId)
    }
    return 'ok'
  }

  async shareAnyoneReader(accessToken: string, fileId: string): Promise<void> {
    this.drive(`share:${fileId}`, accessToken)
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
