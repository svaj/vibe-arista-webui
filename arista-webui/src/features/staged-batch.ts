/**
 * The one shared shape between the screen wave's write paths: a staged batch is a list of **command
 * lines**. `submodeCommands`/`commandBuilder` answer `CommandSpec[]`, because a spec may be
 * `{ cmd, input }` for a multiline command; every batch these screens stage is a plain string, and the
 * review panel plus the destructive guards read the text — so the narrowing is asserted, not cast. A
 * verb that ever stages an object spec fails here loudly instead of showing an operator `undefined`.
 *
 * S1 (#71) introduced this inline in `InterfacesDashboard.tsx`; S2 (#72) is the second caller of the
 * same rule, so it moved here rather than being copied.
 */
import type { CommandSpec } from '@devhax-heavy-industries/arista-eapi'

export function stageLines(batch: readonly CommandSpec[]): readonly string[] {
  return batch.map((entry) => {
    if (typeof entry === 'string') return entry
    throw new Error(`this screen stages plain command lines; got an object spec for ${JSON.stringify(entry.cmd)}`)
  })
}
