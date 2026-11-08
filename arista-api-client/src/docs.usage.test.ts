/**
 * `docs:check` — the USAGE.md snippets compile (M13 #15, PLAN §M13: docs were written as the API
 * *target*, so drift between them and the shipped surface has to be a build failure, not a review
 * miss). Runs in the unit project (every `npm test` checks the docs); `npm run docs:check` is the
 * focused alias.
 *
 * ## How it works
 *  1. Every ```-ts fence in `docs/USAGE.md` is extracted with its start line; the temp file is named
 *     after that line (`usage-L146.ts`), so a tsc error maps straight back to the doc.
 *  2. Fences land under `node_modules/docs-check/` (workspace-internal on purpose: `@types/node` and
 *     the module's own `paths` mappings must resolve; `node_modules` is untracked by construction).
 *  3. Prose-established free variables (`node`, `host`, `approved`…) get ambient `declare` preambles
 *     ONLY when the fence neither binds nor imports them — fences that define `node` themselves
 *     (several do) get no ambient one, so the check reflects real usage, not a lucky global. Every
 *     fence is forced to a module (`export {}`) because `declare module` augmentation and top-level
 *     `await` both require it.
 *  4. Compilation runs the REAL `tsc` (`--noEmit`) over a generated tsconfig that mirrors the
 *     consumers' contract: ESNext + bundler resolution + the published `exports` mapped to the `src/`
 *     entrypoints (`development` condition, same sources), strict. TS 7's programmatic JS surface is
 *     `unstable/*` subpaths; the CLI is the stable thing to call, and it is what a consumer's editor
 *     effectively runs.
 *  5. Any error line fails the test, re-rendered to `docs/USAGE.md:<fence line>`. The fence-count
 *     cross-check (extracted === count of ts tags) prevents a lang-tag rename from silently dropping
 *     coverage.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = join(PKG_ROOT, 'docs', 'USAGE.md')
const OUT_DIR = join(PKG_ROOT, 'node_modules', 'docs-check')

interface Fence {
  /** 1-based line of the opening fence marker in USAGE.md — carried into the temp file name. */
  readonly startLine: number
  readonly body: string
}

function extractTsFences(markdown: string): Fence[] {
  const lines = markdown.split('\n')
  const fences: Fence[] = []
  let open: { start: number; lang: string } | undefined
  let body: string[] = []
  for (const [i, line] of lines.entries()) {
    const m = /^```(\w*)\s*$/u.exec(line)
    if (open === undefined) {
      if (m !== null && m[1] !== undefined) {
        open = { start: i + 1, lang: m[1] }
        body = []
      }
      continue
    }
    if (/^```\s*$/u.test(line)) {
      if (open.lang === 'ts' && body.some((entry) => entry.trim() !== '')) fences.push({ startLine: open.start, body: body.join('\n') })
      open = undefined
      body = []
      continue
    }
    body.push(line)
  }
  if (open !== undefined) throw new Error(`unclosed code fence at docs/USAGE.md:${String(open.start)}`)
  return fences
}

/** Identifiers the prose leaves free; ambient-declared only when the fence uses one without binding it. */
const AMBIENT: Readonly<Record<string, string>> = {
  node: 'declare const node: import("@devhax-heavy-industries/arista-eapi").Node;',
  conn: 'declare const conn: import("@devhax-heavy-industries/arista-eapi").Transport;',
  host: 'declare const host: string;',
  username: 'declare const username: string;',
  password: 'declare const password: string;',
  port: 'declare const port: number;',
  approved: 'declare const approved: boolean;',
  confText: 'declare const confText: string;',
  // The §5 validate-changes excerpt continues the session started in the previous excerpt's prose;
  // same rule as the others: only declared when the fence does not bind it itself.
  session: 'declare const session: Awaited<ReturnType<import("@devhax-heavy-industries/arista-eapi").Node["configSession"]>>;',
}

function usesIdentifier(body: string, id: string): boolean {
  return new RegExp(`(^|[^\\w$.])${id}(?![\\w$])`, 'u').test(body)
}

function bindsOrImports(body: string, id: string): boolean {
  return (
    new RegExp(`(^|[{;(,\\n])\\s*(?:const|let|var|function|class|interface|type|enum)\\s+${id}\\b`, 'u').test(body) ||
    new RegExp(`declare\\s+(?:const|let|function|class)\\s+${id}\\b`, 'u').test(body) ||
    new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${id}\\b`, 'u').test(body)
  )
}

function preambleFor(fence: Fence): string {
  const declared: string[] = []
  for (const [id, decl] of Object.entries(AMBIENT)) {
    if (usesIdentifier(fence.body, id) && !bindsOrImports(fence.body, id)) declared.push(decl)
  }
  return [...declared, 'export {};'].join('\n')
}

/** Resolves the typescript CLI without deep-importing past the package's exports map (bin path is readable from package.json). */
function tscCli(): string {
  for (const rel of ['../node_modules/typescript', './node_modules/typescript']) {
    const dir = resolve(PKG_ROOT, rel)
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const bin = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: { tsc?: string } }).bin?.tsc
      if (bin !== undefined) return join(dir, bin)
    }
  }
  throw new Error('docs:check cannot locate the typescript CLI (node_modules/typescript bin tsc)')
}

describe('docs:check — every TypeScript fence in docs/USAGE.md compiles', () => {
  it('fence census stays honest', () => {
    const text = readFileSync(USAGE, 'utf8')
    const fences = extractTsFences(text)
    expect(fences.length).toBeGreaterThanOrEqual(17)
    expect(fences.length, 'every ts fence in docs/USAGE.md is compiled (a lang-tag rename must not drop coverage)').toBe((text.match(/^```ts\s*$/gmu) ?? []).length)
  })

  it('tsc --noEmit over the extracted fences against src/ is clean', () => {
    const fences = extractTsFences(readFileSync(USAGE, 'utf8'))
    mkdirSync(OUT_DIR, { recursive: true })
    const files = fences.map((fence) => {
      const name = `usage-L${String(fence.startLine)}.ts`
      writeFileSync(join(OUT_DIR, name), `${preambleFor(fence)}\n${fence.body}\n`, 'utf8')
      return name
    })
    const tsconfig = {
      compilerOptions: {
        strict: true,
        target: 'esnext',
        // ESNext libs and NOTHING else: with DOM in scope the global `Node` (a DOM type)
        // shadows the package's Node class and every "not imported" mistake compiles against the wrong
        // thing. Fences importing the class get the class; fences forgetting it get a loud TS2304.
        lib: ['esnext'],
        module: 'esnext',
        moduleResolution: 'bundler',
        // TS 7 removed `baseUrl`: `paths` entries resolve against the tsconfig file's directory, and
        // this tsconfig lives at node_modules/docs-check — so the package's src/ is two levels up.
        paths: {
          '@devhax-heavy-industries/arista-eapi': ['../../src/index.ts'],
          '@devhax-heavy-industries/arista-eapi/node': ['../../src/node.ts'],
          '@devhax-heavy-industries/arista-eapi/testing': ['../../src/testing/index.ts'],
        },
        types: ['node'],
        skipLibCheck: true,
        noEmit: true,
      },
      files,
    }
    writeFileSync(join(OUT_DIR, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf8')
    const proc = spawnSync(process.execPath, [tscCli(), '-p', join(OUT_DIR, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8', cwd: OUT_DIR })
    if (proc.status !== 0) {
      const rendered = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`
        .split('\n')
        .map((line) => line.replace(/^usage-L(\d+)\.ts/u, 'docs/USAGE.md:$1 [fence]'))
        .filter((line) => line.trim() !== '')
        .slice(0, 80)
      throw new Error(`docs:check failed:\n${rendered.join('\n')}`)
    }
  })
})
