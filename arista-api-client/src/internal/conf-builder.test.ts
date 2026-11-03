/**
 * The entry-parameterised factory core — M3 (#5). `src/index.test.ts` and `src/node.test.ts` cover
 * the two public entry surfaces; this file covers the seams they share but cannot reach directly:
 * the exported `connectionFromProfile`/`nodeFromProfile` helpers (index re-exports them, so they are
 * a contract), the profile-**object** bag's unknown-key refusal, and the settings-merge precedence
 * an entry test only exercises one way.
 */

import { describe, expect, it } from 'vitest'

import {
  connectionFromProfile,
  nodeFromOptions,
  nodeFromProfile,
  profileNotFound,
} from './conf-builder'
import { createTransport } from '../transports/create'
import { createProfiles, ProfileStore } from '../profiles'
import { Node } from '../command-layer'
import { NotSupportedError } from '../errors'
import type { ConnectionProfile } from '../profiles'

function requireProfile(store: ProfileStore, name: string): ConnectionProfile {
  const profile = store.get(name)
  if (profile === undefined) throw new Error(`test setup: profile ${JSON.stringify(name)} is not in the store`)
  return profile
}

function failureMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to throw, but it returned normally')
}

describe('the exported profile-object helpers', () => {
  const store = (): ProfileStore =>
    createProfiles({ lab: { transport: 'https', host: '10.0.0.30', username: 'ui', password: 'unused-in-tests', enablepwd: 'from-file' } })

  it('connectionFromProfile builds a transport, with overrides layered on', () => {
    const transport = connectionFromProfile(requireProfile(store(), 'lab'), createTransport, 'browser')
    expect(transport.address).toBe('https://10.0.0.30:443/command-api')
    const retargeted = connectionFromProfile(requireProfile(store(), 'lab'), createTransport, 'browser', { host: '10.0.0.99' })
    expect(retargeted.address).toBe('https://10.0.0.99:443/command-api')
  })

  it('nodeFromProfile merges settings: caller wins, profile fills the rest (client.py:1066, :504)', () => {
    const lab = requireProfile(store(), 'lab')
    const fromFile = nodeFromProfile(lab, {}, createTransport, 'browser')
    expect(fromFile).toBeInstanceOf(Node)
    expect(fromFile.settings.enablePassword).toBe('from-file')
    const fromCaller = nodeFromProfile(lab, { enablePassword: 'from-caller', configDefaults: false, autorefresh: undefined }, createTransport, 'browser')
    expect(fromCaller.settings.enablePassword).toBe('from-caller')
    expect(fromCaller.configDefaults).toBe(false)
  })
})

describe('bag validation the entry specs miss on one form or the other', () => {
  it('refuses unknown keys on the profile-object bag, naming the form (row 31)', () => {
    const lab = requireProfile(createProfiles({ lab: { transport: 'https', host: 'x' } }), 'lab')
    const message = failureMessage(() => nodeFromOptions({ profile: lab, host: 'elsewhere' } as never, createTransport, 'browser'))
    expect(message).toMatch(/unknown option\(s\) host/u)
    expect(message).toMatch(/profile object form/u)
  })

  it('profileNotFound lists names only — never values — for empty and full stores alike (DR-011)', () => {
    expect(profileNotFound('x', new ProfileStore()).message).toMatch(/Known profiles: none/u)
    const store = createProfiles({ sw1: { host: 'h', password: 'profile-secret' } })
    const error = profileNotFound('x', store)
    expect(error).toBeInstanceOf(NotSupportedError)
    expect(error.message).toContain('sw1')
    expect(error.message).not.toContain('profile-secret')
  })
})
