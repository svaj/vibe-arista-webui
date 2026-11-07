/**
 * F3 (#65) presentation primitive: "the read succeeded and there is nothing to show".
 *
 * This must never stand in for a failed read. `SwitchManager.tsx` keeps that line today —
 * `'The device returned no VLAN entries.'` (empty) versus the `role="alert"` block carrying
 * `device unreachable` (error) — and `App.test.tsx` pins that a read failure is not rendered as an
 * empty result. So this component renders no `role="alert"`, no `aria-live`, and no error styling:
 * callers use the `.notice-error` markup (F4/F6 own that) for failures.
 *
 * The copy is a prop because the answer is screen-specific: what is empty, and what action or
 * device state would fill it (cf. `App.test.tsx`'s 'No supported Ethernet interfaces were
 * returned.' vs 'No configured Ethernet interfaces are available; …').
 */
export interface EmptyStateProps {
  /** The one-line "what is empty" statement, shown as the primary text. */
  readonly heading: string
  /** Optional "what would fill it" hint: a device read, an action, or a configuration step. */
  readonly hint?: string
}

export function EmptyState({ heading, hint }: EmptyStateProps) {
  return <div className="empty-state">
    <p className="empty-state-heading">{heading}</p>
    {hint !== undefined && <p className="empty-state-hint">{hint}</p>}
  </div>
}
