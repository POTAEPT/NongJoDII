// #142: why someone in the group may be missing from the list. LINE tells the bot about a
// person only after they send a message (or join after the bot), so people who were in the
// group before it show up once they type anything there.

export const MEMBERS_HINT = {
  count: (known: number, total: number) => `น้องจดดีรู้จักแล้ว ${known} จาก ${total} คน`,
  why: 'คนที่ยังไม่ขึ้น จะขึ้นที่นี่หลังพิมพ์อะไรก็ได้ในกลุ่ม 1 ครั้ง แล้วเปิดหน้านี้ใหม่',
  unknownTotal: 'ถ้ายังไม่เห็นบางคน ให้คนนั้นพิมพ์อะไรก็ได้ในกลุ่ม 1 ครั้ง แล้วเปิดหน้านี้ใหม่',
} as const

/** `total` is LINE's member count (null when unknown). Nothing shows when everyone is known. */
export function MembersHint({ known, total }: { known: number; total: number | null }) {
  if (total !== null && known >= total) return null
  return (
    <div role="note" className="rounded-xl bg-warn-bg px-3 py-2 text-sm text-warn">
      {total !== null && <p className="font-semibold">{MEMBERS_HINT.count(known, total)}</p>}
      <p>{total !== null ? MEMBERS_HINT.why : MEMBERS_HINT.unknownTotal}</p>
    </div>
  )
}
