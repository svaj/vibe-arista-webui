/**
 * `DeviceIdentity` and `identityFrom` are the `src/features/SwitchManager.tsx` pair, moved verbatim
 * so the header primitive (F3, #65) can compose without owning a read, and every later screen
 * (F6/#68 then S1–S15) resolves identity the same way. The screen's private copy is gone: F6
 * rewired `VlanAssignment` onto this one, which is why #65 deliberately did not touch the file
 * whose behaviour `App.test.tsx` pinned at the time.
 */
import type { ShowVersionReply } from '../eapi/show-contracts'

export type DeviceIdentity = { hostname: string; version: string; model: string }

/** `hostname` exists only in the switch's `show version` capture; `modelName` is in both. */
export const identityFrom = (version: ShowVersionReply): DeviceIdentity =>
  ({ hostname: version.hostname ?? version.modelName, version: version.version, model: version.modelName })
