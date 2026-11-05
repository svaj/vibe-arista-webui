/**
 * Recorder + fixture tests — M12 (#14), all offline. Nothing here contacts a device or a container:
 * the "device" is either `createCodecTransport` over a scripted `RawSend` (the same seam
 * `src/testing/mock-transport.test.ts:294-309` uses) or a hand-driven `recorder.sink`, which is how the
 * refusal paths get exercised.
 *
 * What this file owns:
 *  - the identity envelope and the version/model-separated slug (DR-043, docs/TESTING.md:130-131);
 *  - redaction on write **and** on load, including the unredacted-`enable`-input assertion
 *    docs/TESTING.md:112 asks for, with the detector derived from `src/internal/redact.ts` (DR-011);
 *  - deterministic bytes (a refresh that changes nothing must produce an empty diff);
 *  - the replay path fixtures exist for: identity mismatch refuses, then `MockTransport` answers from
 *    the recorded `{cmds → reply}` map.
 *
 * The filesystem half (`recordingPath`/`writeRecording`/`readRecording`) is
 * `src/testing/recorder-node.test.ts` — this file stays free of `node:*` so it also proves the
 * browser-safe half works standalone (DR-002).
 */

import { describe, expect, it } from 'vitest'

import { AuthError, ProtocolError, TlsError } from '../errors'
import { REDACTED, redactWireText } from '../internal/redact'
import { createRequestIds, sendRequest } from '../internal/wire'
import { createCodecTransport, type RawSend } from '../transports/base'
import { mockTransport } from './mock-transport'
import {
  assertRecordingIdentity,
  assertTargetSlug,
  buildRecording,
  createRecorder,
  findUnredactedEnableInput,
  identityFromVersionReply,
  parseRecording,
  recordingMatchKey,
  recordingText,
  recordSender,
  replayRecording,
  targetSlug,
  RECORDING_FORMAT,
  type DeviceIdentity,
  type RecordingFixture,
} from './recording'

/** The lab target this milestone pins (docs/CEOS.md:5-6, :113). */
const LAB: DeviceIdentity = { modelName: 'cEOS-4.28.14M', version: '4.28.14M', targetClass: 'lab' }
/** The hardware target, spelled as its existing show-version fixture spells it. */
const HARDWARE: DeviceIdentity = { modelName: 'DCS-7050TX-64', version: '4.28.13.1M', targetClass: 'hardware' }

const LAB_ENDPOINT = 'https://localhost:8443/command-api'

/**
 * A "device" that answers one scripted body (or throws), traced into a recorder exactly the way a real
 * transport traces it: `src/transports/base.ts:85-94` runs every body through `redactWireText` before
 * the sink sees it, so this is the honest capture path.
 */
function traced(answerText: string | undefined, failure: Error | undefined, requestId = 'lab-1'): { recorder: ReturnType<typeof createRecorder>; transport: ReturnType<typeof createCodecTransport> } {
  const recorder = createRecorder()
  const send: RawSend = async () => {
    if (failure !== undefined) throw failure
    return answerText as string
  }
  const transport = createCodecTransport({
    kind: 'mock',
    address: LAB_ENDPOINT,
    send,
    ids: { clientId: 'lab', next: () => requestId },
    trace: recorder.sink,
  })
  return { recorder, transport }
}

/**
 * Feed the sink by hand, bypassing `base.ts` — this is how the write-time guard gets a fair test.
 * The bodies are NOT pre-redacted here, which a real transport would never do. The reply defaults to an
 * empty success envelope because a request with no reply is a *different* case (see the `incomplete`
 * test): the M2 recorder keeps it pending, and `buildRecording` must not invent a capture for it.
 */
function handFed(request: string, response?: string, failure?: string, requestId = 'hand-1'): ReturnType<typeof createRecorder> {
  const recorder = createRecorder()
  recorder.sink({ direction: 'request', endpoint: LAB_ENDPOINT, requestId, body: request })
  const reply = response ?? (failure === undefined ? JSON.stringify({ jsonrpc: '2.0', result: [{}], id: requestId }) : undefined)
  if (reply !== undefined) recorder.sink({ direction: 'response', endpoint: LAB_ENDPOINT, requestId, body: reply })
  if (failure !== undefined) recorder.sink({ direction: 'failure', endpoint: LAB_ENDPOINT, requestId, body: failure })
  return recorder
}

const VERSION_REPLY = { version: '4.28.14M', modelName: 'cEOS-4.28.14M', hostname: 'lab' }

function showVersionBody(id: string): string {
  return JSON.stringify({ jsonrpc: '2.0', result: [VERSION_REPLY], id })
}

describe('the target slug is version/model separated, per docs/TESTING.md:130-131', () => {
  it('spells the hardware directory exactly as the docs spell it', () => {
    // Through the shared identity so this case cannot drift from the fixture lane's model/version pair.
    expect(targetSlug(HARDWARE.modelName, HARDWARE.version, HARDWARE.targetClass)).toBe(
      '7050tx-64-4.28.13.1M',
    )
  })

  it('spells the cEOS directory exactly as the runbook spells it', () => {
    expect(targetSlug('cEOS-4.28.14M', '4.28.14M', 'lab')).toBe('ceos-4.28.14M')
  })

  it('normalises the lab family rather than baking a container model id into a directory name', () => {
    // These are illustrative inputs of the shapes a lab run can hand back, not a claim about what any
    // particular build reports as `modelName` — what a device reports is exactly what a live run pins at
    // run time (`live-guard.ts` `EAPI_ALLOW_MODEL`, docs/CEOS.md:128-129). The rule under test is the
    // *directory* rule from docs/CEOS.md:143-144: one label per lab family, version-separated.
    for (const name of ['cEOS', 'CEOSLab-SEA-1', 'cEOS lab 4.28', 'cEOS-4.28.14M']) {
      expect(targetSlug(name, '4.28.14M', 'lab')).toBe('ceos-4.28.14M')
    }
    expect(targetSlug('vEOS-lab', '4.28.14M', 'lab')).toBe('veos-4.28.14M')
  })

  it('refuses to invent a slug out of an empty identity', () => {
    expect(() => targetSlug('', '4.28.14M', 'lab')).toThrow(/non-empty modelName/)
    expect(() => targetSlug('cEOS', '   ', 'lab')).toThrow(/non-empty modelName and version/)
  })

  it('refuses a slug it cannot turn into a directory name (an engineering-build version string)', () => {
    // The engineering-build shape is upstream's own: pyeapi `test/unit/test_client.py:56` uses
    // '4.17.1.1F-3512479.41711F (engineering build)'. A directory name with a space in it is a fixture
    // nobody can `git diff`, so the caller must pin a shorter slug instead.
    expect(() => targetSlug('cEOS', '4.17.1.1F-3512479.41711F (engineering build)', 'lab')).toThrow(/refusing to make a directory name/)
  })

  it('refuses the contradiction of a hardware target reporting a lab model name', () => {
    expect(() => targetSlug('cEOS-4.28.14M', '4.28.14M', 'hardware')).toThrow(/contradiction/)
  })

  it('assertTargetSlug accepts a fixture filed under its own slug and refuses anything else', () => {
    expect(() => assertTargetSlug('ceos-4.28.14M', LAB)).not.toThrow()
    expect(() => assertTargetSlug('7050tx-64-4.28.13.1M', LAB)).toThrow(/never land on top of a/)
  })

  it('refuses an identity.slug the device did not earn', () => {
    expect(() => buildRecording([], { ...LAB, slug: '7050tx-64-4.28.13.1M' })).toThrow(/disagrees with the slug/)
  })

  it('refuses an unlabelled capture and an unknown target class', () => {
    expect(() => buildRecording([], { ...LAB, modelName: '  ' })).toThrow(/needs the device identity/)
    const bogusClass = { ...LAB, targetClass: 'switch' } as unknown as DeviceIdentity
    expect(() => buildRecording([], bogusClass)).toThrow(/unknown targetClass/)
  })

  it('reads the two identity fields through the product parser, not a private copy of it', () => {
    const identity = identityFromVersionReply(VERSION_REPLY, { targetClass: 'lab' })
    expect(identity).toMatchObject({ modelName: 'cEOS-4.28.14M', version: '4.28.14M' })
    // command-layer.ts:274 keeps `modelName` whole (MIGRATION §5 row 35) and computes versionNumber;
    // a reply that does not report them throws ProtocolError instead of yielding "None" (pyeapi's answer).
    expect(() => identityFromVersionReply({ modelName: 'cEOS' }, { targetClass: 'lab' })).toThrow(ProtocolError)
  })
})

describe('buildRecording turns a traced round trip into a replayable fixture', () => {
  it('records the envelope beside the {cmds → reply} map (PLAN.md:391)', async () => {
    const { recorder, transport } = traced(showVersionBody('lab-1'), undefined)
    await transport.execute('show version')
    const fixture = buildRecording(recorder, LAB)
    expect(fixture.format).toBe(RECORDING_FORMAT)
    expect(fixture.identity).toMatchObject({
      targetSlug: 'ceos-4.28.14M',
      targetClass: 'lab',
      modelName: 'cEOS-4.28.14M',
      aristaVersion: '4.28.14M',
      versionNumber: '4.28.14',
      provenance: 'captured',
      endpoint: LAB_ENDPOINT,
    })
    expect(fixture.captures).toHaveLength(1)
    expect(fixture.captures[0]?.commands).toEqual(['show version'])
    expect(fixture.captures[0]?.result).toEqual([VERSION_REPLY])
    expect(fixture.captures[0]?.format).toBe('json')
    expect(fixture.incomplete).toEqual([])
  })

  it('never writes an enable password, because the capture path already redacted it (DR-011)', async () => {
    const { recorder, transport } = traced(JSON.stringify({ jsonrpc: '2.0', result: [{}, {}], id: 'lab-1' }), undefined)
    await transport.execute([{ cmd: 'enable', input: 'sup3r-s3cret\n' }, 'show version'])
    const fixture = buildRecording(recorder, LAB)
    const text = recordingText(fixture)
    expect(text).toContain(`${JSON.stringify(REDACTED)}`)
    expect(text).not.toContain('sup3r-s3cret')
    expect(fixture.captures[0]?.commands).toEqual([{ cmd: 'enable', input: REDACTED }, 'show version'])
  })

  it('redacts again on the way out, so a caller that forgot `trace` still cannot write a secret', () => {
    const recorder = handFed(JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'hand-1', params: { version: 1, format: 'json', cmds: [{ cmd: 'enable', input: 'hunter2' }, 'show version'] } }))
    const fixture = buildRecording(recorder, LAB)
    expect(fixture.captures[0]?.commands).toEqual([{ cmd: 'enable', input: REDACTED }, 'show version'])
    expect(recordingText(fixture)).not.toContain('hunter2')
  })

  it('records a device error envelope as an error, not as a result', () => {
    const recorder = handFed(
      JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'e-1', params: { version: 1, format: 'json', cmds: ['show vlan 999'] } }),
      JSON.stringify({ jsonrpc: '2.0', error: { code: 1002, message: "CLI error: won't compute", data: [] }, id: 'e-1' }),
    )
    const fixture = buildRecording(recorder, LAB)
    expect(fixture.captures[0]?.error).toMatchObject({ code: 1002 })
    expect(fixture.captures[0]?.result).toBeUndefined()
    // The recorded envelope deliberately drops `id`: replay re-ids it (see the replay describe below).
    expect(JSON.stringify(fixture)).not.toContain('"id":"e-1"')
  })

  it('keeps a body that never parsed as raw text, because that is what a ProtocolError case needs', () => {
    const recorder = handFed(JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'r-1', params: { version: 1, format: 'json', cmds: ['show version'] } }), '<html>502 Bad Gateway</html>')
    const fixture = buildRecording(recorder, LAB)
    expect(fixture.captures[0]?.raw).toBe('<html>502 Bad Gateway</html>')
    expect(fixture.captures[0]?.result).toBeUndefined()
  })

  it('records a mapped transport failure, redacting the credential-shaped half of its message', async () => {
    // base.ts:92-94 traces `${error.name}: ${error.message}` through redactWireText, so a failure body is
    // guarded by the same rules as a request body — including the USERNAME_CREDENTIAL rule at
    // src/internal/redact.ts:46, which is what the text below feeds it.
    const { recorder, transport } = traced(undefined, new AuthError('login rejected: username admin secret plain hunter2', { endpoint: LAB_ENDPOINT }), 'f-1')
    await transport.execute('show version').catch(() => undefined)
    const fixture = buildRecording(recorder, { ...LAB, capturedAt: '2026-11-03T00:00:00.000Z' })
    expect(fixture.captures[0]?.failure).toMatch(/^AuthError:/u)
    expect(fixture.captures[0]?.failure).toContain(REDACTED)
    expect(fixture.captures[0]?.result).toBeUndefined()
    expect(recordingText(fixture)).not.toContain('hunter2')
    expect(fixture.identity.capturedAt).toBe('2026-11-03T00:00:00.000Z')
  })

  it('records a TLS failure as a failure line, not as an empty reply (a refused handshake has an answer)', async () => {
    const { recorder, transport } = traced(undefined, new TlsError('certificate verify failed: self-signed certificate', { endpoint: LAB_ENDPOINT }), 'tls-1')
    await transport.execute('show version').catch(() => undefined)
    const fixture = buildRecording(recorder, LAB)
    expect(fixture.captures[0]?.failure).toMatch(/^TlsError:/u)
    expect((fixture.captures[0] as { raw?: string }).raw).toBeUndefined()
  })

  it('keeps an open request in "incomplete" instead of half-writing a capture', () => {
    const recorder = createRecorder()
    recorder.sink({ direction: 'request', endpoint: LAB_ENDPOINT, requestId: 'open-1', body: '{"jsonrpc":"2.0","method":"runCmds","id":"open-1","params":{"version":1,"cmds":["show version"]}}' })
    const fixture = buildRecording(recorder, LAB)
    expect(fixture.captures).toEqual([])
    expect(fixture.incomplete).toEqual(['open-1'])
  })

  it('refuses a request side we cannot read, because it could never be keyed for replay', () => {
    const recorder = handFed('not-json-at-all')
    expect(() => buildRecording(recorder, LAB)).toThrow(/its request side is not a JSON-RPC body/)
  })

  it('refuses a request body with no params.cmds', () => {
    const recorder = handFed(JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'x-1', params: { version: 1, format: 'json' } }))
    expect(() => buildRecording(recorder, LAB)).toThrow(/no params\.cmds array/)
  })

  it('refuses an exchange that has neither a response nor a failure', () => {
    // Reached through the array form of `buildRecording`: the sink cannot produce this shape (its
    // response/failure branch always closes the exchange), so a hand-assembled exchange is the honest
    // way to show the writer refuses a half-capture instead of writing an unreplayable entry.
    const half = [{ requestId: 'n-1', endpoint: LAB_ENDPOINT, request: JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'n-1', params: { version: 1, format: 'json', cmds: ['show version'] } }) }]
    expect(() => buildRecording(half, LAB)).toThrow(/neither a response nor a failure/)
  })

  it('refuses a recording that spans two endpoints (docs/CEOS.md:136, one target per job)', () => {
    const recorder = createRecorder()
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'a-1', params: { version: 1, format: 'json', cmds: ['show version'] } })
    recorder.sink({ direction: 'request', endpoint: LAB_ENDPOINT, requestId: 'a-1', body })
    recorder.sink({ direction: 'response', endpoint: LAB_ENDPOINT, requestId: 'a-1', body: showVersionBody('a-1') })
    recorder.sink({ direction: 'request', endpoint: 'https://127.0.0.1:8444/command-api', requestId: 'a-2', body: body.replace('a-1', 'a-2') })
    recorder.sink({ direction: 'response', endpoint: 'https://127.0.0.1:8444/command-api', requestId: 'a-2', body: showVersionBody('a-2').replace('lab-1', 'a-2') })
    expect(() => buildRecording(recorder, LAB)).toThrow(/belongs to one endpoint/)
  })
})

describe('the unredacted-enable-input guard (docs/TESTING.md:112)', () => {
  it('flags a structured enable input that is still a real value', () => {
    expect(findUnredactedEnableInput({ cmds: [{ cmd: 'enable', input: 'hunter2' }] })).toEqual(['$.cmds[0].input (cmd="enable")'])
  })

  it('flags an enable input of the wrong type, which redactCommands would leave alone', () => {
    // src/internal/redact.ts:84 only rewrites a *string* input, so `{input: 42}` survives redaction —
    // the detector treats "not exactly <redacted>" as unredacted, which is the safe reading.
    expect(findUnredactedEnableInput([{ cmd: 'enable', input: 42 }])).toEqual(['$[0].input (cmd="enable")'])
    expect(findUnredactedEnableInput([{ cmd: 'enable', input: ['hunter2'] }])).toHaveLength(1)
  })

  it('accepts an enable input that is exactly the redaction token, and an enable with no input at all', () => {
    expect(findUnredactedEnableInput([{ cmd: 'enable', input: REDACTED }])).toEqual([])
    expect(findUnredactedEnableInput([{ cmd: 'enable' }])).toEqual([])
    expect(findUnredactedEnableInput([{ cmd: 'enable' }, 'show version'])).toEqual([])
  })

  it('does not treat a non-enable input as a secret (a banner body is not a password)', () => {
    expect(findUnredactedEnableInput([{ cmd: 'banner motd', input: 'Authorized access only' }])).toEqual([])
  })

  it('follows the enable spelling rule exactly, including the boundary that keeps "enabled" out', () => {
    // The detector re-uses the rule at src/internal/redact.ts:50, so its false positives are the
    // redactor's false positives and no more: `Enable` counts, `enabled-feature` does not.
    expect(findUnredactedEnableInput([{ cmd: 'Enable', input: 'hunter2' }])).toHaveLength(1)
    expect(findUnredactedEnableInput([{ cmd: 'enable of all', input: 'x' }])).toHaveLength(1)
    expect(findUnredactedEnableInput([{ cmd: 'enabled-feature', input: 'x' }])).toEqual([])
  })

  it('catches the textual form EOS prints in an error message', () => {
    const body = `{"jsonrpc":"2.0","error":{"code":1005,"message":"[\"CLI command 1 of 1 'enable' failed: invalid secret\", \"input='hunter2'\"]"}}`
    expect(findUnredactedEnableInput(body)).toHaveLength(1)
    expect(findUnredactedEnableInput(body)[0]).toContain('$ (text: input=hunter2)')
  })

  it('accepts that same text once the redactor has had it, which proves the pair is consistent', () => {
    // This is the load-bearing proof, not a nicety: because `redactCommandText` replaces the value with
    // REDACTED using the same bare-token class as its own detector (src/internal/redact.ts:32,:24), a
    // body that has been through the redactor cannot still satisfy the detector.
    const unredacted = `CLI command 1 of 1 'enable' failed: invalid secret input='hunter2'`
    expect(findUnredactedEnableInput(unredacted)).toHaveLength(1)
    expect(findUnredactedEnableInput(redactWireText(unredacted))).toEqual([])
    const structured = JSON.stringify({ params: { cmds: [{ cmd: 'enable', input: 'hunter2' }] } })
    expect(findUnredactedEnableInput(redactWireText(structured))).toEqual([])
  })

  it('walks JSON that is hiding inside a string value (a raw response body cannot smuggle one)', () => {
    const offenders = findUnredactedEnableInput({ raw: JSON.stringify({ params: { cmds: [{ cmd: 'enable', input: 'hunter2' }] } }) })
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('!json')
  })

  it('finds nothing to object to in a well-formed fixture it built itself', async () => {
    const { recorder, transport } = traced(JSON.stringify({ jsonrpc: '2.0', result: [{}, VERSION_REPLY], id: 'lab-1' }), undefined)
    await transport.execute([{ cmd: 'enable', input: 'hunter2' }, 'show version'])
    const fixture = buildRecording(recorder, LAB)
    expect(findUnredactedEnableInput(fixture)).toEqual([])
  })

  it('refuses to serialise a fixture someone assembled by hand', () => {
    const handBuilt = {
      format: RECORDING_FORMAT,
      identity: { targetSlug: 'ceos-4.28.14M', targetClass: 'lab', modelName: 'cEOS-4.28.14M', aristaVersion: '4.28.14M', versionNumber: '4.28.14', provenance: 'captured' },
      captures: [{ requestId: 'h-1', commands: [{ cmd: 'enable', input: 'hunter2' }], result: [{}] }],
      incomplete: [],
    } as unknown as RecordingFixture
    expect(() => recordingText(handBuilt)).toThrow(/unredacted enable input survived at \$\.captures\[0\]\.commands\[0\]\.input/)
  })

  it('refuses to load a committed fixture that a human edited back into an unredacted state', () => {
    const text = JSON.stringify(
      {
        format: RECORDING_FORMAT,
        identity: { targetSlug: 'ceos-4.28.14M', targetClass: 'lab', modelName: 'cEOS-4.28.14M', aristaVersion: '4.28.14M', versionNumber: '4.28.14', provenance: 'captured' },
        captures: [{ requestId: 'h-1', commands: [{ cmd: 'enable', input: 'hunter2' }], result: [{}] }],
        incomplete: [],
      },
      null,
      2,
    )
    expect(() => parseRecording(text, 'ceos-4.28.14M/hand-edited--case.json')).toThrow(/refusing to load ceos-4.28.14M/)
    expect(() => parseRecording(text, 'ceos-4.28.14M/hand-edited--case.json')).toThrow(/src\/internal\/redact\.ts:50/u)
  })

  it('enforces the envelope shape on load, so a fixture cannot drift into something unreplayable', () => {
    const base = {
      format: RECORDING_FORMAT,
      identity: { targetSlug: 'ceos-4.28.14M', targetClass: 'lab', modelName: 'cEOS-4.28.14M', aristaVersion: '4.28.14M', versionNumber: '4.28.14', provenance: 'captured' },
      captures: [{ requestId: 'h-1', commands: ['show version'], result: [VERSION_REPLY] }],
      incomplete: [],
    }
    expect(() => parseRecording(JSON.stringify({ ...base, format: 'arista-eapi-recording/v9' }))).toThrow(/is not a "arista-eapi-recording\/v1" recording/)
    expect(() => parseRecording(JSON.stringify({ ...base, identity: undefined }))).toThrow(/no identity envelope/)
    expect(() => parseRecording(JSON.stringify({ ...base, identity: { ...base.identity, provenance: undefined } }))).toThrow(/provenance must be/u)
    expect(() => parseRecording(JSON.stringify({ ...base, identity: { ...base.identity, targetSlug: 'mystery-box' } }))).toThrow(/identity mismatch/)
    expect(() => parseRecording(JSON.stringify({ ...base, captures: [{ requestId: 'h-1', result: [] }] }))).toThrow(/no commands array/)
    expect(() => parseRecording(JSON.stringify({ ...base, captures: [{ requestId: 'h-1', commands: ['show version'] }] }))).toThrow(/no result\/error\/raw\/failure/)
    expect(() => parseRecording('{"oops":')).toThrow(/is not valid JSON/)
  })
})

describe('the fixture bytes are deterministic (a no-op refresh shows an empty diff)', () => {
  it('serialises identically for identical input, including a re-run a moment later', async () => {
    const first = await buildOnce()
    const second = await buildOnce()
    expect(recordingText(first)).toBe(recordingText(second))
  })

  async function buildOnce(): Promise<RecordingFixture> {
    // The scripted reply id has to equal the id the transport issued: `src/transports/base.ts:89` runs
    // `assertResponseIdMatches` on every response, and a mismatch is a ProtocolError (DR-017) before the
    // sink ever sees the body.
    const { recorder, transport } = traced(showVersionBody('det-1'), undefined, 'det-1')
    await transport.execute('show version')
    return buildRecording(recorder, LAB)
  }

  it('writes no timestamp unless the harness supplies one, and never a path-relevant one', () => {
    const without = buildRecording(handFed(JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'hand-1', params: { version: 1, format: 'json', cmds: ['show version'] } }), showVersionBody('hand-1')), LAB)
    expect(recordingText(without)).not.toMatch(/capturedAt/u)
    const withStamp = buildRecording(handFed(JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'hand-1', params: { version: 1, format: 'json', cmds: ['show version'] } }), showVersionBody('hand-1')), { ...LAB, capturedAt: '2026-11-03T00:00:00.000Z' })
    expect(recordingText(withStamp)).toContain('"capturedAt": "2026-11-03T00:00:00.000Z"')
  })

  it('survives a text → parse → text round trip byte for byte', async () => {
    const fixture = await buildOnce()
    const text = recordingText(fixture)
    const reparsed = parseRecording(text, 'ceos-4.28.14M/show-version--round-trip.json')
    expect(recordingText(reparsed)).toBe(text)
    expect(reparsed.identity).toEqual(fixture.identity)
  })

  it('matches a replay key to the whole joined command list, which is how MockTransport matches', () => {
    // src/testing/mock-transport.ts:79-88: a string matcher matches when a command equals it **or** when
    // the whole list joined with "\n" equals it. So a two-command batch key has to spell both.
    expect(recordingMatchKey(['show vlan 20', 'show version'])).toBe('show vlan 20\nshow version')
    expect(recordingMatchKey(['show version'])).toBe('show version')
  })
})

describe('replay: a fixture drives MockTransport offline, and refuses a mismatched device', () => {
  async function labFixture(): Promise<RecordingFixture> {
    const { recorder, transport } = traced(JSON.stringify({ jsonrpc: '2.0', result: [{}, VERSION_REPLY], id: 'lab-1' }), undefined, 'lab-1')
    await transport.execute([{ cmd: 'enable', input: 'hunter2' }, 'show version'])
    return buildRecording(recorder, LAB)
  }

  it('scripts the recorded batch and answers the same commands', async () => {
    const fixture = await labFixture()
    const mock = mockTransport({ seed: 'replay', nonce: 'replay' })
    const outcome = replayRecording(fixture, mock, { slug: 'ceos-4.28.14M', modelName: 'cEOS-4.28.14M', version: '4.28.14M' })
    expect(outcome.scripted).toBe(1)
    expect(outcome.keys).toEqual(['enable\nshow version'])
    const result = await mock.execute([{ cmd: 'enable', input: 'whatever' }, 'show version'])
    if (!result.ok) throw new Error(`replay should answer: ${result.error.message}`)
    expect(result.result[1]).toEqual(VERSION_REPLY)
    expect(mock.sent()).toEqual([[{ cmd: 'enable', input: 'whatever' }, 'show version']])
  })

  it('refuses to replay a lab fixture to a caller expecting the hardware lane (DR-043)', async () => {
    const fixture = await labFixture()
    const mock = mockTransport()
    expect(() => replayRecording(fixture, mock, { modelName: 'DCS-7050TX-64', version: '4.28.13.1M' })).toThrow(/identity mismatch/)
    expect(mock.callCount()).toBe(0)
  })

  it('refuses a fixture filed under the wrong directory', async () => {
    const fixture = await labFixture()
    expect(() => assertRecordingIdentity(fixture, { slug: '7050tx-64-4.28.13.1M' })).toThrow(/targetSlug/)
    expect(() => assertRecordingIdentity(fixture, { targetClass: 'hardware' })).toThrow(/targetClass/)
    expect(() => assertRecordingIdentity(fixture, {})).not.toThrow()
  })

  it('does not require the request ids to match, because replay re-ids them (DR-017/correlation)', async () => {
    const fixture = await labFixture()
    const mock = mockTransport({ seed: 'fresh-ids', nonce: 'fresh' })
    replayRecording(fixture, mock)
    const result = await mock.execute([{ cmd: 'enable', input: 'x' }, 'show version'])
    if (!result.ok) throw new Error(result.error.message)
    expect(String(result.request.id)).toMatch(/^fresh-fresh-ids-1$/u)
    expect(fixture.captures[0]?.requestId).toBe('lab-1')
  })

  it('a batch key that omits a command matches nothing, so the fixture spells every command', async () => {
    const fixture = await labFixture()
    const mock = mockTransport()
    replayRecording(fixture, mock, { slug: 'ceos-4.28.14M' })
    // One command of the recorded batch must fail loudly rather than half-replay (docs/TESTING.md §3).
    await expect(mock.execute('show version')).rejects.toThrow(/no scripted answer/)
  })

  it('replays a recorded device error as the typed failure it was', async () => {
    const recorder = handFed(
      JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'e-1', params: { version: 1, format: 'json', cmds: ['show vlan 999'] } }),
      JSON.stringify({ jsonrpc: '2.0', error: { code: 1002, message: "CLI error: command not found", data: [] }, id: 'e-1' }),
    )
    const fixture = buildRecording(recorder, LAB)
    const mock = mockTransport()
    expect(replayRecording(fixture, mock).scripted).toBe(1)
    const result = await mock.execute('show vlan 999')
    if (result.ok) throw new Error('expected the recorded error to come back')
    expect(result.error.name).toBe('CommandError')
    expect(result.error.code).toBe(1002)
  })

  it('replays a non-JSON body verbatim, which is what keeps the malformed-envelope cases offline-testable', async () => {
    const recorder = handFed(JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 'r-1', params: { version: 1, format: 'json', cmds: ['show version'] } }), '<html>502 Bad Gateway</html>')
    const fixture = buildRecording(recorder, LAB)
    const mock = mockTransport()
    const outcome = replayRecording(fixture, mock)
    expect(outcome.scripted).toBe(1)
    const result = await mock.execute('show version')
    if (result.ok) throw new Error('expected a parse failure')
    expect(result.error.name).toBe('ProtocolError')
  })

  it('does not script a mapped failure, and says so instead of inventing an error class', async () => {
    const { recorder, transport } = traced(undefined, new AuthError('not authorised', { endpoint: LAB_ENDPOINT }), 'f-1')
    await transport.execute('show version').catch(() => undefined)
    const fixture = buildRecording(recorder, LAB)
    const mock = mockTransport()
    const outcome = replayRecording(fixture, mock)
    expect(outcome.scripted).toBe(0)
    expect(outcome.deferredFailures).toEqual(['show version'])
    await expect(mock.execute('show version')).rejects.toThrow(/no scripted answer/)
  })

  it('refuses to script a capture whose command list is empty', async () => {
    const fixture = await labFixture()
    const broken = { ...fixture, captures: [{ requestId: 'z-1', commands: [], result: [{}] }] }
    expect(() => replayRecording(broken, mockTransport())).toThrow(/no commands/)
  })

  it('replays every capture in arrival order, which is what a config session depends on', async () => {
    const recorder = createRecorder()
    const batch = (id: string, cmds: readonly string[], reply: unknown): void => {
      recorder.sink({ direction: 'request', endpoint: LAB_ENDPOINT, requestId: id, body: JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id, params: { version: 1, format: 'json', cmds } }) })
      recorder.sink({ direction: 'response', endpoint: LAB_ENDPOINT, requestId: id, body: JSON.stringify({ jsonrpc: '2.0', result: [reply], id }) })
    }
    batch('s-1', ['vlan 4000'], {})
    recorder.sink({ direction: 'request', endpoint: LAB_ENDPOINT, requestId: 's-2', body: JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', id: 's-2', params: { version: 1, format: 'json', cmds: ['show session-config diffs'] } }) })
    recorder.sink({ direction: 'response', endpoint: LAB_ENDPOINT, requestId: 's-2', body: JSON.stringify({ jsonrpc: '2.0', result: [{ output: '+vlan 4000' }], id: 's-2' }) })
    const fixture = buildRecording(recorder, { ...LAB, targetClass: 'lab' })
    const outcome = replayRecording(fixture, mockTransport())
    expect(outcome.keys).toEqual(['vlan 4000', 'show session-config diffs'])
  })
})

describe('recordSender wraps the byte-level seam for an untraced sender', () => {
  it('captures a round trip and redacts for the sink only, never for the device', async () => {
    const recorder = createRecorder()
    const sent: unknown[] = []
    const inner = {
      send(request: { params: { cmds: unknown } }): string {
        sent.push(request.params.cmds)
        return JSON.stringify({ jsonrpc: '2.0', result: [{}, VERSION_REPLY], id: String((request as unknown as { id: string }).id) })
      },
    }
    const wrapped = recordSender(inner as never, recorder, LAB_ENDPOINT)
    const ids = createRequestIds({ seed: 'wrap', nonce: 'wrap' })
    const result = await sendRequest(wrapped, [{ cmd: 'enable', input: 'hunter2' }, 'show version'], { ids })
    if (!result.ok) throw new Error(result.error.message)
    // The device saw the real input — redaction is a logging/recording concern (DR-011).
    expect(sent[0]).toEqual([{ cmd: 'enable', input: 'hunter2' }, 'show version'])
    const fixture = buildRecording(recorder, LAB)
    expect(recordingText(fixture)).not.toContain('hunter2')
    expect(fixture.captures[0]?.commands).toEqual([{ cmd: 'enable', input: REDACTED }, 'show version'])
    expect(result.result[1]).toEqual(VERSION_REPLY)
  })

  it('records a sender that throws, and re-throws unchanged', async () => {
    const recorder = createRecorder()
    const wrapped = recordSender({ send: () => { throw new Error('socket hang up') } } as never, recorder, LAB_ENDPOINT)
    const ids = createRequestIds({ seed: 'boom', nonce: 'boom' })
    await expect(sendRequest(wrapped, 'show version', { ids })).rejects.toThrow(/socket hang up/u)
    const fixture = buildRecording(recorder, LAB)
    expect(fixture.captures[0]?.failure).toMatch(/Error: socket hang up/u)
    expect(fixture.incomplete).toEqual([])
  })
})
