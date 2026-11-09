/**
 * `hw-capture.ts` — the read-mostly policy layer for the **hardware capture lane** (#14 §3, added
 * 2026-11-08). This module decides *what* gets captured from a physical 7050TX-64 and *what must be
 * scrubbed* before bytes are committed; the round trips themselves are recorded with the existing
 * recorder pair (`recording.ts` + `recorder-node.ts`), into `test/fixtures/recordings/7050tx-64-4.28.13.1M/`
 * (docs/TESTING.md:130-131, docs/CEOS.md:143-145).
 *
 * ## Why a separate lane from the container harness
 * `scripts/ceos-lab.mjs` owns disposable-target capture: it creates the container, knows its cert,
 * stamps `targetClass:"lab"` + `hardwareEvidence:"none"` on every file, and hard-refuses to write
 * outside `fixtures/live/ceos-*`. A physical switch shares **none** of those assumptions — the cert is
 * the device's own, the run has no container to tear down, and the evidence claim is the opposite one.
 * DR-043's whole point is that the two kinds of bytes never mix, so the hardware lane lives in its own
 * files and writes only the replay-tree format that already models `'hardware'`
 * (`TARGET_CLASSES`, `recording.ts:144`).
 *
 * ## What this module adds over the lab lane's redaction
 * The container lane scrubs: enable inputs (recorder rule), `secret sha512 …` material, PEM blocks, the
 * run user, and MACs **under `*mac*` keys** only (a recorded scope gap: STP bridge addresses and LACP
 * system IDs sit under other keys and passed verbatim — flagged for review in PR #98). A real switch's
 * serial numbers *are* a person's asset inventory, and its hostname/IPs are a lab map, so the hardware
 * lane scrubs strictly:
 *  - every MAC-shaped **value** (whole-value zero or in-string replace), not just MAC-named keys;
 *  - every key containing `serial` (and `serialNum`-shaped values are not re-introduced);
 *  - `secret sha512 …` / `secret md5 …` material and PEM blocks (same rules as the lab lane), applied
 *    to object **keys** as well as values — the running-config JSON keys each config LINE, and the
 *    first executed capture leaked a live hash that way (DR-133) — and to the envelope's free-text
 *    identity fields (the endpoint carries the switch's real management address);
 *  - caller-supplied strings (`extraSecrets`: hostname, mgmt IP, lab domain…) — replaced wherever found;
 *  - the recorder's own enable-input rule stays (`findUnredactedEnableInput` gates every write through
 *    `recordingText`/`parseRecording`).
 * Scrubbing is **before** the file is built, not after: the returned log lists every rewrite path so the
 * live run's console shows what was changed (counts only — never the secret text).
 *
 * ## Session-probe policy (DR-035(b) made physical)
 * The `HwProbeBatch` type is the shape the operator reviews **before the switch session**: batches that
 * `allowCommit` may stage only commands naming `{{SCRATCH}}` (the one designated unused interface,
 * supplied at run time from `EAPI_SCRATCH_INTERFACE` through `requireScratchInterface`); every batch —
 * abort-only included — refuses whole feature-families categorically (management-path / listener /
 * user / persistence commands), because an aborted session defers config *by policy belief*, and a
 * command that answers despite that belief on a **production-adjacent switch** must have been refused
 * before it was ever staged. That reasoning is the same one DR-035(c) applies to `copy run start` on a
 * container; here the blast radius is somebody's up-and-running switch.
 *
 * Browser-safe (no `node:*`): the fs half of the writes lives in `recorder-node.ts`, exactly like the
 * lab lane's split, so nothing here can widen the `./testing` browser surface.
 */

import { assertNoPersistenceCommand } from './live-guard'
import { targetSlug, type DeviceIdentity, type RecordingCapture, type RecordingFixture } from './recording'
import type { CommandSpec } from '../types/eapi'

/** The scenario half of every batch-1 case name (docs/TESTING.md:113-114: `<command>--<scenario>`). */
export const HW_INVENTORY_SCENARIO = 'hw-inventory' as const
/** Scenario for the `format:'text'` companion captures (same spelling the lab fixtures use: `--text`). */
export const HW_TEXT_SCENARIO = 'hw-text' as const
/** Scenario for a reviewed config-session probe recorded from the switch. */
export const HW_SESSION_SCENARIO = 'hw-session-probe' as const

/** One catalog entry: the exact CLI string to run, and how its case is encoded. */
export interface HwCatalogEntry {
  readonly cmd: string
  /**
   * `true` for commands that are **not** expected to answer JSON on this platform either — recorded
   * once each way is fine, but they default to the text encoding so a negative is still captured,
   * not thrown away as "unconverted".
   */
  readonly textPreferred?: boolean | undefined
  /** Skip the JSON attempt entirely (bare sub-mode parents the CLI only answers in text). */
  readonly textOnly?: boolean | undefined
  /** Non-default scenario suffix for the case name (e.g. `text` → `show-version--hw-text`). */
  readonly scenario?: string | undefined
}

/**
 * The batch-1 read-only inventory for the 7050TX-64: every command the cEOS lane answers today, so
 * each capture has a cross-target twin whose *difference* is the hardware discovery, plus the §3
 * target-sensitive shows the container can never settle (licensing, TCAM, LAG resources, inventory,
 * environment) and the `http-commands … https certificate` read the sweep needs to pin the device cert.
 *
 * Case names come from {@link hwCaseName}, so parity with the lab fixtures is mechanical, and the
 * ordering is the run order: identity first (`show version`) because every later file is filed under
 * the slug it derives.
 */
export const HW_INVENTORY_CATALOG: readonly HwCatalogEntry[] = [
  // --- identity + environment (the lane's own precedence: slug derivation first) ---
  { cmd: 'show version' },
  { cmd: 'show version detail' },
  { cmd: 'show inventory' },
  { cmd: 'show systems' },
  { cmd: 'show environment' },
  { cmd: 'show environment power' },
  { cmd: 'show environment temperature' },
  { cmd: 'show environment cooling' },
  { cmd: 'show environment last' },
  // --- target-sensitive questions from STATUS.md §3 ---
  { cmd: 'show license features' },
  { cmd: 'show license all' },
  { cmd: 'show hardware tcam' },
  { cmd: 'show hardware tcam profile' },
  { cmd: 'show lag resources' },
  // --- listener/management surface (DR-013/DR-043: the cert to pin comes from here) ---
  { cmd: 'show management api http-commands' },
  { cmd: 'show management api http-commands https certificate' },
  // --- configured-state families mirrored 1:1 from the cEOS capture set ---
  { cmd: 'show configuration sessions' },
  { cmd: 'show configuration sessions detail' },
  { cmd: 'show interfaces' },
  { cmd: 'show interfaces status' },
  { cmd: 'show interfaces switchport' },
  { cmd: 'show interfaces trunk' },
  { cmd: 'show ip access-lists' },
  { cmd: 'show ip interface brief' },
  { cmd: 'show ip route' },
  { cmd: 'show lldp neighbors' },
  { cmd: 'show mlag' },
  { cmd: 'show mlag detail' },
  { cmd: 'show ntp status' },
  { cmd: 'show ntp associations' },
  { cmd: 'show port-channel dense' },
  { cmd: 'show port-channel detail' },
  { cmd: 'show spanning-tree' },
  { cmd: 'show spanning-tree detail' },
  { cmd: 'show vlan' },
  { cmd: 'show vrf' },
  { cmd: 'show vrrp' },
  { cmd: 'show running-config' },
  { cmd: 'show running-config all' },
  { cmd: 'show startup-config' },
  // --- text twins for the models whose §3 question is partly about rendering ---
  { cmd: 'show version', scenario: 'text', textOnly: true },
  { cmd: 'show interfaces status', scenario: 'text', textOnly: true },
  { cmd: 'show management api http-commands', scenario: 'text', textOnly: true },
  { cmd: 'show running-config', scenario: 'text', textOnly: true },
] as const

/**
 * The recording case name for a catalog entry: `show-interfaces-status--hw-inventory`, mirroring the
 * lab fixture spelling (`test/fixtures/live/ceos-4.28.14M/show-interfaces-status.json`) so a reviewer
 * can diff the two lanes file-for-file.
 */
export function hwCaseName(cmd: string, scenario: string = HW_INVENTORY_SCENARIO): string {
  const commandPart = cmd
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (commandPart === '') throw new Error(`hwCaseName: ${JSON.stringify(cmd)} has no name-safe characters`)
  return `${commandPart}--${scenario}`
}

/** Envelope identity for a hardware capture, built from the device's OWN `show version` strings. */
export function hwDeviceIdentity(reported: { version: string; modelName: string }, opts: { image?: string | undefined; topology?: string | undefined } = {}): DeviceIdentity {
  return {
    modelName: reported.modelName,
    version: reported.version,
    targetClass: 'hardware',
    slug: targetSlug(reported.modelName, reported.version, 'hardware'),
    ...(opts.image === undefined ? {} : { image: opts.image }),
    ...(opts.topology === undefined ? {} : { topology: opts.topology }),
    provenance: 'captured',
  }
}

// --- hardware redaction ---------------------------------------------------------------------------------

/** Zero placeholder written for every MAC the scrubber rewrites (the lab lane's existing constant). */
export const HW_ZEROED_MAC = '00:00:00:00:00:00'

/** The MAC-shaped string, bare-token form: exact whole values get zeroed, substrings get replaced. */
const MAC_EXACT = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/u
const MAC_EMBEDDED = /([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/gu

/** `secret sha512 <hash>` / `secret md5 <hash>` — one rule that matches running/startup config text. */
const SECRET_MATERIAL = /\bsecret\s+(sha512|md5)\s+\S+/giu
/** PEM armour (the device-cert read carries the body; the fingerprint in the §3 checklist is what gets pinned). */
const PEM_BLOCK = /-----BEGIN[A-Z ]*-----[\s\S]*?-----END[A-Z ]*-----/giu
/** Token values that *look like* serials when the key name does not say so (e.g. a positional list). */
const SERIAL_VALUE = /^[A-Z]\d{2}\d{6}[A-Z]?$|^[A-Z0-9]{9,17}$/u
/** Which string values are too serial-shaped to keep: only rewritten under a serial-named key's sibling. */
const SERIAL_KEY_HINT = /serial/iu

export interface HwRedactOptions {
  /** Operator-supplied literals (hostname, mgmt address, lab domain…): every occurrence is replaced. */
  readonly extraSecrets?: readonly string[] | undefined
}

/** What the scrubber changed: JSONPath-ish locations + rule name. Never contains the secret value. */
export interface HwRedactionLogEntry {
  readonly path: string
  readonly rule: 'mac' | 'secret' | 'pem' | 'serial' | 'extra'
}

export interface HwRedactionResult {
  readonly value: unknown
  readonly log: readonly HwRedactionLogEntry[]
}

const REPLACEMENTS: Readonly<Record<HwRedactionLogEntry['rule'], string>> = {
  mac: HW_ZEROED_MAC,
  secret: '<hw-redacted-secret>',
  pem: '<hw-redacted-pem>',
  serial: '<hw-redacted-serial>',
  extra: '<hw-redacted>',
}

/**
 * The rule chain applied to ONE string, shared by the value walk and the **key** walk (DR-133).
 * `keyHint` gates the serial rule; `path` is what lands in the log, and callers must keep the log
 * itself secret-free — a raw device-config line can BE a key, so a value path is built from the
 * already-scrubbed key, never the raw one.
 */
function redactHwString(value: string, opts: HwRedactOptions, keyHint: string | undefined, path: string, sink: HwRedactionLogEntry[]): string {
  const extras = (opts.extraSecrets ?? []).filter((entry) => entry !== '')
  let out = value
  const isSerialContext = keyHint !== undefined && SERIAL_KEY_HINT.test(keyHint)
  if (isSerialContext && out !== '' && SERIAL_VALUE.test(out)) {
    sink.push({ path, rule: 'serial' })
    out = REPLACEMENTS.serial
  }
  if (SECRET_MATERIAL.test(out)) {
    SECRET_MATERIAL.lastIndex = 0
    sink.push({ path, rule: 'secret' })
    out = out.replace(SECRET_MATERIAL, (match) => match.replace(/\s+\S+$/u, ` ${REPLACEMENTS.secret}`))
  }
  if (PEM_BLOCK.test(out)) {
    PEM_BLOCK.lastIndex = 0
    sink.push({ path, rule: 'pem' })
    out = out.replace(PEM_BLOCK, REPLACEMENTS.pem)
  }
  PEM_BLOCK.lastIndex = 0
  if (MAC_EXACT.test(out)) {
    sink.push({ path, rule: 'mac' })
    out = HW_ZEROED_MAC
  } else if (MAC_EMBEDDED.test(out)) {
    MAC_EMBEDDED.lastIndex = 0
    sink.push({ path, rule: 'mac' })
    out = out.replace(MAC_EMBEDDED, HW_ZEROED_MAC)
  }
  MAC_EMBEDDED.lastIndex = 0
  for (const secret of extras) {
    if (out.includes(secret)) {
      sink.push({ path, rule: 'extra' })
      out = out.split(secret).join(REPLACEMENTS.extra)
    }
  }
  return out
}

/**
 * Walk a parsed device reply (or the text half) and rewrite anything a real switch leaks but a
 * container does not — **strings in value position and object keys alike** (DR-133: the JSON
 * `show running-config` carries each config line as a key, and the first executed hardware capture
 * leaked a live `secret sha512` hash that way). Key-hints matter: MACs zero wherever the *value
 * itself* is MAC-shaped (whole or embedded), serials only under serial-named keys (or exact values
 * that are 9-17 alphanumerics with a serial key sibling — deliberately narrow, so route targets and
 * interfaces are never touched). Each rule names itself in the log; the secret text never does.
 */
export function redactHwValue(value: unknown, opts: HwRedactOptions, path = '$', keyHint?: string, log?: HwRedactionLogEntry[]): HwRedactionResult {
  const sink = log ?? []

  if (typeof value === 'string') {
    return { value: redactHwString(value, opts, keyHint, path, sink), log: sink }
  }

  if (Array.isArray(value)) {
    const rewritten = value.map((entry, index) => redactHwValue(entry, opts, `${path}[${String(index)}]`, undefined, sink).value)
    return { value: rewritten, log: sink }
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    // DR-133: KEYS go through the same chain. `show running-config`/`… all` in JSON form answer a
    // `cmds` object keyed by the config LINE itself — first executed hardware capture (2026-11-08)
    // proved a live `username … secret sha512 $6$…` hash surviving as a key while the identical rule
    // fired on the text-form capture. The serial rule still gates on the (scrubbed) key name.
    const used = new Set<string>()
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const safeKey = key === '' ? key : redactHwString(key, opts, key, `${path}.[key]`, sink)
      let unique = safeKey
      if (used.has(unique)) {
        // A scrub can collide two lines onto one key (the device's own map was unique); collision may
        // never cost an entry — keep both, visibly (the lab lane's rule, adopted here).
        let n = 1
        while (used.has(`${unique} #${String(n)}`)) n += 1
        unique = `${unique} #${String(n)}`
      }
      used.add(unique)
      // The VALUE path rides the scrubbed key: the log stays secret-free even when the raw key was
      // the secret-bearing line.
      out[unique] = redactHwValue(entry, opts, `${path}.${unique}`, key, sink).value
    }
    return { value: out, log: sink }
  }

  return { value, log: sink }
}

export interface SanitizedRecording {
  readonly fixture: RecordingFixture
  readonly log: readonly HwRedactionLogEntry[]
}

/** Identity fields that must stay verbatim: envelope↔directory agreement and replay matching read them. */
const IDENTITY_MATCH_FIELDS: readonly string[] = ['targetSlug', 'modelName', 'aristaVersion', 'versionNumber', 'targetClass', 'provenance']

/**
 * Apply {@link redactHwValue} to every replayable part of a built recording (parsed replies, command
 * text, raw bodies — **keys and values**, DR-133), preserving the recorder's own guarantees (`format`,
 * `requestId`, arrival order). The identity envelope's free-text fields (`endpoint`, `topology`,
 * `image`) get the same string chain: on the hardware lane the endpoint carries the switch's real
 * management address, and a literal configured in `EAPI_HW_SCRUB` scrubbing inside captures but not in
 * every file's envelope is the same leak class as the key-position secret (TESTING.md:131: redact
 * identifying data as well as credentials). The matching fields ({@link IDENTITY_MATCH_FIELDS}) stay
 * verbatim — they are the device's honest words, and `assertFixtureIdentity`/`loadRecordingFor` read
 * them.
 *
 * `commands[].input` is deliberately **not** rewritten beyond the base redactor's reach: an enable input
 * that is not already `REDACTED` fails the write at `recordingText` (`findUnredactedEnableInput`), which
 * is a louder failure than silently rewriting a staged credential here.
 */
export function sanitizeHwRecording(fixture: RecordingFixture, opts: HwRedactOptions = {}): SanitizedRecording {
  const log: HwRedactionLogEntry[] = []
  const captures: RecordingCapture[] = fixture.captures.map((capture, captureIndex) => {
    const base = `$[captures][${String(captureIndex)}]`
    const commands: CommandSpec[] = capture.commands.map((command, commandIndex) => {
      if (typeof command === 'string') {
        return redactHwValue(command, opts, `${base}.commands[${String(commandIndex)}]`, undefined, log).value as string
      }
      const cmd = redactHwValue(command.cmd, opts, `${base}.commands[${String(commandIndex)}].cmd`, undefined, log).value as string
      return { ...command, cmd }
    })
    const result = capture.result === undefined ? undefined : (redactHwValue(capture.result, opts, `${base}.result`, undefined, log).value as RecordingCapture['result'])
    const raw = capture.raw === undefined ? undefined : (redactHwValue(capture.raw, opts, `${base}.raw`, undefined, log).value as string)
    const error = capture.error === undefined ? undefined : ({ ...capture.error, message: redactHwValue(capture.error.message, opts, `${base}.error.message`, undefined, log).value as string })
    return { ...capture, commands, ...(result === undefined ? {} : { result }), ...(raw === undefined ? {} : { raw }), ...(error === undefined ? {} : { error }) }
  })
  const identity: Record<string, unknown> = { ...fixture.identity }
  for (const [key, entry] of Object.entries(identity)) {
    if (IDENTITY_MATCH_FIELDS.includes(key)) continue
    if (typeof entry === 'string') identity[key] = redactHwString(entry, opts, key, `$.identity.${key}`, log)
  }
  return { fixture: { ...fixture, identity: identity as unknown as RecordingFixture['identity'], captures }, log }
}

// --- session-probe policy -------------------------------------------------------------------------------

/**
 * One reviewed config-session probe batch, as committed in a spec file *before* the switch session
 * happens (the user reviews the PR of the draft, not a live editor).
 */
export interface HwProbeBatch {
  /** Batch label; goes into the session name `hw-probe-<name>` and the case name. */
  readonly name: string
  /** What the probe is asking the device (printed, for the operator record). */
  readonly question: string
  /** Staging lines in apply order; `{{SCRATCH}}` is substituted with the declared scratch interface. */
  readonly commands: readonly string[]
  /**
   * The reviewed mutation decision. `false` ⇒ the harness aborts after capturing `show session-config
   * diffs`; `true` ⇒ only legal when **every** command names the scratch interface (below, enforced).
   */
  readonly allowCommit: boolean
}

export interface HwProbeSpec {
  readonly batches: readonly HwProbeBatch[]
}

const SCRATCH_TOKEN = '{{SCRATCH}}'
/**
 * Refused everywhere on the hardware lane regardless of commit state — the categories whose failure
 * mode is "the connection or the box itself changes under us" (DR-035 docs/CEOS.md:131 keeps the
 * management path out of every test write, and per the user's locked decision a switch session never
 * touches users, the listener, ZTP, or persistence).
 */
const HW_PROBE_FORBIDDEN: readonly { re: RegExp; why: string }[] = [
  { re: /management\s+api\s+http-commands/iu, why: 'the eAPI listener itself — turning it off ends the capture session and is a §2 bootstrap concern, not a probe' },
  { re: /\busername\b/iu, why: 'user/credential changes are forbidden on the switch lane (locked decision: read-only + one scratch interface)' },
  { re: /\binterface\s+management|(^|[\s,])management\d/iu, why: 'the management path is off-limits for writes (docs/CEOS.md:131) — the very interface the capture session is connected through' },
  { re: /\bztp\b/iu, why: 'ZTP state belongs to §2 bootstrap, not to a probe' },
  { re: /\brollback\b/iu, why: 'rollback semantics are sweep questions to be OBSERVED (STATUS.md §3), never induced on somebody\'s running switch' },
  { re: /\bconfigure\s+replace\b/iu, why: 'whole-config replace is a whole-box blast radius' },
]

/** Parse + validate a probe spec's JSON text. Every refusal names the batch and command at fault. */
export function parseHwProbeSpec(text: string): HwProbeSpec {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`hw probe spec is not valid JSON: ${(err as Error).message}`)
  }
  const rawBatches = (data as { batches?: unknown }).batches
  if (!Array.isArray(rawBatches) || rawBatches.length === 0) {
    throw new Error('hw probe spec needs a non-empty `batches` array')
  }
  const batches: HwProbeBatch[] = rawBatches.map((entry, index) => {
    const batch = entry as Partial<HwProbeBatch>
    const where = `batches[${String(index)}]`
    if (typeof batch.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(batch.name)) {
      throw new Error(`${where}.name must match /^[a-z0-9][a-z0-9-]{0,39}$/u (it becomes a config-session name segment), got ${JSON.stringify(batch.name)}`)
    }
    if (typeof batch.question !== 'string' || batch.question.trim() === '') throw new Error(`${where}.question is required — an unexplained write on a physical switch cannot be reviewed`)
    if (!Array.isArray(batch.commands) || batch.commands.length === 0) throw new Error(`${where}.commands must be a non-empty list of staging lines`)
    const cmds = batch.commands.map((cmd, cmdIndex) => {
      if (typeof cmd !== 'string' || cmd.trim() === '') throw new Error(`${where}.commands[${String(cmdIndex)}] must be a non-empty string`)
      for (const rule of HW_PROBE_FORBIDDEN) {
        if (rule.re.test(cmd)) throw new Error(`${where}.commands[${String(cmdIndex)}] is refused on the hardware probe lane (${rule.why}): the line is not echoed beyond its first word`)
      }
      return cmd
    })
    const persistence = assertNoPersistenceCommand(cmds)
    if (persistence !== undefined) throw new Error(`${where}.commands contains a persistence line — ${persistence.reason}`)
    const allowCommit = batch.allowCommit === true
    if (allowCommit) {
      // The mechanical scope fence for a committed hardware write (locked decision: the ONE designated
      // unused interface): the batch must open with exactly `interface {{SCRATCH}}` and every other
      // line must be an indented child of that context — so no second feature context can be entered,
      // and no global-config line can ride along. Human review of the spec is the second layer; this
      // is the layer that cannot be fat-fingered at the switch console.
      const opener = /^interface\s+\{\{SCRATCH\}\}\s*$/iu
      if (!opener.test(cmds[0] ?? '')) {
        throw new Error(`${where} is allowCommit but does not open with exactly \`interface ${SCRATCH_TOKEN}\` — a committed hardware write is bounded to the designated scratch interface (locked decision, DR-035(b) made physical)`)
      }
      for (const [i, cmd] of cmds.entries()) {
        if (i === 0) continue
        if (!/^[ \t]/u.test(cmd) || /^(?:exit|end|configure|interface)\b/iu.test(cmd.trim())) {
          throw new Error(`${where}.commands[${String(i)}] leaves the scratch-interface context (${JSON.stringify(cmd.split(/\s+/u)[0])} — only indented children of the opener may be committed on the hardware lane)`)
        }
      }
    }
    if (!allowCommit) return { name: batch.name, question: batch.question, commands: cmds, allowCommit: false }
    return { name: batch.name, question: batch.question, commands: cmds, allowCommit: true }
  })
  const names = new Set(batches.map((batch) => batch.name))
  if (names.size !== batches.length) throw new Error('hw probe spec has duplicate batch names — case names would collide in the recordings tree')
  return { batches }
}

/** Substitute the scratch-interface token after the guard has accepted the name. */
export function resolveHwScratchToken(commands: readonly string[], scratchInterface: string): readonly string[] {
  if (scratchInterface === '') throw new Error('resolveHwScratchToken needs a non-empty interface name')
  return commands.map((cmd) => cmd.split(SCRATCH_TOKEN).join(scratchInterface))
}

/** The case name for one probe batch (its staged commands and captures live in this recording). */
export function hwProbeCaseName(batchName: string): string {
  return `configure-session-${batchName}--${HW_SESSION_SCENARIO}`
}

/**
 * The command the probe harness uses to read back the scratch interface after a COMMIT batch.
 *
 * The keyword is **plural** — `interfaces` — and that is device-verified, not a style choice. The
 * 2026-11-08 supervised run wrote a committed `description` on the scratch port and then died on the
 * singular spelling: the SKU answers `show running-config interface Ethernet22` with
 * `% Incomplete token (at token 2: 'interface')` (1002). Arista's own system suite uses the plural
 * form throughout (`pyeapi/test/system/test_api_interfaces.py:202,:239,:283`,
 * `test_api_ipinterfaces.py:78`, `test_api_switchports.py:77`), and this client already models the
 * plural keyword elsewhere (`live-interfaces.live.test.ts` maps upstream's text reads to it).
 * Keeping the spelling next to the parser that reviews the spec means a future run card cannot
 * re-introduce the singular form by hand.
 */
export function hwScratchReadBackCommand(scratchInterface: string): string {
  if (scratchInterface === '') throw new Error('hwScratchReadBackCommand needs a non-empty interface name')
  return `show running-config interfaces ${scratchInterface}`
}

/**
 * Resumability filter for a partially completed switch day (`EAPI_HW_PROBE_ONLY`).
 *
 * A probe run mutates: once a commit batch has committed, replaying the whole spec from the top
 * re-answers questions with a now-dirty port (and after the DR-135 crash the run had *already
 * committed* `scratch-description` four batches before the loop died). So the operator must be able
 * to name the remaining batches instead. An unknown name is a refusal, never a silent no-op —
 * skipping the batch you meant to run, on a physical switch, is how a half-restored port happens.
 */
export function selectHwProbeBatches(batches: readonly HwProbeBatch[], filter: string | undefined): readonly HwProbeBatch[] {
  if (filter === undefined || filter.trim() === '') return batches
  const wanted = filter
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (wanted.length === 0) return batches
  const known = new Set(batches.map((batch) => batch.name))
  const unknown = wanted.filter((name) => !known.has(name))
  if (unknown.length > 0) {
    throw new Error(`hw-session-probe: EAPI_HW_PROBE_ONLY names batch(es) the reviewed spec does not have: ${unknown.join(', ')} — known batches: ${[...known].join(', ')}`)
  }
  const selected = batches.filter((batch) => wanted.includes(batch.name))
  // Keep the spec's order (restore-last discipline) regardless of how the filter was typed.
  return selected
}
