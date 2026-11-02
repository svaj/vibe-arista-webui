import { isBuiltin } from 'node:module'

import { defineConfig, type Plugin } from 'vite'

// Node built-ins stay external: the `./node` entry really runs on them, and the browser
// entry must never reach them (DR-002). Externals alone are NOT the guard — they only stop
// Rolldown from inlining a specifier, which would otherwise hide a violation behind a
// resolve failure. The guard is `browserSafetyGuard()` below: it fails the build when a Node
// built-in appears in the `src/index.ts` bundle, and when the `src/node.ts` bundle stops
// importing one (which would mean the check had gone blind). It runs inside `npm run build`,
// so CI catches it. The source-graph half of the same rule is `src/browser-safety.test.ts`.
const nodeBuiltin = /^node:/

/** Module specifier syntaxes that can pull another module in. Output is unminified, so text works. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
]

/** `node:fs`, a bare `fs`, `node:internal/…` — everything that only exists in a Node runtime. */
function isNodeSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:') || isBuiltin(specifier)
}

function specifiersIn(code: string): string[] {
  const found = new Set<string>()
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const value = match[1]
      if (value !== undefined) found.add(value)
    }
  }
  return [...found]
}

interface EmittedEntry {
  readonly name: string
  /** Bundle key / emitted file name, used to follow imports between emitted chunks. */
  readonly fileName: string
  /** Shared chunks are not entries; they still count as dependencies of whichever entry loads them. */
  readonly isEntry: boolean
  /** Chunks this chunk imports, as they appear in the emitted import statements. */
  readonly imports: readonly string[]
  /** `null` for chunks with no facade module (the shared chunks, exactly). */
  readonly facadeModuleId: string | null
  readonly moduleIds: readonly string[]
  readonly code: string
}

/** Which built-ins a chunk depends on, from graph metadata *and* from the rendered import statements. */
function nodeDependencies(chunk: EmittedEntry): string[] {
  const fromGraph = chunk.moduleIds.filter((id) => isNodeSpecifier(id))
  const fromCode = specifiersIn(chunk.code).filter((specifier) => isNodeSpecifier(specifier))
  return [...new Set([...fromGraph, ...fromCode])].sort()
}

interface EntryRule {
  /** Matched on the chunk's facade module id, anchoring the check to a source file, not an output name. */
  readonly file: string
  readonly label: string
  /** DR-002: only `src/node.ts` may reach `node:*`. `src/index.ts` must reach none of them. */
  readonly allowNodeBuiltins: boolean
}

const ENTRY_RULES: readonly EntryRule[] = [
  { file: 'src/index.ts', label: 'browser entry', allowNodeBuiltins: false },
  { file: 'src/node.ts', label: 'node entry', allowNodeBuiltins: true },
]

function entryChunkFor(file: string, chunks: readonly EmittedEntry[]): EmittedEntry | undefined {
  const suffix = `/${file}`
  return chunks.find(
    (chunk) => chunk.isEntry && chunk.facadeModuleId !== null && chunk.facadeModuleId.replace(/\\/gu, '/').endsWith(suffix),
  )
}

/**
 * The entry chunk is not the whole bundle: Rolldown hoists the modules both entries share into a
 * separate chunk (`dist/src-<hash>.js`), which the browser entry then imports. A `node:` specifier
 * living there would reach a browser and still leave `dist/index.js` clean, so the check runs over the
 * **transitive closure** of chunks an entry loads — exactly the set of files a consumer executes.
 */
function chunkClosure(entry: EmittedEntry, chunks: readonly EmittedEntry[]): EmittedEntry[] {
  const byName = new Map<string, EmittedEntry>()
  for (const chunk of chunks) {
    byName.set(chunk.fileName, chunk)
    byName.set(chunk.name, chunk)
    byName.set(chunk.fileName.replace(/^\.\//u, ''), chunk)
  }
  const seen = new Set<EmittedEntry>([entry])
  const queue: EmittedEntry[] = [entry]
  while (queue.length > 0) {
    const chunk = queue.shift() as EmittedEntry
    for (const imported of chunk.imports) {
      const normalized = imported.replace(/^\.\//u, '')
      const next = byName.get(normalized) ?? chunks.find((candidate) => candidate.fileName === normalized || candidate.fileName.endsWith(`/${normalized}`))
      if (next !== undefined && !seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return [...seen]
}

/**
 * DR-002's build-time enforcement point (PLAN M2's exit gate: "no Node built-ins reachable from the
 * browser entry (enforced by a build-time check)"). Throwing from `generateBundle` aborts
 * `vite build`, so `npm run build` — and therefore CI — fails red instead of printing a warning.
 *
 * The reverse assertion on `src/node.ts` is not decoration: a guard that matches nothing passes
 * silently, so if the Node entry ever stops importing a built-in the check has stopped proving
 * anything and must be re-examined. Both halves are demonstrated in the PR body for #4.
 */
function browserSafetyGuard(): Plugin {
  return {
    name: 'arista-eapi:browser-safety-guard',
    apply: 'build',
    // Runs on the rendered output, which is the artifact consumers actually load through `exports`.
    enforce: 'post',
    generateBundle(_options, bundle): void {
      // Copied into a narrow shape on purpose: the emitted chunk type differs between Rollup and
      // Rolldown, and these fields are all the guard needs from either. Every chunk is collected,
      // entry or not — a shared chunk is a dependency of whichever entry imports it.
      const chunks: EmittedEntry[] = []
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          chunks.push({
            name: item.name,
            fileName: item.fileName,
            isEntry: item.isEntry,
            imports: item.imports,
            facadeModuleId: item.facadeModuleId ?? null,
            moduleIds: item.moduleIds,
            code: item.code,
          })
        }
      }
      const problems: string[] = []

      for (const rule of ENTRY_RULES) {
        const entry = entryChunkFor(rule.file, chunks)
        if (entry === undefined) {
          problems.push(
            `${rule.label} (${rule.file}) produced no entry chunk, so the DR-002 browser-safety check could not run. ` +
              'This build is not verified: fix the lib entry map rather than trusting a green build.',
          )
          continue
        }
        const closure = chunkClosure(entry, chunks)
        const found = [...new Set(closure.flatMap((chunk) => nodeDependencies(chunk)))].sort()
        const emitted = closure.map((chunk) => chunk.fileName).join(', ')
        if (!rule.allowNodeBuiltins && found.length > 0) {
          problems.push(
            `${rule.label} (${rule.file}) must not reach any Node built-in (DR-002), but the bundle it loads (${emitted}) references ${found.join(', ')}\n` +
              'Move that code behind src/node.ts (or a node-*.ts module only that entry imports) and keep ' +
              'src/index.ts browser-safe: the webui loads this entry through Vite, where these specifiers cannot resolve.',
          )
          continue
        }
        if (rule.allowNodeBuiltins && found.length === 0) {
          problems.push(
            `${rule.label} (${rule.file}) no longer references a single Node built-in, which is the opposite half of the DR-002 check. ` +
              'Either the Node transports moved out of this entry, or the guard stopped seeing dependencies — verify before trusting it.',
          )
        }
      }

      if (problems.length > 0) {
        throw new Error(`[browser-safety-guard] DR-002 violation:\n\n${problems.join('\n\n')}`)
      }
      this.info('[browser-safety-guard] the browser entry bundle is free of Node built-ins; the node entry uses them as expected (DR-002).')
    },
  }
}

export default defineConfig({
  plugins: [browserSafetyGuard()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // Not a shipped-minified library yet: readable output keeps the M0 diff reviewable.
    minify: false,
    target: 'es2022',
    lib: {
      // Two entries == the two runtime faces of the package (DR-002, DR-021).
      entry: {
        index: 'src/index.ts',
        node: 'src/node.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: (id: string) => nodeBuiltin.test(id),
    },
  },
})
