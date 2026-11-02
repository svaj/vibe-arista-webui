/**
 * `ShowContracts` — the declaration-merging contract, M1 (#3).
 *
 * This is the type test `src/types/eapi.ts` points at ("the augment + narrow type test") and the
 * PLAN M1 bullet "Type tests (`expectTypeOf`) that `show<T>()` narrows by command literal". It proves
 * extension point #1 of docs/ARCHITECTURE.md §9: the map ships **empty**, a consumer widens it by
 * declaration merging, `ShowReply<K>` then resolves to the augmented reply for that literal, and an
 * un-modelled literal is `unknown` — never `any`, which is the difference between a webui screen
 * that fails to compile and one that silently renders `undefined`.
 *
 * The specifier note matters: a consumer writes the augmentation against the package name
 * (docs/USAGE.md §4) —
 *
 *   declare module '@devhax-heavy-industries/arista-eapi' { interface ShowContracts { … } }
 *
 * — which is what `arista-webui/src/eapi-show-contracts.test.ts` exercises against the published
 * declarations. From **inside** this package that same specifier is illegal (TS2664: a module cannot
 * augment itself), so the in-package form below targets the declaring module, `'./eapi'` — the one
 * interface both forms merge into. Merging through the root re-export is asserted on the webui side;
 * here the assertions are about the map itself, so the two files are not duplicates.
 *
 * Everything here is compile-time. `src/types/**` is declaration-only and excluded from coverage
 * (docs/TESTING.md §2), so the single runtime assertion is the emptiness of the module itself.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import * as eapiTypes from './eapi'
import type { CommandResult, ShowContracts, ShowReply } from './eapi'

// --- what a consumer adds (the shape docs/USAGE.md §4 shows for `lag counters`) ----------------

interface ShowVersionReply {
  readonly hostname: string
  readonly version: string
  readonly modelName: string
  readonly serialNumber: string
  readonly uptime: number
}

interface LagCounterEntry {
  readonly lagName: string
  readonly totalInOctets: number
}

/** The commands THIS file widens the map with — the type-level and runtime view of the same list. */
const AUGMENTED_COMMANDS = ['version', 'lag counters'] as const
type AugmentedKey = (typeof AUGMENTED_COMMANDS)[number]

declare module './eapi' {
  interface ShowContracts {
    version: ShowVersionReply
    'lag counters': readonly LagCounterEntry[]
  }
}

/**
 * Type identity in both directions — stronger than assignability, so an interface that drifted to
 * `any`/`unknown`/a supertype fails instead of passing quietly.
 */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/**
 * Stand-in for M4's (`#6`) runtime accessor `node.show<K>(command): Promise<ShowReply<K>>`. M1 owns
 * no command layer, so the *contract* M4 must satisfy is expressed here at type level rather than by
 * pretending a method exists.
 */
type ShowCall<K extends keyof ShowContracts | string> = Promise<ShowReply<K>>

describe('ShowContracts ships empty and is widened only by consumers (ARCHITECTURE.md §9)', () => {
  it('src/types/eapi.ts declares no runtime values at all', () => {
    // Declaration-only module: the map is a type, so nothing can leak into the browser bundle.
    expect(Object.keys(eapiTypes)).toEqual([])
  })

  it('the only members of the map are the ones this consumer added', () => {
    // Proves the shipped interface contributes zero keys: any member declared in `src/types/eapi.ts`
    // (or a stale one left over from a previous augmentation) breaks this identity.
    expectTypeOf<Exactly<keyof ShowContracts, AugmentedKey>>().toEqualTypeOf<true>()
    expectTypeOf<keyof ShowContracts>().toEqualTypeOf<'version' | 'lag counters'>()
  })
})

describe('declaration merging is visible to expectTypeOf', () => {
  it('ShowContracts["version"] is the augmented reply, not a placeholder', () => {
    expectTypeOf<ShowContracts['version']>().toEqualTypeOf<ShowVersionReply>()
    expectTypeOf<ShowContracts['lag counters']>().toEqualTypeOf<readonly LagCounterEntry[]>()
  })

  it('ShowReply<K> resolves per literal', () => {
    expectTypeOf<Exactly<ShowReply<'version'>, ShowVersionReply>>().toEqualTypeOf<true>()
    expectTypeOf<Exactly<ShowReply<'lag counters'>, readonly LagCounterEntry[]>>().toEqualTypeOf<true>()
  })

  it('the augmented keys are usable where the map is consumed', () => {
    // The runtime half of the same list keeps a typo in the type-level list from going unnoticed.
    expect<readonly (keyof ShowContracts)[]>(AUGMENTED_COMMANDS).toEqual(['version', 'lag counters'])
    expectTypeOf<'version'>().toExtend<keyof ShowContracts>()
    expectTypeOf<AugmentedKey>().toExtend<keyof ShowContracts | string>()
  })
})

describe('an un-augmented command literal is unknown, never any', () => {
  it('ShowReply resolves to unknown for a literal the consumer did not declare', () => {
    expectTypeOf<ShowReply<'interfaces status'>>().toEqualTypeOf<unknown>()
    expectTypeOf<ShowReply<'show mlag'>>().toEqualTypeOf<unknown>()
    expectTypeOf<ShowReply<'configuration sessions'>>().toBeUnknown()
    expectTypeOf<ShowReply<'anything-not-in-the-map'>>().not.toBeAny()
    expectTypeOf<ShowReply<'interfaces status'>>().not.toBeNever()
  })

  it('`unknown` refuses to be used as a reply object without an explicit narrowing', () => {
    // If the fallback ever degenerated to `any`, this directive becomes unused and the build fails.
    // @ts-expect-error - un-modelled command: `unknown` is not assignable to a shaped reply
    const unmodelled: ShowVersionReply = null as unknown as ShowReply<'interfaces status'>
    // Compiles only because the augmentation resolved `ShowReply<'version'>` to the consumer's shape.
    const modelled: ShowVersionReply = null as unknown as ShowReply<'version'>
    // Both are `null` here — only the types differ, which is the point of the test.
    expect(modelled).toBeNull()
    expect(unmodelled).toBeNull()
  })
})

describe('narrowing by command literal, as M4 (#6) will expose it', () => {
  it('ShowCall<K> carries the literal through to the reply type', () => {
    expectTypeOf<ShowCall<'version'>>().resolves.toEqualTypeOf<ShowVersionReply>()
    expectTypeOf<ShowCall<'lag counters'>>().resolves.toEqualTypeOf<readonly LagCounterEntry[]>()
    expectTypeOf<ShowCall<'interfaces status'>>().resolves.toEqualTypeOf<unknown>()
  })

  it('the whole map maps each literal to its reply, and nothing else', () => {
    type Replies = { [K in keyof ShowContracts]: ShowReply<K> }
    type ExpectedReplies = { version: ShowVersionReply; 'lag counters': readonly LagCounterEntry[] }
    expectTypeOf<Exactly<Replies, ExpectedReplies>>().toEqualTypeOf<true>()
  })

  it('the codec still yields CommandResult; typing it as a reply is M4’s casting point (#6)', () => {
    // A consumer reply is an interface, so it is NOT structurally assignable to the
    // `Record<string, unknown>` the decoder returns (no implicit index signature). M4 (#6) owns the
    // single place that types `result[i]` as `ShowReply<K>`; asserting it here keeps that boundary
    // from being designed away by accident in a later milestone.
    expectTypeOf<ShowVersionReply extends CommandResult ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<CommandResult>().not.toEqualTypeOf<ShowVersionReply>()
  })

  it('two different literals do not collapse into one reply type', () => {
    expectTypeOf<ShowReply<'version'>>().not.toEqualTypeOf<ShowReply<'lag counters'>>()
    expectTypeOf<Exactly<ShowReply<'version'>, ShowReply<'lag counters'>>>().toEqualTypeOf<false>()
  })
})
