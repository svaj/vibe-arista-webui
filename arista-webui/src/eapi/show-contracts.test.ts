/**
 * Pins for M13's screen contracts (`src/eapi/show-contracts.ts`). Two layers, same as the client's
 * own fixture discipline:
 *
 * 1. **Type layer** — `expectTypeOf` on `ShowReply<key>` proves the augmentation actually lands on
 *    every M13 literal, and proves the literals that are NOT augmented (`lag`, and the USAGE.md §4
 *    probe `'lag counters'`) stay `unknown`, because an unmodelled command must be narrowed on
 *    purpose, not silently trusted.
 * 2. **Shape layer** — the payload literals below are **verbatim copies** of the recorded replies:
 *    the cEOS-lab 4.28.14M captures under `arista-api-client/test/fixtures/live/ceos-4.28.14M/`
 *    and the DCS-7050TX-64 / 4.28.13.1M capture under
 *    `arista-api-client/test/fixtures/show/show-version--4.28.13.1M-dcs-7050tx-64.json`, plus the
 *    `Ethernet1` status row preserved verbatim in
 *    `arista-api-client/src/resources/interfaces.test.ts` (`LAB_ROW_ETHERNET1`, captured before the
 *    2026-11-06 M12c re-run returned an empty `interfaceStatuses` map). Assigning each literal
 *    straight to `ShowReply<key>` makes the **compiler** check it: a contract that drifts from real
 *    device output fails `npm run typecheck`, and the runtime `expect` lines keep the copies honest.
 *    Nothing here contacts a switch (offline rule, DR-011).
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ShowReply } from '@devhax-heavy-industries/arista-eapi'

import type {
  ShowInterfaceStatusRow,
  ShowInterfacesStatusReply,
  ShowManagementApiHttpCommandsReply,
  ShowMlagReply,
  ShowVersionReply,
  ShowVlanEntry,
  ShowVlanReply,
} from './show-contracts'

type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

describe('the augmentation lands on every modelled M13 literal (ARCHITECTURE §9.1)', () => {
  it('each modelled command resolves to this file\'s contract, not to `unknown`', () => {
    expectTypeOf<Exactly<ShowReply<'version'>, ShowVersionReply>>().toEqualTypeOf<true>()
    expectTypeOf<Exactly<ShowReply<'interfaces status'>, ShowInterfacesStatusReply>>().toEqualTypeOf<true>()
    expectTypeOf<Exactly<ShowReply<'vlan'>, ShowVlanReply>>().toEqualTypeOf<true>()
    expectTypeOf<Exactly<ShowReply<'mlag'>, ShowMlagReply>>().toEqualTypeOf<true>()
    // S1 (#71) added the sixth literal; the spelling is the command with no `show ` prefix.
    expectTypeOf<Exactly<ShowReply<'management api http-commands'>, ShowManagementApiHttpCommandsReply>>().toEqualTypeOf<true>()
  })

  it('`show lag` stays unmodelled until a capture exists — no invented LAG shape (STATUS §3)', () => {
    expectTypeOf<ShowReply<'lag'>>().toEqualTypeOf<unknown>()
    expectTypeOf<ShowReply<'lag'>>().not.toBeAny()
    expectTypeOf<ShowReply<'lag counters'>>().toEqualTypeOf<unknown>()
    // @ts-expect-error - a LAG screen cannot read `.mtu` off a command this app has not captured
    const unmodelled: { mtu?: number } = {} as unknown as ShowReply<'lag'>
    expect(unmodelled).toEqual({})
  })
})

describe('the contracts accept the recorded device replies verbatim (compiler-side pins)', () => {
  // `arista-api-client/test/fixtures/show/show-version--4.28.13.1M-dcs-7050tx-64.json` (`result`-bare).
  const capVersion7050tx: ShowVersionReply = {
    hostname: 'sw1',
    version: '4.28.13.1M',
    systemMacAddress: '00:00:00:00:00:00',
    modelName: 'DCS-7050TX-64',
    serialNumber: '0000000000',
    aristaHardwareModel: 'DCS-7050TX-64',
    aristaHardwareVersion: '0.00',
    internalVersion: '4.28.13.1M',
    internalArch: 'ap48_h_-r4',
    architecture: 'x86_64',
    versionFormat: 'short',
    mem: 7934740,
    bootupTimestamp: 0,
    uptime: 0,
    uptimeString: '0:00:00',
    versionInfo: [{ version: 'eos4.28.13.1M.vmlinux', imageType: 'eroute', email: '', timestamp: '' }],
  }

  // `arista-api-client/test/fixtures/live/ceos-4.28.14M/show-version.json` → `result`.
  const capVersionCeos: ShowVersionReply = {
    imageFormatVersion: '1.0',
    cEosToolsVersion: '1.1',
    uptime: 35.9098596572876,
    modelName: 'cEOSLab',
    kernelVersion: '6.18.33.2-microsoft-standard-WSL2',
    internalVersion: '4.28.14M-50015774.42814M',
    memTotal: 65799848,
    mfgName: 'Arista',
    serialNumber: '',
    systemMacAddress: '00:00:00:00:00:00',
    bootupTimestamp: 1793981465.5379803,
    memFree: 49947136,
    version: '4.28.14M-50015774.42814M (engineering build)',
    configMacAddress: '00:00:00:00:00:00',
    isIntlVersion: false,
    imageOptimization: 'None',
    internalBuildId: '9ce2494c-255b-4104-b282-676994531323',
    hardwareRevision: '',
    hwMacAddress: '00:00:00:00:00:00',
    architecture: 'i686',
  }

  // `…/show-vlan.json` → `result`.
  const capVlan: ShowVlanReply = {
    sourceDetail: '',
    vlans: {
      '1': { status: 'active', name: 'default', interfaces: {}, dynamic: false },
    },
  }

  // `…/show-mlag.json` → `result`.
  const capMlag: ShowMlagReply = {
    localInterface: '',
    state: 'disabled',
    reloadDelay: 300,
    peerLink: '',
    dualPrimaryDetectionState: 'disabled',
    reloadDelayNonMlag: 300,
    mlagPorts: { 'Disabled': 0, 'Active-partial': 0, 'Inactive': 0, 'Configured': 0, 'Active-full': 0 },
    portsErrdisabled: false,
    dualPrimaryPortsErrdisabled: false,
  }

  // The 2026-11-06 capture of this command answered an empty map — that reply must type too.
  const capInterfacesStatusEmpty: ShowInterfacesStatusReply = { interfaceStatuses: {} }

  // `Ethernet1` row of the earlier capture of the same command, kept verbatim by the client suite.
  const capStatusRowEthernet1: ShowInterfaceStatusRow = {
    vlanInformation: { interfaceMode: 'bridged', vlanId: 1, interfaceForwardingModel: 'bridged' },
    bandwidth: 1000000000,
    interfaceType: 'EbraTestPhyPort',
    description: '',
    autoNegotiateActive: false,
    duplex: 'duplexFull',
    autoNegotigateActive: false,
    linkStatus: 'connected',
    lineProtocolStatus: 'up',
  }

  // Sibling `show interfaces` spelling the reader also accepts (pyeapi capture): same row type.
  const capStatusRowSiblingSpelling: ShowInterfaceStatusRow = {
    description: '',
    interfaceStatus: 'connected',
    lineProtocolStatus: 'up',
    mtu: 9216,
    hardware: 'ethernet',
  }
  const capInterfacesStatusSibling: ShowInterfacesStatusReply = { interfaces: { Management1: capStatusRowSiblingSpelling } }

  it('the 7050TX-64 version capture types, and its switch-only keys read', () => {
    expect(capVersion7050tx.hostname).toBe('sw1')
    expect(capVersion7050tx.modelName).toBe('DCS-7050TX-64')
    expect(capVersion7050tx.versionInfo).toHaveLength(1)
  })

  it('the cEOS-lab version capture types, and the screens required keys are the shared intersection', () => {
    expect(capVersionCeos.hostname).toBeUndefined()
    expect(capVersionCeos.mem).toBeUndefined()
    for (const reply of [capVersion7050tx, capVersionCeos]) {
      expect(typeof reply.version).toBe('string')
      expect(typeof reply.modelName).toBe('string')
      expect(typeof reply.systemMacAddress).toBe('string')
      expect(typeof reply.internalVersion).toBe('string')
      expect(typeof reply.architecture).toBe('string')
      expect(typeof reply.bootupTimestamp).toBe('number')
      expect(typeof reply.uptime).toBe('number')
    }
  })

  it('the vlan capture types with decimal-string map keys and an unknown-member map', () => {
    const entry = capVlan.vlans['1']
    expect(entry?.name).toBe('default')
    expect(entry?.dynamic).toBe(false)
    expectTypeOf(entry).toEqualTypeOf<ShowVlanEntry>()
    expect(entry?.interfaces).toEqual({})
  })

  it('the mlag capture types, keys present while MLAG is disabled', () => {
    expect(capMlag.state).toBe('disabled')
    expect(capMlag.mlagPorts['Active-full']).toBe(0)
    expect(capMlag.peerLink).toBe('')
  })

  // `…/recordings/7050tx-64-r-4.28.13.1M/show-management-api-http-commands--hw-inventory.json`,
  // capture 1's second `result` entry. Two deliberate departures from a byte-exact copy, both F8 (#70)
  // contract (d): the `users` map is empty here because the real capture keys it by the **operator's
  // login** with byte/counter values, and the endpoint host stays the capture lane's `<hw-redacted>`.
  // The key *shape* — `users` is an object, `urls` names `Management1` — is what the contract pins.
  const capMgmtApiHardware: ShowManagementApiHttpCommandsReply = {
    httpServer: { running: false, configured: false, port: 80 },
    users: {},
    bytesOut: 11620105,
    logLevel: 'none',
    dscpValue: 0,
    corsOrigins: [],
    hitCount: 75,
    vrf: 'default',
    lastHitTime: 1794184543.7545743,
    tlsProtocol: ['1.0', '1.1', '1.2'],
    localHttpServer: { running: false, configured: false, port: 8080 },
    executionTime: 68.98355392968551,
    enabled: true,
    fipsEnabled: false,
    httpsServer: { running: true, configured: true, port: 443 },
    requestCount: 66,
    vrfs: ['default'],
    urls: ['Management1 : https://<hw-redacted>:443'],
    unixSocketServer: { running: false, configured: false },
    bytesIn: 12169,
    commandCount: 172,
    iframeAncestors: [],
  }

  // `…/live/ceos-4.28.14M/show-management-api-http-commands.json` → `result`. Note the device pads the
  // interface token with SPACES before the colon — a screen parser cannot assume one space.
  const capMgmtApiCeos: ShowManagementApiHttpCommandsReply = {
    tlsProtocol: ['1.0', '1.1', '1.2'],
    urls: ['Vlan100     : https://10.0.100.1:443'],
    httpServer: { running: false, configured: false, port: 80 },
    users: {},
    localHttpServer: { running: false, configured: false, port: 8080 },
    executionTime: 0,
    dscpValue: 0,
    bytesOut: 0,
    enabled: true,
    fipsEnabled: false,
    httpsServer: { running: true, configured: true, port: 443 },
    corsOrigins: [],
    hitCount: 0,
    vrf: 'default',
    iframeAncestors: [],
    unixSocketServer: { running: false, configured: false },
    requestCount: 0,
    vrfs: ['default'],
    commandCount: 0,
    logLevel: 'none',
    bytesIn: 0,
  }

  it('both management-api captures type, and the serving interface is readable from each', () => {
    expect(capMgmtApiHardware.urls[0]).toContain('Management1')
    expect(capMgmtApiCeos.urls[0]).toContain('Vlan100')
    expect(capMgmtApiHardware.lastHitTime).toBeTypeOf('number')
    // The cEOS answer carries no `lastHitTime` key, so the contract cannot promise it.
    expect(capMgmtApiCeos.lastHitTime).toBeUndefined()
    for (const reply of [capMgmtApiHardware, capMgmtApiCeos]) {
      expect(reply.enabled).toBe(true)
      expect(reply.vrf).toBe('default')
      expect(reply.httpsServer.running).toBe(true)
      expect(Array.isArray(reply.urls)).toBe(true)
    }
    // @ts-expect-error - `urls` is a string list, not a map, so a screen cannot index it by interface
    const notAMap = capMgmtApiHardware.urls.Management1
    expect(notAMap).toBeUndefined()
  })

  it('both interface-status spellings type, empty map included', () => {
    expect(capInterfacesStatusEmpty.interfaceStatuses).toEqual({})
    expect(capInterfacesStatusSibling.interfaces?.Management1.interfaceStatus).toBe('connected')
    // @ts-expect-error - `.status` is the client's normalised column, not a device column in the raw reply
    const notARawColumn = capStatusRowEthernet1.status
    expect(notARawColumn).toBeUndefined()
    expect(capStatusRowEthernet1.linkStatus).toBe('connected')
    expect(capStatusRowEthernet1.autoNegotigateActive).toBe(false)
  })
})
