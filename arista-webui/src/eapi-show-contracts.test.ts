/**
 * The webui half of extension point #1 in `arista-api-client/docs/ARCHITECTURE.md` §9: the app widens
 * the client's `ShowContracts` map by augmenting the **published package types**, exactly as
 * `docs/USAGE.md` §4 documents it. Since M13 (#15) the app has real augmentations — the modelled
 * screen commands in `src/eapi/show-contracts.ts`, pinned against captured device replies in
 * `src/eapi/show-contracts.test.ts`. This file keeps the *mechanism* proof against the declaration
 * file the webui actually resolves (`dist/index.d.ts` via the `types` condition), so the extension
 * point itself cannot rot from the consumer side even if the screen set changes:
 *
 * - a key augmented from app source lands on the package root re-export, and
 * - a command the app has not modelled stays `unknown` and must be narrowed on purpose.
 *
 * The client-side equivalent — `arista-api-client/src/types/eapi.test.ts` — targets the declaring
 * module, because a package cannot augment its own name (TS2664). Both files assert type identity;
 * neither asserts runtime behaviour: there is nothing to run.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ShowContracts, ShowReply } from '@devhax-heavy-industries/arista-eapi'

import type { ShowVersionReply } from './eapi/show-contracts'

type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

describe('the webui widens ShowContracts by declaration merging (ARCHITECTURE §9.1)', () => {
  it('a key augmented by app source lands on the package root re-export', () => {
    // `src/eapi/show-contracts.ts` merges `version` into the map by package name; this file proves
    // the merge is visible to code that resolves the PUBLISHED types, not just the TS source.
    expectTypeOf<ShowContracts['version']>().toEqualTypeOf<ShowVersionReply>()
    expectTypeOf<Exactly<ShowReply<'version'>, ShowVersionReply>>().toEqualTypeOf<true>()
  })

  it('the typed reply really carries the modelled screen fields', () => {
    type ScreenView = Pick<ShowVersionReply, 'hostname' | 'version' | 'modelName'>
    expectTypeOf<ShowReply<'version'>>().toMatchTypeOf<ScreenView>()
    expectTypeOf<keyof ShowReply<'version'> & ('version' | 'modelName' | 'systemMacAddress')>().toEqualTypeOf<'version' | 'modelName' | 'systemMacAddress'>()
  })

  it('a command the app has not modelled is `unknown`, so the screen must narrow it on purpose', () => {
    expectTypeOf<ShowReply<'ip interface brief'>>().toEqualTypeOf<unknown>()
    expectTypeOf<ShowReply<'ip interface brief'>>().not.toBeAny()
    // @ts-expect-error - `unknown` cannot be indexed as if the contract already existed
    const unmodelled: { interfaces?: unknown } = {} as unknown as ShowReply<'ip interface brief'>
    const modelled: ShowVersionReply = {} as unknown as ShowVersionReply
    expect(unmodelled).toEqual({})
    expect(modelled).toBeTypeOf('object')
  })
})
