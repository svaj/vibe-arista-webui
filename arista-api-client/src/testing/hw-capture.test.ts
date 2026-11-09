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
  HW_PROBE_SESSION_PREFIX,
  hwCaseName,
  hwDeviceIdentity,
  hwProbeCaseName,
  hwProbePendingRevertSessions,
  hwProbeRetrySessionName,
  hwProbeRunTag,
  hwProbeSessionName,
  hwProbeTimerWaitMs,
  hwReadBackOutput,
  hwScratchReadBackCommand,
  parseHwProbeSpec,
  redactHwValue,
  resolveHwScratchToken,
  sanitizeHwRecording,
  selectHwProbeBatches,
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

  it('refuses a staged commit-session EXEC verb in any batch — those are lifecycle, not staged config', () => {
    // Why this fence exists at all: `commit <intf>`/`revert <intf>` are not staged config — they act on the
    // SESSION immediately, and the `<intf>` form implicitly saves to startup-config (DECISIONS DR-081), a
    // write no spec line could be reviewed for. `abort` staged would end the batch's own session early.
    for (const cmd of ['commit Ethernet22 verify', 'revert Ethernet22', 'abort', 'copy running-config session-config', '   commit Ethernet22 verify']) {
      for (const commitable of [true, false]) {
        const bad = { batches: [{ name: 'x', question: 'q', commands: ['interface {{SCRATCH}}', '   no shutdown', cmd], allowCommit: commitable }] }
        expect(() => parseHwProbeSpec(JSON.stringify(bad)), `${cmd} allowCommit=${String(commitable)}`).toThrow(/never belongs in `commands`/u)
      }
    }
  })

  it('carries commitWithRevertTimer through to the batch, refusing a timer this client cannot send', () => {
    const ok = { batches: [{ name: 'commit-timer', question: 'q', commands: ['interface {{SCRATCH}}', '   description T'], allowCommit: true, commitWithRevertTimer: '00:02:00' }] }
    expect(parseHwProbeSpec(JSON.stringify(ok)).batches[0]?.commitWithRevertTimer).toBe('00:02:00')
    for (const bad of ['2:00', '99 minutes', '00:00:00', '', '00:90:00']) {
      const spec = { batches: [{ ...ok.batches[0], commitWithRevertTimer: bad }] }
      expect(() => parseHwProbeSpec(JSON.stringify(spec)), JSON.stringify(bad)).toThrow(/commitWithRevertTimer/u)
    }
  })

  it('refuses a revert timer on a batch it may not commit (the fence is what bounds it)', () => {
    const bad = { batches: [{ name: 'x', question: 'q', commands: ['interface {{SCRATCH}}', '   description T'], allowCommit: false, commitWithRevertTimer: '00:02:00' }] }
    expect(() => parseHwProbeSpec(JSON.stringify(bad))).toThrow(/needs allowCommit: true/u)
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
    // It must also clear whatever the commit set writes, or a crash mid-commit-set leaves the operator's
    // port holding a mutation with no re-state line (DR-135: run 2 stranded `description
    // HW-CAPTURE-PROBE` on Ethernet22 exactly this way).
    const restore = spec.batches.find((batch) => batch.name === 'scratch-restore')
    expect(restore?.commands.map((cmd) => cmd.trim())).toContain('no description')
    // REV 5 (run 5, DR-137): the restore is now EXACTLY the two no-lines the box staged cleanly inside
    // the refused session — `no description` + `no mtu` are both device-verified (the 1002 came on the
    // NEXT token). The old `switchport mode auto` line was this repo's invention, and its refusal
    // (1002, token 2: 'auto') skipped the restore commit for the third run in a row: no probe run has
    // ever COMMITTED a switchport-mode change (the mode-changing batches all aborted, and the
    // restore-order batch staged the defaults and diffed 0 lines), so the restore never carries one.
    expect(restore?.commands).toEqual(['interface {{SCRATCH}}', '   no description', '   no mtu'])
    expect(spec.batches.flatMap((batch) => batch.commands).some((cmd) => /switchport mode auto/iu.test(cmd))).toBe(false)
    // REV 5 (run 5, DR-137): the restore is now EXACTLY the two no-lines the box staged cleanly inside
    // the refused session — `no description` + `no mtu` are both device-verified (the 1002 came on the
    // NEXT token). The old `switchport mode auto` line was this repo's invention, and its refusal
    // (1002, token 2: 'auto') skipped the restore commit for the third run in a row: no probe run has
    // ever COMMITTED a switchport-mode change (the mode-changing batches all aborted, and the
    // restore-order batch staged the defaults and diffed 0 lines), so the restore never carries one.
    expect(restore?.commands).toEqual(['interface {{SCRATCH}}', '   no description', '   no mtu'])
    expect(spec.batches.flatMap((batch) => batch.commands).some((cmd) => /switchport mode auto/iu.test(cmd))).toBe(false)
    // The restore batch must be LAST: it is the net-zero guarantee for everything the commit set leaves
    // behind, including a revert that never fires (run 2 left `description HW-CAPTURE-PROBE` on the port
    // because a crash skipped it).
    expect(spec.batches.at(-1)?.name).toBe('scratch-restore')
    // DR-136 follow-up: the timed batch has to run BEFORE the restore (the lane waits its deadline out,
    // and the restore then clears whatever the box left applied), and the spec timer must be short enough
    // that the lane actually waits it — otherwise the config lock would still be held when the next batch
    // opened.
    const timed = spec.batches.find((batch) => batch.commitWithRevertTimer !== undefined)
    expect(timed?.name).toBe('commit-timer')
    expect(timed?.allowCommit, 'a revert timer is only legal on a commit batch').toBe(true)
    expect(hwProbeTimerWaitMs(timed?.commitWithRevertTimer ?? '00:00:00'), 'the lane must be able to sit out this timer before touching the port again').toBeDefined()
    expect(spec.batches.findIndex((batch) => batch.name === 'commit-timer')).toBeLessThan(spec.batches.findIndex((batch) => batch.name === 'scratch-restore'))
    // DR-134 pin (first probe run, 2026-11-08): the REV-1 restore batch carried a committed
    // `no switchport`, which would have STRANDED the scratch port routed — its pre-session state has
    // been L2-by-default since the default the lab read left. A committed restore line may never
    // take the port out of the class the operator declared it in.
    for (const batch of commitBatches) {
      for (const cmd of batch.commands) {
        expect(cmd.trim().toLowerCase(), `restore batch ${batch.name} would re-class the scratch port: ${JSON.stringify(cmd)}`).not.toBe('no switchport')
      }
    }
    // DR-134 granularity: EOS stops a staged batch at the first refused line, so a multi-question
    // batch silently loses every question queued behind a refusal — which is exactly how run 1 died
    // (`switchport trunk allowed vlan only …` 1002 masked the routed-conversion line). Each refused
    // sub-question earns its OWN batch name -> its own recording.
    expect(spec.batches.some((batch) => batch.name === 'trunk-allowed-only')).toBe(true)
    // The same failure hit run 2 through the one batch REV 2 left unsplit: `vlan 4090 name …` was
    // refused first and the SVI/VRRP/ip-routing questions behind it were never asked (DR-135). REV 3
    // splits them, one NEW line per batch with only already-accepted context above it.
    const names = new Set(spec.batches.map((batch) => batch.name))
    expect(names.has('vlans-vrrp-iprouting'), 'the masked multi-question batch must not come back').toBe(false)
    for (const splitName of ['vlan-inline-name', 'vlan-block-form', 'vlan-interface-ip', 'vlan-interface-vrrp', 'ip-routing']) {
      expect(names.has(splitName), `rev-3 split batch ${splitName} is missing`).toBe(true)
    }
    // A staged VLAN/VLAN-interface batch must never be committed: parseHwProbeSpec bounds commits to
    // the scratch interface, and these batches sit OUTSIDE it on purpose (abort-only answers).
    for (const splitName of ['vlan-inline-name', 'vlan-block-form', 'vlan-interface-ip', 'vlan-interface-vrrp', 'vlan-interface-vrrp-ipv4', 'ip-routing']) {
      expect(spec.batches.find((batch) => batch.name === splitName)?.allowCommit, `${splitName} must stay abort-only`).toBe(false)
    }
    // REV 4 (run 4, DR-136): the box REFUSED the legacy VRRP spelling and named its replacement —
    // `vrrp 1 ip <addr>` -> `Unavailable command (This command is deprecated by 'vrrp ipv4')`. That is
    // exactly the arm this client composes on >= 4.21.3 (`src/resources/vrrp.ts:618`), and §3 may not
    // borrow the cEOS answer for it (DR-043), so the modern form gets its own batch.
    expect(names.has('vlan-interface-vrrp-ipv4'), 'the modern-spelling VRRP follow-up is missing').toBe(true)
    const vrrpModern = spec.batches.find((batch) => batch.name === 'vlan-interface-vrrp-ipv4')
    expect(vrrpModern?.commands.map((cmd) => cmd.trim())).toContain('vrrp 1 ipv4 169.254.90.7')
    // §3's `commit timer` line lives in this lane now: a revert timer is armed by a COMMIT, so it can only
    // be asked where commits are legal — and it must be fenced and ordered like one.
    expect(names.has('commit-timer'), 'the commit-timer batch is missing').toBe(true)
    expect(spec.batches.length).toBeGreaterThanOrEqual(17)
  })
})

describe('the post-commit scratch read-back (hardware-verified command spelling)', () => {
  it('sends the PLURAL `interfaces` keyword — the SKU answered the singular form 1002', () => {
    // Live evidence, 2026-11-08 run 2: `show running-config interface Ethernet22` =>
    // Error [1002] … "% Incomplete token (at token 2: 'interface')", one statement AFTER a successful
    // commit. Arista's own system suite uses the plural (`test_api_interfaces.py:202,:239,:283`).
    expect(hwScratchReadBackCommand('Ethernet22')).toBe('show running-config interfaces Ethernet22')
  })

  it('never emits a bare `show running-config …` for an empty interface name', () => {
    expect(() => hwScratchReadBackCommand('')).toThrow(/non-empty interface/u)
  })
})

describe('hwReadBackOutput — the exec-item unwrap run 5 proved necessary (DR-137)', () => {
  // Run 5's console prints claimed "scratch block 0 line(s); markers … none" after successful commits,
  // while the batch recordings held the exact lines quoted below. The harness had been reading
  // `.output` on the WRONG level: node.exec answers one item per command (the composed `enable` gets
  // one too) and each device reply is wrapped in `result`. These shapes are copied from the run 5
  // captures, because the old prints would have passed no fixture but the truth is in the recording.
  const block = 'interface Ethernet22\n   description HWPROBE-TIMER\n   mtu 9214'

  it('unwraps the exec item shape { result: { output } }', () => {
    expect(hwReadBackOutput({ result: { output: block } })).toBe(block)
  })

  it('also answers for bare wire/fixture shapes and the text key', () => {
    expect(hwReadBackOutput({ output: block })).toBe(block)
    expect(hwReadBackOutput({ result: { text: block } })).toBe(block)
  })

  it('the enable echo and missing replies read as empty, honestly', () => {
    expect(hwReadBackOutput({})).toBe('')
    expect(hwReadBackOutput({ result: {} })).toBe('')
    expect(hwReadBackOutput(undefined)).toBe('')
  })
})

describe('hwReadBackOutput — the exec-item unwrap run 5 proved necessary (DR-137)', () => {
  // Run 5's console prints claimed "scratch block 0 line(s); markers … none" after successful commits,
  // while the batch recordings held the exact lines quoted below. The harness had been reading
  // `.output` on the WRONG level: node.exec answers one item per command (the composed `enable` gets
  // one too) and each device reply is wrapped in `result`. These shapes are copied from the run 5
  // captures, because the old prints would have passed no fixture but the truth is in the recording.
  const block = 'interface Ethernet22\n   description HWPROBE-TIMER\n   mtu 9214'

  it('unwraps the exec item shape { result: { output } }', () => {
    expect(hwReadBackOutput({ result: { output: block } })).toBe(block)
  })

  it('also answers for bare wire/fixture shapes and the text key', () => {
    expect(hwReadBackOutput({ output: block })).toBe(block)
    expect(hwReadBackOutput({ result: { text: block } })).toBe(block)
  })

  it('the enable echo and missing replies read as empty, honestly', () => {
    expect(hwReadBackOutput({})).toBe('')
    expect(hwReadBackOutput({ result: {} })).toBe('')
    expect(hwReadBackOutput(undefined)).toBe('')
  })
})

describe('probe session names (the DR-136 opener-refusal retry)', () => {
  it('builds the canonical greppable name from a batch name', () => {
    expect(hwProbeSessionName('trunk-groups')).toBe(`${HW_PROBE_SESSION_PREFIX}trunk-groups`)
  })

  it('names a refused batch retryably: distinct from the canonical name, same prefix, inside the length cap', () => {
    const canonical = hwProbeSessionName('scratch-description')
    const retry = hwProbeRetrySessionName('scratch-description', hwProbeRunTag(1_794_189_394_635))
    expect(retry).not.toBe(canonical)
    expect(retry.startsWith(HW_PROBE_SESSION_PREFIX)).toBe(true)
    // The longest legal spec batch name (parser: [a-z0-9][a-z0-9-]{0,39}) plus prefix, separator and tag still
    // fits this client's own session-name cap, so the retry can never be refused by assertSessionName.
    const longest = hwProbeRetrySessionName('a'.repeat(40), 'zzzzzzzz')
    expect(longest.length).toBeLessThanOrEqual(64)
    expect(longest).toMatch(/^[a-z0-9-]+$/u)
  })

  it('refuses a run tag with nothing alphanumeric in it, instead of building a name the guard may reject', () => {
    expect(() => hwProbeRetrySessionName('x', '---')).toThrow(/non-empty alphanumeric/u)
  })

  it('refuses a batch name the spec parser itself would refuse', () => {
    for (const bad of ['', 'Bad-Name', 'has space', 'x'.repeat(41)]) {
      expect(() => hwProbeSessionName(bad), bad).toThrow(/spec batch name/u)
    }
  })
})

describe('the revert-timer wait window', () => {
  it('waits out a short timer with slack, and refuses to wait out a long or zero one', () => {
    expect(hwProbeTimerWaitMs('00:02:00')).toBe((120 + 15) * 1000)
    expect(hwProbeTimerWaitMs('00:00:00')).toBeUndefined()
    expect(hwProbeTimerWaitMs('01:00:00')).toBeUndefined()
    expect(hwProbeTimerWaitMs('00:00:00')).toBeUndefined()
  })

  it('refuses a timer this client could not have sent', () => {
    for (const bad of ['2:00', '24:00:00', '99 minutes', '']) {
      expect(() => hwProbeTimerWaitMs(bad), bad).toThrow(/HH:MM:SS/u)
    }
  })

  it('reports the session table in the shape §3 reads it', () => {
    const pending = [{ name: 'commit timer conflict', state: 'pending-revert', commitBy: 2 }, { name: 'closed', state: 'completed' }]
    expect(hwProbePendingRevertSessions(pending as never)).toEqual([{ name: 'commit timer conflict', state: 'pending-revert' }, { name: 'closed', state: 'completed' }])
  })
})

describe('the resume filter for a partially completed switch day', () => {
  const batches: readonly { name: string; question: string; commands: readonly string[]; allowCommit: boolean }[] = [
    { name: 'scratch-description', question: 'q', commands: ['interface {{SCRATCH}}', '   description X'], allowCommit: true },
    { name: 'scratch-mtu', question: 'q', commands: ['interface {{SCRATCH}}', '   mtu 9214'], allowCommit: true },
    { name: 'scratch-restore', question: 'q', commands: ['interface {{SCRATCH}}', '   no description'], allowCommit: true },
  ]

  it('runs everything when the filter is absent or blank', () => {
    expect(selectHwProbeBatches(batches, undefined).map((b) => b.name)).toEqual(['scratch-description', 'scratch-mtu', 'scratch-restore'])
    expect(selectHwProbeBatches(batches, '   ').map((b) => b.name)).toEqual(['scratch-description', 'scratch-mtu', 'scratch-restore'])
  })

  it('selects the named batches but keeps the SPEC order, restore last', () => {
    expect(selectHwProbeBatches(batches, 'scratch-restore,scratch-mtu').map((b) => b.name)).toEqual(['scratch-mtu', 'scratch-restore'])
  })

  it('refuses an unknown batch name instead of silently skipping the one intended', () => {
    // Silent no-ops are how a half-restored port survives a switch day on a physical device.
    expect(() => selectHwProbeBatches(batches, 'scratch-descrption')).toThrow(/does not have/u)
    expect(() => selectHwProbeBatches(batches, 'scratch-descrption')).toThrow(/scratch-description, scratch-mtu, scratch-restore/u)
  })
})
