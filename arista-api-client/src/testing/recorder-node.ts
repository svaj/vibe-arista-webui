/**
 * The filesystem half of the recorder — M12 (#14), split out of `recording.ts` on purpose.
 *
 * `recording.ts` must stay browser-safe so the webui can record and replay fixtures in a component
 * test (DR-002). The DR-002 check is not a style rule: `vite.config.ts`'s `browserSafetyGuard()` fails
 * `npm run build` when a Node built-in appears in the **transitive closure** of either entry bundle, and
 * `src/browser-safety.test.ts:7` walks the same graph offline. Neither entry imports `src/testing/**`
 * today; keeping `node:fs` in this separate file means adding a future `./testing` export subpath
 * (the plan in `src/testing/README.md`) cannot quietly drag a filesystem dependency into a browser
 * chunk — the browser-safe half is importable on its own, and this file is the one a Node harness has
 * to name.
 *
 * Path policy, all of it deliberate:
 *  - `test/fixtures/recordings/<target-slug>/<case>.json` — docs/TESTING.md:108-131, docs/CEOS.md:143;
 *  - the directory comes from the **fixture's own identity**, never from the caller, so a cEOS capture
 *    cannot be filed on top of a hardware one (DR-043) by passing a wrong argument;
 *  - the file name is `slug + case` only. No timestamp, no pid, no random suffix: a refresh that changes
 *    nothing shows an empty diff, which is the only way a reviewer can spot a refresh that changed
 *    something (docs/TESTING.md:113-114 names fixtures after the command + scenario for the same reason).
 *
 * Offline note: nothing in this file runs during `npm test` except from its own test
 * (`recorder-node.test.ts`), which writes to a temp directory it removes. No device, no container.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertRecordingIdentity, assertTargetSlug, parseRecording, recordingText, TARGET_CLASSES, type ExpectedDevice, type RecordingFixture } from './recording'

/** The committed recording tree, relative to this package (docs/TESTING.md:108-109). */
export const RECORDINGS_DIR: string = fileURLToPath(new URL('../../test/fixtures/recordings/', import.meta.url))

/** `<command>--<scenario>` (docs/TESTING.md:113-114). `--` is required, so `recorder.test.json` is refused. */
const CASE_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?--[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u
const SLUG = /^[a-z0-9][a-zA-Z0-9._-]*$/u

/** Where a fixture lives, as data — used by the loaders and by every refusal message. */
export interface RecordingLocation {
  readonly slug: string
  readonly caseName: string
  /** Override the tree root; only a temp directory in a test, or the harness's scratch area. */
  readonly root?: string | undefined
}

function rootOf(root?: string | undefined): string {
  return resolve(root ?? RECORDINGS_DIR)
}

/**
 * The deterministic path for a location. Refuses anything that could escape the tree (`..`, a nested
 * path, an absolute slug) and anything that breaks the naming convention, because a fixture tree people
 * review has to stay reviewable.
 */
export function recordingPath(location: RecordingLocation): string {
  const { slug, caseName } = location
  if (!SLUG.test(slug)) {
    throw new Error(`recording slug ${JSON.stringify(slug)} is not a usable directory name (expected ${SLUG.source}) — the slug is the target identity, docs/CEOS.md:143-145`)
  }
  if (!CASE_NAME.test(caseName)) {
    throw new Error(
      `recording case name ${JSON.stringify(caseName)} is refused: expected the <command>--<scenario> spelling of docs/TESTING.md:113-114 (a name is required to contain "--", no path separators, no leading/trailing punctuation). A fixture named after its test file hides what a broken recording actually captured`,
    )
  }
  const root = rootOf(location.root)
  const path = resolve(join(root, slug, `${caseName}.json`))
  if (!path.startsWith(join(root, slug) + '/')) {
    throw new Error(`refusing to write outside the recording tree: ${JSON.stringify(path)}`)
  }
  return path
}

/** Read one fixture. A missing file lists the cases that *do* exist, so a typo is not a mystery. */
export function readRecording(location: RecordingLocation): RecordingFixture {
  const path = recordingPath(location)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    const available = listRecordingCases(location.slug, location.root)
    throw new Error(
      `no recording at ${JSON.stringify(path)} — cases present for ${JSON.stringify(location.slug)}: ${available.length === 0 ? '(none)' : available.join(', ')}. A replay for a command that has never been captured is a missing fixture, not an empty answer (docs/TESTING.md:112)`,
    )
  }
  return parseRecording(text, path)
}

/**
 * Read a fixture and assert it belongs where it is filed. The **directory is itself an expectation**: a
 * capture someone moved by hand into the other lane's directory fails the load rather than quietly
 * serving the wrong device's bytes (DR-043, docs/TESTING.md:130-131).
 *
 * This is the replay entry point both halves use: an offline test loads by
 * `{ slug: 'ceos-4.28.14M', caseName: 'show-version--lab-identity' }`, and a live test passes its
 * `EAPI_ALLOW_MODEL`/`EAPI_ALLOW_VERSION` pins as `expected` so a fixture cannot paper over a
 * wrong-target run.
 */
export function loadRecording(location: RecordingLocation, expected?: ExpectedDevice | undefined): RecordingFixture {
  const fixture = readRecording(location)
  assertRecordingIdentity(fixture, { slug: location.slug, ...(expected ?? {}) })
  return fixture
}

/** The cases recorded for one target slug. */
export function listRecordingCases(slug: string, root?: string | undefined): string[] {
  if (!SLUG.test(slug)) throw new Error(`recording slug ${JSON.stringify(slug)} is not a usable directory name`)
  const dir = join(rootOf(root), slug)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.filter((entry) => entry.endsWith('.json')).sort()
}

/** Every target slug present in the tree — the two lanes the docs insist on keeping apart. */
export function listRecordingTargets(root?: string | undefined): string[] {
  const dir = rootOf(root)
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export interface WriteRecordingOptions {
  readonly caseName: string
  readonly root?: string | undefined
  /**
   * Explicit, and only ever set by `npm run fixtures:refresh` (PLAN.md:395). A test that writes a
   * fixture without opting in is a test that rewrites committed evidence on every run.
   */
  readonly overwrite?: boolean | undefined
}

export interface WrittenRecording {
  readonly path: string
  readonly bytes: number
  /** Whether a file that did not exist before was created (false = an explicit refresh replaced one). */
  readonly created: boolean
  /** `false` when the bytes were already identical — the diff-stable case a re-run of the harness hits. */
  readonly changed: boolean
}

function identityKey(fixture: RecordingFixture): string {
  const { targetSlug, modelName, aristaVersion, targetClass } = fixture.identity
  return [targetSlug, modelName, aristaVersion, targetClass].join('|')
}

/**
 * Write (or refresh) one fixture. Three refusals, in order:
 *  1. the envelope must agree with the directory it would land in (`assertTargetSlug`) — belt and braces
 *     after `buildRecording`, so a fixture assembled by hand cannot be misfiled either;
 *  2. an existing file whose **identity** differs is never replaced (DR-043: "cEOS recordings must never
 *     overwrite hardware fixtures", docs/TESTING.md:131);
 *  3. an existing file with the same identity still needs `overwrite: true`, so nothing rewrites
 *     committed evidence implicitly.
 *
 * The redaction guard is not repeated here: {@link recordingText} asserts it on every serialisation, and
 * {@link parseRecording} asserts it on every read — write and load are both gated, which is what makes
 * a hand-edit in the tree fail a test rather than a review.
 */
export function writeRecording(fixture: RecordingFixture, options: WriteRecordingOptions): WrittenRecording {
  assertTargetSlug(fixture.identity.targetSlug, {
    modelName: fixture.identity.modelName,
    version: fixture.identity.aristaVersion,
    targetClass: fixture.identity.targetClass,
  })
  if (!TARGET_CLASSES.includes(fixture.identity.targetClass)) {
    throw new Error(`refusing to write ${JSON.stringify(options.caseName)}: targetClass ${JSON.stringify(fixture.identity.targetClass)} is not one of ${TARGET_CLASSES.join(', ')}`)
  }
  const path = recordingPath({ slug: fixture.identity.targetSlug, caseName: options.caseName, ...(options.root === undefined ? {} : { root: options.root }) })
  let previous: string | undefined
  try {
    previous = readFileSync(path, 'utf8')
  } catch {
    previous = undefined
  }
  if (previous !== undefined) {
    const existing = parseRecording(previous, path)
    if (identityKey(existing) !== identityKey(fixture)) {
      throw new Error(
        `refusing to overwrite ${JSON.stringify(path)}: it holds a capture of ${JSON.stringify(identityKey(existing))} and this one is ${JSON.stringify(identityKey(fixture))}. cEOS and hardware evidence never share a file (DR-043, docs/TESTING.md:131)`,
      )
    }
    if (options.overwrite !== true) {
      throw new Error(`refusing to overwrite ${JSON.stringify(path)} without overwrite:true — refreshing a committed fixture is explicit (PLAN.md:395, npm run fixtures:refresh)`)
    }
  }
  const text = recordingText(fixture)
  mkdirSync(join(rootOf(options.root), fixture.identity.targetSlug), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return { path, bytes: Buffer.byteLength(text, 'utf8'), created: previous === undefined, changed: previous !== text }
}
