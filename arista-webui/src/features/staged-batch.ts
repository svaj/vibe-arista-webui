/**
 * The one shared shape between the screen wave's write paths: a staged batch is a list of **command
 * lines**. `submodeCommands`/`commandBuilder` answer `CommandSpec[]`, because a spec may be
 * `{ cmd, input }` for a multiline command; every batch the S1–S7 screens stage is a plain string, and the
 * review panel plus the destructive guards read the text — so `stageLines`'s narrowing is asserted, not
 * cast: a verb that ever stages an object spec fails there loudly instead of showing an operator `undefined`.
 * #78 (S8) is the deliberate exception — the EOF-terminated `banner` verb genuinely stages `{cmd, input}`,
 * and its review copy comes from {@link stageDisplay} below.
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

/**
 * The review-copy form for a batch that MAY carry `{cmd, input}` specs (#78, S8: the EOF-terminated
 * `banner <kind>` framing pinned in `resources/system.ts` line 431-437 is the first such staged
 * verb in this app). The input text is never inlined here — a banner body is arbitrary
 * device-displayed text, and the screen renders it separately as `<pre>` text — so an object spec
 * displays as its command plus a digest stating the terminator contract and the body's line count.
 */
export function stageDisplay(batch: readonly CommandSpec[]): readonly string[] {
  return batch.map((entry) => {
    if (typeof entry === 'string') return entry
    if (entry.input === undefined) return entry.cmd
    // The client's own framing (`system.ts` setBanner): `${body}\nEOF\n`, one trailing newline
    // folded. Recover the body length the same way, for honest operator copy only.
    const unterminated = entry.input.endsWith('\n') ? entry.input.slice(0, -1) : entry.input
    const body = unterminated.endsWith('\nEOF') ? unterminated.slice(0, -'\nEOF'.length) : unterminated
    const lines = body === '' ? 0 : body.split('\n').length
    return `${entry.cmd} (multiline input: ${String(lines)} line(s), EOF-terminated)`
  })
}
