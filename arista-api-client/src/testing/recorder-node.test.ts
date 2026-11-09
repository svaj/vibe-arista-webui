/**
 * The filesystem half of the recorder — M12 (#14).
 *
 * Two kinds of test, and the split matters:
 *  1. **temp-directory writes** (`mkdtempSync`, removed in `afterAll`). Every path assertion proves the
 *     writer is deterministic and cannot escape the tree. Nothing in these cases touches
 *     `test/fixtures/recordings/`, which one test asserts outright — committed evidence is only ever
 *     rewritten by an explicit `npm run fixtures:refresh` (PLAN.md:395).
 *  2. **read-only assertions over the committed tree**: the redaction guard, the naming convention and
 *     the "envelope agrees with its directory" rule run against the real fixtures, the way
 *     `src/internal/wire.fixture.test.ts` does for `test/fixtures/wire/` (docs/TESTING.md:112 —
 *     "a test asserts the fixture tree contains no unredacted `enable` input").
 *
 * Offline (DR-034): the only I/O is `node:fs` on this machine. No device, no container.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { REDACTED } from '../internal/redact'
import {
  buildRecording,
  findUnredactedEnableInput,
  parseRecording,
  recordingText,
  type DeviceIdentity,
  type RecordingFixture,
} from './recording'
import {
  RECORDINGS_DIR,
  listRecordingCases,
  listRecordingTargets,
  loadRecording,
  readRecording,
  recordingPath,
  writeRecording,
} from './recorder-node'

const LAB: DeviceIdentity = { modelName: 'cEOS-4.28.14M', version: '4.28.14M', targetClass: 'lab' }
const HARDWARE: DeviceIdentity = { modelName: 'DCS-7050TX-64', version: '4.28.13.1M', targetClass: 'hardware' }
const LAB_ENDPOINT = 'https://localhost:8443/command-api'

/** One traced round trip, hand-fed: enough to build a real fixture without any I/O of its own. */
function labFixture(identity: DeviceIdentity = LAB, caseId = 'n-1'): RecordingFixture {
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: caseId, params: { version: 1, format: 'json', cmds: ['show version'] } })
  return buildRecording(
    [{ requestId: caseId, endpoint: LAB_ENDPOINT, request: body, response: JSON.stringify({ jsonrpc: '2.0', result: [{ version: identity.version, modelName: identity.modelName }], id: caseId }) }],
    identity,
  )
}

let scratch = ''

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'arista-eapi-recordings-'))
})

afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true })
})

describe('deterministic paths inside the recording tree', () => {
  it('files a fixture under the slug its own identity implies', () => {
    const path = recordingPath({ slug: 'ceos-4.28.14M', caseName: 'show-version--lab-identity', root: scratch })
    expect(path).toBe(join(scratch, 'ceos-4.28.14M', 'show-version--lab-identity.json'))
  })

  it('asks for the lab and hardware spellings the docs use, with an uppercase train letter intact', () => {
    // docs/CEOS.md:143-144 and docs/TESTING.md:130-131 both keep the `M` in `4.28.14M`, so a slug rule
    // that forced full lowercasing would not match the documented tree.
    for (const slug of ['ceos-4.28.14M', '7050tx-64-4.28.13.1M']) {
      expect(() => recordingPath({ slug, caseName: 'show-version--case', root: scratch })).not.toThrow()
    }
  })

  it('never puts a timestamp (or anything else volatile) into a path', () => {
    const first = writeRecording(labFixture(), { caseName: 'show-version--stable', root: scratch })
    const second = writeRecording(labFixture(), { caseName: 'show-version--stable', root: scratch, overwrite: true })
    expect(first.path).toBe(second.path)
    expect(first.path).not.toMatch(/T\d{2}:\d{2}|\d{10,}/u)
  })

  it('refuses a case name that is not <command>--<scenario> (docs/TESTING.md:113-114)', () => {
    for (const caseName of ['show-version.json', 'recorder.test.json', 'Show-Version--Case', 'show-version--', '--show-version', 'show version--case']) {
      expect(() => recordingPath({ slug: 'ceos-4.28.14M', caseName, root: scratch }), caseName).toThrow(/is refused/)
    }
  })

  it('refuses any spelling that could escape the tree', () => {
    for (const caseName of ['../outside--case', 'a/../b--c', '/etc/passwd', 'nested/dir--case']) {
      expect(() => recordingPath({ slug: 'ceos-4.28.14M', caseName, root: scratch }), caseName).toThrow(/is refused/)
    }
    for (const slug of ['../escape', 'a/b', '', 'with space']) {
      expect(() => recordingPath({ slug, caseName: 'show-version--case', root: scratch }), slug).toThrow(/not a usable directory name/)
    }
  })

  it('writes under the identity-derived directory, never under a caller-supplied one', () => {
    const written = writeRecording(labFixture(), { caseName: 'show-version--derived-dir', root: scratch })
    expect(written.path).toBe(join(scratch, 'ceos-4.28.14M', 'show-version--derived-dir.json'))
    expect(written.created).toBe(true)
    expect(written.changed).toBe(true)
  })

  it('keeps the two lanes in separate directories, which is the shape DR-043 asks for', () => {
    const hardware = writeRecording(labFixture(HARDWARE), { caseName: 'show-version--baseline', root: scratch })
    const lab = writeRecording(labFixture(LAB), { caseName: 'show-version--baseline', root: scratch })
    expect(hardware.path).toBe(join(scratch, '7050tx-64-4.28.13.1M', 'show-version--baseline.json'))
    expect(lab.path).toBe(join(scratch, 'ceos-4.28.14M', 'show-version--baseline.json'))
    expect(listRecordingTargets(scratch).sort()).toEqual(['7050tx-64-4.28.13.1M', 'ceos-4.28.14M'])
  })
})

describe('refresh discipline (PLAN.md:395 — a refresh is explicit)', () => {
  it('refuses to overwrite an existing fixture without overwrite:true', () => {
    writeRecording(labFixture(), { caseName: 'show-version--refresh', root: scratch })
    expect(() => writeRecording(labFixture(), { caseName: 'show-version--refresh', root: scratch })).toThrow(/without overwrite:true/)
    expect(() => writeRecording(labFixture(), { caseName: 'show-version--refresh', root: scratch })).toThrow(/fixtures:refresh/u)
  })

  it('reports a no-op refresh as unchanged, which is the only way a diff can mean something', () => {
    const first = writeRecording(labFixture(), { caseName: 'show-version--noop', root: scratch })
    const again = writeRecording(labFixture(), { caseName: 'show-version--noop', root: scratch, overwrite: true })
    expect(again.created).toBe(false)
    expect(again.changed).toBe(false)
    expect(first.bytes).toBe(again.bytes)
  })

  it('refuses a refresh whose identity drifted, even inside the same directory', () => {
    // Same slug (`cEOS` and `cEOSLab-SEA-1` both normalise to `ceos` at 4.28.14M), different recorded
    // model. Silently rewriting the envelope is how a fixture stops describing the box it came from.
    writeRecording(labFixture({ ...LAB, modelName: 'cEOS' }), { caseName: 'show-version--drift', root: scratch })
    const drifted = labFixture({ ...LAB, modelName: 'CEOSLab-SEA-1' })
    expect(() => writeRecording(drifted, { caseName: 'show-version--drift', root: scratch, overwrite: true })).toThrow(/it holds a capture of/)
  })

  it('refuses to build a fixture whose caller-supplied slug disagrees with the identity (before the writer)', () => {
    // The writer never sees a mislabelled fixture: `buildRecording` refuses an `identity.slug` the device
    // did not earn, which is the enforcement point for "cEOS recordings must never overwrite hardware
    // fixtures" (docs/TESTING.md:131, DR-043).
    expect(() => labFixture({ ...LAB, slug: '7050tx-64-4.28.13.1M' })).toThrow(/disagrees with the slug/)
  })
})

describe('reading fixtures back', () => {
  it('round-trips a written file to an equal fixture', () => {
    const fixture = labFixture()
    const written = writeRecording(fixture, { caseName: 'show-version--round-trip', root: scratch })
    const back = readRecording({ slug: 'ceos-4.28.14M', caseName: 'show-version--round-trip', root: scratch })
    expect(recordingText(back)).toBe(recordingText(fixture))
    expect(back.identity.targetSlug).toBe('ceos-4.28.14M')
    expect(back.captures[0]?.commands).toEqual(['show version'])
    expect(written.path.endsWith('.json')).toBe(true)
  })

  it('lists the cases present so a missing fixture says what does exist', () => {
    writeRecording(labFixture(), { caseName: 'show-vlan--three-vlans', root: scratch })
    writeRecording(labFixture(), { caseName: 'show-version--baseline-case', root: scratch })
    const cases = listRecordingCases('ceos-4.28.14M', scratch)
    expect(cases).toContain('show-vlan--three-vlans.json')
    expect(cases).toContain('show-version--baseline-case.json')
    expect(cases).toEqual([...cases].sort())
    let missing = ''
    try {
      readRecording({ slug: 'ceos-4.28.14M', caseName: 'show-mlag--absent', root: scratch })
    } catch (error) {
      missing = error instanceof Error ? error.message : String(error)
    }
    expect(missing).toMatch(/no recording at/u)
    expect(missing).toContain('show-vlan--three-vlans.json')
    expect(listRecordingCases('nope-1.0', scratch)).toEqual([])
  })

  it('loadRecording treats the directory as an identity expectation and refuses a moved file', () => {
    const fixture = labFixture()
    writeRecording(fixture, { caseName: 'show-version--moved', root: scratch })
    // Simulate a human moving the file across lanes: same bytes, wrong directory.
    const from = join(scratch, 'ceos-4.28.14M', 'show-version--moved.json')
    const otherDir = join(scratch, '7050tx-64-4.28.13.1M')
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, 'show-version--moved.json'), readFileSync(from, 'utf8'), 'utf8')
    expect(() => loadRecording({ slug: '7050tx-64-4.28.13.1M', caseName: 'show-version--moved', root: scratch })).toThrow(/identity mismatch/u)
    expect(loadRecording({ slug: 'ceos-4.28.14M', caseName: 'show-version--moved', root: scratch }).identity.targetSlug).toBe('ceos-4.28.14M')
  })

  it('refuses to load a fixture an editor put a password back into', () => {
    const poisoned = {
      format: 'arista-eapi-recording/v1',
      identity: {
        targetSlug: 'ceos-4.28.14M',
        targetClass: 'lab',
        modelName: 'cEOS-4.28.14M',
        aristaVersion: '4.28.14M',
        versionNumber: '4.28.14',
        provenance: 'captured',
      },
      captures: [{ requestId: 'p-1', commands: [{ cmd: 'enable', input: 'plaintext-was-pasted-back' }], result: [{}] }],
      incomplete: [],
    }
    const dir = join(scratch, 'ceos-4.28.14M')
    writeFileSync(join(dir, 'show-version--poisoned.json'), JSON.stringify(poisoned, null, 2), 'utf8')
    expect(() => readRecording({ slug: 'ceos-4.28.14M', caseName: 'show-version--poisoned', root: scratch })).toThrow(/unredacted enable input/u)
    expect(() => parseRecording(JSON.stringify(poisoned))).toThrow(/src\/internal\/redact\.ts:50/u)
  })
})

describe('the committed recording tree is guarded on every npm test', () => {
  const targets = listRecordingTargets()

  it('has at least one target directory, so the loop below cannot pass by scanning nothing', () => {
    expect(targets.length).toBeGreaterThan(0)
  })

  it('contains only the version/model-separated directories the docs name', () => {
    // docs/CEOS.md:143-144 and docs/TESTING.md:130-131 name the pair; a third lane arriving without
    // changing those docs is a decision, not an accident, so this pins the set — widened to the -R
    // hardware slug by DR-131 (TESTING.md now names `7050tx-64-r-4.28.13.1M/` beside the base one).
    const documented = ['ceos-4.28.14M', '7050tx-64-4.28.13.1M', '7050tx-64-r-4.28.13.1M']
    for (const slug of targets) expect(documented, slug).toContain(slug)
    expect(targets).toContain('ceos-4.28.14M')
  })

  it('contains no live credential material anywhere — keys included (DR-133)', () => {
    // The DR-133 leak: EOS answers `show running-config` (json) `cmds`-keyed by the config LINE, so a
    // value-only scrubber could walk a whole tree of live `secret sha512 $6$…` hashes and count the run
    // clean. This scan reads each recording as TEXT, so it bites keys, values and raw bodies alike —
    // it is the guard that would have caught the first executed hardware capture before commit.
    // Placeholders are allowed by construction: every pattern requires a non-`<` payload after the
    // known prefix, and `<hw-redacted-secret>`/`<redacted-lab-secret>` start with one.
    const liveSecretPatterns: readonly { re: RegExp; why: string }[] = [
      { re: /\$[156]\$[A-Za-z0-9./]{6,}\$[A-Za-z0-9./]+/u, why: 'crypt(3) password hash' },
      { re: /\bsecret\s+(?:sha512|sha256|md5|plain)\s+(?!<)\S/u, why: 'un-redacted EOS `secret …` material' },
      { re: /-----BEGIN (?:RSA |EC )?(?:PRIVATE KEY|ENCRYPTED)/u, why: 'private key material' },
      { re: /\benable\s+(?:algorithm\s+\S+\s+)?password\s+(?!<)[\x21-\x7e]{6,}/u, why: 'un-redacted enable password' },
    ]
    for (const slug of targets) {
      for (const file of listRecordingCases(slug)) {
        const path = recordingPath({ slug, caseName: file.replace(/\.json$/u, '') })
        const text = readFileSync(path, 'utf8')
        for (const { re, why } of liveSecretPatterns) {
          expect(text, `${path}: ${why}`).not.toMatch(re)
        }
      }
    }
  })

  it('every fixture parses, is marked with a provenance, and agrees with its own directory', () => {
    for (const slug of targets) {
      const cases = listRecordingCases(slug)
      expect(cases.length, `${slug} should hold at least one committed example`).toBeGreaterThan(0)
      for (const file of cases) {
        const caseName = file.replace(/\.json$/u, '')
        const fixture = loadRecording({ slug, caseName })
        expect(fixture.identity.targetSlug).toBe(slug)
        expect(['captured', 'hand-authored-example']).toContain(fixture.identity.provenance)
        expect(findUnredactedEnableInput(fixture)).toEqual([])
      }
    }
  })

  it('no committed recording contains a plaintext enable input or the wire-fixture probe token', () => {
    // `pw-from-fixture-probe` is the token `test/fixtures/wire/README.md` allows in *hand-authored
    // envelopes* only. A recording is post-redaction by construction, so its `enable` input must read
    // `<redacted>` and the probe string must never appear — which is the same guard, one layer up.
    for (const slug of targets) {
      for (const file of listRecordingCases(slug)) {
        const path = recordingPath({ slug, caseName: file.replace(/\.json$/u, '') })
        const text = readFileSync(path, 'utf8')
        expect(text, path).not.toContain('pw-from-fixture-probe')
        const fixture = parseRecording(text, path)
        for (const capture of fixture.captures) {
          for (const command of capture.commands) {
            if (typeof command === 'object' && /^enable(?:\s|$)/iu.test(command.cmd)) {
              expect(command.input, `${path}: ${slug}`).toBe(REDACTED)
            }
          }
        }
      }
    }
  })

  it('proves the offline suite never writes into the committed tree', () => {
    // A cheap, explicit tripwire: the scratch root used above must not be the committed directory, and
    // every path the writer produced this run stays outside it.
    expect(scratch.startsWith(RECORDINGS_DIR)).toBe(false)
    const written = writeRecording(labFixture(), { caseName: 'show-version--tripwire', root: scratch })
    expect(written.path.startsWith(RECORDINGS_DIR)).toBe(false)
  })
})
