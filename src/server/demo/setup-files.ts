import type { Demo } from './demo-deps'
import { groupsDir, rewriteGroupFile, type GroupFile } from './group-files'

// A group made with "สร้างกลุ่ม" is saved as not set up (setUp: false). Once its real setup
// completes (the form saved and the Owner confirmed, or the form attached it to a Project as
// a Sub group, #159), its file records the outcome, so Reset brings it back set up. Called
// after every sim and LIFF request of the demo.

export function recordSetUpFiles(demo: Demo): void {
  const { world, store } = demo
  for (const g of world.groups) {
    if (!g.fileNotSetUp || !g.file) continue
    const row = store.tables.groups.find((r) => r.lineGroupId === g.lineGroupId)
    if (!row?.projectId || row.ownerConfirmedAt === null) continue
    const project = store.tables.projects.find((p) => p.id === row.projectId)
    const owner = world.personaById(row.nominatedOwnerLineUserId ?? project?.ownerLineUserId ?? '')
    if (!owner) {
      world.addLog('error', `[${g.name}] setup not recorded in ${g.file}: its Owner is not a demo persona`)
      g.fileNotSetUp = false
      continue
    }
    const isMain = store.tables.group_setups.some((r) => r.groupId === row.id && r.isMain)
    const def: GroupFile = { name: g.name, lineGroupId: g.lineGroupId, members: [...g.members], owner: owner.key, mode: 'new-project' }
    if (!isMain) {
      const mainRow = store.tables.groups.find((r) => r.projectId === row.projectId
        && store.tables.group_setups.some((s) => s.groupId === r.id && s.isMain))
      const parent = mainRow ? world.groupById(mainRow.lineGroupId) : undefined
      if (!parent?.file) {
        world.addLog('error', `[${g.name}] setup not recorded in ${g.file}: its Project's main group has no file`)
        g.fileNotSetUp = false
        continue
      }
      def.mode = 'sub-group'
      def.parent = parent.file
    }
    try {
      rewriteGroupFile(groupsDir(), g.file, def)
      world.addLog('event', `[${g.name}] setup recorded in ${g.file} (${isMain ? 'new Project' : `Sub group of ${def.parent}`}, Owner ${owner.key})`)
    } catch (err) {
      world.addLog('error', `[${g.name}] setup not recorded in ${g.file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    g.fileNotSetUp = false
  }
}
