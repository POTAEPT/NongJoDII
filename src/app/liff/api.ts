// The LIFF views' POST to their API routes, and the shared error copy. Only the LIFF ID
// token goes up as identity: the server verifies it with LINE. A 200 must carry JSON (a bad
// body throws, and the view shows its error). An error answer's JSON (a 400's field, a
// 403's reason) is read when there is one; otherwise json is null.
//
// The views name their routes as '/api/...'. The /demo simulator serves the same routes
// under '/demo/api/...' and calls setApiBase('/demo/api') before it renders a view; the
// live LIFF never calls it, so its paths stay exactly as written.
let apiBase = '/api'

export function setApiBase(base: string): void {
  apiBase = base
}

/** '/api/x' under the current API base ('/api/x' on the live LIFF). */
export function apiPath(path: string): string {
  return path.startsWith('/api/') ? `${apiBase}${path.slice('/api'.length)}` : path
}

export async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const res = await fetch(apiPath(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: unknown = res.status === 200 ? await res.json() : await res.json().catch(() => null)
  return { status: res.status, json }
}

export const ERR_401 = 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชตอีกครั้ง'
export const ERR_400 = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง'

/** Status-specific copy; `forbidden` and `notFound` name what the page is about. */
export function errorCopy(
  status: number,
  copy: { forbidden: string; notFound: string; fallback: string },
): string {
  if (status === 401) return ERR_401
  if (status === 403) return copy.forbidden
  if (status === 404) return copy.notFound
  if (status === 400) return ERR_400
  return copy.fallback
}
