# `src/internal/` — not public API (DR-040)

Runtime-agnostic internals: `wire.ts` (JSON-RPC `buildRequest`/`parseResponse`),
`redact.ts`, `config-text.ts` (`chunkify`/`section`/`getBlock`), `ranges.ts`,
`collections.ts`, `journal.ts`. Nothing here is exported from `src/index.ts` or
`src/node.ts`.

Lands in: **M1** (#3, wire codec + redaction), **M6** (#8, config-text engine),
**M5** (#7, session journal). See `docs/ARCHITECTURE.md` §2 and §6 for the import rules.
