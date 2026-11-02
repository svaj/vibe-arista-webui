/**
 * The switch-local gates — `src/transports/local.ts`, M2 (#4), DR-008 + DR-014.
 *
 * These three functions are the whole difference between this client and pyeapi on the local question.
 * Upstream not only allows `/var/run/command-api.sock` and `localhost:8080`, it injects a
 * `connection: localhost` → socket profile into every configuration at import time
 * (`client.py:214-221`), so a script that never named a transport can end up talking to whatever local
 * listener exists — unauthenticated, at priv-15 (`DISABLE_AAA`, `HttpServicePlugin/Capi.py:83-124`).
 * pyeapi's unit suite (436 methods) has no equivalent of any of this, because the checks do not exist
 * upstream.
 *
 * Asserted per gate: the refusal, the refusal's *wording* (an operator has to be able to find the flag
 * that would change the answer), the warning when it is allowed, and the once-per-process de-duplication
 * that makes the warning usable at all. No socket is opened by any of these calls — a gate that fails
 * must fail before anything is reachable (DR-030's "no I/O in init", pushed one step further).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NotSupportedError } from '../errors'
import { clearWarningRegistry, hasWarned, warnOnce } from '../internal/warn'
import { assertCleartextAllowed, assertLocalOptIn, assertNoCredentials } from './local'

let warnings: string[] = []

beforeEach(() => {
  warnings = []
  clearWarningRegistry()
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]): void => {
    warnings.push(args.map((value) => String(value)).join(' '))
  })
})

describe('assertLocalOptIn — the local kinds have to be said out loud (DR-008)', () => {
  it('refuses a unix socket unless the flag is a literal true, and names the consequence', () => {
    let thrown: unknown
    try {
      assertLocalOptIn('unix', 'unix:/var/run/command-api.sock', undefined)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(NotSupportedError)
    const message = (thrown as InstanceType<typeof NotSupportedError>).message
    expect(message).toMatch(/refusing to build the 'unix' transport/u)
    expect(message).toMatch(/DISABLE_AAA/u)
    expect(message).toMatch(/priv-15 on the switch/u)
    expect(message).toMatch(/allowLocalUnauthenticated: true/u)
    expect(message).toMatch(/DR-008\/DR-014/u)
    // And it warned about nothing: the refusal is the message.
    expect(warnings).toEqual([])
  })

  it('treats false, a truthy non-true and a missing flag identically, because "sort of opted in" is not a thing', () => {
    for (const optIn of [false, 1, 'true', {}, null]) {
      expect(() => assertLocalOptIn('http-local', 'http://127.0.0.1:8080/command-api', optIn)).toThrow(NotSupportedError)
    }
  })

  it('allows the literal true, and says what it just allowed once per process (DR-014)', () => {
    assertLocalOptIn('unix', 'unix:/var/run/command-api.sock', true)
    assertLocalOptIn('unix', 'unix:/var/run/command-api.sock', true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/unauthenticated priv-15 eAPI on the switch itself/u)
    expect(warnings[0]).toMatch(/DISABLE_AAA on 4\.28/u)
    expect(warnings[0]).toMatch(/never on a host that exposes that listener/u)
    expect(hasWarned('local-unauthenticated-unix')).toBe(true)
  })

  it('the unix and http-local warnings are separate, so a UI log line says which listener is exposed', () => {
    assertLocalOptIn('unix', 'unix:/var/run/command-api.sock', true)
    assertLocalOptIn('http-local', 'http://127.0.0.1:8080/command-api', true)
    expect(warnings).toHaveLength(2)
    expect(warnings.join('\n')).toMatch(/'unix'/u)
    expect(warnings.join('\n')).toMatch(/'http-local'/u)
  })
})

describe('assertNoCredentials — handing a DISABLE_AAA listener a password is a lie, not a no-op', () => {
  it('refuses a username, a password, or both, naming the kind and the reason (DR-014)', () => {
    for (const credentials of [{ username: 'admin' }, { password: 'x' }, { username: 'admin', password: 'x' }]) {
      let thrown: unknown
      try {
        assertNoCredentials('unix', credentials)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(NotSupportedError)
      const message = (thrown as InstanceType<typeof NotSupportedError>).message
      expect(message).toMatch(/takes no username\/password/u)
      expect(message).toMatch(/unauthenticated \(DISABLE_AAA\)/u)
      expect(message).toMatch(/ignored rather than honoured/u)
    }
    expect(() => assertNoCredentials('http-local', { username: 'admin', password: 'x' })).toThrow(/'http-local'/u)
  })

  it('an empty-string credential is still a credential attempt, and none at all passes', () => {
    expect(() => assertNoCredentials('unix', { username: '' })).toThrow(NotSupportedError)
    expect(() => assertNoCredentials('unix', {})).not.toThrow()
    expect(() => assertNoCredentials('unix', { username: undefined, password: undefined })).not.toThrow()
  })
})

describe('assertCleartextAllowed — the one gate for every cleartext endpoint (DR-008)', () => {
  it('lets loopback through, but says once that it is the switch-local cleartext listener (DR-014)', () => {
    // Every spelling of "this machine" that `isLoopbackHost` accepts, including the bracketed IPv6
    // literal a `baseUrl` produces. `127.1`-style shorthand is deliberately *not* in the list.
    for (const host of ['127.0.0.1', '127.16.42.7', 'localhost', 'localhost.localdomain', '::1', '[::1]']) {
      assertCleartextAllowed(host, 8080, `http://${host}:8080/command-api`, undefined)
    }
    // Every loopback form shares one warning key: the fact is stated once per process, not per address.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/switch-local listener and is cleartext/u)
    expect(hasWarned('http-loopback')).toBe(true)
  })

  it('does not let a host that merely looks loopback through the gate', () => {
    // `127.1` is a valid shortcut on some stacks and a hostname on others. Ambiguity does not get to
    // mean "credentials over cleartext, no warning".
    expect(() => assertCleartextAllowed('127.1', 80, 'http://127.1:80/command-api', undefined)).toThrow(NotSupportedError)
    expect(() => assertCleartextAllowed('127.0.0.1.evil.example', 80, 'http://127.0.0.1.evil.example/command-api', undefined)).toThrow(NotSupportedError)
    expect(() => assertCleartextAllowed('10.0.0.5', 80, 'http://10.0.0.5/command-api', undefined)).toThrow(NotSupportedError)
  })

  it('refuses a non-loopback cleartext endpoint and tells the operator both fixes', () => {
    let thrown: unknown
    try {
      assertCleartextAllowed('sw1.lan', 80, 'http://sw1.lan:80/command-api', undefined)
    } catch (error) {
      thrown = error
    }
    const message = (thrown as InstanceType<typeof NotSupportedError>).message
    expect(message).toMatch(/refusing to speak cleartext http to http:\/\/sw1\.lan:80\/command-api/u)
    expect(message).toMatch(/use an https endpoint/u)
    expect(message).toMatch(/allowInsecureTransport/u)
    expect(message).toMatch(/127\.0\.0\.0\/8, ::1, localhost/u)
    expect(message).toMatch(/DR-008/u)
  })

  it('allowInsecureTransport: true walks through, loudly, and names the host:port now readable (DR-013)', () => {
    assertCleartextAllowed('sw1.lan', 80, 'http://sw1.lan:80/command-api', true)
    assertCleartextAllowed('sw2.lan', 80, 'http://sw2.lan:80/command-api', true)
    // One warning per process, but two endpoints were accepted — the flag is a process-wide decision.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/credentials are going over cleartext http to sw1\.lan:80/u)
    expect(warnings[0]).toMatch(/anyone on the path can read them/u)
    expect(hasWarned('insecure-transport')).toBe(true)
  })

  it('a loopback address never needs the flag, so the switch-operator case stays free of noise', () => {
    assertCleartextAllowed('127.0.0.1', 8080, 'http://127.0.0.1:8080/command-api', undefined)
    expect(warnings.join('\n')).not.toMatch(/allowInsecureTransport/u)
    expect(hasWarned('insecure-transport')).toBe(false)
  })

  it('a non-boolean flag value is a refusal, not an opt-in', () => {
    for (const value of ['true', 1, {}]) {
      expect(() => assertCleartextAllowed('sw1.lan', 80, 'http://sw1.lan:80/command-api', value)).toThrow(NotSupportedError)
    }
  })
})

describe('warnOnce itself — the de-duplication these gates depend on', () => {
  it('prints once per key, and reports whether it printed', () => {
    expect(warnOnce('k', 'first')).toBe(true)
    expect(warnOnce('k', 'second')).toBe(false)
    expect(warnOnce('other', 'other message')).toBe(true)
    expect(warnings).toEqual(['[arista-eapi] first', '[arista-eapi] other message'])
    expect(hasWarned('k')).toBe(true)
    expect(hasWarned('never')).toBe(false)
    clearWarningRegistry()
    expect(hasWarned('k')).toBe(false)
    expect(warnOnce('k', 'again after reset')).toBe(true)
  })

  it('prefixes every line with the package tag, so the warning is attributable in a webui console', () => {
    warnOnce('tagged', 'a message')
    expect(warnings[0]).toBe('[arista-eapi] a message')
  })
})
