// 'dashboard' is linked from the weekly insight post (#21); its screen is #18.
// 'setup' (the setup form) and 'owner' (the Owner confirm) take groups.id (#52).
export type LiffView = 'google' | 'review' | 'task' | 'progress' | 'dashboard' | 'setup' | 'owner'
export function liffUrl(liffId: string, view: LiffView, id?: string): string {
  return `https://liff.line.me/${liffId}?view=${view}` + (id ? `&id=${encodeURIComponent(id)}` : '')
}
