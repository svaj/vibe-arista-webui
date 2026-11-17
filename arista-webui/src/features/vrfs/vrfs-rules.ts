/**
 * S16 (#90): the pure grammar half of the VRF manager — no React, no device, no I/O.
 *
 * Every predicate here mirrors a guard in `arista-api-client/src/resources/vrfs.ts`, and every
 * line builder here composes text **byte-identical to what the frozen `node.vrfs` verbs send**,
 * copied from the pins in `vrfs.test.ts` (which themselves reproduce pyeapi's `test_api_vrfs.py`
 * texts). The rule this screen lives by (DR-141, DECISIONS.md): command text is port
 * composition, never invention — a token this file makes up would turn our bug into the
 * device's verdict. The device keeps the final say (DR-005): a line staged here that EOS
 * rejects comes back as the device's own `CommandError`.
 *
 * ## Run-9 hardware evidence (2026-11-15, supervised 7050TX-64 probe)
 *
 * - `vrf instance UNBLOCK-VRF` + `rd 65000:1` staged FULL (the header and the `rd` line travel
 *   in one batch; the device diff then showed the DEVICE adding `no ip routing vrf UNBLOCK-VRF`
 *   itself — a new VRF's routing flags are set by the device, not by this screen).
 *   `configure-session-unblock2-vrf-instance--hw-session-probe.json`
 * - `vrf definition UNBLOCK-VRF2` was REFUSED with error 1002 saying the keyword is deprecated
 *   on this image — which is exactly why {@link pickDefinitionForm} defers to the device's own
 *   written config text (DR-099) instead of guessing a version.
 *   `configure-session-unblock2-vrf-definition--hw-session-probe.json`
 * - `interface Vlan20` + `vrf UNBLOCK-VRF` STAGED even though the VRF did not exist — the
 *   "VRF … not configured." refusal arrives when the line runs, as the device's own error.
 *   `configure-session-unblock2-vrf-assignment--hw-session-probe.json`
 */
import type { VrfDefinitionForm } from '@devhax-heavy-industries/arista-eapi'

/** Mirror of `VRF_NAME` (vrfs.ts:161): numbers, letters, underscore — nothing else. */
export const VRF_NAME_GRAMMAR = /^\w+$/u

/**
 * Mirrors {@link assertVrfName} (vrfs.ts:233-239): the grammar the READER reuses, because
 * pyeapi's `(\w+)` capture truncates anything wider and regex metacharacters would widen the
 * section-key lookups the client's reads build. Returns the refusal text, or `undefined` when
 * the name passes.
 */
export function vrfNameError(value: string): string | undefined {
  if (value.trim() === '') return 'A VRF name is required — the client composes `vrf <form> <name>` and interpolates whatever it is given (assertVrfName, vrfs.ts).'
  if (!VRF_NAME_GRAMMAR.test(value)) {
    return `"${value}" is not a VRF name this client accepts: one or more of numbers, letters and underscore only (VRF_NAME, vrfs.ts:161; assertVrfName refuses the same set — anything wider is truncated to the leading (\\w+) run, and metacharacters would widen the section-key lookups the reader makes).`
  }
  return undefined
}

/** Module-local mirror of the client's `hasControlCharacter` (same predicate shape as users-rules.ts). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Mirrors {@link assertVrfRd} (vrfs.ts:251-258): a non-empty single token. The empty value is
 * refused on purpose — clearing goes through the `no rd` arm (DR-037), never an empty `rd ` line.
 * Outer whitespace is lost before the read sees it, inner whitespace produces a line no consumer
 * can treat as one token, and a control character breaks the config line. Shape (`a:b`) is NOT
 * enforced here: which rds the CLI accepts is the device's answer (DR-032), and pyeapi never checked.
 */
export function vrfRdError(value: string): string | undefined {
  if (value.trim() === '') return 'An empty rd is refused — clear the value with the `Clear rd` action (the `no rd` arm), not an empty value (assertVrfRd, vrfs.ts, DR-037).'
  if (value !== value.trim()) return 'An rd cannot carry leading or trailing whitespace — the reader parses it from the rstripped body line, so the padding would never read back (assertVrfRd, vrfs.ts).'
  if (/\s/u.test(value)) return 'An rd must be one token — whitespace inside it produces a line this client can send but no consumer can read back as a single value (assertVrfRd, vrfs.ts).'
  if (hasControlCharacter(value)) return 'An rd cannot contain a control character — it would break the config line this client reads back (assertVrfRd, vrfs.ts, row 74).'
  return undefined
}

/**
 * Mirrors {@link assertVrfDescription} (vrfs.ts:274-280): present, round-trippable text.
 * Outer whitespace and control characters break the read; a contained `"` cannot survive the
 * reader's unquote step. Whether EOS quotes longer descriptions is unverified on hardware (M12 #14),
 * so this guard is a CLIENT round-trip rule, not a device claim.
 */
export function vrfDescriptionError(value: string): string | undefined {
  if (value.trim() === '') return 'An empty description is refused — clear it with the `Clear description` action (the `no description` arm), not an empty value (assertVrfDescription, vrfs.ts, DR-037).'
  if (value !== value.trim()) return 'A description cannot carry leading or trailing whitespace — the reader returns the rstripped line remainder, so the padding would never read back (assertVrfDescription, vrfs.ts).'
  if (hasControlCharacter(value)) return 'A description cannot contain a control character — it would break the config line this client reads back (assertVrfDescription, vrfs.ts, row 74).'
  if (value.includes('"')) return 'A description containing a quote cannot round-trip through this reader, which unquotes a balanced pair (assertVrfDescription, vrfs.ts). Legality on EOS is unverified on hardware (M12 #14) — the refusal here is the client contract, not a device verdict.'
  return undefined
}

/** Minimal entry shape {@link pickDefinitionForm} needs — `Vrf` satisfies it structurally. */
export interface FormEvidence {
  readonly definitionForm: VrfDefinitionForm
}

/**
 * Mirrors `VrfsResource.resolveVrfForm` (vrfs.ts:357-380, DR-099) over the read table instead of
 * the raw config sections: ANY instance-form entry wins even on a mixed config (the keyword the
 * device demonstrably still accepts); a definition-only config writes the legacy keyword; no VRF
 * sections at all fall back to the client's convention default `instance` (repo floor EOS 4.28,
 * matching upstream's own ≥4.23 gate) — a device that predates the keyword refuses with its own
 * `CommandError` (DR-005).
 */
export function pickDefinitionForm(entries: Iterable<FormEvidence>): {
  readonly form: VrfDefinitionForm
  readonly fromDeviceConfig: boolean
} {
  let sawDefinition = false
  for (const entry of entries) {
    if (entry.definitionForm === 'instance') return { form: 'instance', fromDeviceConfig: true }
    if (entry.definitionForm === 'definition') sawDefinition = true
  }
  return sawDefinition
    ? { form: 'definition', fromDeviceConfig: true }
    : { form: 'instance', fromDeviceConfig: false }
}

/** `vrf <form> <name>` — the exact section header `vrfHeader` composes (vrfs.ts:382-385). */
export function vrfHeader(form: VrfDefinitionForm, name: string): string {
  return `vrf ${form} ${name}`
}

/** The interface-side keyword per form (vrfs.ts, `bindInterfaceVrf`): `vrf` vs `vrf forwarding`. */
export function interfaceVrfKeyword(form: VrfDefinitionForm): string {
  return form === 'instance' ? 'vrf' : 'vrf forwarding'
}

/**
 * Create batch — `vrfs.create(name, {rd})` sends the header and `rd …` in one transaction
 * (vrfs.ts:393-402; run 9 staged the same pair FULL). The optional `description` line is the
 * exact text `setVrfDescription` composes inside the section (vrfs.ts:445), carried in the same
 * batch instead of a second transaction; the `default rd` / `default description` arms exist on
 * the client but this screen does not offer them (screen scope, not device scope).
 */
export function createVrfLines(
  form: VrfDefinitionForm,
  name: string,
  options: { readonly rd?: string; readonly description?: string } = {},
): string[] {
  return [
    vrfHeader(form, name),
    ...(options.rd === undefined ? [] : [`rd ${options.rd}`]),
    ...(options.description === undefined ? [] : [`description ${options.description}`]),
  ]
}

/** `no vrf <form> <name>` — `vrfs.delete` (vrfs.ts:404-407). */
export function deleteVrfLines(form: VrfDefinitionForm, name: string): string[] {
  return [`no ${vrfHeader(form, name)}`]
}

/** `vrf <form> <name>` + `rd <value>` — `setVrfRd` enters the section and sets one line (vrfs.ts:429-432). */
export function setRdLines(form: VrfDefinitionForm, name: string, rd: string): string[] {
  return [vrfHeader(form, name), `rd ${rd}`]
}

/** `no rd` inside the section — `unsetVrfRd` (vrfs.ts:435-437). */
export function unsetRdLines(form: VrfDefinitionForm, name: string): string[] {
  return [vrfHeader(form, name), 'no rd']
}

/** `description <value>` inside the section — `setVrfDescription` (vrfs.ts:445-448). */
export function setDescriptionLines(form: VrfDefinitionForm, name: string, description: string): string[] {
  return [vrfHeader(form, name), `description ${description}`]
}

/** `no description` inside the section — `unsetVrfDescription` (vrfs.ts:451-453). */
export function unsetDescriptionLines(form: VrfDefinitionForm, name: string): string[] {
  return [vrfHeader(form, name), 'no description']
}

export type RoutingFamily = 'ipv4' | 'ipv6'
export type RoutingArm = 'set' | 'no' | 'default'

/** The bare stem: `ip routing vrf <name>` / `ipv6 unicast-routing vrf <name>` — both TOP-level (divergence 9). */
export function routingStem(family: RoutingFamily, name: string): string {
  return family === 'ipv4' ? `ip routing vrf ${name}` : `ipv6 unicast-routing vrf ${name}`
}

/**
 * Routing-flag batch arms — `setIpv4Routing` sends the BARE stem (no trailing word; vrfs.ts:471-473),
 * the disable arm prefixes `no `, the default arm prefixes `default ` (vrfs.ts:479/485, mirrored for
 * ipv6 at :489-503). One line, top level, like every routing verb.
 */
export function routingLines(family: RoutingFamily, arm: RoutingArm, name: string): string[] {
  const stem = routingStem(family, name)
  return [arm === 'set' ? stem : `${arm} ${stem}`]
}

/**
 * Bind batch — `vrfs.setInterface` enters the interface and writes the per-form keyword
 * (vrfs.ts:529, reproduce-verified on run 9 with `interface Vlan20` + `vrf UNBLOCK-VRF`).
 * Assignment existence is checked when the line RUNS: the run-9 capture shows the device
 * refusing a not-yet-configured VRF (`VRF UNBLOCK-VRF not configured.`) — staging passes, the
 * device answers.
 */
export function bindInterfaceLines(form: VrfDefinitionForm, iface: string, vrfName: string): string[] {
  return [`interface ${iface}`, `${interfaceVrfKeyword(form)} ${vrfName}`]
}

/** `no vrf` / `no vrf forwarding` inside the interface — `vrfs.unsetInterface` (vrfs.ts:534-537). */
export function unbindInterfaceLines(form: VrfDefinitionForm, iface: string): string[] {
  return [`interface ${iface}`, `no ${interfaceVrfKeyword(form)}`]
}
