import { describe, expect, it } from 'vitest'
import type { ShowVersionReply } from '../eapi/show-contracts'

import { identityFrom } from './identity'

// The same verbatim capture shape `App.test.tsx` mocks for `node.show('version')`.
const switchReply: ShowVersionReply = {
  hostname: 'sw1',
  version: '4.28.13.1M',
  systemMacAddress: '00:00:00:00:00:00',
  modelName: 'DCS-7050TX-64',
  serialNumber: '0000000000',
  internalVersion: '4.28.13.1M',
  architecture: 'x86_64',
  bootupTimestamp: 0,
  uptime: 0,
}

// The cEOS-lab 4.28.14M capture shape: no `hostname` key at all, which is exactly why the fallback
// exists (`src/eapi/show-contracts.ts` models `hostname` as hardware-capture-only).
const labReply: ShowVersionReply = {
  version: '4.28.14M-50015774.42814M',
  systemMacAddress: '00:1c:73:00:00:00',
  modelName: 'cEOSLab',
  serialNumber: '',
  internalVersion: '4.28.14M-50015774.42814M',
  architecture: 'i686',
  bootupTimestamp: 0,
  uptime: 0,
}

describe('identityFrom', () => {
  it('takes hostname, version and model from a switch `show version` reply', () => {
    expect(identityFrom(switchReply)).toEqual({ hostname: 'sw1', version: '4.28.13.1M', model: 'DCS-7050TX-64' })
  })

  it('falls back to modelName when the reply carries no hostname', () => {
    expect(identityFrom(labReply)).toEqual({ hostname: 'cEOSLab', version: '4.28.14M-50015774.42814M', model: 'cEOSLab' })
  })

  it('keeps an explicitly configured hostname rather than the model in either capture', () => {
    const named: ShowVersionReply = { ...labReply, hostname: 'ceos01' }

    expect(identityFrom(named).hostname).toBe('ceos01')
    expect(identityFrom(named).model).toBe(labReply.modelName)
  })

  it('never substitutes a device string the reply did not carry', () => {
    // `version` is required in every capture, so the chip version is always the device's own string —
    // including an engineering-build spelling, which is passed through unmodified.
    expect(identityFrom(labReply).version).toBe('4.28.14M-50015774.42814M')
    expect(identityFrom(switchReply).model).toBe('DCS-7050TX-64')
  })

  it('treats an empty-ish hostname as present, since only absence triggers the fallback', () => {
    // `??` not `||`: an empty `hostname` string is the device's answer, and inventing the model name
    // in its place would be a claim about the device. F6/#68 keeps this distinction.
    const blank: ShowVersionReply = { ...switchReply, hostname: '' }

    expect(identityFrom(blank).hostname).toBe('')
  })
})
