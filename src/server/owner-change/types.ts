// Shapes of /api/takeover/load and /api/takeover/answer (#31). Types only: the LIFF
// client imports this file with `import type`.

export type TakeoverChoice = 'takeover' | 'detach'

/** The take-over question as the new Owner sees it. `subGroups` empty: nothing to answer
 *  (already answered, or the Sub groups detached after 7 days). */
export type TakeoverLoad = {
  mainGroupName: string | null
  subGroups: { groupId: string; name: string | null }[]
  /** When the waiting Sub groups detach by themselves (ISO), null when none wait. */
  detachAt: string | null
}

export type TakeoverAnswerResult = { choice: TakeoverChoice; subGroups: number }
