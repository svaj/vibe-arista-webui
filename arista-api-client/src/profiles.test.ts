/**
 * The profile engine — M3 (#5). Everything `src/profiles.ts` decides on its own: INI **structure**
 * (`parseEapiConf`), key **meaning** (`normalizeProfile` + `ProfileStore`), and **translation**
 * (`profileToTransportOptions`). Entry-level behaviour (which factory builds which kind, what each
 * entry exports) belongs to `src/index.test.ts` / `src/node.test.ts`; the search that *finds* a file
 * belongs to `src/internal/eapi-conf.test.ts`.
 *
 * Fixture-driven per the M3 exit gate: the corpus under `test/fixtures/eapi.conf/` (five verbatim
 * pyeapi fixtures plus ours for the quirks upstream has no sample for — see that directory's README)
 * is enumerated from disk and every file must appear in the manifest below, so a fixture can never
 * drift back to being unread (the M1 `wire.fixture.test.ts` pattern).
 *
 * pyeapi parity anchors are re-verified against `pyeapi/test/unit/test_client.py` expectations at
 * the cited `client.py` lines; where we deliberately diverge, the assertion says which row of
 * MIGRATION.md §5 owns the decision (rows 54-60 are M3's band).
 */

import { describe, expect, it } from 'vitest'

import {
  acceptedTransportNames,
  CONNECTION_SECTION_PREFIX,
  createProfiles,
  DEFAULT_LOCAL_CONNECTION_NAME,
  DEFAULT_PROFILE_TRANSPORT,
  normalizeProfile,
  parseEapiConf,
  profileNodeSettings,
  profileToTransportOptions,
  ProfileStore,
  type ConnectionProfile,
  type ParsedEapiConf,
  type ProfileFieldValue,
  type ProfileIssueKind,
} from './profiles'
import { confFixture, listedConfFixtures } from './testing/fake-conf-fs'

/** One profile out of a parsed corpus file, or a hard test-setup failure. */
function profileOf(parsed: ParsedEapiConf, name: string): ConnectionProfile {
  const found = parsed.profiles.find((profile) => profile.name === name)
  if (found === undefined) throw new Error(`fixture setup: profile ${JSON.stringify(name)} is not in this fixture`)
  return found
}

function issueKindsAt(parsed: ParsedEapiConf, line: number): ProfileIssueKind[] {
  return parsed.issues.filter((issue) => issue.line === line).map((issue) => issue.kind)
}

const FIXTURE_MANIFEST = [
  'crlf.conf',
  'defaults.conf',
  'duplicate-section.conf',
  'dut.conf',
  'eapi.conf',
  'empty.conf',
  'env_path.conf',
  'malformed.conf',
  'nohost.conf',
  'percent.conf',
  'tags.conf',
]

describe('the eapi.conf fixture corpus is read, not decorative', () => {
  it('every fixture has a manifest entry and every manifest entry is a fixture', () => {
    expect(listedConfFixtures()).toEqual(FIXTURE_MANIFEST)
  })
})

describe('parseEapiConf — structure', () => {
  it("upstream's eapi.conf keeps its three sections and every value ends up un-padded (row 59)", () => {
    // The upstream file writes `enablepwd: enablepwd` with a space after the delimiter, and
    // configparser consumes it (`(=|:)\s*` before the value capture). pyeapi's own tests compare the
    // bare word, and so must we — a stored ' enablepwd' is a password that fails at the CLI with no
    // visible cause. This is what `node.test.ts` first caught.
    const parsed = parseEapiConf(confFixture('eapi.conf'))
    expect(parsed.profiles.map((profile) => profile.name)).toEqual(['test1', 'test2', 'localhost'])
    const test1 = profileOf(parsed, 'test1')
    expect(test1).toMatchObject({
      host: '192.168.1.16',
      username: 'eapi',
      password: 'password',
      enablePassword: 'enablepwd',
    })
    expect(test1.tags).toEqual(['tag1', 'tag2'])
    expect(test1.transport).toBeUndefined()
    // No `host` **key**: pyeapi substitutes the section name (`client.py:207-211`), row 58.
    expect(profileOf(parsed, 'test2').host).toBe('test2')
    // The file's own `localhost` section is the author's, not ours: no transport either way (row 55
    // governs only the *injected* profile, which this module never creates).
    expect(profileOf(parsed, 'localhost')).toMatchObject({ host: 'localhost', username: 'eapi' })
    expect(parsed.issues).toEqual([])
  })

  it('a section with no keys gets host = the section name (upstream nohost.conf, row 58)', () => {
    const parsed = parseEapiConf(confFixture('nohost.conf'))
    expect(profileOf(parsed, 'test').host).toBe('test')
    expect(parsed.issues).toEqual([])
    // The caller can turn the quirk off; then there is simply no host to build on.
    const strict = parseEapiConf(confFixture('nohost.conf'), { applyHostDefault: false })
    expect(profileOf(strict, 'test').host).toBeUndefined()
  })

  it('an empty file parses to nothing without complaining', () => {
    const parsed = parseEapiConf(confFixture('empty.conf'))
    expect(parsed.profiles).toEqual([])
    expect(parsed.issues).toEqual([])
  })

  it('keeps pyeapi-spelled transports verbatim as the authors wrote them (dut.conf, env_path.conf)', () => {
    // Resolution to a `TransportKind` is translation's job, not the parser's (`client.py:114-122`).
    expect(profileOf(parseEapiConf(confFixture('dut.conf')), 'veos01').transport).toBe('http')
    expect(profileOf(parseEapiConf(confFixture('env_path.conf')), 'env_path').transport).toBe('https')
  })

  it('CRLF files parse identically to LF ones (a Windows-authored conf is not malformed)', () => {
    const parsed = parseEapiConf(confFixture('crlf.conf'))
    expect(parsed.issues).toEqual([])
    const crlf = profileOf(parsed, 'crlf')
    expect(crlf).toMatchObject({ host: '10.0.0.10', username: 'cli' })
    // Inline `#` is NOT a comment start for configparser and not for us either — a password with a
    // `#` in it must survive the round trip intact (row 56).
    expect(crlf.password).toBe('crlf#keep')
    expect(crlf.enablePassword).toBe('en#crlf')
    expect(crlf.tags).toEqual(['rack-c', 'rack-d'])
  })

  it('merges a duplicate section, first value wins, and keeps reading (row 56)', () => {
    // pyeapi raises DuplicateSectionError and loses every profile after the duplicate
    // (`client.py:198-203` — verified by running it); the profiles.test manifest fixture exists
    // because that data loss is the single worst failure mode an operator can hit.
    const parsed = parseEapiConf(confFixture('duplicate-section.conf'))
    expect(parsed.profiles.map((profile) => profile.name)).toEqual(['dup', 'after'])
    const dup = profileOf(parsed, 'dup')
    expect(dup).toMatchObject({ host: '10.0.0.1', username: 'first-user', password: 'dup-secret' })
    expect(dup.tags).toEqual(['shared'])
    const duplicateLines = parsed.issues.filter((issue) => issue.kind === 'duplicate-section')
    expect(duplicateLines.map((issue) => issue.line)).toEqual([6])
    // The repeated *options* inside the second block are reported too, and the first value survived.
    expect(issueKindsAt(parsed, 7)).toEqual(['invalid-line']) // repeat `host` — first value kept
    expect(issueKindsAt(parsed, 9)).toEqual(['invalid-line']) // repeat `tags` — first value kept
    expect(JSON.stringify(parsed.issues)).not.toContain('dup-secret')
  })

  it('reports every kind of malformed line with its 1-based line number instead of discarding (rows 56/58)', () => {
    const parsed = parseEapiConf(confFixture('malformed.conf'))
    expect(parsed.profiles.map((profile) => profile.name)).toEqual(['ok'])
    expect(profileOf(parsed, 'ok').host).toBe('10.0.0.5')
    expect(issueKindsAt(parsed, 1)).toEqual(['invalid-line']) // garbage before any header
    expect(issueKindsAt(parsed, 3)).toEqual(['invalid-line']) // indented, nothing to continue
    expect(issueKindsAt(parsed, 5)).toEqual(['invalid-line']) // no `:`/`=` separator
    expect(issueKindsAt(parsed, 7)).toEqual(['invalid-line']) // stray line with no live section
    // Two flavours of nameless header, two reporting passes. A bare `[]` is caught AT the header
    // line, so that issue carries a line number; `[connection:]` carries the prefix, is created by
    // the header pass, and its EMPTY name is discovered in the profile pass — by section, line-less.
    // pyeapi registers both under '' and gives them host = "" (`client.py:207-211`); we refuse both,
    // and generate_tags (client.py:233) cannot crash on the colon-less section as upstreams does.
    const emptyNames = parsed.issues.filter((issue) => issue.kind === 'empty-name')
    expect(emptyNames.map((issue) => [issue.profile, issue.line])).toEqual([
      ['', 6],
      ['', undefined],
    ])
    const nonConnection = parsed.issues.filter((issue) => issue.kind === 'non-connection-section')
    expect(nonConnection.map((issue) => [issue.profile, issue.line])).toEqual([['other:section', undefined]])
    expect(parsed.otherSections).toEqual(['other:section'])
    // Names, keys and lines print; a line's VALUE never does (DR-011).
    const printed = JSON.stringify(parsed.issues)
    expect(printed).not.toContain('nameless')
    expect(printed).not.toContain('nowhere')
    expect(printed).not.toContain('10.0.0.5')
  })

  it('merges [DEFAULT] into every connection, raw section kept for the caller (row 57)', () => {
    const parsed = parseEapiConf(confFixture('defaults.conf'))
    expect(parsed.profiles.map((profile) => profile.name)).toEqual(['withdef', 'ownuser'])
    expect(profileOf(parsed, 'withdef')).toMatchObject({ username: 'global-user', timeoutMs: 30_000 })
    expect(profileOf(parsed, 'ownuser').username).toBe('own-user')
    expect(parsed.defaults).toEqual({ username: 'global-user', timeout: '30' })
    expect(parsed.otherSections).toEqual([]) // the default section is metadata, never a connection
  })

  it('keeps % inside a value that would crash pyeapi through configparser interpolation (row 57)', () => {
    // pyeapi's `items()` call at `client.py:207` interpolates every value; `100%` raises
    // InterpolationSyntaxError out of `load_config`, discarding the whole file. There is nothing to
    // interpolate here, so the password is simply kept — a silently-dropped config is the worse bug.
    const parsed = parseEapiConf(confFixture('percent.conf'))
    expect(profileOf(parsed, 'pct')).toMatchObject({ password: 'p%sx', enablePassword: '100%' })
    expect(parsed.issues).toEqual([])
  })

  it('trims tags but indexes an empty one, exactly like generate_tags does (client.py:230, row 60)', () => {
    const parsed = parseEapiConf(confFixture('tags.conf'))
    expect(profileOf(parsed, 't1').tags).toEqual(['rack-a', 'rack-b', ''])
    expect(profileOf(parsed, 't2').tags).toEqual(['', 'rack-a'])
    expect(profileOf(parsed, 'untagged').tags).toBeUndefined()
  })

  it('reads the line-level details the fixtures do not carry: BOM, continuations, case, comments', () => {
    const parsed = parseEapiConf([
      '\ufeff[connection:BomHost]',
      'host: 1.1.1.1',
      '   continued value',
      'EnablePwd: MixedCaseKey',
      '; whole-line comment',
      '# another comment',
      '  spaced key :value',
      'password = p#1',
      'transport =',
      '[connection:BomHost]',
      'port: 8443',
    ].join('\n'))
    const profile = profileOf(parsed, 'BomHost')
    // Indented continuation with no delimiter joins with `\n` — verified against real configparser.
    expect(profile.host).toBe('1.1.1.1\ncontinued value')
    // Keys are lowered by configparser optionxform; section names are NOT, so `BomHost` keeps its
    // identity and the two blocks are one profile merged (duplicate-section path).
    expect(profile.enablePassword).toBe('MixedCaseKey')
    expect(profile.password).toBe('p#1')
    expect(profile.port).toBe(8443)
    expect((profile as { 'spaced key'?: unknown })['spaced key']).toBeUndefined()
    expect(profile.issues?.some((issue) => issue.kind === 'empty-transport')).toBe(true)
    expect(issueKindsAt(parsed, 10)).toEqual(['duplicate-section'])
  })
})

describe('normalizeProfile — meaning', () => {
  const ALL_KEYS: Record<string, ProfileFieldValue> = {
    transport: 'https',
    host: 'sw1.lan',
    port: '8443',
    path: '/command-api ',
    socket_path: '/var/run/command-api.sock',
    base_url: 'https://proxy.lan/eapi',
    username: 'ui',
    password: 'pw',
    enablepwd: 'en',
    tags: 'a, b',
    default: 'true',
    timeout: '30',
    timeout_ms: '15000',
    ca_file: 'bundle.pem',
    cert_file: 'client.pem',
    key_file: 'client.key',
    server_name: 'sw1.internal',
    fingerprint: 'aa:bb',
    dangerously_disable_tls_verification: 'off',
    allow_insecure_transport: 'yes',
    allow_local_unauthenticated: '1',
    nonce: 'lab',
    seed: 'abc',
    id_start: '10',
  }

  it('coerces every recognized key through the one table (both file and app spellings)', () => {
    const { profile, issues } = normalizeProfile('all', ALL_KEYS)
    expect(issues).toEqual([])
    expect(profile).toMatchObject({
      name: 'all',
      transport: 'https',
      host: 'sw1.lan',
      port: 8443,
      path: '/command-api', // trimmed — pyeapi hands the raw string to a socket that tolerates it; we do not store the pad
      socketPath: '/var/run/command-api.sock',
      baseUrl: 'https://proxy.lan/eapi',
      username: 'ui',
      password: 'pw',
      enablePassword: 'en',
      tags: ['a', 'b'],
      default: true,
      timeoutMs: 15_000, // the later key wins; `timeout: 30` (seconds) folded first
      ca: 'bundle.pem',
      cert: 'client.pem',
      key: 'client.key',
      serverName: 'sw1.internal',
      fingerprint: 'aa:bb',
      dangerouslyDisableTlsVerification: false,
      allowInsecureTransport: true,
      allowLocalUnauthenticated: true,
      nonce: 'lab',
      seed: 'abc',
      idStart: 10,
    })
    // `timeout: 30` in SECONDS vs `timeout_ms` in ms — DR-019, MIGRATION.md §5 row 22: the units are
    // never mixed, and both inputs still have to fold onto the one stored field.
    const seconds = normalizeProfile('s', { timeout: '1.5' })
    expect(seconds.profile.timeoutMs).toBe(1500)
    expect(seconds.issues).toEqual([])
    expect(normalizeProfile('d', { default_socket_path: '/alt.sock' }).profile.socketPath).toBe('/alt.sock')
    expect(normalizeProfile('e', { enable_password: 'snake' }).profile.enablePassword).toBe('snake')
    expect(normalizeProfile('c', { enablePassword: 'camel' }).profile.enablePassword).toBe('camel')
  })

  it('records a blocking issue instead of storing an unreadable value (row 59)', () => {
    // Every one of these is a value pyeapi either crashes on later (`int(port)`, `eapilib.py:666`)
    // or quietly ignores (`deafult`, row 31's bug). Here the key is reported by name and NOT stored.
    const cases: [string, Record<string, ProfileFieldValue>, string][] = [
      ['port', { port: 'not-a-port' }, 'is not a port number'],
      ['port-hex', { port: '0x539' }, 'is not a port number'],
      ['port-high', { port: '70000' }, 'is not a port number'],
      ['timeout', { timeout: '-5' }, 'positive number of seconds'],
      ['timeout_ms', { timeout_ms: 'zero' }, 'positive number of milliseconds'],
      ['id_start', { id_start: '1.5' }, 'non-negative integer'],
      ['boolean', { allow_insecure_transport: 'maybe' }, 'explicit truth value'],
      ['empty-transport', { transport: '  ' }, 'is empty'],
    ]
    for (const [label, fields, phrase] of cases) {
      const { profile, issues } = normalizeProfile(label, fields)
      expect(issues.length, label).toBe(1)
      expect(issues[0]?.message, label).toMatch(new RegExp(phrase, 'u'))
      expect(issues[0]?.kind, label).oneOf(['invalid-value', 'empty-transport'])
      // The offending value never enters the issue text — the position could hold a secret (DR-011).
      expect(issues[0]?.message, label).not.toContain(String(Object.values(fields)[0]))
      // And the value is NOT stored: only identity and the derived issue list remain.
      expect(Object.keys(profile).filter((key) => key !== 'name' && key !== 'issues'), label).toEqual([])
    }
  })

  it('treats an unknown key as reportable but not fatal, and never stores it (row 31)', () => {
    const { profile, issues } = normalizeProfile('typo', { host: 'sw1.lan', deafult: 'sw1.lan' })
    expect(issues.map((issue) => issue.kind)).toEqual(['unknown-key'])
    expect(profile.host).toBe('sw1.lan')
    // The key is REPORTED and never stored — that combination is what row 31 demands.
    expect((profile as unknown as Record<string, unknown>)['deafult']).toBeUndefined()
  })

  it('keeps a present-but-empty host from tripping the name default (row 8/51, verified against a run)', () => {
    // pyeapi substitutes only when the `host` **key** is absent; `host:` (empty, key present) stays
    // empty there and posts to `https://:443/command-api`. Here the empty value coerces to no value
    // at all, and the missing-host refusal (row 8) is what the operator sees instead.
    const parsed = parseEapiConf('[connection:blank]\nhost:\nusername: u')
    expect(profileOf(parsed, 'blank').host).toBeUndefined()
    expect(parsed.issues).toEqual([])
  })
})

describe('ProfileStore — the registry without pyepais module-global (client.py:127-312, row 54)', () => {
  it('addConnection trims the name, refuses the empty one pyeapi still registers', () => {
    const store = new ProfileStore()
    expect(store.addConnection(' sw1 ', { host: 'x' }).name).toBe('sw1')
    expect(store.get('sw1')?.host).toBe('x')
    expect(() => store.addConnection('', {})).toThrow(/needs a name/u)
    expect(store.names()).toEqual(['sw1'])
  })

  it('replacing a name re-normalizes and rebuilds the tag index (client.py:312)', () => {
    const store = createProfiles({ sw: { host: 'a', tags: 'old-tag' } })
    expect(store.hostsForTag('old-tag')).toEqual(['sw'])
    store.addConnection('sw', { host: 'b' })
    expect(store.hostsForTag('old-tag')).toBeUndefined()
    expect(store.get('sw')?.tags).toBeUndefined()
    expect(store.size).toBe(1)
  })

  it('hostsForTag yields undefined for an unknown tag, not an empty list (row 60)', () => {
    // Upstream returns `None` and its test `test_hosts_for_tag_returns_none` asserts it; an empty
    // array would make a failed fan-out look like a fan-out that succeeded and found nobody.
    const store = createProfiles(parseEapiConf(confFixture('tags.conf')).profiles)
    expect(store.hostsForTag('rack-a')).toEqual(['t1', 't2'])
    expect(store.hostsForTag('  rack-b ')).toEqual(['t1']) // the lookup trims like upstreams does (client.py:352-367)
    expect(store.hostsForTag('nobody-has-this')).toBeUndefined()
    expect(store.hostsForTag('')).toEqual(['t1', 't2']) // the kept-empty tag is really indexed
    expect([...store.tags().keys()].sort()).toEqual(['', 'rack-a', 'rack-b'])
    const frozen = store.hostsForTag('rack-a')
    expect(() => (frozen as string[]).push('x')).toThrow(TypeError)
  })

  it('lists names, never secrets, and rebuilds the tag index for parsed profiles', () => {
    const parsed = parseEapiConf(confFixture('eapi.conf'))
    const store = createProfiles(parsed.profiles)
    expect(store.names()).toEqual(['test1', 'test2', 'localhost'])
    expect(store.all().length).toBe(3)
    expect(store.configFor('test1')).toBe(store.get('test1'))
    expect(store.has('test1')).toBe(true)
    expect(store.has('nope')).toBe(false)
    const rendered = `${String(store)} ${JSON.stringify(store.tags())}`
    expect(rendered).toContain('test1')
    expect(rendered).not.toContain('password') // value absent; only names and tag→host maps print (DR-011)
    expect(rendered).not.toContain('enablepwd')
  })

  it('never invents the implicit localhost profile in this layer (row 55; only loaders call the injection)', () => {
    const store = new ProfileStore()
    expect(store.has(DEFAULT_LOCAL_CONNECTION_NAME)).toBe(false)
    const local = store.addDefaultLocalConnection()
    expect(local).toMatchObject({ name: DEFAULT_LOCAL_CONNECTION_NAME, transport: 'socket' })
    // The method mirrors pyeapi's unconditional `_add_default_connection` (`client.py:214-221`);
    // the no-clobber guard lives with its callers — `resolveEapiConf` and `optionsFromProfileName`
    // both check `store.has(...)` first (`client.py:184`'s equivalent), which is what the
    // `src/internal/eapi-conf.test.ts` and `src/node.test.ts` specs pin. Re-check it for a
    // caller-authored section one more time from here: adding under an existing name replaces it.
    store.addConnection(DEFAULT_LOCAL_CONNECTION_NAME, { host: 'mine' })
    expect(store.get(DEFAULT_LOCAL_CONNECTION_NAME)?.transport).toBeUndefined()
  })

  it('createProfiles accepts records, parsed arrays, and nothing at all', () => {
    expect(createProfiles().size).toBe(0)
    expect(createProfiles({}).size).toBe(0)
    const fromRecord = createProfiles({ lab: { transport: 'https', host: '10.0.0.30' } })
    const fromArray = createProfiles(fromRecord.all())
    expect(fromArray.get('lab')).toEqual(fromRecord.get('lab'))
  })
})

describe('profileToTransportOptions — translation to one TransportOptions member (client.py:370-391 analog)', () => {
  const profile = (fields: Record<string, ProfileFieldValue>): ConnectionProfile =>
    normalizeProfile('probe', fields).profile

  it('builds the https member with endpoint, credentials and common knobs carried across', () => {
    const options = profileToTransportOptions(profile({
      transport: 'https',
      host: 'sw1.lan',
      port: 8443,
      path: '/command-api',
      username: 'ui',
      password: 'unused-in-tests',
      timeout: 30,
      nonce: 'lab',
      seed: 's',
      id_start: 3,
      ca: 'bundle.pem',
      server_name: 'internal.lan',
      fingerprint: 'aa:bb',
    }), { entry: 'browser' })
    expect(options).toMatchObject({
      kind: 'https',
      host: 'sw1.lan',
      port: 8443,
      path: '/command-api',
      username: 'ui',
      timeoutMs: 30_000,
      nonce: 'lab',
      seed: 's',
      idStart: 3,
      ca: 'bundle.pem',
      serverName: 'internal.lan',
      fingerprint: 'aa:bb',
    })
  })

  it('defaults a missing transport to https, like DEFAULT_TRANSPORT applied in connect (client.py:124, :452 — row 59)', () => {
    const options = profileToTransportOptions(profile({ host: 'sw1.lan' }), { entry: 'browser' })
    expect(options).toMatchObject({ kind: 'https' })
    expect(DEFAULT_PROFILE_TRANSPORT).toBe('https')
  })

  it('resolves pyeapi transport spellings through TRANSPORT_ALIASES, never by falling through (row 60)', () => {
    // `client.py:388-389` raises TypeError('invalid transport specified'); here the refusal is typed,
    // names the profile and both spellings, and lists what IS accepted per entry — no default kind.
    const message = (): string => {
      try {
        profileToTransportOptions(profile({ transport: 'carrier-pigeon', host: 'x' }), { entry: 'browser' })
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      throw new Error('expected the transport name to be refused')
    }
    expect(message()).toMatch(/invalid transport specified/u)
    expect(message()).toContain('carrier-pigeon')
    const browserNames = acceptedTransportNames('browser')
    const nodeNames = acceptedTransportNames('node')
    expect(browserNames).toEqual(expect.arrayContaining(['https', 'http']))
    for (const name of ['socket', 'http_local', 'https_certs', 'http_session', 'https_session']) {
      expect(nodeNames, name).toContain(name)
      expect(browserNames, name).not.toContain(name)
    }
  })

  it('refuses a kind the entry cannot build, naming the ./node import (DR-002/DR-013/DR-018)', () => {
    for (const spelling of ['socket', 'session', 'https_certs', 'http_local']) {
      let message = ''
      try {
        profileToTransportOptions(profile({ transport: spelling, host: 'x' }), { entry: 'browser' })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message, spelling).toMatch(/does not have/u)
      expect(message, spelling).toContain('@devhax-heavy-industries/arista-eapi/node')
    }
  })

  it('refuses keys the chosen kind has no such option for, instead of ignoring them (row 31)', () => {
    const cases: [string, Record<string, ProfileFieldValue>, 'node' | 'browser', string][] = [
      ['socket+host', { transport: 'socket', host: 'x' }, 'node', 'sets host'],
      ['http+tls', { transport: 'http', host: 'x', allow_insecure_transport: true, ca: 'a.pem' }, 'browser', 'sets ca'],
      ['https+insecure', { transport: 'https', host: 'x', allow_insecure_transport: true }, 'browser', 'allowInsecureTransport'],
      ['session+local', { transport: 'https_session', host: 'x', allow_local_unauthenticated: true }, 'node', 'allowLocalUnauthenticated'],
    ]
    for (const [label, fields, entry, phrase] of cases) {
      let message = ''
      try {
        profileToTransportOptions(profile(fields), { entry })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message, label).toMatch(/no such option/u)
      expect(message, label).toContain(phrase) // the key prints by name; its value never prints (DR-011)
    }
  })

  it('keeps the switch-local kinds inert until the risk is stated (DR-008/DR-014, row 55)', () => {
    let message = ''
    try {
      profileToTransportOptions(profile({ transport: 'socket' }), { entry: 'node' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/allow_local_unauthenticated/u)
    expect(message).toMatch(/DISABLE_AAA/u)
    // stated either in the profile itself or per-call, and the socket path rides through:
    expect(profileToTransportOptions(profile({ transport: 'socket' }), { entry: 'node', overrides: { allow_local_unauthenticated: true } })).toMatchObject({ kind: 'unix', allowLocalUnauthenticated: true })
    expect(profileToTransportOptions(profile({ transport: 'socket', allow_local_unauthenticated: true, default_socket_path: '/alt.sock' }), { entry: 'node' })).toMatchObject({ kind: 'unix', socketPath: '/alt.sock' })
    expect(profileToTransportOptions(profile({ transport: 'http_local', allow_local_unauthenticated: true, port: 8080 }), { entry: 'node' })).toMatchObject({ kind: 'http-local', port: 8080 })
  })

  it('requires both halves of the mTLS identity, like HTTPSConnection raising ValueError (eapilib.py:706-709, row 25)', () => {
    expect(() => profileToTransportOptions(profile({ transport: 'https_certs', host: 'x', cert: 'c.pem' }), { entry: 'node' })).toThrow(TypeError)
    const both = profileToTransportOptions(profile({ transport: 'https_certs', host: 'x', cert: 'c.pem', key: 'k.pem' }), { entry: 'node' })
    expect(both).toMatchObject({ kind: 'https-client-cert', cert: 'c.pem', key: 'k.pem' })
  })

  it('maps session spellings onto the one session kind and passes its options (DR-018)', () => {
    for (const spelling of ['http_session', 'https_session']) {
      expect(profileToTransportOptions(profile({ transport: spelling, host: 'x', username: 'ui', password: 'unused-in-tests' }), { entry: 'node' })).toMatchObject({ kind: 'session', host: 'x' })
    }
  })

  it('lets the mock kind assemble here but says so plainly: a profile must not steer production at a mock (M2 rule)', () => {
    expect(profileToTransportOptions(profile({ transport: 'mock' }), { entry: 'node' })).toEqual(expect.objectContaining({ kind: 'mock' }))
  })

  it('refuses to build anything from a profile whose own keys could not be honoured (row 59)', () => {
    const broken = normalizeProfile('broken', { host: 'x', port: 'nope', enablePassword: 'unused-enable-secret' })
    let message = ''
    try {
      profileToTransportOptions(broken.profile, { entry: 'browser' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/refusing to build a connection from profile/u)
    expect(message).toMatch(/is not a port number/u)
    expect(message).not.toContain('unused-enable-secret') // key names and reasons print, values do not (DR-011)
    // An unknown-key issue alone must not block: report, then build from what IS honoured.
    const typoed = normalizeProfile('typo', { transport: 'https', host: 'x', api_version: '2' })
    expect(profileToTransportOptions(typoed.profile, { entry: 'browser' })).toMatchObject({ kind: 'https' })
  })

  it('round-trips a stored profile through the field table without dropping client-spelled keys', () => {
    // The bug this pins: `profileFieldsOf` emits camelCase, and without the `ca`/`cert`/`key` aliases
    // an https_certs profile from app config would come back as unknown-key + DROPPED, making mTLS
    // unbuildable from a store (checkpoint defect 7).
    const store = createProfiles({
      mtls: { transport: 'https_certs', host: 'x', cert: 'c.pem', key: 'k.pem', ca: ['/a.pem ', '', '/b.pem'] },
    })
    const original = store.get('mtls')
    if (original === undefined) throw new Error('test setup: mtls profile missing')
    const reNormalized = store.add(original) // one full profile → fields → profile round trip
    expect(reNormalized.issues).toBeUndefined()
    const built = profileToTransportOptions(reNormalized, { entry: 'node' })
    expect(built).toMatchObject({ kind: 'https-client-cert', cert: 'c.pem', key: 'k.pem', ca: ['/a.pem', '/b.pem'] })
  })

  it('profileNodeSettings carries only enablePassword, and CONNECTION_SECTION_PREFIX is exported for callers', () => {
    expect(profileNodeSettings(profile({ enablepwd: 'en' }))).toEqual({ enablePassword: 'en' })
    expect(profileNodeSettings(profile({ host: 'x' }))).toEqual({})
    expect(CONNECTION_SECTION_PREFIX).toBe('connection:')
  })
})
