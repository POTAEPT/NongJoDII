// The LIFF views' POST to their API routes. Only the LIFF ID token goes up as identity:
// the server verifies it with LINE. A 200 must carry JSON (a bad body throws, and the view
// shows its error). An error answer's JSON (a 400's field, a 403's reason) is read when
// there is one; otherwise json is null.
export async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: unknown = res.status === 200 ? await res.json() : await res.json().catch(() => null)
  return { status: res.status, json }
}
