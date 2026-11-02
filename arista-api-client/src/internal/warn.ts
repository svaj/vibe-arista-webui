/**
 * Process-wide safety warnings — M2 (#4).
 *
 * DR-013 requires that `dangerouslyDisableTlsVerification` "log a warning once per process", and
 * DR-014 requires the local (unauthenticated priv-15) transports to say so out loud. Doing that per
 * transport instance would bury the message under a constructor loop; doing it once, globally, is
 * the documented behaviour.
 *
 * This is the only module-level mutable state in the package, and it is deliberately *not*
 * configuration state (which DR-038 rules out): it is a de-duplication registry for messages that
 * have already been printed. Nothing reads it back to change behaviour.
 */

const emitted = new Set<string>()

/**
 * Print `message` at most once per `key` per process.
 *
 * @returns `true` when the warning was printed, `false` when it was suppressed as a duplicate.
 */
export function warnOnce(key: string, message: string): boolean {
  if (emitted.has(key)) return false
  emitted.add(key)
  // `console.warn` rather than a logger dependency: the webui and Node CLIs both surface it, and the
  // message is already secret-free by construction (DR-011 — no credential is ever interpolated).
  console.warn(`[arista-eapi] ${message}`)
  return true
}

/** True when `key` has already been warned about in this process. */
export function hasWarned(key: string): boolean {
  return emitted.has(key)
}

/**
 * Test-only reset, so warning assertions stay order-independent. Not re-exported from either entry
 * point (`src/internal/**` is not API — DR-040).
 */
export function clearWarningRegistry(): void {
  emitted.clear()
}
