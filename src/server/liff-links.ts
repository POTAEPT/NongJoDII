// 'dashboard' is linked from the weekly insight post (#21); its screen is #18.
// 'setup' (the setup form) and 'owner' (the Owner confirm) take groups.id (#52).
export type LiffView = 'google' | 'review' | 'task' | 'progress' | 'dashboard' | 'setup' | 'owner'
/** The ids the Google OAuth callback page links back to the LIFF google view with: `done`
 *  after a sign-in that finished, `back` after one that did not (cancelled, expired,
 *  failed). Neither starts a new sign-in by itself. */
export const GOOGLE_RETURN = { done: 'done', back: 'back' } as const
export function liffUrl(liffId: string, view: LiffView, id?: string): string {
  return `https://liff.line.me/${liffId}?view=${view}` + (id ? `&id=${encodeURIComponent(id)}` : '')
}
