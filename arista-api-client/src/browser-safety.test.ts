/**
 * DR-002 guard tests — M2 (#4), the source-graph half of the browser-safety check.
 *
 * The build-time half is `browserSafetyGuard()` in `vite.config.ts` (it inspects the emitted chunks,
 * so a green `npm run build` is evidence). This file is the fast half: it walks the **module graph**
 * of `src/index.ts` and fails when any module reachable from the browser entry names a Node built-in,
 * which is a better error message than a bundle diff and lands in `npm test`.
 *
 * Two anti-vacuity assertions matter as much as the refusal itself:
 *  - the walk must actually reach the transport modules (a broken resolver would scan nothing and
 *    "pass"), and must reach `src/node.ts`'s Node built-ins when started from `src/node.ts`;
 *  - the Node-only transports must be absent from the browser graph *as named modules*, so an
 *    accidental `index.ts` → `node-create.ts` import fails here instead of only at build time.
 *
 * ARCHITECTURE §5 promises the same rule as a runtime test ("constructing `kind: 'unix'` from the
 * browser entry throws `NotSupportedError`"), so the option/kind refusals are asserted here too —
 * they are what a JS caller, or an `eapi.conf` profile object handed over by M3 (#5), gets.
 *
 * Test-only file: it imports `node:fs` deliberately, and `*.test.ts` is excluded from both build
 * entries (`tsconfig.build.json`, and the vitest `unit` project never bundles).
 */

import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as browserEntry from './index'
import * as nodeEntry from './node'
import { NotSupportedError, TransportError } from './errors'

const SRC_DIR = dirname(fileURLToPath(new URL('./index.ts', import.meta.url)))

/** Extensions a relative specifier can resolve to. `.ts` only — this package has no `.js` sources. */
const RESOLVE_SUFFIXES: readonly string[] = ['', '.ts', '/index.ts']

/** After these characters a `/` starts a regex literal; after an identifier or `)` it is a division. */
const REGEX_PRECEDING_CHAR = /[(,=:[!&|?{};+\-*%~^]/u
/** Keywords after which a `/` is also a regex literal — single-character memory is not enough. */
const REGEX_PRECEDING_KEYWORD = /\b(?:return|case|typeof|await|yield|delete|void|in|of|new)\s+$/u

/** Every `import`/`export … from`/`import()`/`require` form, applied to comment-stripped source. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/**
 * Blank out comments and template-literal bodies; copy everything else. The distinction is what makes
 * the scan honest:
 *  - comments are the false-positive source — almost every file header in this package *discusses*
 *    `node:https`, `node:net` and `node:fs`, and messages built with template literals quote the
 *    `@devhax-heavy-industries/arista-eapi/node` import path a caller should use instead;
 *  - quoted strings are the true-positive source — an import specifier is always one of those.
 * Comments become spaces and template bodies become blanks (newlines kept), so offsets and line numbers
 * stay put for a readable failure dump.
 */
function stripCommentsAndStrings(source: string): string {
  const out: string[] = []
  let index = 0
  /** Last significant character before a `/`, to tell a regex literal from a division operator. */
  let previous = ''
  while (index < source.length) {
    const char = source[index] as string
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out.push(' ')
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      out.push('  ')
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out.push(source[index] === '\n' ? '\n' : ' ')
        index += 1
      }
      out.push('  ')
      index += 2
      continue
    }
    if (char === '`') {
      // Template literal: keep the delimiters, blank the body. This is where the refusal messages
      // live, and they name module specifiers (`'@devhax-heavy-industries/arista-eapi/node'`) inside
      // prose — which must not be mistaken for an import.
      out.push(char)
      index += 1
      let closed = false
      while (index < source.length && !closed) {
        const current = source[index] as string
        if (current === '\\') {
          out.push('  ')
          index += 2
          continue
        }
        if (current === '`') {
          out.push(current)
          index += 1
          closed = true
          continue
        }
        if (current === '$' && source[index + 1] === '{') {
          // A `${…}` hole can contain real code (a nested template, a string with a specifier-looking
          // word), so walk it with a brace counter and copy its contents verbatim.
          out.push('${')
          index += 2
          let braces = 1
          while (index < source.length && braces > 0) {
            const inner = source[index] as string
            if (inner === '{') braces += 1
            if (inner === '}') braces -= 1
            out.push(inner)
            index += 1
          }
          continue
        }
        out.push(current === '\n' ? '\n' : ' ')
        index += 1
      }
      previous = '`'
      continue
    }
    if (char === '"' || char === "'") {
      // Quoted string: copied verbatim, because this is exactly where an import specifier lives. The
      // loop still has to find the terminator, so a quote inside a comment or regex cannot confuse it.
      const quote = char
      out.push(quote)
      index += 1
      while (index < source.length) {
        const current = source[index] as string
        if (current === '\\') {
          out.push(current, source[index + 1] ?? ' ')
          index += 2
          continue
        }
        out.push(current)
        index += 1
        if (current === quote) break
      }
      previous = quote
      continue
    }
    if (char === '/' && (REGEX_PRECEDING_CHAR.test(previous) || REGEX_PRECEDING_KEYWORD.test(source.slice(Math.max(0, index - 8), index)))) {
      // A regex literal: copy it verbatim (delimiters and character classes included) so its body is
      // never mistaken for a string, and its own `/` terminators are not mistaken for a comment.
      // `previous` alone cannot tell `x) / y` (division) from `return /x/` (regex), hence the keyword test.
      out.push(char)
      index += 1
      let inClass = false
      while (index < source.length) {
        const current = source[index] as string
        out.push(current)
        index += 1
        if (current === '\\') {
          out.push(source[index] ?? '')
          index += 1
          continue
        }
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) break
      }
      previous = '/'
      continue
    }
    out.push(char)
    if (char.trim() !== '') previous = char
    index += 1
  }
  return out.join('')
}

function specifiersOf(file: string): string[] {
  const code = stripCommentsAndStrings(readFileSync(file, 'utf8'))
  const found = new Set<string>()
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const value = match[1]
      if (value !== undefined) found.add(value)
    }
  }
  return [...found]
}

function resolveRelative(file: string, specifier: string): string {
  for (const suffix of RESOLVE_SUFFIXES) {
    try {
      const candidate = resolve(dirname(file), `${specifier}${suffix}`)
      readFileSync(candidate)
      return candidate
    } catch {
      // try the next suffix
    }
  }
  throw new Error(`cannot resolve ${JSON.stringify(specifier)} from ${file.replace(`${SRC_DIR}/`, '')}`)
}

interface GraphWalk {
  /** Every module reachable from the entry, as paths relative to `src/`. */
  readonly modules: readonly string[]
  /** `module → node:* specifier` pairs found anywhere in that graph. */
  readonly nodeSpecifiers: readonly string[]
  /** Bare non-relative specifiers that are not Node built-ins, i.e. third-party runtime imports. */
  readonly packageSpecifiers: readonly string[]
  /** Specifiers that could not be resolved — a resolver bug must fail loudly, never scan nothing. */
  readonly unresolved: readonly string[]
}

/** Breadth-first walk of the static import graph from one entry file. */
function walk(entry: string): GraphWalk {
  const seen = new Set<string>()
  const queue = [resolve(entry)]
  const nodeSpecifiers: string[] = []
  const packageSpecifiers: string[] = []
  const unresolved: string[] = []
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('node:') || isBuiltin(specifier)) {
        nodeSpecifiers.push(`${file.replace(`${SRC_DIR}/`, '')} → ${specifier}`)
        continue
      }
      if (specifier.startsWith('.')) {
        try {
          queue.push(resolveRelative(file, specifier))
        } catch (error) {
          unresolved.push(error instanceof Error ? error.message : String(error))
        }
        continue
      }
      packageSpecifiers.push(`${file.replace(`${SRC_DIR}/`, '')} → ${specifier}`)
    }
  }
  return {
    modules: [...seen].map((file) => file.replace(`${SRC_DIR}/`, '')).sort(),
    nodeSpecifiers: nodeSpecifiers.sort(),
    packageSpecifiers: packageSpecifiers.sort(),
    unresolved: unresolved.sort(),
  }
}

/** The Node-only transports, by source path — none of these may appear in the browser graph. */
const NODE_ONLY_MODULES: readonly string[] = [
  'transports/node-create.ts',
  'transports/node-https.ts',
  'transports/node-client-cert.ts',
  'transports/node-cookie.ts',
  'transports/node-http.ts',
  'transports/node-tls.ts',
  'transports/node-unix.ts',
  'transports/node-http-local.ts',
]

describe('DR-002 module graph of the browser entry', () => {
  const graph = walk(fileURLToPath(new URL('./index.ts', import.meta.url)))

  it('resolves every relative specifier it sees, so the walk cannot silently shrink', () => {
    expect(graph.unresolved).toEqual([])
  })

  it('reaches the transport modules, which is the point of the walk', () => {
    for (const module of [
      'transports/create.ts',
      'transports/fetch.ts',
      'transports/base.ts',
      'transports/contract.ts',
      'transports/correlate.ts',
      'transports/error-map.ts',
      'transports/local.ts',
      'internal/wire.ts',
      'internal/redact.ts',
      'errors.ts',
    ]) {
      expect(graph.modules, `${module} should be reachable from src/index.ts`).toContain(module)
    }
    expect(graph.modules.length).toBeGreaterThan(12)
  })

  it('has no Node built-in anywhere in it (DR-002)', () => {
    expect(graph.nodeSpecifiers).toEqual([])
  })

  it('has no third-party runtime import either — the browser entry ships dependency-free', () => {
    expect(graph.packageSpecifiers).toEqual([])
  })

  it('does not reach a single node-*.ts transport (DR-002/DR-013/DR-014/DR-018)', () => {
    for (const module of NODE_ONLY_MODULES) {
      expect(graph.modules, `${module} must not be reachable from src/index.ts`).not.toContain(module)
    }
  })
})

describe('the walk is not vacuous: it sees node:* when they are there', () => {
  const nodeGraph = walk(fileURLToPath(new URL('./node.ts', import.meta.url)))

  it('resolves the Node entry graph fully', () => {
    expect(nodeGraph.unresolved).toEqual([])
  })

  it('lists the built-ins src/node.ts pulls in, transitively', () => {
    const builtins = nodeGraph.nodeSpecifiers.map((entry) => entry.split(' → ')[1] as string)
    for (const expected of ['node:fs', 'node:http', 'node:https', 'node:tls', 'node:buffer']) {
      expect(builtins, `the walker should see ${expected} in the ./node graph`).toContain(expected)
    }
    expect(nodeGraph.nodeSpecifiers.length).toBeGreaterThanOrEqual(3)
  })

  it('reaches every Node-only transport module', () => {
    for (const module of NODE_ONLY_MODULES) {
      expect(nodeGraph.modules, `${module} should be reachable from src/node.ts`).toContain(module)
    }
  })
})

describe('what each entry point exports', () => {
  const nodeOnlySymbols = ['TlsTransport', 'SessionCookieTransport', 'ClientCertTransport', 'UnixSocketTransport', 'HttpLocalTransport'] as const

  it('keeps the Node transports out of the browser entry surface', () => {
    const surface = browserEntry as unknown as Record<string, unknown>
    for (const symbol of nodeOnlySymbols) {
      expect(surface[symbol], `src/index.ts must not export ${symbol}`).toBeUndefined()
    }
  })

  it('exports the two browser kinds from both entries, because ./node is a superset (DR-021)', () => {
    for (const entry of [browserEntry, nodeEntry] as const) {
      expect(typeof entry.createTransport).toBe('function')
      expect(typeof entry.FetchTransport).toBe('function')
      expect(typeof entry.HttpTransport).toBe('function')
    }
    for (const symbol of nodeOnlySymbols) {
      expect(typeof (nodeEntry as unknown as Record<string, unknown>)[symbol], `src/node.ts must export ${symbol}`).toBe('function')
    }
  })
})

describe('constructing a Node-only kind from the browser entry (ARCHITECTURE §5 guard test)', () => {
  const nodeOnlyKinds = ['unix', 'http-local', 'session', 'https-client-cert'] as const

  for (const kind of nodeOnlyKinds) {
    it(`refuses kind ${JSON.stringify(kind)} with a message naming the ./node import`, () => {
      const build = (): unknown => browserEntry.createTransport({ kind } as never)
      expect(build).toThrow(NotSupportedError)
      expect(build).toThrow(/Node-only/u)
      expect(build).toThrow(/@devhax-heavy-industries\/arista-eapi\/node/u)
    })
  }

  it('refuses the local transports (unix and http-local) rather than degrading to a network kind (DR-008/DR-014)', () => {
    // The literal `path`/`port` from pyeapi's socket/http_local profiles: they must not be read as if
    // they were ordinary endpoint options on an entry that has no such capability.
    expect(() => browserEntry.createTransport({ kind: 'unix', socketPath: '/var/run/command-api.sock' } as never)).toThrow(/Node-only/u)
    expect(() => browserEntry.createTransport({ kind: 'http-local', port: 8080, allowLocalUnauthenticated: true } as never)).toThrow(/Node-only/u)
  })

  it('refuses DR-013 TLS trust options on a browser kind instead of ignoring them', () => {
    for (const tlsOption of [
      { ca: 'inline PEM' },
      { fingerprint: 'ab:cd' },
      { dangerouslyDisableTlsVerification: true },
      { serverName: 'sw1.lan' },
    ]) {
      const build = (): unknown => browserEntry.createTransport({ kind: 'https', host: 'sw1.lan', ...tlsOption } as never)
      expect(build).toThrow(NotSupportedError)
      expect(build).toThrow(/browser build/u)
    }
  })

  it('refuses `allowLocalUnauthenticated` in the browser build (DR-008)', () => {
    expect(() => browserEntry.createTransport({ kind: 'https', host: 'sw1.lan', allowLocalUnauthenticated: true } as never)).toThrow(/browser build/u)
  })

  it('refuses an option that belongs to no kind at all, rather than quietly ignoring it (DR-016)', () => {
    expect(() => browserEntry.createTransport({ kind: 'https', host: 'sw1.lan', enforce_verification: true } as never)).toThrow(NotSupportedError)
    expect(() => browserEntry.createTransport({ kind: 'https', host: 'sw1.lan', enforce_verification: true } as never)).toThrow(/enforce_verification/u)
  })
})

describe("the browser factory's mock refusal (docs/TESTING.md §3)", () => {
  it('refuses kind "mock": a scripted device cannot be built by production code', () => {
    expect(() => browserEntry.createTransport({ kind: 'mock' } as never)).toThrow(NotSupportedError)
    expect(() => browserEntry.createTransport({ kind: 'mock' } as never)).toThrow(/mockTransport/u)
  })

  it('a `kind` from JS (no compile-time narrowing) is refused by the exhaustive-switch guard', () => {
    const sneaky = { kind: 'telnet', host: 'sw1.lan' } as unknown as Parameters<typeof browserEntry.createTransport>[0]
    expect(() => browserEntry.createTransport(sneaky)).toThrow(/unknown transport kind/u)
  })
})

describe('a browser transport that is built at all is a configured one', () => {
  it('refuses to invent a host, unlike pyeapi, which defaults to localhost (row 8)', () => {
    expect(() => browserEntry.createTransport({ kind: 'https' })).toThrow(TypeError)
    expect(() => browserEntry.createTransport({ kind: 'https' })).toThrow(/never defaults to localhost/u)
  })

  it('names the endpoint it will use, so an error message can quote it (DR-005)', () => {
    const transport = browserEntry.createTransport({ kind: 'https', host: 'sw1.lan', port: 8443, path: '/command-api' })
    expect(transport.kind).toBe('https')
    expect(transport.address).toBe('https://sw1.lan:8443/command-api')
    expect(String(transport)).toBe('https://sw1.lan:8443/command-api')
  })

  it('does not speak cleartext to a non-loopback host without the flag (DR-008)', () => {
    expect(() => browserEntry.createTransport({ kind: 'http', host: 'sw1.lan' })).toThrow(NotSupportedError)
    expect(() => browserEntry.createTransport({ kind: 'http', host: 'sw1.lan' })).toThrow(/cleartext/u)
  })

  it('closes idempotently, and refuses to send afterwards rather than hanging (M1 rule, kept at the transport seam)', async () => {
    const transport = browserEntry.createTransport({ kind: 'https', host: 'sw1.lan' })
    await transport.close()
    await transport.close()
    await expect(transport.execute('show version')).rejects.toBeInstanceOf(TransportError)
    await expect(transport.execute('show version')).rejects.toThrow(/is closed/u)
  })
})
