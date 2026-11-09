/**
 * Offline unit tests for the hardware-capture policy layer (#14 §3) — `npm test` only, no device.
 *
 * These pin the three promises the hardware lane makes before any switch session is ever run:
 *  1. the batch-1 catalog is safe-by-construction (read-only commands, unique reviewable case names
 *     that pass the recording-tree naming rule, identity first);
 *  2. the scrubber rewrites exactly what a *physical* device leaks beyond the lab lane (MACs anywhere,
 *     serials, secret material, PEM, operator strings) and rewrites nothing else (positional numbers,
 *     route targets, interface names survive);
 *  3. the probe-spec parser refuses mutations the locked decision forbids — commits only via the
 *     `{{SCRATCH}}` token, listener/user/management-path/ZTP/rollback/replace/persistence refused
 *     everywhere — and each refusal *names* its cause (the operator reviews this file, not a live editor).
 */

import { describe, expect, it } from 'vitest'

import { findUnredactedEnableInput } from './recording'
import { REDACTED } from '../internal/redact'
import {
  HW_INVENTORY_CATALOG,
  HW_INVENTORY_SCENARIO,
  HW_SESSION_SCENARIO,
  HW_TEXT_SCENARIO,
  HW_ZEROED_MAC,
  hwCaseName,
  hwDeviceIdentity,
  hwProbeCaseName,
  parseHwProbeSpec,
  redactHwValue,
  resolveHwScratchToken,
  sanitizeHwRecording,
  type HwRedactOptions,
} from './hw-capture'

describe('batch-1 catalog shape (read-only by construction)', () => {
  it('every command is a show — the lane has no write verb at all', () => {
    for (const entry of HW_INVENTORY_CATALOG) {
      expect(entry.cmd.trim().toLowerCase()).toMatch(/^show\s/u)
    }
  })

  it('case names are unique and satisfy the recording-tree naming rule (<command>--<scenario>)', () => {
    const caseName = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?--[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u
    const seen = new Set<string>()
    for (const entry of HW_INVENTORY_CATALOG) {
      const scenario = entry.scenario === 'text' ? HW_TEXT_SCENARIO : HW_INVENTORY_SCENARIO
      const name = hwCaseName(entry.cmd, scenario)
      expect(name).toMatch(caseName)
      expect(seen.has(name)).toBe(false)
      seen.add(name)
    }
  })

  it('the mirrored families keep file-for-file parity with the cEOS capture set', () => {
    const commands = new Set(HW_INVENTORY_CATALOG.map((entry) => entry.cmd))
    // Spot-check the parity anchors called out in STATUS.md §3 / the cEOS fixture names:
    for (const cmd of ['show version', 'show interfaces status', 'show configuration sessions', 'show ip access-lists', 'show running-config']) {
      expect(commands.has(cmd)).toBe(true)
    }
  })

  it('identity is the first capture — the slug every later file belongs to derives from it', () => {
    expect(HW_INVENTORY_CATALOG[0]?.cmd).toBe('show version')
  })
})

describe('case naming + identity', () => {
  it('spells command text into the lab-fixture style', () => {
    expect(hwCaseName('show interfaces status')).toBe('show-interfaces-status--hw-inventory')
    expect(hwCaseName('show management api http-commands https certificate', HW_TEXT_SCENARIO)).toBe('show-management-api-http-commands-https-certificate--hw-text')
    expect(() => hwCaseName('!!')).toThrow(/name-safe/u)
  })

  it('derives the 7050tx-64 slug from the device report, class hardware, provenance captured', () => {
    const identity = hwDeviceIdentity({ version: '4.28.13.1M', modelName: 'DCS-7050TX-64' })
    expect(identity.slug).toBe('7050tx-64-4.28.13.1M')
    expect(identity.targetClass).toBe('hardware')
    expect(identity.provenance).toBe('captured')
  })

  it('refuses to file a container answer under a hardware slug (targetSlug contradiction)', () => {
    expect(() => hwDeviceIdentity({ version: '4.28.14M', modelName: 'cEOS Lab' })).toThrow(/contradiction|lab slug/u)
  })

  it('probe case names embed the batch and the fixed scenario', () => {
    expect(hwProbeCaseName('scratch-l2')).toBe(`configure-session-scratch-l2--${HW_SESSION_SCENARIO}`)
    expect(hwCaseName('configure session scratch-l2', HW_SESSION_SCENARIO)).toBe('configure-session-scratch-l2--hw-session-probe')
  })
})

describe('the hardware scrubber', () => {
  const opts: HwRedactOptions = { extraSecrets: ['sw-lab-1', '10.20.0.0'] }

  it('zeroes MAC-shaped whole values wherever they sit, not only under mac-named keys', () => {
    const { value, log } = redactHwValue({ bridgeAddress: 'aa:bb:cc:dd:ee:ff', systemId: { mac: '01:23:45:67:89:ab' } }, opts)
    expect(value).toEqual({ bridgeAddress: HW_ZEROED_MAC, systemId: { mac: HW_ZEROED_MAC } })
    expect(log.filter((entry) => entry.rule === 'mac')).toHaveLength(2)
  })

  it('replaces MACs embedded inside longer strings', () => {
    const { value, log } = redactHwValue('lacp system id 02:00:64:9a:3d:01 priority 32768', opts)
    expect(value).toBe(`lacp system id ${'00:00:00:00:00:00'} priority 32768`)
    expect(log.some((entry) => entry.rule === 'mac')).toBe(true)
  })

  it('scrubs serial-shaped values only under serial-named keys — positional numbers survive', () => {
    const { value, log } = redactHwValue({ serialNumber: 'S45022730018', mfgHours: 41723, memberId: '101' }, opts)
    expect(value).toEqual({ serialNumber: '<hw-redacted-serial>', mfgHours: 41723, memberId: '101' })
    expect(log.filter((entry) => entry.rule === 'serial')).toHaveLength(1)
  })

  it('rewrites secret sha512/md5 material and multi-block PEM armour in config text', () => {
    const text = [
      'username api priv 15 secret sha512 $6$abcdefghijklmnop',
      'line con 0 password 7 0822455D7A',
      'certificate:\n-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n-----BEGIN RSA PRIVATE KEY-----\n\n-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const { value, log } = redactHwValue(text, opts)
    expect(String(value)).toContain('secret sha512 <hw-redacted-secret>')
    expect(String(value)).not.toContain('$6$abcdefghijklmnop')
    expect(String(value)).toContain('<hw-redacted-pem>')
    expect(String(value)).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(log.filter((entry) => entry.rule === 'pem')).toHaveLength(1)
    expect(log.some((entry) => entry.rule === 'secret')).toBe(true)
  })

  it('replaces every occurrence of the operator extras, without echoing them into the log', () => {
    const { value, log } = redactHwValue({ hostname: 'sw-lab-1', addr: ['10.20.0.0', '10.20.0.5'] }, opts)
    // Exact-literal replacement only: the `/24` literal does not touch the `.5` sibling.
    expect(value).toEqual({ hostname: '<hw-redacted>', addr: ['<hw-redacted>', '10.20.0.5'] })
    const rendered = JSON.stringify(log)
    expect(rendered).not.toContain('sw-lab-1')
    expect(rendered).not.toContain('10.20.0.0')
  })

  it('leaves ordinary model output untouched (route targets, interfaces, numbers)', () => {
    const untouched = {
      vrfs: { default: { routeRoutes: { '10.10.0.0/24': { nextHops: { 0: { interface: 'Ethernet1', nexthopAddr: '10.10.0.2' } }, nextHopCount: 1 } } } },
      interfaces: [['Ethernet1', 'eth1', 'connected', 'sfp is present', 'rplca', 0, 0, 0, 'none', 'a1:00.0, 2:00.0, 3:00.0', '']],
    }
    const { value, log } = redactHwValue(structuredClone(untouched), {})
    expect(value).toEqual(untouched)
    expect(log).toHaveLength(0)
  })

  it('scrubs secret material in object KEYS — running-config JSON keys every config line (DR-133)', () => {
    // The exact shape the first executed hardware capture produced: EOS answers `show
    // running-config` (json) as `cmds: { "<line>": … }`, so the config LINE is a key and the
    // value-only walk left a live `secret sha512 $6$…` hash sitting in the committed-ready file
    // while the identical rule fired on the text-form capture of the same command.
    const cmds = {
      'username svaj privilege 15 role ops secret sha512 $6$hcWmOI0ESIx6ZamW$hVVtEa.SURVIVINGSAMPLEHASH': null,
      'username max-length 255': null,
      'interface Management1': { '  ip address 10.20.0.7/24': null },
    }
    const { value, log } = redactHwValue({ cmds }, opts)
    const rendered = JSON.stringify(value)
    expect(rendered).toContain('secret sha512 <hw-redacted-secret>')
    expect(rendered).not.toContain('hcWmOI0ESIx6ZamW')
    expect(rendered).not.toContain('SURVIVINGSAMPLEHASH')
    // extras fire on keys too (the section child line carries an operator-scrubbed address).
    expect(rendered).not.toContain('10.20.0.0')
    // The log names the rule but never carries the raw key text (the KEY *is* the secret here).
    const secretEntries = log.filter((entry) => entry.rule === 'secret')
    expect(secretEntries.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(log)).not.toContain('hcWmOI0ESIx6ZamW')
  })

  it('a scrubbed-key collision keeps both entries instead of silently dropping one (DR-133)', () => {
    // Two usernames whose scrubbed forms would land on one JSON key: the device's own map was
    // unique, so losing a neighbouring entry to our scrub is a corruption we must not cause.
    const { value } = redactHwValue({
      'aaa secret sha512 $6$firsthashfirsthashfirst': 1,
      'aaa secret sha512 $6$secondhashsecondhashsecon': 2,
    }, {})
    const keys = Object.keys(value as Record<string, unknown>)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    expect(Object.values(value as Record<string, unknown>)).toEqual([1, 2])
  })

  it('scrubs the identity envelope free-text (endpoint mgmt address) but keeps match fields verbatim', () => {
    // The physical switch's management address appears in EVERY file's identity.endpoint; an extras
    // literal that scrubbed inside captures had to scrub there too (TESTING.md:131). The fields
    // assertFixtureIdentity/loadRecordingFor compare must stay byte-identical.
    const fixture = {
      format: 'arista-eapi-recording/v1' as const,
      identity: {
        targetSlug: '7050tx-64-r-4.28.13.1M',
        targetClass: 'hardware' as const,
        modelName: 'DCS-7050TX-64-R',
        aristaVersion: '4.28.13.1M',
        versionNumber: '4.28.13.1',
        provenance: 'captured' as const,
        endpoint: 'https://10.20.0.0:443/command-api',
        topology: 'supervised sw-lab-1 session; single device',
      },
      captures: [{ requestId: 'r-1', commands: ['show version'], result: [{}], format: 'json' as const }],
      incomplete: [],
    }
    const out = sanitizeHwRecording(fixture, opts)
    expect(out.fixture.identity.endpoint).toBe('https://<hw-redacted>:443/command-api')
    expect(out.fixture.identity.topology).toBe('supervised <hw-redacted> session; single device')
    expect(out.fixture.identity.modelName).toBe('DCS-7050TX-64-R')
    expect(out.fixture.identity.aristaVersion).toBe('4.28.13.1M')
    expect(out.fixture.identity.targetSlug).toBe('7050tx-64-r-4.28.13.1M')
    expect(out.log.some((entry) => entry.path === '$.identity.endpoint' && entry.rule === 'extra')).toBe(true)
  })

  it('sanitizes a built recording end-to-end and keeps replayable structure + enable gating', () => {
    const fixture = {
      format: 'arista-eapi-recording/v1' as const,
      identity: {
        targetSlug: '7050tx-64-4.28.13.1M',
        targetClass: 'hardware' as const,
        modelName: 'DCS-7050TX-64',
        aristaVersion: '4.28.13.1M',
        versionNumber: '4.28.13.1',
        provenance: 'captured' as const,
      },
      captures: [
        {
          requestId: 'r-1',
          commands: [{ cmd: 'enable', input: REDACTED }, 'show interfaces'],
          result: [{ interfaces: { Ethernet1: { macAddress: '02:00:64:9a:3d:01', mtu: 1500 } } }],
          format: 'json' as const,
        },
      ],
      incomplete: [],
    }
    const out = sanitizeHwRecording(fixture, opts)
    const capture = out.fixture.captures[0]
    expect(capture?.commands).toEqual([{ cmd: 'enable', input: REDACTED }, 'show interfaces'])
    expect(JSON.stringify(capture?.result)).toContain(HW_ZEROED_MAC)
    expect(JSON.stringify(capture?.result)).not.toContain('02:00:64:9a:3d:01')
    expect(capture?.format).toBe('json')
    expect(out.log.length).toBeGreaterThan(0)
    // The recorder's own gate still passes (enable input stayed REDACTED through our walk).
    expect(findUnredactedEnableInput(out.fixture)).toEqual([])
  })

  it('rewrites a leaked enable input NOT at all — the writer gate below is the loudest failure', () => {
    // Deliberate division of labour (documented on sanitizeHwRecording): we do not rewrite `input`;
    // `recordingText`/`parseRecording` refuse such a fixture. Assert the *policy*, not the failure text.
    const bad = { cmd: 'enable', input: 'hunter2' }
    const out = sanitizeHwRecording(
      { format: 'arista-eapi-recording/v1', identity: { targetSlug: 'x-lane-test', targetClass: 'hardware', modelName: 'X', aristaVersion: '1', versionNumber: '1', provenance: 'captured' }, captures: [{ requestId: 'r', commands: [bad] }], incomplete: [] },
      {},
    )
    expect(findUnredactedEnableInput(out.fixture)).not.toEqual([])
  })
})

describe('the probe-spec parser (policy made mechanical)', () => {
  const base = {
    batches: [
      { name: 'scratch-l2', question: 'does the TX-64 answer trunk-group writes?', commands: ['interface {{SCRATCH}}', '   switchport mode trunk'], allowCommit: true },
      { name: 'abort-only-mtu', question: 'jumbo rejections?', commands: ['interface {{SCRATCH}}', '   mtu 9214'], allowCommit: false },
    ],
  }

  it('accepts a spec whose commit batches are all scratch-scoped', () => {
    const spec = parseHwProbeSpec(JSON.stringify(base))
    expect(spec.batches.map((b) => b.name)).toEqual(['scratch-l2', 'abort-only-mtu'])
    expect(resolveHwScratchToken(base.batches[0]?.commands ?? [], 'Ethernet44')).toEqual(['interface Ethernet44', '   switchport mode trunk'])
  })

  it('refuses an allowCommit batch with any command outside the scratch interface', () => {
    const bad = { batches: [{ ...base.batches[0], commands: ['vlan 10', '   name PROBE'] }] }
    expect(() => parseHwProbeSpec(JSON.stringify(bad))).toThrow(/allowCommit.*SCRATCH|SCRATCH.*allowCommit/u)
  })

  it('refuses listener/user/management-path/ZTP/rollback/replace lines everywhere, abort-only included', () => {
    for (const cmd of ['management api http-commands no shutdown', 'username probe priv 15 secret sha512 x', ' Management1 ip address dhcp', 'ztp run', 'rollback clean-config', 'configure replace flash:x.cfg']) {
      const bad = { batches: [{ name: 'x', question: 'q', commands: [cmd], allowCommit: false }] }
      expect(() => parseHwProbeSpec(JSON.stringify(bad)), cmd).toThrow(/is refused on the hardware probe lane/u)
    }
  })

  it('refuses persistence lines like the live lane does (DR-035(c) needs no container)', () => {
    const bad = { batches: [{ name: 'x', question: 'q', commands: ['copy running-config startup-config'], allowCommit: false }] }
    expect(() => parseHwProbeSpec(JSON.stringify(bad))).toThrow(/persistence/u)
  })

  it('names the failing batch/field in every structural refusal, and rejects duplicate batch names', () => {
    expect(() => parseHwProbeSpec('{"batches":[]}')).toThrow(/non-empty `batches`/u)
    expect(() => parseHwProbeSpec(JSON.stringify({ batches: [{ name: 'BAD NAME', question: 'q', commands: ['x'], allowCommit: false }] }))).toThrow(/batches\[0\]\.name/u)
    expect(() => parseHwProbeSpec(JSON.stringify({ batches: [{ name: 'ok', question: '   ', commands: ['x'], allowCommit: false }] }))).toThrow(/question/u)
    expect(() => parseHwProbeSpec(JSON.stringify({ batches: [{ name: 'ok', question: 'q', commands: [], allowCommit: false }] }))).toThrow(/commands/u)
    const dup = { batches: [base.batches[0], { ...base.batches[1], name: 'scratch-l2' }] }
    expect(() => parseHwProbeSpec(JSON.stringify(dup))).toThrow(/duplicate batch names/u)
  })

  it('refuses a whole malformed paste without echoing the offending command line', () => {
    const bad = { batches: [{ name: 'x', question: 'q', commands: ['username admin secret sha512 SUPERSECRETVALUE'], allowCommit: false }] }
    let message = ''
    try {
      parseHwProbeSpec(JSON.stringify(bad))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toContain('SUPERSECRETVALUE')
  })
})

describe('the committed draft probe spec is itself machine-checked (review-before-run)', () => {
  it('docs/hw-session-probes.draft.json parses under the same policy the live probe enforces', async () => {
    const { readFileSync } = await import('node:fs')
    const spec = parseHwProbeSpec(readFileSync(new URL('../../docs/hw-session-probes.draft.json', import.meta.url), 'utf8'))
    expect(spec.batches.length).toBeGreaterThanOrEqual(6)
    const commitBatches = spec.batches.filter((batch) => batch.allowCommit)
    expect(commitBatches.length).toBeGreaterThan(0)
    for (const batch of commitBatches) {
      expect(batch.commands[0]?.trim().toLowerCase()).toBe('interface {{scratch}}')
      for (const cmd of batch.commands.slice(1)) {
        expect(/^[ \t]/u.test(cmd), `commit batch ${batch.name} left the scratch context: ${JSON.stringify(cmd.split(/\s+/u)[0])}`).toBe(true)
      }
    }
    // A restore batch exists so committed probes are net-zero on the running switch.
    expect(spec.batches.some((batch) => batch.name.includes('restore') && batch.allowCommit)).toBe(true)
  })
})
