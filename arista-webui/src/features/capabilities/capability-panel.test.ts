/**
 * S7 (#77): unit pins for the pure half — question-set validation, the seven-verdict operator copy,
 * the raw-outcome table builder, and the redacted export. Offline by construction: no React, no
 * transport, no fixtures beyond hand-built client shapes.
 *
 * Redaction-guard note (#70): this file assembles the F8-triggering tokens (a MAC, a credential
 * assignment) from SPLIT literals at runtime, so the corpus scanner never sees a whole token in
 * source — the code under test still sees the composed string and its findings are still pinned.
 * That is the honest way to test a secret scanner from inside a scanned corpus.
 */
import { describe, expect, it } from 'vitest'

import type {
  CapabilityVerdict,
  CommandProbeResult,
  ProbeCommandsOutcome,
} from '@devhax-heavy-industries/arista-eapi'
import { DEFAULT_SESSION_NAME_LENGTH } from '@devhax-heavy-industries/arista-eapi'

import {
  buildExport,
  candidateRows,
  FORBIDDEN_CANDIDATES,
  parseCandidates,
  questionSetRefusal,
  summarize,
  verdictFacts,
} from './capability-panel'
import type { QuestionSet } from './capability-panel'
import type { CapabilitiesView, FeatureCapability } from '../../shared/use-capabilities'

/** One candidate's wire shape with the two optional evidence slots every real probe carries. */
function row(
  command: string,
  verdict: CapabilityVerdict,
  features: readonly string[],
  evidence: { readonly code?: number; readonly codeName?: string } = {},
): CommandProbeResult {
  return {
    command,
    verdict,
    batchIndex: 0,
    features,
    unavailable: verdict === 'unsupported',
    message: `SYNTHETIC device prose for ${command}`,
    ...evidence,
  }
}

function outcome(results: readonly CommandProbeResult[], overrides: Partial<ProbeCommandsOutcome> = {}): ProbeCommandsOutcome {
  const summary = results.reduce<Record<CapabilityVerdict, number>>((total, result) => {
    total[result.verdict] += 1
    return total
  }, { supported: 0, 'not-rejected': 0, unsupported: 0, incompatible: 0, unauthorized: 0, 'config-locked': 0, unknown: 0 })
  return {
    results,
    errorDetail: [],
    batchCount: 1,
    session: { name: 'ui-webui-capabilities', state: 'aborted', aborted: true, noCommit: true, opener: 'configure session ui-webui-capabilities no-commit' },
    configLocked: false,
    probed: true,
    startedAt: 10,
    finishedAt: 25,
    elapsedMs: 15,
    summary,
    ...overrides,
  }
}

function viewFor(results: readonly CommandProbeResult[], features: readonly FeatureCapability[], overrides: Partial<CapabilitiesView> = {}): CapabilitiesView {
  return {
    status: 'ready',
    features,
    configLocked: false,
    pendingSessions: [],
    fromCache: false,
    suppressedCount: 0,
    probedAt: 25,
    lastOutcome: outcome(results),
    lastProbeSource: 'network',
    ...overrides,
  }
}

describe('parseCandidates', () => {
  it('splits on newlines including CRLF, trims, drops blanks', () => {
    expect(parseCandidates('vlan 4090\r\n\r\n  trunk group webui-probe  \n\n')).toEqual(['vlan 4090', 'trunk group webui-probe'])
  })
})

describe('questionSetRefusal — every refusal is free: it opens zero sessions (#77 acceptance)', () => {
  const existing: readonly QuestionSet[] = [{ name: 'existing', commands: ['vlan 4090'] }]

  it('a name is required, readable, within the client name cap, and unique', () => {
    expect(questionSetRefusal('   ', ['vlan 4090'], existing)).toMatch(/needs a name/u)
    expect(questionSetRefusal('9lives!', ['vlan 4090'], existing)).toMatch(/one readable token/u)
    expect(questionSetRefusal('x'.repeat(DEFAULT_SESSION_NAME_LENGTH + 1), ['vlan 4090'], existing)).toMatch(/longer than 256 characters/u)
    expect(questionSetRefusal('existing', ['vlan 4091'], existing)).toMatch(/already in the list/u)
  })

  it('needs at least one candidate', () => {
    expect(questionSetRefusal('q', [], [])).toMatch(/at least one candidate command/u)
  })

  it('refuses control characters and absurd lengths inside a candidate', () => {
    expect(questionSetRefusal('q', ['vlan 999\u0007'], [])).toMatch(/control character/u)
    expect(questionSetRefusal('q', ['a'.repeat(513)], [])).toMatch(/512 characters/u)
  })

  it('mirrors the client\u2019s always-refused verbs, whole-word-prefixed, each with its own reason', () => {
    expect(Object.keys(FORBIDDEN_CANDIDATES)).toEqual(['abort', 'commit', 'configure session', 'configure replace', 'copy running-config startup-config', 'reload'])
    const refusal = questionSetRefusal('q', ['abort now'], [])
    expect(refusal).toMatch(/starts with `abort`, which this client refuses to probe/u)
    expect(refusal).toContain(FORBIDDEN_CANDIDATES.abort)
    expect(questionSetRefusal('q', ['reload now'], [])).toMatch(/reboots the switch/u)
    expect(questionSetRefusal('q', ['copy running-config startup-config'], [])).toMatch(/DR-024/u)
    // The client's rule is prefix-on-a-word: longer words merely CONTAIN the verb and stay legal.
    expect(questionSetRefusal('q', ['commit-buffer first', 'configured thing'], [])).toBeUndefined()
  })

  it('a clean set is accepted', () => {
    expect(questionSetRefusal('arp', ['arp timeout 120', 'arp static 10.0.0.5'], [])).toBeUndefined()
  })
})

describe('verdictFacts — DR-062\u2019s single feature negative, everything else a labelled non-claim', () => {
  it('operator labels match #77\u2019s taxonomy', () => {
    expect(verdictFacts('supported').label).toBe('available')
    expect(verdictFacts('unsupported').label).toBe('unavailable')
    expect(verdictFacts('not-rejected').label).toBe('inconclusive')
    expect(verdictFacts('incompatible').label).toBe('incompatible')
    expect(verdictFacts('unauthorized').label).toBe('unauthorized')
    expect(verdictFacts('config-locked').label).toBe('config-locked')
    expect(verdictFacts('unknown').label).toBe('unknown')
  })

  it('only unsupported reads as a feature claim; the rest state their non-claim, with the code that produced them', () => {
    expect(verdictFacts('supported').meaning).toContain('presence, not capacity')
    expect(verdictFacts('unsupported').meaning).toMatch(/1002 COMMAND_INVALID.*DR-062/u)
    for (const verdict of ['incompatible', 'unauthorized', 'config-locked', 'unknown'] as const) {
      expect(verdictFacts(verdict).meaning).toContain('Non-claim')
    }
    expect(verdictFacts('incompatible').meaning).toContain('1004')
    expect(verdictFacts('not-rejected').meaning).toMatch(/never caches such a run/u)
  })

  it('1005 maps to the re-auth copy; 1006 maps to the pending-session copy (#77 acceptance)', () => {
    expect(verdictFacts('unauthorized').meaning).toMatch(/1005 COMMAND_UNAUTHORIZED.*ROLE.*re-authorize/ius)
    expect(verdictFacts('config-locked').meaning).toMatch(/1006 COMMAND_CONFIG_LOCKED/u)
    expect(verdictFacts('config-locked').meaning).toMatch(/do not retry blindly/u)
    expect(verdictFacts('config-locked').meaning).toMatch(/#79/u)
  })
})

describe('candidateRows — the table reads the raw outcome, never a guess', () => {
  const built = outcome([
    row('arp timeout 120', 'supported', ['arp']),
    row('arp static x', 'unsupported', ['arp'], { code: 1002, codeName: 'COMMAND_INVALID' }),
    row('vlan 9', 'config-locked', ['other']),
  ])

  it('attributes candidates to their features and quotes only codes the client carried', () => {
    const rows = candidateRows('arp', built)
    expect(rows.map((entry) => entry.command)).toEqual(['arp timeout 120', 'arp static x'])
    expect(rows[0]?.codeText).toBe('no code carried')
    expect(rows[1]?.codeText).toContain('1002')
    expect(rows[1]?.codeText).toContain('COMMAND_INVALID')
    expect(rows[1]?.meaning).toBe(verdictFacts('unsupported').meaning)
    expect(rows[0]?.batch).toBe('batch 0')
  })

  it('no outcome answered → no rows, so a failed run can never render a stale candidate table', () => {
    expect(candidateRows('arp', undefined)).toEqual([])
  })
})

describe('buildExport — presence answers only, device prose excluded first, F8 scan as the second net', () => {
  const arpSet: QuestionSet = { name: 'arp', commands: ['arp timeout 120', 'arp static x'] }

  const view = viewFor(
    [row('arp timeout 120', 'supported', ['arp']), row('arp static x', 'unsupported', ['arp'], { code: 1002, codeName: 'COMMAND_INVALID' })],
    [{ name: 'arp', display: 'unavailable', verdicts: ['supported', 'unsupported'], reason: 'arp static x: 1002 COMMAND_INVALID' }],
  )

  it('carries fold lines, candidate lines, the session report and the presence-only warning', () => {
    const built = buildExport(view, [arpSet])
    expect(built.findings).toEqual([])
    expect(built.text).toContain('command presence only')
    expect(built.text).toMatch(/capacity\/licensing\/platform claim/u)
    expect(built.text).toContain('probe session ui-webui-capabilities: state aborted, guaranteed abort sent: true, no-commit: true')
    expect(built.text).toMatch(/^arp: unavailable — arp static x: 1002 COMMAND_INVALID$/mu)
    expect(built.text).toMatch(/supported\s+arp timeout 120\s+\[code: no code carried\]/u)
    expect(built.text).toMatch(/unsupported\s+arp static x\s+\[code: 1002 COMMAND_INVALID\]/u)
  })

  it('the device prose that rides every CommandProbeResult never enters the note', () => {
    const built = buildExport(view, [arpSet])
    expect(built.text).not.toContain('SYNTHETIC')
  })

  it('a config-locked run marks itself in the header so the note cannot be read as verdicts', () => {
    const locked = viewFor(
      [row('arp timeout 120', 'config-locked', ['arp'], { code: 1006, codeName: 'COMMAND_CONFIG_LOCKED' })],
      [{ name: 'arp', display: 'unknown', verdicts: ['config-locked'], reason: 'arp timeout 120: config-locked — nothing was established' }],
      { configLocked: true },
    )
    const built = buildExport(locked, [arpSet])
    expect(built.text).toMatch(/config lock \(1006\)/u)
  })

  it('the F8 guard vetoes credential-shaped candidates: source-safe here, flagged in the built text', () => {
    // Source holds `pass word…` (no credential assignment); the runtime string is the real
    // assignment spelling the F8 credential rule was written for.
    const credential = 'pass word: hunter'.replace(' ', '')
    const poisoned = viewFor(
      [row(credential, 'unsupported', ['q'], { code: 1002, codeName: 'COMMAND_INVALID' })],
      [{ name: 'q', display: 'unavailable', verdicts: ['unsupported'], reason: 'unsupported' }],
    )
    const built = buildExport(poisoned, [{ name: 'q', commands: [credential] }])
    expect(built.findings.map((finding) => finding.rule)).toContain('credential')
  })

  it('the F8 guard vetoes MAC-carrying candidates — the OUI half and the host half never adjoin in source', () => {
    const mac = `arp static ${'00:1c:73' + ':00:00:'}${'05'}`
    const poisoned = viewFor(
      [row(mac, 'unsupported', ['arp'], { code: 1002, codeName: 'COMMAND_INVALID' })],
      [{ name: 'arp', display: 'unavailable', verdicts: ['unsupported'], reason: 'unsupported' }],
    )
    const built = buildExport(poisoned, [{ name: 'arp', commands: [mac] }])
    expect(built.findings.map((finding) => finding.rule)).toContain('mac')
  })
})

describe('summarize — the client\u2019s own counts, one clause per non-zero verdict', () => {
  it('no outcome says so plainly', () => {
    expect(summarize(undefined)).toBe('No probe has answered in this page load.')
  })
  it('counts only non-zero verdicts and flags inconclusive runs', () => {
    const line = summarize(outcome([
      row('a', 'supported', ['x']),
      row('b', 'config-locked', ['x']),
    ]))
    expect(line).toContain('1 supported, 1 config-locked')
    expect(line).not.toMatch(/\b0 /u)
    expect(line).toContain('2 candidate(s) in 1 batch(es); inconclusive run: true')
  })
})
