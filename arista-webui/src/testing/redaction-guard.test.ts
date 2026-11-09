/**
 * F8 (#70): the credentials / artifact contract as a test.
 *
 * This file deliberately spells **synthetic** secrets to prove each rule fires, so it is the one
 * reviewed exemption from its own corpus: `SELF` below is filtered out of the scan set (Vite already
 * excludes the calling module from its own `import.meta.glob`; spelling the exclusion out keeps the
 * behaviour honest across resolver changes, and it is what an `EXEMPTIONS` entry would look like if a
 * second file ever needed one).
 *
 * Three layers, all offline (CAP-TESTING — the device half goes through the `./testing` seam):
 * 1. **rule unit tests** — each rule flags the thing it names and passes the redacted forms the
 *    repo's captures actually produce;
 * 2. **a permanent mutation control** — `scanFixtureFiles` over a synthetic bad payload must report,
 *    so the tree scan in layer 3 can never drift into vacuity;
 * 3. **the tree scan** — every committed payload in this app (anything under a `fixtures` directory,
 *    every `.json` in `src`, and every test source, because an inline `show …` literal pasted into a
 *    component test IS a fixture — contract (b)) must scan clean.
 */
import { describe, expect, it } from 'vitest'
import { REDACTED, redactCommands } from '@devhax-heavy-industries/arista-eapi'
import { createFakeNode } from '@devhax-heavy-industries/arista-eapi/testing'

import {
  findUnredactedCredentials,
  findUnredactedEnableInputs,
  findUnredactedMacs,
  findUnredactedSerials,
  SCAN_EXEMPT_MARKER,
  scanFixtureFiles,
  scanText,
  scanValue,
} from './redaction-guard'
import type { ScannedFile } from './redaction-guard'

// Synthetic stand-ins. A lab-shaped MAC with a non-zero device half, a non-zero serial, and an enable
// secret — none of them real, all of them the shape the guard refuses to see committed (DR-011).
const REAL_SHAPED_MAC = '00:1c:73:de:ad:be'
const REAL_SHAPED_SERIAL = 'SN3162372U'
const SYNTHETIC_ENABLE = 'enable-secret-not-a-real-one'

/** This file, by the label the scan set uses. The only reviewed exemption, and it has no marker to carry. */
const SELF = 'src/testing/redaction-guard.test.ts'

/** Paths (beyond `SELF`) allowed to carry `SCAN_EXEMPT_MARKER`. Adding one here is a review decision. */
const EXEMPTIONS: readonly string[] = []

/** The fixture that documents the convention, and the clean example the tree scan is checked against. */
const CLEAN_FIXTURE_PATH = 'src/testing/fixtures/show-version--ceos-4.28.14M.json'

// Root-relative patterns (project root = this workspace), so every label is a repo-openable path.
const fixtureFiles = import.meta.glob('/src/**/fixtures/**/*.{json,txt,text}', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const jsonFiles = import.meta.glob('/src/**/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const testSources = import.meta.glob('/src/**/*.test.{ts,tsx}', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

const corpus: readonly ScannedFile[] = Object.entries({ ...fixtureFiles, ...jsonFiles, ...testSources })
  .map(([key, text]) => ({ path: key.replace(/^\//u, ''), text }))
  .filter((file) => file.path !== SELF)

describe('the mac rule (contract b: only already-redacted capture values)', () => {
  it('passes the two forms redaction actually produces', () => {
    expect(findUnredactedMacs("systemMacAddress: '00:00:00:00:00:00'")).toEqual([])
    // Arista's OUI with the device-assigned half zeroed — the identity-fixture shape in identity.test.ts.
    expect(findUnredactedMacs("systemMacAddress: '00:1c:73:00:00:00'")).toEqual([])
    expect(findUnredactedMacs('"configMacAddress": "00:00:00:00:00:00"')).toEqual([])
  })

  it('flags a MAC whose host half is real, in every separator style', () => {
    expect(findUnredactedMacs("systemMacAddress: '00:1c:73:de:ad:be'")).toEqual([REAL_SHAPED_MAC])
    expect(findUnredactedMacs('00-1c-73-de-ad-be')).toEqual(['00-1c-73-de-ad-be'])
    expect(findUnredactedMacs('001c.73de.adbe')).toEqual(['001c.73de.adbe'])
  })

  it('stays quiet on the hex that legitimately lives in a capture: digests, UUIDs, timestamps', () => {
    const legitimate = 'imageId sha256:8fd4e31caeba5db82d706eaed00252d67a1caa7d68670e5bd7e2af54935f2e26 fingerprint 8409DB215BBDB08FB0F3F31095E1F3BA internalBuildId 9ce2494c-255b-4104-b282-676994531323 bootupTimestamp 1794237292.719755 version 4.28.14M-50015774.42814M'
    expect(findUnredactedMacs(legitimate)).toEqual([])
  })
})

describe('the serial rule', () => {
  it('passes the redacted serial forms in both spellings', () => {
    expect(findUnredactedSerials("serialNumber: '0000000000'")).toEqual([])
    expect(findUnredactedSerials("serialNumber: ''")).toEqual([])
    expect(findUnredactedSerials('"serialNumber": ""')).toEqual([])
    expect(findUnredactedSerials(`serialNumber: '${REDACTED}'`)).toEqual([])
  })

  it('flags a serial spelled out, in TS and JSON form, and leaves a type declaration alone', () => {
    expect(findUnredactedSerials(`serialNumber: '${REAL_SHAPED_SERIAL}'`)).toEqual([`serialNumber=${REAL_SHAPED_SERIAL}`])
    expect(findUnredactedSerials(`{"serialNumber": "${REAL_SHAPED_SERIAL}"}`)).toEqual([`serialNumber=${REAL_SHAPED_SERIAL}`])
    expect(findUnredactedSerials('readonly serialNumber: string')).toEqual([])
  })
})

describe('the credential rule', () => {
  it('passes the documented placeholders', () => {
    expect(findUnredactedCredentials("password: 'never-sent'")).toEqual([])
    expect(findUnredactedCredentials('EAPI_PASS=replace-with-a-lab-only-password')).toEqual([])
    expect(findUnredactedCredentials('EAPI_PASS=')).toEqual([])
    expect(findUnredactedCredentials(`password: '${REDACTED}'`)).toEqual([])
  })

  it('flags a real value in an env line, a TS object, or a JSON body (incl. enablePassword)', () => {
    expect(findUnredactedCredentials('EAPI_PASS=S3cretLab')).toEqual(['EAPI_PASS=S3cretLab'])
    expect(findUnredactedCredentials("password: 'hunter2'")).toEqual(['password=hunter2'])
    expect(findUnredactedCredentials('{"password": "hunter2"}')).toEqual(['password=hunter2'])
    expect(findUnredactedCredentials("{ settings: { enablePassword: 'hunter2' } }")).toEqual(['enablePassword=hunter2'])
  })

  it('ignores the prose form of the env names', () => {
    expect(findUnredactedCredentials('Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.')).toEqual([])
  })
})

describe('the enable-input rule (contract c: the wire is the leak surface)', () => {
  it('flags an inline enable spec in either property order, but not a redacted one', () => {
    expect(findUnredactedEnableInputs(`{ cmd: 'enable', input: '${SYNTHETIC_ENABLE}' }`)).toEqual([`inline enable spec (input=${SYNTHETIC_ENABLE})`])
    expect(findUnredactedEnableInputs(`{ input: '${SYNTHETIC_ENABLE}', cmd: 'enable' }`)).toHaveLength(1)
    expect(findUnredactedEnableInputs(`{ cmd: 'enable', input: '${REDACTED}' }`)).toEqual([])
  })

  it('hands the wire shapes to the client detector instead of re-deriving them', () => {
    // EOS wire rendering (`input=<value>`), i.e. what a recorded request line looks like.
    expect(findUnredactedEnableInputs(`cmds: enable input=${SYNTHETIC_ENABLE}`)).toEqual([`$ (text: input=${SYNTHETIC_ENABLE})`])
    // A JSON-looking fixture: the helper parses and walks it, so no second rule is needed here.
    expect(findUnredactedEnableInputs(`[{"cmd":"enable","input":"${SYNTHETIC_ENABLE}"}]`)).toEqual(['$!json[0].input (cmd="enable")'])
    expect(scanValue('fixture.json', { params: { cmds: [{ cmd: 'enable', input: SYNTHETIC_ENABLE }] } })).toHaveLength(1)
    expect(scanValue('fixture.json', { params: { cmds: redactCommands([{ cmd: 'enable', input: SYNTHETIC_ENABLE }]) } })).toEqual([])
  })

  it('proves sent()/bodies() carry the enable secret un-redacted, so a secret-focused test asserts the detector (contract c)', async () => {
    const { node, transport } = createFakeNode(
      { replies: { 'show version': { version: '4.28.13.1M', systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64', serialNumber: '0000000000' } } },
      { settings: { enablePassword: SYNTHETIC_ENABLE } },
    )

    await node.show('version')

    // Both assertion surfaces hand back the enable `input` verbatim — which is exactly why the contract
    // forbids asserting/dumping their cleartext and points at the detector instead.
    expect(scanValue('transport.sent()', transport.sent())).toHaveLength(1)
    expect(scanValue('transport.bodies()', transport.bodies())).toHaveLength(1)
    // The same exchange after the client's own redaction pass is clean, so an artifact can be committed.
    expect(scanText('exchange.json', JSON.stringify({ cmds: redactCommands([{ cmd: 'enable', input: SYNTHETIC_ENABLE }]) }))).toEqual([])
  })
})

describe('scanFixtureFiles — the tree-scan mechanic itself', () => {
  it('reports every rule of one bad file and labels each finding with its file', () => {
    const findings = scanFixtureFiles([
      { path: 'src/demo/fixtures/bad.json', text: `{"systemMacAddress": "${REAL_SHAPED_MAC}", "serialNumber": "${REAL_SHAPED_SERIAL}", "cmds": [{"cmd":"enable","input":"${SYNTHETIC_ENABLE}"}]}` },
    ])
    expect(findings.map((finding) => finding.rule).sort()).toEqual(['enable-input', 'mac', 'serial'])
    expect(findings.every((finding) => finding.file === 'src/demo/fixtures/bad.json')).toBe(true)
  })

  it('skips only a file whose text carries the exemption marker', () => {
    const bad = `{ "systemMacAddress": "${REAL_SHAPED_MAC}" }`
    const files: readonly ScannedFile[] = [
      { path: 'a.json', text: bad },
      { path: 'b.json', text: `// ${SCAN_EXEMPT_MARKER} (reviewed: this file is the guard spec)\n${bad}` },
    ]
    const findings = scanFixtureFiles(files)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.file).toBe('a.json')
  })

  it('keeps the text pass on a malformed .json instead of losing the file', () => {
    const findings = scanFixtureFiles([{ path: 'broken.json', text: `{ "systemMacAddress": "${REAL_SHAPED_MAC}"` }])
    expect(findings.map((finding) => finding.rule)).toEqual(['mac'])
  })
})

describe('the committed webui payload tree is clean', () => {
  it('never scans an empty set — the corpus really does carry payload-shaped text', () => {
    expect(corpus.length).toBeGreaterThan(10)
    const joined = corpus.map((file) => file.text).join('\n')
    // The redacted forms show up often enough that a rule regressing to "flag everything" fails here.
    expect(joined.split('00:00:00:00:00:00').length - 1).toBeGreaterThanOrEqual(6)
    expect(joined.split('serialNumber').length - 1).toBeGreaterThanOrEqual(4)
    // The `fixtures/` half of the glob is live, not a promise: screen fixtures (#71+) are scanned the
    // moment they are committed, and this corpus already carries one.
    expect(corpus.filter((file) => file.path.includes('/fixtures/')).map((file) => file.path)).toEqual([CLEAN_FIXTURE_PATH])
  })

  it('the clean fixture passes every rule, so the guard does not flag the forms captures use', () => {
    const fixture = corpus.find((file) => file.path === CLEAN_FIXTURE_PATH)
    expect(fixture).toBeDefined()
    expect(scanFixtureFiles([fixture!])).toEqual([])
  })

  it('scans clean, so no credential, MAC, serial or enable secret slipped into a committed payload', () => {
    const findings = scanFixtureFiles(corpus)
    expect(findings.map((finding) => `${finding.file}: ${finding.rule} — ${finding.detail}`)).toEqual([])
  })

  it('a payload pasted into a component test would trip it (permanent mutation control)', () => {
    const leaked = `\nconst leak = { systemMacAddress: '${REAL_SHAPED_MAC}', serialNumber: '${REAL_SHAPED_SERIAL}', password: 'hunter2' }\n`
    const findings = scanFixtureFiles(corpus.map((file) => ({ path: file.path, text: `${file.text}${leaked}` })))
    const byRule = findings.reduce<Record<string, number>>((tally, finding) => {
      tally[finding.rule] = (tally[finding.rule] ?? 0) + 1
      return tally
    }, {})
    expect(byRule.mac).toBe(corpus.length)
    expect(byRule.serial).toBe(corpus.length)
    expect(byRule.credential).toBe(corpus.length)
  })

  it('no committed file sneaks past the allow-list with an exemption marker', () => {
    const exempt = corpus.filter((file) => file.text.includes(SCAN_EXEMPT_MARKER)).map((file) => file.path)
    expect(exempt).toEqual(EXEMPTIONS)
  })
})
