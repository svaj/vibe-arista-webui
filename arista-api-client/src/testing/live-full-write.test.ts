/**
 * Offline unit tests for the full-write lab wiring helper (#14 D2, DR-126) — `unit` project, no
 * device, no container (DR-034). These pin the two things the 12+ `test/system/*` ports rely on:
 * the composed skip gate (env → class → consent, in that order) and the transport seam firing
 * through a REAL facade (`node.vlans`) — the fence guarding the choke point is exactly what hand-
 * wired suites would each risk forgetting.
 */

import { describe, expect, it } from 'vitest'

import { mockTransport } from './mock-transport'
import { buildFullWriteNode, liveFullWriteReadiness } from './live-full-write'
import { unwrapLiveTarget, type LiveEnv } from './live-guard'
import { NotSupportedError } from '../errors'
import type { CommandResult } from '../types/eapi'

const ADDRESS = 'https://localhost:8443/command-api'

function labEnv(overrides: Record<string, string | undefined> = {}): LiveEnv {
  return {
    EAPI_LIVE: '1',
    EAPI_HOST: 'localhost',
    EAPI_PORT: '8443',
    EAPI_USER: 'eapi-lab',
    EAPI_PASS: 'lab-placeholder-not-a-secret',
    EAPI_TARGET_CLASS: 'lab',
    EAPI_ALLOW_MODEL: 'cEOS',
    EAPI_ALLOW_VERSION: '4.28.14M',
    EAPI_FINGERPRINT: 'AA:BB',
    EAPI_LAB_FULL_WRITE: '1',
    ...overrides,
  }
}

function hwEnv(): LiveEnv {
  return {
    EAPI_LIVE: '1',
    EAPI_HOST: 'switch-1.lab.example',
    EAPI_PORT: '443',
    EAPI_USER: 'eapi-capture',
    EAPI_PASS: 'hw-placeholder-not-a-secret',
    EAPI_TARGET_CLASS: 'hardware',
    EAPI_ALLOW_MODEL: 'DCS-7050TX-64',
    EAPI_ALLOW_VERSION: '4.28.13.1M',
    EAPI_HW_CONSENT: 'DCS-7050TX-64',
    EAPI_ALLOW_HOSTS: 'switch-1.lab.example',
    EAPI_ALLOW_PORTS: '443',
    EAPI_FINGERPRINT: 'AA:BB',
    EAPI_LAB_FULL_WRITE: '1',
  }
}

/** `{}` per wire command; the codec needs one reply each. */
function ack(count: number): CommandResult[] {
  return Array.from({ length: count }, () => ({}) as CommandResult)
}

describe('liveFullWriteReadiness — the composed gate (env → class → consent)', () => {
  it('runs on a complete lab env with the consent flag', () => {
    const gate = liveFullWriteReadiness(labEnv())
    expect(gate.runnable).toBe(true)
    expect(gate.skipReason).toBeUndefined()
  })

  it('missing consent skips loudly with the DR-126 reason, and a wrong flag value is missing consent', () => {
    expect(liveFullWriteReadiness(labEnv({ EAPI_LAB_FULL_WRITE: undefined })).skipReason).toMatch(/EAPI_LAB_FULL_WRITE=1/u)
    expect(liveFullWriteReadiness(labEnv({ EAPI_LAB_FULL_WRITE: 'yes' })).runnable).toBe(false)
  })

  it('a hardware env refuses the full-write lane even WITH the flag (the flag cannot cross class lanes)', () => {
    const gate = liveFullWriteReadiness(hwEnv())
    expect(gate.runnable).toBe(false)
    expect(gate.skipReason).toMatch(/hardware target/u)
  })

  it('an incomplete env keeps the guard refusal as the skip reason (env gate runs before the consent gate)', () => {
    const gate = liveFullWriteReadiness(labEnv({ EAPI_LIVE: undefined }))
    expect(gate.runnable).toBe(false)
    expect(gate.skipReason).toMatch(/EAPI_LIVE is not set/u)
  })
})

describe('buildFullWriteNode — the fence fires through the facade, at the seam, offline', () => {
  it('lets the legitimate full-write batch (a new VLAN) through the wrapper', async () => {
    const target = unwrapLiveTarget(liveFullWriteReadiness(labEnv()).resolution)
    const transport = mockTransport({ address: ADDRESS })
    transport.replies(['enable', 'configure terminal', 'vlan 4000'].join('\n'), ack(3))
    const node = buildFullWriteNode(target, { transport })
    await node.vlans.create(4000)
    expect(transport.sent()).toHaveLength(1)
  })

  it('rejects a self-lockout write BEFORE the mock transport sees a byte', async () => {
    const target = unwrapLiveTarget(liveFullWriteReadiness(labEnv()).resolution)
    const transport = mockTransport({ address: ADDRESS })
    const node = buildFullWriteNode(target, { transport })
    await expect(node.configure(['username admin privilege 15 secret SUPERSECRETVAL'])).rejects.toThrow(NotSupportedError)
    expect(transport.sent()).toHaveLength(0)
    // Same class of refusal for the listener line, and the in-use user of THIS run:
    await expect(node.configure(['no management api http-commands no shutdown'])).rejects.toThrow(/eAPI listener/u)
    await expect(node.configure(['username eapi-lab role network-api'])).rejects.toThrow(/self-lockout/u)
    expect(transport.sent()).toHaveLength(0)
  })

  it('reads never trip the fence (no config marker → no scan) and callMethod/kind/address pass through', async () => {
    const target = unwrapLiveTarget(liveFullWriteReadiness(labEnv()).resolution)
    const transport = mockTransport({ address: ADDRESS })
    // getConfig() asks for format:'text' (command-layer.ts:758), so the scripted reply carries
    // `output:` — the JSON runningConfig model belongs to the params form and would parse to nothing.
    // Two entries, one per WIRE command (the enable + the show): same rule as ack() in the sibling file.
    const configResult = [{}, { output: 'username admin secret sha512 $6$whatever\n!\n' }] as CommandResult[]
    transport.replies(['enable', 'show running-config all'].join('\n'), configResult)
    transport.replies(['enable', 'show running-config'].join('\n'), configResult)
    const node = buildFullWriteNode(target, { transport })
    await node.getRunningConfig()
    expect(transport.sent()).toHaveLength(1)
    expect(node.connection.kind).toBe(transport.kind)
    expect(node.connection.address).toBe(ADDRESS)
    expect(typeof node.connection.callMethod).toBe('function')
  })
})
