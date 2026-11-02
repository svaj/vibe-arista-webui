/**
 * The webui half of extension point #1 in `arista-api-client/docs/ARCHITECTURE.md` §9: the app widens
 * the client's `ShowContracts` map by augmenting the **published package types**, exactly as
 * `docs/USAGE.md` §4 documents it. Screens will do this for real in M9 (#13); this file proves the
 * mechanism against the declaration file the webui actually resolves (`dist/index.d.ts` via the
 * `types` condition), so the contract cannot rot from the consumer side.
 *
 * The client-side equivalent — `arista-api-client/src/types/eapi.test.ts` — targets the declaring
 * module, because a package cannot augment its own name (TS2664). Both files assert type identity,
 * neither asserts runtime behaviour: there is nothing to run.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ShowContracts, ShowReply } from '@devhax-heavy-industries/arista-eapi'

interface LagCounterEntry {
  readonly lagName: string
  readonly totalInOctets: number
  readonly lacpTraffic: string
}

declare module '@devhax-heavy-industries/arista-eapi' {
  interface ShowContracts {
    'lag counters': readonly LagCounterEntry[]
  }
}

type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

describe('the webui can widen ShowContracts by declaration merging (ARCHITECTURE §9.1)', () => {
  it('the augmentation lands on the package root re-export', () => {
    expectTypeOf<Exactly<ShowReply<'lag counters'>, readonly LagCounterEntry[]>>().toEqualTypeOf<true>()
    expectTypeOf<keyof ShowContracts>().toEqualTypeOf<'lag counters'>()
  })

  it('a command the app has not modelled is `unknown`, so the screen must narrow it on purpose', () => {
    expectTypeOf<ShowReply<'vlan 20'>>().toEqualTypeOf<unknown>()
    expectTypeOf<ShowReply<'vlan 20'>>().not.toBeAny()
    // @ts-expect-error - `unknown` cannot be indexed as if the contract already existed
    const unmodelled: LagCounterEntry[] = [] as unknown as ShowReply<'vlan 20'>
    const modelled: readonly LagCounterEntry[] = [] as unknown as ShowReply<'lag counters'>
    expect(unmodelled).toHaveLength(0)
    expect(modelled).toHaveLength(0)
  })
})
