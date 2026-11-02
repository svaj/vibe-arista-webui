# `src/types/` — wire + contract types, no runtime code

`eapi.ts` (**M1** #3): `JsonRpcId`, `CommandSpec`, `RunCmdsParams`, `JsonRpcSuccess`,
`JsonRpcFailure`, `EapiResponse`. `contracts.ts`: the augmentable `ShowContracts` map the
webui's screens type against (**M4** #6), plus narrow resource contracts
(`VlanEntry`, `SwitchportEntry`, `InterfaceEntry`) — **M9**/**M10** (#11, #12).

Excluded from coverage because it is declaration-only (docs/TESTING.md §2).
