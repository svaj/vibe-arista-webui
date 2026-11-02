# `test/fixtures/wire/` — hand-authored eAPI envelope cases (M1, #3)

These are **hand-authored** JSON-RPC envelope cases, not device recordings (docs/TESTING.md §4
reserves `recordings/<host-class>/<case>.json` for captures, and no device has been touched by this
milestone — `npm test` stays offline, DR-034). Message texts are modelled on what EOS 4.28.13.1M
prints (`CLI command N of M '<cmd>' failed: …`, with `CliCommand.__str__` appending `input=%r`),
but the wording is **synthetic until M12 (#14) records real captures**. Treat the numeric codes and
the envelope *shape* as the contract; treat the prose as illustrative.

Naming: `<method>--<scenario>.json`, per TESTING.md §4 — never named after a test.

| File | Covers |
| --- | --- |
| `runCmds--success-two-commands.json` | a `result[]` reply (`enable` + `show version`) |
| `runCmds--success-empty-result.json` | `result: []` — success with nothing to show |
| `runCmds--text-success-diff.json` | the `format: "text"` answer a DR-012 retry receives |
| `runCmds--error-1000-command-failed.json` | `1000`, `error.data` as the per-command array |
| `runCmds--error-1001-command-exception.json` | `1001` |
| `runCmds--error-1002-data-array.json` | `1002`, `error.data[]` including the `errors` marker entry |
| `runCmds--error-1002-error-detail.json` | `1002` with `includeErrorDetail: true` → `data: {result, errorDetail}` |
| `runCmds--error-1003-unconverted.json` | `1003 COMMAND_UNCONVERTED` → the text-fallback trigger |
| `runCmds--error-1004-incompatible.json` | `1004` |
| `runCmds--error-1005-unauthorized.json` | `1005` |
| `runCmds--error-1005-enable-input.json` | DR-011 probe: an `enable` password echoed in `message` **and** `data` |
| `runCmds--error-1006-config-locked.json` | `1006 COMMAND_CONFIG_LOCKED` (DR-023) |
| `runCmds--error-32700-parse-error.json` | `-32700` |
| `runCmds--error-32600-invalid-request.json` | `-32600` |
| `runCmds--error-32601-method-not-found.json` | `-32601` |
| `runCmds--error-32602-unexpected-keyword.json` | `-32602` + the "not supported in this version of EOS" decoration |
| `runCmds--error-32603-internal-error.json` | `-32603` |
| `runCmds--error-no-data.json` | failure envelope where `error.data` is omitted entirely |
| `runCmds--error-empty-data-array.json` | `error.data: []` — present but empty (pyeapi renders an empty `[]` suffix) |
| `runCmds--malformed-unclosed-brace.json` | body that is not parseable JSON → `ProtocolError` with truncated raw text |
| `invalid--result-and-error.json` | both members → `ProtocolError` |
| `invalid--no-result-or-error.json` | neither member → `ProtocolError` |
| `invalid--result-not-array.json` | `result` is an object → `ProtocolError` |
| `invalid--error-without-code.json` | `error.code` missing → `ProtocolError` |
| `invalid--jsonrpc-1.0.json` | unexpected `jsonrpc` → `ProtocolError` |
| `request--two-commands.json` | expected `buildRequest` output (params allow-list, id policy) |
| `request--all-supported-params.json` | DR-016: every accepted param, including `stopOnError`/`includeErrorDetail`/`requestTimeout` |

## Secret probe token

`pw-from-fixture-probe` is the **only** credential-shaped string allowed anywhere in this package's
fixtures. Two files hold the guard, one layer each: `src/internal/wire.test.ts` proves the probe never
appears in a `CommandError` message, `String(error)`, `error.stack` or `JSON.stringify(error)` for the
inline envelopes, and `src/internal/wire.fixture.test.ts` proves it across this directory — enumerating
every file and requiring an exact manifest match (a fixture cannot sit undriven), the
`<method>--<scenario>.json` name convention (a sidecar such as `passwords.conf.json` fails it), every
`{cmd: "enable", input: …}` object carrying exactly this token, and `redactWireText()` over every
fixture body. So a real enable password cannot be committed to the tree by accident, in either the
message text or a structured field. M12 (#14) adds the same guard for recorded fixtures.
