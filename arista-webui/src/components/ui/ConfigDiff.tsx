/**
 * F3 (#65) presentation primitive: the configuration-diff block, extracted verbatim from the
 * review panel in `src/features/SwitchManager.tsx` (`<pre className="diff-output"
 * aria-label="Configuration diff">{draft.diff || 'No configuration differences returned.'}</pre>`).
 * The element, its class, and its accessible name are unchanged so F6's screens keep the markup
 * `App.test.tsx` already exercises.
 *
 * Three arms, and the distinction between the first two is the whole point:
 *   1. `diff === undefined` — the diff has not come back (staged, or the outcome is uncertain), so
 *      committing would be a guess. Shows the staging copy, not an empty diff.
 *   2. `diff === ''` — the device answered with no differences. Shows that fact as diff text.
 *   3. otherwise — the device's diff bytes inside a scrollable `<pre>`, unmodified (no syntax
 *      highlighting, no line folding, no reordering; there is no diff parser here).
 *
 * Commit-enablement is **not** this component's concern: `session.hasDiffBeenRead()`, the
 * attempted-commit warning, and the commit/abort buttons belong to the container (F6), so screens
 * can reuse the block without inheriting that policy.
 */
export interface ConfigDiffProps {
  /** The device diff, or `undefined` while it is still unread. */
  readonly diff?: string
}

export function ConfigDiff({ diff }: ConfigDiffProps) {
  return diff === undefined
    ? <p className="notice">The change is staged or its outcome is uncertain. A diff is required before commit.</p>
    : <pre className="diff-output" aria-label="Configuration diff">{diff || 'No configuration differences returned.'}</pre>
}
