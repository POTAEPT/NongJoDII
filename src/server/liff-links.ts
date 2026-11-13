// 'dashboard' is linked from the weekly insight post (#21); its screen is #18.
export type LiffView = 'google' | 'review' | 'task' | 'progress' | 'dashboard'
export function liffUrl(liffId: string, view: LiffView, id?: string): string {
  return `https://liff.line.me/${liffId}?view=${view}` + (id ? `&id=${encodeURIComponent(id)}` : '')
}
