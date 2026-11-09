/**
 * F8 (#70): the credentials / artifact contract for this app, expressed as an executable guard
 * instead of folklore the next session has to remember.
 *
 * Credentials never enter the browser today: `arista-webui/vite.config.ts` injects
 * `Authorization: Basic …` **server-side** and the app only sees the build-time boolean
 * `__EAPI_PROXY_CONFIGURED__`. That is the correct design and this file does not touch it. The leak
 * surface is the other side of the same fact: once screens multiply, the material a test commits —
 * scripted device answers, capture payloads pasted into a `*.test.tsx`, and (once #91 lands)
 * Playwright traces/HAR/videos — is what can quietly carry a switch's identity or an `enable` secret.
 *
 * ## The four rules, and why each is shaped the way it is
 *
 * | rule | catches | deliberate limit |
 * | --- | --- | --- |
 * | `mac` | a MAC whose **device-assigned half** is non-zero | Arista's own OUI with a zeroed host part (`00:1c:73:00:00:00`, the cEOS-shaped identity fixture in `src/shared/identity.test.ts`) is what the capture redaction *produces*, so it is honest, not a leak. A MAC with both halves real names one box. |
 * | `serial` | `…serial… : "<value>"` where the value is neither empty nor zeroed | `serialNumber: '0000000000'` / `''` are the two redacted forms in the recorded captures (DR-011); a serial is the one field that ties a config to a physical unit. |
 * | `enable-input` | an `enable` command spec carrying an `input` that is not this package's `REDACTED` marker — inline in a fixture, in a parsed JSON body, or in raw wire text | reuses the client's own detector (`findUnredactedEnableInput`, `src/testing/recording.ts`) rather than re-deriving the grammar: `enable` is the only command whose `input` is a password (`src/internal/redact.ts:50`), so that helper is the authority on what "unredacted" means. |
 * | `credential` | `EAPI_PASS=…` / `password: …` with a value outside the documented placeholders | placeholders are named here, and only here: `never-sent` (the M0 consumer test) and `replace-with-a-lab-only-password` (the README's `.env.local` template). A fourth value means either a real secret or a new convention someone forgot to write down — both belong in review. |
 *
 * ## Exemptions are an allow-list, not an escape hatch
 *
 * A file is skipped only when its text carries {@link SCAN_EXEMPT_MARKER}. That is meant for the
 * guard's **own** spec, which has to spell synthetic secrets to prove each rule fires — the same
 * discipline as the client's `node-session-journal` allow-list (DR-011). `redaction-guard.test.ts`
 * pins the exemption set, so a new exempted file cannot land quietly.
 *
 * ## What this guard is NOT
 *
 * It is not a runtime secret handler (the browser correctly has none), not a proxy-auth change, and
 * not the live-run redaction harness — write-time enforcement stays client-side in
 * `arista-api-client/src/testing/recording*`. Offline rule respected: nothing here opens a socket.
 */
import { REDACTED } from '@devhax-heavy-industries/arista-eapi'
import { findUnredactedEnableInput } from '@devhax-heavy-industries/arista-eapi/testing'

/** Which rule produced a finding — the README contract's four clauses, minus the behavioural ones. */
export type GuardRule = 'credential' | 'enable-input' | 'mac' | 'serial'

export interface GuardFinding {
  readonly rule: GuardRule
  /** Caller-labelled source of the text (a repo-relative path, or a synthetic name like `wire-body[0]`). */
  readonly file: string
  /** The offending token and how it was found — enough to fix it without dumping a whole fixture. */
  readonly detail: string
}

/** One committed file as the guard sees it: a label plus its raw text. */
export interface ScannedFile {
  readonly path: string
  readonly text: string
}

/** Presence of this string in a file's text is the ONLY thing that skips it (see the header). */
export const SCAN_EXEMPT_MARKER = 'redaction-scan-exempt'

/** Values a credential slot may legally hold in committed source — the placeholders the README names. */
export const PLACEHOLDER_SECRETS: readonly string[] = [
  REDACTED,
  'never-sent',
  'replace-with-a-lab-only-password',
  // An empty assignment asserts "this field exists and is empty", which carries no secret.
  '',
]

/** A MAC is treated as redacted when its device-assigned (last three octets) half is all zeros. */
const REDACTED_MAC_HOST_HALF = '000000'

// `aa:bb:cc:dd:ee:ff` / `aa-bb-cc-dd-ee-ff`, token-anchored on both sides. The anchoring is what keeps
// the rule quiet on the hex that legitimately lives in a capture — an image digest, a
// `sha256:`-prefixed id, or a UUID-shaped build id (`9ce2494c-255b-4104-b282-…`) — none of which is a
// device identity, and a rule that screamed at those would be turned off within a milestone.
const MAC_COLON_OR_DASH = /(?<![0-9a-fA-F:.-])(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}(?![0-9a-fA-F:.-])/gu
// Cisco dotted form `aabb.ccdd.eeff`, in case a capture ever spells a MAC that way. Same anchoring, so
// a decimal timestamp (`1794237292.719755`) or a version string cannot read as one.
const MAC_DOTTED_TRIPLET = /(?<![0-9a-fA-F.])[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}(?![0-9a-fA-F.])/gu

/**
 * A key that mentions `serial`, assigned a quoted string value. The key quote is optional so the rule
 * covers both spellings a fixture can take — the TS object form (`serialNumber: '…'`) and the JSON
 * form (`"serialNumber": "…"`). A type declaration carries no quoted value, so it never matches.
 */
const SERIAL_ASSIGNMENT = /(["']?)([A-Za-z0-9_]*serial[A-Za-z0-9_]*)\1\s*[:=]\s*(["'])\s*([^"']*)\s*\3/giu

/**
 * The credential spellings a committed file may not carry a real value for. `enablePassword` comes
 * first so the longer key wins the alternation (a bare `password` inside it must not report the tail
 * of a key the leading-context guard would otherwise refuse to match).
 */
const CREDENTIAL_ASSIGNMENT = /(?:^|[^\w.])["']?(enablePassword|EAPI_PASS|EAPI_PASSWORD|password|passwd|passcode)["']?\s*[:=]\s*(["']?)\s*([^"'\s,;)}\]]*)\2/giu

/** An inline `enable` command spec with an `input`, in either property order — the fixture-shaped case the client's text pass cannot see. */
const ENABLE_SPEC_CMD_THEN_INPUT = /\bcmd\s*:\s*(["'])enable\1\s*,\s*\binput\s*:\s*(["'])\s*([^"']*)\s*\2/giu
const ENABLE_SPEC_INPUT_THEN_CMD = /\binput\s*:\s*(["'])\s*([^"']*)\s*\1\s*,\s*\bcmd\s*:\s*(["'])enable\3/giu

const toHex = (token: string): string => token.replace(/[^0-9a-fA-F]/gu, '').toLowerCase()
const isZeroedHostHalf = (token: string): boolean => toHex(token).slice(-6) === REDACTED_MAC_HOST_HALF
const isPlaceholderSecret = (value: string): boolean => PLACEHOLDER_SECRETS.includes(value)

/** Rule `mac`: every MAC-shaped token whose host half is not zeroed. */
export function findUnredactedMacs(text: string): readonly string[] {
  const hits = new Set<string>()
  for (const pattern of [MAC_COLON_OR_DASH, MAC_DOTTED_TRIPLET]) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0]
      if (!isZeroedHostHalf(token)) hits.add(token)
    }
  }
  return [...hits]
}

/** Rule `serial`: every `…serial…`-named key holding a value that is neither empty nor all zeros. */
export function findUnredactedSerials(text: string): readonly string[] {
  const hits: string[] = []
  for (const match of text.matchAll(SERIAL_ASSIGNMENT)) {
    const key = match[2] ?? 'serial'
    const value = match[4] ?? ''
    if (value === '' || /^0+$/u.test(value) || isPlaceholderSecret(value)) continue
    hits.push(`${key}=${value}`)
  }
  return hits
}

/** Rule `credential`: every credential assignment whose value is not a documented placeholder. */
export function findUnredactedCredentials(text: string): readonly string[] {
  const hits: string[] = []
  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
    const [, key = 'password', , value = ''] = match
    if (isPlaceholderSecret(value)) continue
    hits.push(`${key}=${String(value)}`)
  }
  return hits
}

/**
 * Rule `enable-input`, text half. The client helper covers raw wire text (`input=<value>` as EOS
 * renders it) and any JSON-looking string; the two patterns above add the inline-object spelling a
 * TypeScript fixture uses, which is not wire text and not parseable JSON.
 */
export function findUnredactedEnableInputs(text: string): readonly string[] {
  const hits = findUnredactedEnableInput(text)
  for (const match of text.matchAll(ENABLE_SPEC_CMD_THEN_INPUT)) {
    const value = match[3]
    if (value !== undefined && value !== REDACTED) hits.push(`inline enable spec (input=${value})`)
  }
  for (const match of text.matchAll(ENABLE_SPEC_INPUT_THEN_CMD)) {
    const value = match[2]
    if (value !== undefined && value !== REDACTED) hits.push(`inline enable spec (input=${value})`)
  }
  return hits
}

/** Every finding for one body of text. `file` labels the result rows. */
export function scanText(file: string, text: string): readonly GuardFinding[] {
  const findings: GuardFinding[] = []
  for (const token of findUnredactedMacs(text)) findings.push({ rule: 'mac', file, detail: `MAC with a non-zero host half: ${token} — capture redaction zeroes the device-assigned half (DR-011); this names one physical unit.` })
  for (const token of findUnredactedSerials(text)) findings.push({ rule: 'serial', file, detail: `serial-bearing value committed verbatim: ${token}` })
  for (const token of findUnredactedCredentials(text)) findings.push({ rule: 'credential', file, detail: `credential assignment outside the placeholder list: ${token}` })
  for (const token of findUnredactedEnableInputs(text)) findings.push({ rule: 'enable-input', file, detail: `unredacted enable secret at ${token}` })
  return findings
}

/**
 * Every finding for one **live value** (a parsed fixture, or a `MockTransport#bodies()` entry — the
 * un-redacted seam contract (c) warns about). Structural, so it sees `{ cmd: 'enable', input: … }`
 * objects that text scanning would miss.
 */
export function scanValue(file: string, value: unknown): readonly GuardFinding[] {
  return findUnredactedEnableInput(value).map((location) => ({ rule: 'enable-input' as const, file, detail: `unredacted enable secret at ${location}` }))
}

/**
 * The guard entry point: scan the committed files a test handed in, skipping only the allow-listed
 * ones. Returns findings rather than throwing so the test can print every offender at once.
 */
export function scanFixtureFiles(files: readonly ScannedFile[]): readonly GuardFinding[] {
  const findings: GuardFinding[] = []
  for (const { path, text } of files) {
    // The only skip rule in the guard, and it is marker-based, not path-based, so an exemption has to
    // be written down somewhere a reviewer can see. `redaction-guard.test.ts` pins that this corpus
    // carries no other marked file.
    if (text.includes(SCAN_EXEMPT_MARKER)) continue
    // One pass over the bytes: `findUnredactedEnableInput` parses a JSON-looking **string** and walks
    // the result, so a `.json` fixture needs no separate structural call — and running both would
    // report the same secret twice.
    findings.push(...scanText(path, text))
  }
  return findings
}
