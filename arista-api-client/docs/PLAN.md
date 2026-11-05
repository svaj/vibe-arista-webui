# Implementation Plan — `arista-api-client` (pyeapi → TypeScript)

Baseline source: **pyeapi 1.0.4-rc0** (`develop`, `6816d9e`) at `/home/svaj/development/arista/pyeapi`.
Target: a modern TypeScript eAPI client in [`arista-api-client/`](../), consumed by [`arista-webui/`](../../arista-webui/).

Read first: [DECISIONS.md](./DECISIONS.md) (why the plan looks like this) ·
[MIGRATION.md](./MIGRATION.md) (pyeapi → TS name-by-name map) ·
[ARCHITECTURE.md](./ARCHITECTURE.md) (layers and types) ·
[TESTING.md](./TESTING.md) (test strategy) ·
[STATUS.md](./STATUS.md) (live progress board).

---

## 1. Scope confirmed with the owner

| Question | Decision |
|---|---|
| Runtime | **Dual**: Node-capable core + browser-safe entry point. Unix socket, cert pinning, mTLS = Node-only. |
| Fidelity | **Idiomatic TypeScript** + a mapping doc. Not a line-by-line port. |
| Wave 1 modules | Core + `system`, `vlans`, `interfaces`, `switchports`. Others = later waves. |
| Tests | Offline (MockTransport + recorded fixtures) is the default; opt-in real-EOS integration/live and browser E2E prefer disposable cEOS-lab 4.28.14M. Hardware-only checks remain separate; never in `npm test`. See [cEOS runbook](../../docs/CEOS.md). |
| Packaging | Root **npm workspaces**; `@devhax-heavy-industries/arista-eapi` built with Vite/Rolldown lib mode + `tsc` declarations. |
| Docs/tracking | Markdown under `arista-api-client/docs/`, **plus** one GitHub issue per milestone with burn-down checklists. |

### Explicitly **not** ported (upstream line refs in [MIGRATION.md §7](./MIGRATION.md#7-dropped-on-purpose))
`Node.api('name')` string module autoload · duplicate `response` key in `enable()` results ·
`BaseEntity.error` swallow-and-stash idiom · deprecated `value=None` negation in `command_builder` ·
`_find_sub_json` general-purpose JSON matcher (only needed to redact `enable` input) ·
`pyeapi.utils.debug`/`islocalconnection` · `streaming: true` request mode.

---

## 2. Milestone overview

| ID | Milestone | Outcome / exit gate | Depends on | Est. |
|---|---|---|---|---|
| M0 | Workspace & package scaffolding | `npm test`/`lint`/`typecheck`/`build` green in the new package; webui can import it | — | S |
| M1 | Wire protocol core | Encode/decode `runCmds`; full error taxonomy; secret redaction | M0 | M |
| M2 | Transports | `https`, `http`, `https_certs`, `https_session`/`http_session`, unix/http_local (Node), browser+proxy | M1 | M |
| M3 | Connection profiles | `eapi.conf` reader (Node) + in-memory profile store, tagged hosts | M2 | S |
| M4 | `Node` command layer | `exec` / `show` / `showText` / `configure` / config caching / `version`, `model` | M2 | M |
| M5 | Config sessions & change safety | Named, resumable sessions; diff/commit/abort; `configure replace`; `copy run start`; orphan recovery | M4, M6 | M |
| M6 | Text-config engine | `chunkify` port + fixes, `section()`, `getBlock()`, range expand/collapse | M4 | M |
| M7 | Resource framework | `BaseResource`/`Entity`/`EntityCollection` equivalent + `command()` builder | M4, M6 | M |
| M8 | `system` resource | hostname, ipRouting, banners (multiline) | M7 | S |
| M9 | `vlans` + `switchports` | VLAN CRUD + trunk/access mode/group config — first usable UI slice | M7, M8 | M |
| M10 | `interfaces`: base, ethernet, port-channel | Interface CRUD, LAG/LACP (`setMembers`, `lacpFallback`, `minimumLinks`) | M7, M9 | L |
| M11 | Capability probe + dry-run | `verifyConfig` dry-run; probe that classifies 1002/1004/1005/1006 per feature | M5, M9 | M |
| M12 | Live-device suite + fixtures + CI | cEOS provisioning/readiness, recorder, guarded real-EOS suite, coverage gate, trusted CI | M4 | M |
| M13 | Consumption, docs, release | webui dev-proxy wiring, typed `show` contracts, cEOS browser E2E, CHANGELOG, semver/tag policy | M9, M10; M12 for E2E | S |
| W2 | Wave-2 modules (backlog) | `users`, `acl`, `stp`, `mlag`, `varp`, `ipinterfaces`, `vrfs`, `staticroute`, `ntp` | M10 | L |
| W3 | Wave-3 modules (backlog) | `ospf`, `bgp`, `routemaps`, `vrrp`, `VxlanInterface` | W2 | L |

Sizes: S ≈ ½–1 day of agent work, M ≈ 1–3 days, L ≈ 3–6 days (wall-clock for a pair of focused sessions).

```mermaid
graph LR
  M0[M0 scaffolding] --> M1[M1 protocol]
  M1 --> M2[M2 transports]
  M2 --> M3[M3 profiles]
  M2 --> M4[M4 Node]
  M4 --> M5[M5 sessions]
  M4 --> M6[M6 config text]
  M6 --> M7[M7 resources]
  M4 --> M7
  M7 --> M8[M8 system]
  M8 --> M9[M9 vlans+switchports]
  M6 --> M9
  M9 --> M10[M10 interfaces+LAG]
  M5 --> M11[M11 probe+dry-run]
  M9 --> M11
  M4 --> M12[M12 live suite/CI]
  M10 --> M13[M13 docs/release]
  M12 -. E2E harness .-> M13
```

---

## 3. Milestones in detail

### M0 — Workspace & package scaffolding
**Goal:** the package exists, builds, lints, tests, and is importable from `arista-webui` by name.

- [x] Create root `package.json` with `"private": true`, `"workspaces": ["arista-api-client", "arista-webui"]`, and root scripts `build`, `test`, `lint`, `typecheck` that fan out to both packages.
- [x] `arista-api-client/package.json`: name `@devhax-heavy-industries/arista-eapi` (**DR-020 open**), `"type": "module"`, engines `node >= 20`, sideEffects false.
- [ ] Scripts mirroring the webui: `build` (vite lib mode) · `typecheck` (`tsc -b`) · `lint` (`oxlint`) · `test` (`vitest run --project unit`) · `test:watch` (`vitest --project unit`) · `test:live` (`vitest run --project live`) · `coverage` (unit project only) · `docs`.
- [x] `exports` map with conditions: `"."` → browser-safe build; `"./node"` → Node build (unix socket, client certs); `"./package.json"`. Types first, `import` only (no CJS) — **DR-021**.
- [x] `tsconfig.json` + `tsconfig.build.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `declaration` + `declarationMap`, `emitDeclarationOnly` for the types step. `target: ES2022`, `lib: ["ES2023", "DOM"]`.
- [x] `vite.config.ts` lib mode (rolldown) with two entries (`index.ts`, `node.ts`), `formats: ["es"]`, externals left external (`node:net`, `node:tls`, `node:fs`).
- [x] `vitest.config.ts` with `projects`: `unit` (node env, excludes `*.live.test.ts`) and `live` (include only `*.live.test.ts`, `pool: forks`, run only via `test:live`). Coverage provider `v8` with thresholds (see TESTING.md).
- [x] `.oxlintrc.json` at repo root (shared by both packages) with the `typescript` + `import` plugin rules; per-package overrides. If `oxfmt` is available in the pinned `oxlint` major, adopt it and disable Prettier.
- [x] Source skeleton: `src/index.ts`, `src/node.ts`, `src/internal/`, `src/resources/`, `src/types/`, `src/testing/` (public test helpers), `.gitignore`, `LICENSE` (**BSD-3-Clause, retaining Arista's copyright — DR-001**), `NOTICE` attributing the pyeapi port.
- [x] CI: GitHub Actions workflow (Node 20/22 matrix, `typecheck` → `lint` → `test` → `build`; reserve real-EOS jobs for explicit trusted `workflow_dispatch`, per M12 and the cEOS runbook). *(matrix is **22/24**, not 20/22 — see note below)*
- [x] Verify the webui resolves the workspace package (`import { createNode } from '@devhax-heavy-industries/arista-eapi'` type-checks; Vite dev server serves it unbuilt during development).

> **M0 notes (2026-11-01, PR for #2 — what deviated and why):**
> * Every script named above exists **except `docs`** — no doc generator has been chosen and
>   adding one here would be an unjustified dependency. Docs/release tooling is M13's (#15).
> * `tsconfig` needed **three** projects, not two, so colocated tests are type-checked while
>   `dist/` stays clean: `tsconfig.json` (solution, like the webui's) → `tsconfig.build.json`
>   (composite, `emitDeclarationOnly`, excludes `*.test.ts`/`*.live.test.ts`),
>   `tsconfig.test.json` (noEmit, type-checks `src/**` including tests),
>   `tsconfig.node.json` (noEmit, type-checks `vite.config.ts`/`vitest.config.ts` — mirrors the webui).
> * `exports` gained a **`development` condition** (`./src/*.ts`) ahead of `import`, so `arista-webui`
>   dev/test consumes the TypeScript source with no library build and no `resolve.alias`; production
>   builds use `dist/`. `./testing` (DR-021) is **not** wired yet — nothing to point at until M1/M2.
> * Coverage `include` is `['src/**/*.ts']` rather than TESTING.md's `['src/**']`: the skeleton keeps
>   a one-page `README.md` in each `src/` subdirectory (git cannot store empty dirs) and the v8
>   provider tried to parse them (`PARSE_ERROR`).
> * `oxlint@1.90.0` ships only the `oxlint` bin — no bundled `oxfmt` — so there was nothing to adopt;
>   `oxfmt` exists only as a separate package and adopting it would reformat `arista-webui` too.
>   The existing `arista-webui/.oxlintrc.json` moved to the repo root and gained the `import` plugin
>   (`import/no-cycle`) plus an `arista-api-client/**` override that switches the React rules off.
> * Two build-order traps fixed: Vite's `emptyOutDir` deletes `dist/*.d.ts`, so the client's `build`
>   is `vite build && tsc -b --force`; and `arista-webui/tsconfig.json` references
>   `../arista-api-client/tsconfig.build.json` so a standalone webui typecheck has declarations
>   available (resolution is still by package name — no path alias).
> * The workspace lockfile moved from `arista-webui/package-lock.json` to the repo root.
> * **CI matrix is Node 22/24, not 20/22.** The first Actions run proved Node 20 cannot run this
>   repo's pinned toolchain: `vitest@5.0.5` declares `engines.node ^22.12.0 || ^24.0.0 || >=26.0.0`
>   and the webui's `jsdom@30.1.3` (via `undici@8`, needs node >= 22.19) crashes inside
>   `vitest run` on 20. This package stays `engines.node >= 20` per DR-021 — that is a *runtime*
>   floor for library consumers, not a claim about dev tooling. **M12 (#14) should prove the floor
>   properly**: run the built `dist/` under Node 20 with a dependency-free smoke script in CI.

**Exit gate:** `npm run build && npm run typecheck && npm run lint && npm test` green from the repo root; webui imports the package with no path hacks. ✅ met (2026-11-01).

---

### M1 — Wire protocol core
**Port of:** `pyeapi/eapilib.py` (request/response codec, error classes). **Do not** port the `http.client` transport subclasses here.

- [x] `src/types/eapi.ts`: `JsonRpcId`, `CommandSpec = string | { cmd: string; input?: string; revision?: number }` (**only these three keys exist server-side**), `RunCmdsParams` (`version: 1 | 'latest'`, `format: 'json' | 'text'`, `cmds`, `autoComplete`, `expandAliases`, `timestamps`, `stopOnError`, `requestTimeout`, `includeErrorDetail`), `JsonRpcSuccess`, `JsonRpcFailure`, `EapiResponse` union.
- [x] `buildRequest(commands, opts)` — mirrors pyeapi's param **allow-list** behaviour, then extends it to the four params pyeapi drops (`stopOnError`, `includeErrorDetail`, `requestTimeout`) → **DR-016**. Unknown params must be rejected at compile time *and* runtime.
- [x] Request id policy: monotonic per-connection integer + optional client nonce (pyeapi uses `id(self)`, which is not unique across processes) → **DR-017**.
- [x] `parseResponse(text)` → discriminated union; never throw on `error` — return the failure and let the caller raise. Malformed JSON → `ProtocolError` carrying the raw body (truncated to a limit).
- [x] Error taxonomy in `src/errors.ts`: `EapiError` (base), `CommandError` (`code`, `message`, `commandError`, `results[]`, `failedCommand`, `trace()`), `TransportError` (+ subtypes `AuthError`, `TlsError`, `ConnectError`, `TimeoutError`), `ProtocolError`, `SessionError`, `NotSupportedError`. Numeric codes as a `const enum`-free frozen map: `-32700 -32600 -32601 -32602 -32603 1000 1001 1002 1003 1004 1005 1006`. **There is no 1007** → **DR-010**.
- [x] `error.data` handling: array-of-results path (pyeapi `_parse_error_message`) **and** the `includeErrorDetail` object path `{result[], errorDetail[{index,code,message,cmd}]}`.
- [x] `renderCommandError()` message format identical to pyeapi (`Error [code]: msg [err]` for 1000/1001/1002/1004, `Error [code]: msg` otherwise) so device-sourced text stays comparable.
- [x] Secret redaction (**DR-011, a real fix over pyeapi**): redact `input` for `{'cmd':'enable', input}` in (a) log/debug output and (b) *every* error message, not just 1005 — EOS appends `input=%r` to messages for 1000/1001/1002/1004 too. Also redact passwords in `username … secret …` commands before logging. Reuse the `{'cmd':…, 'input':…}` shape matching from `pyeapi/eapilib.py:502-566` inline (do **not** port the generic `_find_sub_json`).
- [x] `-32602` decoration: when the message matches `unexpected keyword argument '(.*)'`, append `"parameter is not supported in this version of EOS"` (pyeapi `eapilib.py:460-468`).
- [x] `text`-encoding fallback hook: on **1003** (`COMMAND_UNCONVERTED`) re-issue the single command with `format: 'text'` — matching pyeapi `Node.enable(strict=False)`; keep `strict` semantics under a different name (`{ tolerateErrors: false }`) → **DR-012**.

**Tests (high priority — port of `test/unit/test_eapilib.py`, 38 methods):**
- [x] `buildRequest`: cmds passthrough, string→array coercion, param allow-list, `version: 'latest'`, explicit `stopOnError:false`, `includeErrorDetail:true`, rejection of a bogus param.
- [x] Every envelope sample in `test/fixtures/wire/*.json`: success, `error` with `data[]`, `error` with `errorDetail`, `-32700`, `-32601`, empty `data` omitted.
- [x] One assertion per code 1000-1006 → expected class + `.code` + rendered message.
- [x] Redaction: enable-input never appears in `error.message`, `Error.toString()`, or the logger output (assert on the *serialised* error).
- [x] 1003 → automatic text retry, and 1003 with `tolerateErrors:false` → throws.
- [x] Type tests (`expectTypeOf`) that `show<T>()` narrows by command literal.

**Exit gate:** encode + decode are pure (no I/O), fully covered, and fixture-driven.

---

### M2 — Transports
**Port of:** `EapiConnection` + the 7 subclasses in `eapilib.py` (68-757) and `TRANSPORTS` in `client.py:112-121`.

- [x] `interface Transport { execute(commands, opts)(commands, opts): Promise<EapiReply>; close(): Promise<void>; readonly kind: TransportKind }`. Transport is the seam that makes the dual-runtime decision work → **DR-002**.
- [x] `FetchTransport` (shared, browser-safe): POST to `<base>/command-api`, `Content-Type: application/json-rpc`, `Authorization: Basic`, timeout via `AbortController` (pyeapi default `timeout: 60` seconds — keep 60 000 ms).
- [x] Node TLS options (`./node` entry): `ca`, `cert`, `key`, `serverName`, **`fingerprint`** (pin self-signed device cert), `rejectUnauthorized` guarded by an explicit `dangerouslyDisableTlsVerification` flag — never a silent default → **DR-013**. pyeapi's `enforce_verification`/`context` knobs are **not** reproduced; they are documented as "replaced by explicit options".
- [x] `HttpTransport` ( cleartext ) — allowed only for `http://` loopback or when `allowInsecureTransport: true`; log a warning. Replaces pyeapi `http`.
- [x] `ClientCertTransport` = pyeapi `https_certs`: requires `cert`+`key`, verification on when `ca` given, off (with warning) when omitted — same semantics as `HTTPSCertConnection.connect()`, but surfaced as explicit options and Node-only.
- [x] `SessionCookieTransport` = pyeapi `http_session`/`https_session`: `POST /login {"username","password"}` → capture `Set-Cookie`, then send it on `/command-api`. Node-only (browser cannot set `Cookie` on a cross-origin request). Must handle non-200 → `AuthError`, and must never echo the body. Logout/`POST /logout` added (pyeapi never logs out) → **DR-018**.
- [x] Local transports (Node-only, feature-flagged): `UnixSocketTransport` (`/var/run/command-api.sock`) and `HttpLocalTransport` (`127.0.0.1:8080`, **plain HTTP only — 4.28 has no 8443 listener**; pyeapi's `DEFAULT_HTTPS_LOCAL_PORT` is a legacy constant) → **DR-014**. Both must print a security warning: EOS marks these `DISABLE_AAA` → unauthenticated priv-15.
- [x] `TransportKind` string union + a `createTransport(options)` factory with an exhaustive switch (compile error when a kind is unimplemented).
- [x] Error mapping: HTTP 401 → `AuthError` (pyeapi raises `ConnectionError`); HTTP 405 → `ProtocolError` (eAPI is POST-only); `ECONNREFUSED`/DNS/TLS handshake → `ConnectError`/`TlsError`; socket hang-up → `TransportError` with `retryable` hint.
- [x] Retry policy: none at transport level by default (config writes are not idempotent). `readOnly: true` requests may retry once on `ConnectError` → **DR-019**.
- [x] `MockTransport` in `src/testing/`: scripted replies by command match + a `recording` mode used by M12.

**Tests (high priority — port of the connection half of `test_eapilib.py` + `test_client.py::test_connect_*`):**
- [x] Request headers: content type, basic-auth string parity with pyeapi for `admin:` (byte-exact base64), absent auth when no credentials.
- [x] 401/403/405/ECONNREFUSED/TLS-failure paths each throw the mapped error and attach `commands`.
- [x] Timeout: `AbortController` fires at the configured ms; error is `TimeoutError` not `ProtocolError`.
- [x] Cookie transport: login POST body shape, cookie reuse on the following call, non-200 login → `AuthError`.
- [x] Cert transport: missing `key`/`cert` → `TypeError` at construction (pyeapi `ValueError`).
- [x] Local transports: unix path default, `8080` default, warning emitted, refusal to construct in the browser build (guard test).
- [x] `dangerouslyDisableTlsVerification` warns; omitting it against a self-signed cert fails with `TlsError`.

**Exit gate:** every pyeapi transport has a TS equivalent or a documented, deliberate omission; no Node built-ins reachable from the browser entry (enforced by a build-time check).

---

### M3 — Connection profiles
**Port of:** `client.py` `Config`, `load_config`, `config_for`, `hosts_for_tag`, `connect`, `connect_to`.

- [x] Decide the profile source: **Node** reads `~/.eapi.conf` and `/mnt/flash/eapi.conf` (INI, `[connection:name]`, honour `$EAPI_CONF`); **browser** receives profiles from app config (`createProfiles(...)`) — never filesystem access → **DR-038**.
- [x] Minimal INI parser (no dependency) + malformed-file tolerance (pyeapi logs and continues) and the `host` defaulting quirk (`client.py:207-211`: a section without `host` gets `host = <name>`).
- [x] Keep pyeapi's implicit `connection:localhost` → socket default **only** in Node; the browser default must be `https` with no host → **DR-008**.
- [x] `tags` support (`tags: a,b`) → `hostsForTag()`; `generateTags()` re-run semantics after `addConnection`.
- [x] `connect(options)` / `connectTo(name)` equivalents: `createConnection(profile)` and `createNode(profile)`, returning a `Node` when asked; validate the transport name exhaustively.

**Tests (port of the config half of `test_client.py`):** fixture INI files (valid, malformed, missing `host`, tags, duplicate sections), autoload search-path order, `$EAPI_CONF` override, `connectTo('nope')` → `ProfileNotFound`.

---

### M4 — `Node` command layer
**Port of:** `client.py:464-1001` (`Node.__init__`, `enable`, `run_commands`, `config`, `get_config`, `refresh`, `version`/`model`).

- [x] `class Node` with `readonly connection: Transport` and lazy, cached `version`, `versionNumber`, `model` (parse from `show version` exactly like `_get_version_properties`, `client.py:557-575`).
- [x] `runCommands(cmds, {encoding, sendEnable})` → raw `result[]` (pyeapi `run_commands`), including the `MULTILINE:` pseudo-syntax **replaced** by real `{cmd, input}` objects → **DR-015**.
- [x] `exec(commands, opts)` = pyeapi `enable()`: returns `{command, result, encoding}` per command; `1003` retry-with-text; explicit `strict` → `tolerateErrors`; refuses config-mode commands with `NotSupportedError` (pyeapi raises `TypeError` when the literal `configure` is present).
- [x] Drop the duplicate `response` key; keep only `result` → **DR-007**.
- [x] `show<T>(command)` typed shell: `show('version')` → `ShowVersionReply`, `show('vlan 20')` → … via a `ShowCommandContracts` interface map that consumers can augment (declaration merging). This is the piece the webui builds on.
- [x] `configure(commands)` (pyeapi `config`) → `configureTerminal` path; `configureSession` path arrives in M5. Both strip the prepended command's output (`response.pop(0)`) and clear config caches, and honour `autorefresh`.
- [x] `enablePassword` handling: `node.setEnablePassword(pw)` → sends `{'cmd':'enable','input':pw}`; **document the priv-15-user shortcut**: with a `privilege 15` Basic-auth user, `sendEnable: false` and the `enable` command is unnecessary → **DR-009**.
- [x] `getConfig({config:'running'|'startup', params:'all', as:'string'|'lines'})` with `configDefaults` support; validate the config name.
- [x] `runningConfig` / `startupConfig` as **async accessors** (`getRunningConfig()`), since TS getters can't await; document the divergence from pyeapi properties → **DR-005**.
- [x] `refresh()` invalidates cached configs; `autorefresh` default `true` preserved.
- [x] `CliVariants` equivalent: `configure([...variant(a), ...])` → `{ variants: [['a','b'], ['c','d']] }` tried in order, re-raising the last `CommandError` (pyeapi `client.py:628-652`). Decide parity vs. ergonomics: keep as `tryVariants()` utility, not a type-level magic → **DR-006**.

**Tests (high priority — 53 pyeapi unit tests in `test_client.py`; port these 30):**
- [x] `enable`: single/multi command, `send_enable` true/false, enable password insertion order, result indexing, `response.pop(0)` after `configure terminal`.
- [x] `config`: chunk of commands order, `configure terminal` prefix, autorefresh off → no `refresh()` call, cache cleared afterwards.
- [x] `get_config`: `running-config`/`startup-config`, `params` appended, `as_string` vs lines, invalid name throws.
- [x] version/model parsing: fixture `show version` for `4.28.13.1M` + `DCS-7050TX-64`, and the no-match fallbacks.
- [x] Error attachment: failing command set → error carries `commands`.
- [x] Type-level: `show('version')` returns `ShowVersionReply`; unknown command → `unknown` (not `any`).

**Exit gate:** read-only work against a mocked switch is fully usable without any resource module (the "generic exec/show" escape hatch works).

---

### M5 — Config sessions & change safety
**Port of:** `configure_session`, `diff`, `commit`, `abort`, `_configure_session` (`client.py:676-696`, `1003-1040`) — plus EOS capabilities pyeapi never exposed.

- [x] `node.configSession({ name?, description?, noCommit? })` → session object. pyeapi always fabricates a `uuid4`; **default our session name to a stable, prefixed id** (`ui-<host>-<pid?>-<uuid8>`) so a crashed client can find it again → **DR-022**.
- [x] Every session command re-sends `configure session <name>` as command #1 (that *is* how EOS re-attaches; pyeapi relies on it too).
- [x] `diff()` — must use `format:'text'`: `show session-config diffs` has no JSON model and returns **1003** under JSON (verified in the 4.28 image) → keep pyeapi's comment-but-fix-it: allow `show session-config` (JSON-capable) and force text for `diffs`.
- [x] `commit()`, `abort()`, `exitSession()`, plus `commitWithRevertTimer(hh:mm:ss)` (EOS auto-revert; **semantics of the confirming second `commit` need device verification** — [open items](./DECISIONS.md#open-items-need-the-device)).
- [x] `listSessions()` via `show configuration sessions` (**is** JSON-model-backed) + `recoverOrphans()` / `abortSession(name)` — pending sessions persist forever and hold the config lock, which is what produces **1006** for the next client → **DR-023**.
- [x] `rollbackCleanConfig(groups?)`, `rollbackToSession(name)` (config-history rollback), `configureReplace(url, {ignoreErrors, force, md5, skipCheckpoint})` with the "cannot configure replace while session X is pending" guard surfaced as `SessionError`.
- [x] `copyRunningToStartup()` / `writeMemory()` — pyeapi has nothing; a UI that commits is not durable without it → **DR-024**.
- [x] `stopOnError` exposure: default `true` (EOS default); a whole-changeset validate mode uses `{stopOnError:false, includeErrorDetail:true}`.
- [x] Session state machine in TS (`open | diffed | committed | aborted | lost`) + a guard that rejects `Node.configure()` while a session is open → **DR-025**.
- [x] Persist session names to a small journal (Node: `~/.config/arista-eapi/sessions.json`; browser: `localStorage`) so recovery survives reloads.

**Tests (high priority):**
- [x] Command sequence for open/configure/diff/commit/abort (assert exact `cmds` arrays — including text-forced `diffs`).
- [x] Re-attach: two sequential `node.configSession({name})` calls produce `configure session <same name>` twice.
- [x] Orphan recovery: fixture `show configuration sessions` output with a pending `ui-x` session → `recoverOrphans()` issues `configure session ui-x abort`.
- [x] 1006 mapping → `SessionError('config locked')` with the offending session surfaced from `trace()`.
- [x] `writeMemory` never auto-runs on commit (data-loss-safe default) and requires an explicit flag.

**Exit gate:** a change can be staged, reviewed as a diff, committed atomically, survived across a page reload, and cleaned up after a crash. ✅ met against `MockTransport` — staged (`run`), reviewed (`diff`, text-forced), committed (`commit`, with the explicit `persist` option), resumable (`configSession({ name })` + `configure session <name>` as `cmds[0]` of every batch) and recoverable (`listSessions`/`abortSession`/`recoverOrphans` + a journal). **Met offline only**: no device or cEOS run has happened, so the device-*effect* half of that sentence is unverified — see the notes below.


> **M5 notes (2026-11-03) — what is implemented, and what is still not true.**
>
> - **Implemented** (all 10 capability boxes and all 5 high-priority test boxes above, 15/15 ticked):
>   `node.configSession({ name?, description?, noCommit?, journal? })` → `ConfigSession`; the **DR-022**
>   prefixed, endpoint-scoped name `ui-<host>-p<pid>-<hex8>` (`ui-<host>-<hex8>` where there is no
>   process) and `SESSION_NAME_PREFIX` doubling as the recovery filter — **DR-047** fixes the
>   `arista-ui-<host>-<uuid8>` shape DR-022 originally sketched to this one, and the journal path; every
>   batch re-sends `configure session <name>` as `cmds[0]` (two sequential handles prove it twice);
>   `diff()` stating `format:'text'` on the request rather than implying it; `run`/`commands`, `commit`,
>   `abort`, `exit`, `commitWithRevertTimer` + `confirmRevertTimer`, `showSessionConfig`,
>   `validateChanges`; the `open | diffed | committed | aborted | lost` machine with the **DR-025**
>   refusal of `configure()` / `configureReplace()` / a second live `configSession()` (**DR-048**: every
>   terminal verb ends the handle); `listSessions` / `abortSession` / `recoverOrphans` and the `1006` →
>   `SessionError('config locked')` mapping (**DR-023**, realised for the first time — pyeapi never
>   mentions 1006); `rollbackCleanConfig` / `rollbackToSession` (stage inside a session, hand back
>   uncommitted) and `configureReplace` with the pending-commit-timer refusal surfaced as a typed error;
>   `copyRunningToStartup` / `writeMemory`, **never** implied by `commit()` (**DR-024**); `stopOnError`
>   per operation plus the changeset mode; the journal on both entries (`FileSessionJournal` behind
>   `./node`, `createWebStorageJournal` in the browser, allow-listed fields per **DR-011**, **DR-049**).
>   Measured: **106** new tests (`config-session.test.ts` 78 + `node-session-journal.test.ts` 28), client
>   31 files / **862** tests, webui 3/6, coverage 97.49% stmts / 90.84% branch with the thresholds
>   untouched.
> - **Not verified on hardware or cEOS, and therefore not claimed** (**DR-050**): what a `commit timer`
>   does to *later* sessions, whether a second `commit` before the deadline confirms or resets the revert
>   (open item 5 — the handler below the image's Python is native and was never inspected here);
>   `configure session <name>` name length/charset; `description "…"` quoting depth; which of `no-commit`,
>   `copy running-config startup-config` and `rollback clean-config [ { groups } ]` answer `1002` on the
>   7050TX-64 (open items 7 and 8); `maxOpenSessions` / `service configuration session max pending`;
>   whether `show configuration sessions` carries any start-time field (`olderThan` is journal-only until
>   the capture says otherwise); and `copy running-config startup-config` behaviour on 4.28.13.1M. Each is
>   a STATUS §3 sweep line to capture in M12 (#14). The specs pin the commands we send and how we read the
>   answers — nothing about what the switch then does.
> - **Still deferred on purpose:** `verifyConfig` / a real dry run stays **M11 (#13)** — which is why no
>   `dryRun()` exists on the handle and why `validateChanges` is documented as "the device applied these,
>   here is the per-command detail"; and the operator-facing screens (diff review, pending-session table,
>   transaction UI) are **M13 (#15)**, together with the Playwright/cEOS browser lane. `Node.section()` /
>   `chunkConfig` pairing and the resource `.commands()` accessors those screens would feed are M7 (#9).
---

### M6 — Text-config engine
**Port of:** `client.py:697-798` — `_chunkify` (the `@lru_cache` decorator sits at `:697`, body `:698-774`) and `section` (`:776-798`) — plus `utils.py:169-232` `lookahead`/`expand_range`/`collapse_range` and `abstract.py:82-101` `get_block`. *(The header previously cited `client.py:193-245`, which is the `Config`/`load_config` area — corrected 2026-11-02 after opening the file.)*

- [x] Port `_chunkify` as a pure function `chunkConfig(config: string): Map<string,string>` — indent-aware sections *and* nested sub-sections, with the recursion invariant (only the outer call may use `indent = 0`) now enforced structurally: the indent parameter is module-private (MIGRATION.md §5 row 42).
- [x] Carry the two special cases: `banner … MULTILINE` / EOF-terminated blocks, and `code unit …` continuation lines. Keep the explicit failure mode for a short line inside an indented block ("likely unhandled multiline literal block"). Pinned against transcribed upstream output both ways — indented EOF keeps swallowing (row 41) and column-0 EOF closes correctly — `chunk.test.ts`.
- [x] **Cache**: pyeapi uses an `lru_cache` on a method (a memory leak keyed by config text); replaced by a single-entry content-hash memo with exact-equality confirmation, invalidated via `invalidate()` (driven by `refresh()` in M4) → **DR-026**; the shared document is a `ReadonlyMap` (rows 12/52).
- [x] `section(regex, {config})` semantics preserved: first matching key, `NotFoundError` when absent (pyeapi raises `TypeError` at `client.py:795`; verified) → **DR-027** (rows 13/50), `NotSupportedError` for the pyeapi sentinel strings.
- [x] `getBlock(parent, {config})` = anchored `^…$` lookup (`abstract.py:98`), returning `undefined` instead of throwing, catching only `NotFoundError` (row 51).
- [x] `expandRange('1-3,7') → ['1','2','3','7']` and `collapseRange([...]) → '1-3,7'`; pyeapi's `*` and comma/range delimiters preserved — with `*`/`Ethernet*`/`foo`/`''` now REFUSED where pyeapi passed them through, and its zero-truthiness artefacts pinned (rows 45-48). These are what drive `interface Ethernet1-4`, `vlan 10-20`, `switchport trunk allowed vlan` for M9/M10 — pyeapi itself has no range callers (row 45).
- [x] Config-text helpers used by every resource: `findLine(config, re)`, `parseBlock(body)`, `unquote(value)` (EOS `"quoted string"` handling in `description`/`name`, row 49), plus `splitLines`/`rstrip`/`lineIndent` with CPython-boundary faithfulness (row 53). **Carry-over for M7 (#9):** `describeLine` keeps the first whitespace run inside `value` (` "quoted"` with quotes), contradicting its own doc and making its `unquote` call unreachable — pinned as current behaviour in `text.test.ts`; fix it deliberately there, not by accident.

**Node-layer gap (expected, not a blocker here):** the `Node.section()` method and the config-cache wiring (`node.refresh() → invalidate()`) land with **M4 (#6)** — that branch owns the `Node` class. This branch deliberately ships the pure engine + cache and does not create competing `Node` methods. Likewise, `src/config` is not yet re-exported from `src/index.ts`/`src/node.ts` — M7 (#9) wires the public surface (and owns the missing `USAGE.md` snippet, DoD item 5).

**Tests (high priority — pyeapi's own `_chunkify` coverage is thin; expect to write more than upstream):**
- [ ] Golden fixtures from real EOS: capture supported 4.28 config forms from cEOS early, and retain separate 7050TX-64 / 4.28.13.1M captures for target parity. Include `router bgp` sub-blocks (`address-family`), `vlan` blocks, `port-channel` with `member interface`, nested `mac security profile`, `class-map`/`policy-map` where supported; record unsupported cases explicitly. *(Left open deliberately: what shipped is 11 **hand-authored** `.conf` fixtures + an upstream-pyeapi oracle — `test/fixtures/config/README.md` says so. The cEOS image is not installed on this machine; the capture is M12 (#14), STATUS §3.)*
- [x] `banner motd MULTILINE: …\nEOF` block stays one section; `code unit` line grouping.
- [x] Short-line-inside-block → the explicit ValueError-equivalent (`ConfigParseError`), not a wrong answer.
- [x] `section()` returns the same text pyeapi would for those fixtures (parity assertions) — `chunk.fixture.test.ts` (ordered-entry oracle) + `section.test.ts` (every oracle key replayed through the transcribed first-match rule; inline answers transcribed 2026-11-02).
- [x] Range helpers: all **6** `test_utils.py` range cases (`test/unit/test_utils.py:51-81` — the box's "15" counted every method in that file; 9 of them exercise `make_iterable`/`load_module`/`debug`, which are M7-planned or dropped (§7)) ported by name, incl. `expand_range('1-3,5')`, mixed ordering, invalid input.
- [x] Property test (fast-check): `collapseRange(expandRange(x)) === canonical(x)` for generated ranges — `fast-check@^4.10.2` devDependency added, generator invariant stated in the test.

**Exit gate:** every wave-1 resource can be parsed from text config with no bespoke regex. *(The engine proves this for config TEXT — 100% statements/lines over `src/config` — but it is only OBSERVABLE as satisfied when M8-M10 parse with these helpers and their tests contain no ad-hoc config regexes. Keep it as the standing acceptance criterion for M7-M10.)*

---

### M7 — Resource framework
**Port of:** `api/abstract.py` (224 lines: `BaseEntity`, `Entity`, `EntityCollection`) + `client.py:927` `Node.api()`. *(Refs re-opened in the clone on 2026-11-03: `BaseEntity` `:49`, `version_number` `:70-72`, `config` `:74-76`, `error` `:78-80`, `get_block` `:82-101`, `configure` `:103-127` (the `except (CommandError): return False` pair at `:126-127`), `command_builder` `:129` with its precedence sentence at `:137` and the branch chain at `:152-161` + deprecated comment `:162-164`, `configure_interface` `:166-178` with `make_iterable` at `:176` and `insert(0, …)` at `:177`, `Entity` `:181` (`__call__` `:191-192`), `EntityCollection` `:198` (`__call__` `:208`, `__getitem__` `:211`, `__len__` `:214`, `__iter__` `:217`, `getall` `:220`, `get(name, default=None)` `:223`); `Node.api` at `client.py:927` with `load_module` `:945` and `initialize`/`instance` `:946-949`.)* M7 also took PR #23's deferred pairing — `Node.chunkConfig`/`section`/`getBlock` over M6's engine, with the DR-026 memos and one invalidation seam (MIGRATION §5 row 80).

- [x] `class ResourceBase { constructor(protected node: Node) }` with `config()` access, `commandBuilder()`; drop `error` property entirely — every verb **throws** → **DR-005**. **As built:** `constructor(node: Node)` with a declared `protected readonly node` — the parameter-property shorthand PLAN wrote is not expressible, because this package sets `erasableSyntaxOnly: true`; same shape, one more line. Construction also runs `assertResourceNode`, so a `Node`-shaped fake missing `getRunningConfig`/`getStartupConfig`/`chunkConfig`/`configure` fails at `new`, not inside a later write (row 82). `config(options)` is **async** (row 75); `commandBuilder` is a `protected` delegate to the free function.
- [x] `Entity<T>` (`get(): Promise<T>` — for global-ish resources: `system`, `ntp`, `mlag`, `ospf`, `bgp`) and `Collection<T, K>` (`getAll`, `get(name)`, `create`, `delete`, `default`, plus `has`, `keys`, `entries`). No Python `Mapping`/`__call__` magic → **DR-004**. **As built:** the shipped names are `Entity<T>` and `EntityCollection<T, K, A>` (`src/resources/base.ts`), the presence verb is `setDefault(name)` not `default` (row 77), `getAll()` answers a `ReadonlyMap` (`ResourceTable`, row 78) and `get()` never answers `undefined` for an entity. Wave-1 module classes remain M8/M9/M10 work.
- [x] Verb naming rule (fixed and documented): read `get`/`getAll`; write `set<Field>`; presence `create`/`delete`/`setDefault`; collection membership `add<X>`/`remove<X>`. Identical to pyeapi so the mapping doc stays 1:1. Documented in three places that must agree: the `base.ts` header table, MIGRATION §3, and USAGE §6.
- [x] Option objects replace `**kwargs` and the 4-arg `command_builder(string, value, default, disable)`: `setTrunkNativeVlan(id)`, `.disable()`, `.default()` become `{ mode: 'set' | 'no' | 'default' }` or dedicated `unsetX()` methods → **DR-037**. Preserve evaluation order **default → disable → value** in the one place it matters and unit-test it. **As built:** `CommandOptions = { value?, mode? }` with `CommandMode = 'set'|'no'|'default'` and `CommandValue = string|number|true`; the order is verified at `abstract.py:137`/`:152-161` and pinned by 45 cases; both upstream fall-throughs (`no value at all`, a falsy `value`) raise instead of emitting `no …`, and a numeric `0` keeps its value. The dedicated-method half is per-module (§3), so M9/M10 spell `unsetX`/`defaultX`. **DR-051** records the result shape (always `string`, never a bool/`error`).
- [x] Replace `isvalidinterface` / `isvlan` guards and `__getattr__`/`marshall` dynamic dispatch with explicit typed methods + runtime validators (`assertInterfaceName`, `assertVlanId`) → **DR-004**. `src/resources/validators.ts`, **DR-053**; `__getattr__`/`marshall` stay unported (DR-006). Stricter than upstream on purpose, incl. the two inversions of upstream's own assertions; the **discriminated-union parser this box implies is NOT here** — M10 (#12) owns it, and the six-kind regex is unverified on hardware (DECISIONS open item 7).
- [ ] Static accessors instead of `node.api('vlans')`: `node.vlans`, `node.interfaces`, `node.switchports`, `node.system` as lazily-constructed getters. A `node.resource('vlans')` string escape hatch may exist for the webui's dynamic tables, typed off a registry map. **Left unticked with a reason:** the registry half is shipped and is the only accessor — `node.resource(name)` / `node.hasResource(name)` over `keyof ResourceKinds` + the frozen `RESOURCE_FACTORIES` table, memoised **per `Node`** (**DR-052**, row 79). A static getter's type is the module's class, and no wave-1 module class exists yet, so `ResourceKinds` is deliberately **empty at M7**; adding `get vlans()` today would not typecheck. Carried to M8-M10. The **other** half of this box is closed on this branch: PLAN's "Entry point wiring" bullet — which M6's note assigned to M7 — is delivered, so `src/index.ts:274-297` re-exports the framework (`ResourceBase`/`Entity`/`EntityCollection`, `ResourceRegistry`/`createResourceRegistry`/`RESOURCE_FACTORIES`, `commandBuilder`/`submodeCommands`, `parseConfigBlock`, `is/assertVlanId`, `is/assertInterfaceName`, `toArray`, and the `Command*`/`Resource*`/`ConfigField*`/`ParsedFields` types), and `src/node.ts:80` (`export * from './index'`) carries them to the Node entry. `src/index.test.ts` pins the list by name (a rename cannot silently drop a public export) and asserts `RESOURCE_FACTORIES` ships empty (row 79, DR-025).
- [x] `command()` builder returns `string[]` (never mutates caller arrays; pyeapi's `configure_interface` `insert(0, …)` bug aside — see DR-004 note on the deprecated `value=None` path). **As built, two functions** (DR-051/row 71): `commandBuilder(stem, { mode, value }) → string` builds **one** command line, and `submodeCommands(parent, commands) → CommandSpec[]` builds the list, returning a fresh array copied through `toArray` — so the upstream mutation at `abstract.py:177` / `vlans.py:244-245` has no analogue here. `resource.command()` is not a name this port ships.
- [x] Shared parsing base: `parseConfigBlock(body, fieldParsers)` — the shape every wave-1/wave-2 module needs (they read running-config, not dedicated `show` commands). `src/resources/config-block.ts`; the record's type is derived from the parser map, `''` parses to an empty block, and it owns no error class of its own (row 81, which also answers MIGRATION row 49's `describeLine` question: not changed here, fixed by M9).

**Tests:**
- [x] Command-builder truth table (set/no/default/`value===true`) — **45** cases in `src/resources/command-builder.test.ts`, incl. both refused fall-throughs and the precedence. *(This box's "12 cases, mirroring pyeapi's `test_abstract`-style assertions" counted against a file that does not exist: there is **no** `pyeapi/test/unit/test_abstract.py`. The embedded expectations actually are `test_api_system.py:31-58` and `test_api_switchports.py:67-116`, plus **12** pre-armed sites waiting for the `command_builder` raise — 9 in `test_api_bgp.py` (incl. `:117`), 2 in `test_api_ipinterfaces.py` (`:104`, `:135`), 1 in `test_api_routemaps.py:154`.)*
- [x] `configureInterface` wraps in `interface X` exactly once and doesn't mutate the input array (regression vs pyeapi) — asserted twice, on both helpers: `base.test.ts` and `command-builder.test.ts` (the same array passed to two calls comes back unchanged, the two answers are equal, the parent appears once), with `src/internal/collections.test.ts` pinning the copy itself.
- [x] Throwing: a failing write rejects with `CommandError` (no silent `false`), with `.failedCommand` set — `base.test.ts:287-320`, pinning `failedCommand` to `'vlan 4094'` and `'mtu 9001'`.
- [x] Registry: `node.vlans` returns the same instance twice; `node.resource('bogus')` throws — `src/resources/registry.test.ts` (12 cases) asserts memo identity with exactly one construction (`:61-65`), an unknown name throwing and naming what is registered (`:72-75`), the dangerous type-row-without-factory case (`:86-88`), per-`Node` isolation (`:107-109`), `Object.isFrozen(RESOURCE_FACTORIES)` (`:133`) and `node.hasResource('vlans') === false` against the empty map (`:142`). *(The literal `node.vlans` identity assertion rides the unticked accessor box above; it is exercised through a probe `ResourceKinds` instead.)*
- Landed beyond this milestone's box list, because PR #23 deferred it here: `src/command-layer.config.test.ts` (25) pins `chunkConfig`/`section`/`getBlock`, the two DR-026 memos, the read-only document, and invalidation after `configure()` and `refresh()`. Upstream has **no** unit test that calls `Node.section` or `get_block` at all.

**Exit gate:** the first resource module (M8) requires ~30 lines of new plumbing at most. **Met, and measured rather than estimated:** the `PLAN.md M7 exit gate — the plumbing cost of one module` case in `src/resources/base.test.ts` counts the real spans in that file — **19 lines** for a wired `Entity` (`class HostnameEntity`: class line + 4 verbs), **43 lines** for a wired `EntityCollection` with its parse map (`class ProbeVlans`), asserted as `≤30` / `≤45` so the figure cannot drift silently. Excluded from the count by construction: the `ResourceKinds` row, the `RESOURCE_FACTORIES` entry, imports and JSDoc.

---

### M8 — `system` resource (wave 1)
**Port of:** `api/system.py` (186 lines: `get`, `_parse_hostname`, `_parse_iprouting`, `_parse_banners`, `set_hostname`, `set_iprouting`, `set_banner`).

- [x] Types: `SystemSettings { hostname, ipRouting, banner?: { login?, motd?, exec? } }`. **As built:** `banner` is always present (`{}` when the device has none) and the *kinds* are the optional members — `undefined` stays reserved for "no such block" (DR-027, §5 row 90); `SystemBannerKind`/`SystemBanner`/`SystemSettings` export from both package entries.
- [x] `get()` from `ip routing` / `hostname` / banner blocks. **As built:** one chunked `show running-config all` off the DR-026 memo serves all three fields (pinned by the transport's command list); scalars anchor on indent-0 section keys so a banner body cannot impersonate a command — **DR-055**, §5 rows 83-87.
- [x] `setHostname(h)` with EOS name rules validated (length, no leading digit/space) — stricter than pyeapi. **As built, with the label PLAN's phrasing could not know then:** the workspace cannot observe EOS's real name rules (no device, no readable CLI sources, pyeapi checks nothing at `system.py:118-134`), so each refusal is stated as *client policy* — single token, no control chars, no quote, ≤ 128 generous bound, no leading digit — "unverified on hardware, M12 (#14) to capture", device keeping the refusing authority. **DR-057**, §5 row 89.
- [x] `setIpRouting(true|false)` via default/disable modes. **As built:** `false` maps to `{ mode: 'no' }` (the one place pyeapi's `value is False` special case is ported, `system.py:151-152`), non-boolean refused instead of reaching the deprecated fall-through (`abstract.py:160-161`, DR-037); `unsetIpRouting`/`defaultIpRouting` spell the other two forms.
- [x] `setBanner(kind, text)` using the multiline form `{"cmd":"banner motd","input":"text\nEOF\n"}`; strip the trailing newline pyeapi appends, and document why `input` must end with `\n` → **DR-015**. **As built:** the client *owns* the terminator — always `\nEOF\n`, exactly one caller newline folded into it, bodies that could not read back (`EOF` line, CR, empty) refused pre-wire; `kind` is a closed set refused where pyeapi interpolates it into the command line (`:171`). **DR-056**, §5 rows 86/88.
- [x] Out of pyeapi but cheap: `setNameServers`, `setIpDomainLookup`, `setSnmpLocation/Contact`? — mark **backlog**, don't scope-creep wave 1. **Decided: backlogged**, per this box's own instruction — none shipped; natural home is W2 (#16) or a post-M10 `system` extension.

**Tests (7 pyeapi `test_api_system.py` + 20 system tests → 12 unit tests):** hostname set/get, `ip routing` set/no/default, banner multiline payload shape assert (no redaction leak in the logged payload), `get()` with a bare 4.28 minimal config, banner parse with embedded quotes. **As built, both figures corrected:** `test_api_system.py` has **5** methods (AST count on the pinned clone 2026-11-03 — `docs/TESTING.md` §6 already said 5; this line was the error) and `system.test.ts` lands **41**, not 12 — the probed-divergence cases (§5 rows 83-90) each need their own pin, and the 5 upstream command texts are reproduced verbatim. The multiline payload is asserted byte-for-byte (`{cmd, input}` with the `EOF` line), and the redaction claim is pinned in both directions: only `enable` inputs are secrets, so a refused banner body *stays* readable in `CommandError.commands` (DR-011, DR-056).

---

### M9 — `vlans` + `switchports` (wave 1 — first demoable UI slice)
**Port of:** `api/vlans.py` (372) + `api/switchports.py` (417).

- [x] `vlans.get(vid)` → `{ id, name, state: 'active'|'suspend', trunkGroups[] }`; `getAll()`; `create(vid)`, `delete(vid)`, `setDefault(vid)`; `setVlanName`, `setVlanState`, `setTrunkGroups`, `addTrunkGroup`, `removeTrunkGroup`. Validate `1..4094` (parse failure path in `_parse_vlan_id` preserved as `VlanNotFoundError` → **DR-027**). **As built:** the full verb set shipped (plus the `unsetX`/`defaultX` pair per §3, and `create(vid, { name, state })` in ONE transaction where upstream needs two calls). **No `VlanNotFoundError` was created** — the existing taxonomy already has both DR-027 arms (`NotFoundError` for lookups, `ConfigParseError` for unreadable sections) plus `NotSupportedError` for refused ids; a per-module error class violates DR-005/DR-010. `1..4094` is the WRITE bound and pyeapi's own (`range(1, 4095)`); reads KEEP out-of-band values the switch wrote — the read/write split is **DR-059**, §5 rows 95/96.
- [x] `switchports.get(name).getAll()` keyed by interface, plus `setMode`, `setAccessVlan`, `setTrunk` (native + allowed), `setTrunkNativeVlan`, `setTrunkAllowedVlans`, `addTrunkGroup`, `removeTrunkGroup`. Use M6 range helpers for `allowed vlan`; pyeapi's `_parse_trunk_allowed_vlans` `forwarding:trunk:allowed-vlans` fallback (`switchports.py:120`) → **DR-028** if it is unexplained: verify on device (`switchport trunk allowed vlan forward all`), keep behaviour, but document; **flag the `name=`-fallback hack at `switchports.py:147-151` as a known bug and record a decision** → **DR-029**. **As built:** all verbs shipped; a `number[]` canonicalises via M6's `sortedRangeValues`+`collapseRangeToString` (`[10,20,21,22]` → `10,20-22`), a raw string passes through after id-grammar range-check — the `all`/`forward all` vocabulary is DR-028's open item, the verbatim pin `1,2,3-5,6,7` reproduced, row 47's ported quirks not re-exercised. **Both boxes' line refs FAIL against the pinned clone and `switchports.ts`' header carries the correction:** `forwarding` exists in `pyeapi/` only as the `vrf forwarding` COMMAND — the allowed-vlan value is read from the running-config (`:156-157`), and THAT read is the behaviour kept (documented, per this box's own instruction); the `name=` fallback is `:83` + the `if interface:` filter at `:174`, not inside `:147-151`'s docstring. The DR-028/DR-029 entries stay as history (their DECISIONS stand); the fallback is closed on the key side — `getAll` names entries from the SECTION HEADER, never the caller's argument (§5 rows 96/98).
- [x] `interfaceMode` enum matching EOS (`access | trunk | dot1q-tunnel | private-vlan`), with `trunk groups` support gated by capability probe results from M11. **As built, one half each:** the four values are what `setMode` WRITES ({@link SWITCHPORT_MODES}); `Switchport.mode` on READ is typed `string` deliberately, because a device token beyond the four must survive the read rather than vanish into a parse failure (row 98) — `isSwitchportMode` narrows for a UI. **The capability-probe half CANNOT be ticked: M11 (#13) is unimplemented.** The verbs ship ungated; the capability *claim* waits for `capabilities.probe()` (open item 4). Noted here so the box is never silently counted done by its code half.
- [x] Both modules must batch reads: one `show running-config` per `getAll()`, not one per entity (pyeapi re-parses config each call; keep the *behaviour* but add a per-call config cache) → **DR-030**. **As built and MEASURED** (transport command lists, §5 row 93): one request per collection operation, reused by a `get()` on the same memo, ZERO reads for single-field writes. "Keep the behaviour" is read as keep the ANSWER, not the N+1: upstream's per-entity `get`-inside-`getall` is exactly the bug rows 15/78 exist to retire, and the §2 parity column says ported-verbs, never ported-quadratic.

**Tests (high priority — 15 + 21 pyeapi unit tests → ~40 of ours):** get on named/unnamed vlan, create with `name`, delete with dependents (`no vlan X` rejection → `CommandError`), state suspend/active round trip, `switchport mode` matrix, native vlan vs allowed set interactions, trunk group add/remove idempotence, and the `interface` sub-block parse from realistic JSON-ish fixtures. **As built: 101 landed, not ~40** — `vlans.test.ts` **45** + `switchports.test.ts` **43** (all 36 upstream methods ported, command texts verbatim; the malformed-answer behaviours diverge per DR-059) plus **13 direct specs** for the shared extractors in `config-block.test.ts` (row 91; keeps the M7 file at 100/100). Reported against the target rather than matched silently.

**Exit gate:** the webui can list VLANs, assign an access port, and show a diff before commit — with only wave-1 modules. **Status: the CLIENT half is complete** (both collections, access-port writes, and the session `diff()` + commit flow from M5 are all on this branch with offline pins); **the webui half is recorded as M13 (#15) consumption work in PR #28's body, not claimed** — `arista-webui` still has no screen that consumes any module, and an exit gate is not allowed to quietly become a client-only gate.

---

### M10 — `interfaces`, ethernet + port-channel (wave 1, biggest module)
**Port of:** `api/interfaces.py` (1,101 lines — `Interfaces`, `BaseInterface`, `EthernetInterface`, `PortchannelInterface`, `VxlanInterface`).

- [ ] Split deliberately: **M10a** `Interfaces` facade + `BaseInterface` (get/getAll/create/delete/default, description,Shutdown, mtu, encap) · **M10b** `EthernetInterface` (sflow, flowcontrol send/receive, vrf) · **M10c** `PortchannelInterface` (members, mode, minimumLinks, lacpFallback, lacpTimeout) · **M10d** `VxlanInterface` → **defer to wave 3** with `QinQ`/EVPN (7050TX VXLAN hardware capability is *unverified* — [open items](./DECISIONS.md#open-items-need-the-device)). **M10a done on its branch (#12):** `src/resources/interfaces.ts` + 113 specs, §5 rows 99-106, DR-067-069; `EthernetInterface`/`PortchannelInterface` are NOT stubbed — `create`/`delete` on a physical Ethernet is a typed refusal naming M10b, and the module's per-kind fields arrive with M10b/M10c (DR-068).
- [x] `getAll()` from `show interfaces status`-shaped JSON where available + running-config for the settings (hybrid read strategy: **command → model-backed `show` when available, else config text**) → **DR-031**. **As built:** config decides existence, the show only enriches, and the cost is an explicit option — `{ status: 'auto' | 'skip' | 'require' }` = 2 / 1 / 2 requests with a re-throw, 3 when the unit answers `1003` and M2's codec retries as text. Row spellings come from the **recording of this command** (cEOS-lab 4.28.14M, `interfaceStatuses`/`linkStatus`) ahead of pyeapi's sibling-command capture (**DR-069**); the hardware spelling is still an M12 (#14) §3 capture.
- [ ] `setDescription` (quoting rules), `setMtu` (bounds 68..9214 on this platform — read from `show interfaces` rather than a hard-coded constant → **DR-032**), `noShutdown` semantics via `disable`. **Half built:** `setDescription`/`unsetDescription`/`defaultDescription` and `shutdown`/`noShutdown`/`defaultShutdown` ship as DR-037's named verbs (upstream's `disable=True` default becomes a second named intent, `interfaces.py:305`/`:325-326`), and description quoting follows M6's `unquote` on read with this client's own round-trip refusals on write. **The MTU bound box stays unticked honestly:** `interfaces.py` has no MTU verb at all (row 105), `68`/`9214` appear nowhere in the module, and no capture carries an L2 MTU column — so what ships is a positive-safe-integer client rule plus pinned `CommandError` paths, **not** a platform bound. Reading 68..9214 off `show interfaces` waits on M12 (#14) §3.
- [ ] LAG: `setMembers(name, members, mode)` — preserve the "shutdown member interfaces before joining" behaviour pyeapi uses (`interfaces.py:677-717`) and the `port-group N mode active|on` generation; `getMembers()` via `show port-channel <id> all-ports`.
- [x] Validation split: pyeapi's `isvalidinterface` regex (`interfaces.py:81`) replaced by a per-kind parser (`Ethernet<N>`, `Port-Channel<N>`, `Vlan<N>`, `Management<N>`, `Loopback<N>`) returning a discriminated union. **As built:** `INTERFACE_GRAMMAR` in `validators.ts` — six anchored patterns, `{ kind, index, name, subinterface? }`, the suffix arm only on Ethernet/Port-Channel (`interfaces.py:271-277` + its own `interface Ethernet48.2044` fixture header), `parseInterfaceName` total for readers and `is/assertInterfaceName` the write-side guards. Row 76's forward promise is closed; the **refusals M7 pinned stay refused** (dotted, `Ethernet1/1`, `Peer-Ethernet`) because that is open item 7, not a parser question — **DR-067**.

**Tests (high priority — 72 pyeapi unit tests in `test_api_interfaces.py`; port ~60):** interface name parsing matrix, `get` on each kind, description quoting, shutdown/no-shutdown/default, sflow/flowcontrol commands, VRF binding, port-channel member diffing (add/remove/replace), lacp mode/fallback/timeout, `create`/`delete` for port-channel, and a fixture-driven `getAll()` on a 48-port 4.28 config. **M10a lands the first six groups plus more** (113 specs: the 21-case grammar matrix, per-kind `get`, the three-answer `shutdown` rule, quoting, the create/delete refusals, encapsulation both ways, MTU as client policy, request-count pinning at 1/2/3, and the recorded cEOS-lab status shape). Still owed by M10b/M10c: sflow/flowcontrol, VRF binding, member diffing, LACP mode/fallback/timeout, port-channel create/delete. The **fixture-driven 48-port `getAll()`** stays unticked on purpose — no 48-port 4.28 running-config has been captured, and hand-authoring one would be a synthetic fixture presented as device text (M12 #14 §3).

**Exit gate:** LAG/LACP (features.md high-priority item) is configurable end-to-end with diffs, and `npm test` covers both the ethernet and port-channel paths.

---

### M11 — Capability probe + dry-run (differentiators over pyeapi)
- [ ] `node.verifyConfig(configlets)` via the `verifyConfig` JSON-RPC method (returns normalised/aggregated configlets) → power a "review changes" screen without touching the device.
- [ ] `capabilities.probe(feature)` runs candidate commands inside a throwaway **config session with `stopOnError:false`, then aborts**, and records `1002` (command doesn't exist) / `1004` (exists but not eAPI-able) / `1005` (role can't run it) / `1006` (locked). Cache results per device with a TTL → **DR-033**.
- [ ] `node.getCompletions(partial)` / `getCommandHelp(cmd)` (real eAPI methods) → power the webui's command input.
- [ ] Nothing is hard-coded as "supported on 7050TX" in the client: feature presence is probed, because Arista gates features per model via ArToggles/licensing we cannot enumerate from the artifacts available → **DR-033**.

**Tests:** each classification path (fixture replies for 1002/1004/1005/1006), probe caching + TTL, probe **always** aborts its session even on throw (no orphan — assert `abort` issued), `verifyConfig` payload shape.

---

### M12 — Live-device suite, fixtures, CI
- [x] Provision disposable cEOS-lab **4.28.14M** from the local authorized image following the [cEOS runbook](../../docs/CEOS.md) and supplied vendor README; verify host compatibility, image identity, interface mapping, HTTPS trust, and authenticated `show version` readiness with a bounded timeout. Do not assume Docker process readiness means EOS is ready. **As built (M12 #14, PR #29; verified post-reboot 2026-11-04, including this box's own warning turned on us — see below):** `lab:up` enforces the image digest it boots, refuses a non-privileged daemon verdict instead of degrading, polls EOS `Cli` (bounded attempts) not `docker ps`, and TRUST is proven by cross-checking the published endpoint's TLS fingerprint against the container's own `/persist/secure/capi.pem` before any authenticated call. "Interface mapping" was where the first boot lied: attaching BOTH lab networks let `docker run -p` resolve to the cEOS NIC that has no kernel route — 30/30 ECONNRESET on a healthy-EOS container — so the harness now single-attaches (row 112 carries the isolation matrix; a runtime detach made the published port answer mid-diagnosis, which is what proved the cause).
- [x] Automate run-owned container/network/port allocation, lab-only bootstrap credentials, and always/finally teardown; fail explicitly on provisioning, readiness, or cleanup errors. Never prune shared Docker resources or fall back to the physical switch. **As built:** run-scoped names + labels; `lab:list`/`lab:down` act only on label-verified OWNERSHIP (verified by re-inspection, idempotent); credentials are random-per-run, printed once, in a 0600 state file inside a 0700 dir; explicit exit codes for provisioning vs readiness vs cleanup failures; the fallback-to-hardware half is the live-guard's consent matrix (row 110) — there is no accepted env spelling that reaches the physical switch. Post-reboot `up→probe→down` left zero containers/networks/state.
- [x] `src/testing/recorder.ts`: wrap any transport, persist `{cmds → reply}` JSON under `test/fixtures/recordings/`, with automatic secret redaction on write. **As built — not under the drafted filename:** the seam is `src/testing/recording.ts` (browser-safe, DR-002: no `node:*` — the webui may record/replay its own fixtures) with the filesystem half in `src/testing/recorder-node.ts`, behind the `./node` entry. Redaction is stronger than the box asked: on CAPTURE at the transport's trace seam, AGAIN on write-out, and `findUnredactedEnableInput` re-checked on LOAD (DR-064, §5 rows 107/109). Replay onto `MockTransport` plus the identity envelope / `assertRecordingIdentity` ship on the same seam; the PLAN filename predates the DR-002 split and is considered satisfied by the pair.
- [ ] `*.live.test.ts` suite = port of the safest pyeapi `test/system/*` cases (284 methods upstream; port the **read-mostly ~60** and the full VLAn/switchports/interfaces write cycles against a scratch interface only).
- [x] Live guard: `EAPI_LIVE=1` + `EAPI_HOST/USER/PASS` (or `EAPI_PASS_VAR`) required; local opt-out skips with a printed reason → **DR-034**. Explicit CI live jobs fail on missing prerequisites or all-skipped suites. Allow-list exact endpoint/port and target kind, check actual model/version (exact 4.28.14M for this cEOS image), and test refusal paths → **DR-043**. **As built except the CI clause (belongs to the open CI box):** `resolveLiveEnv` is a pure function of an injected env — refusals are data `{ok, code, reason}` naming variables never values, target-class `lab` is checked BEFORE host/port so `prod`/`hardware`/blank refuses even in lab-looking spellings, `localhost:8080` (the PHYSICAL switch's local eAPI) is refused by the port gate before any cleartext opt-in can reach it, expected model + exact `4.28.14M` pinned, and the whole refusal matrix is unit-tested offline (`live-guard.test.ts`, 63 cases incl. the 2026-11-04 non-lab-target additions; mutation-verified — killing the target-class gate fails 7 named tests). DR-065 / §5 rows 110-111 are the record, incl. the deliberately-unfixed `::1` over-strictness.
- [ ] Device policy: live tests must use a **named config session**, target only `Ethernet<configured scratch port>`, never `copy run start`, and always `abort` on failure. Refuse to run when `EAPI_TARGET_CLASS !== 'lab'` → **DR-035**.
- [ ] Fixtures: committed JSON/config recordings for every supported wave-1 resource; regenerate with `npm run fixtures:refresh` (explicit EOS access). Separate cEOS 4.28.14M from 7050TX-64 4.28.13.1M captures, with version/model/image/topology metadata and redaction. Collect initial cEOS samples as soon as M4 is available; do not block parser work on physical hardware. **Left unticked with the landed part recorded:** the SEPARATION half is machine-enforced (`targetSlugFor` model/version split, `assertRecordingIdentity` on replay, per-file `hardwareEvidence`/`targetClass` metadata — DR-066), the "initial cEOS samples" half finally happened post-M4: **9 real redacted cEOS captures** under `test/fixtures/live/ceos-4.28.14M/` (§5 row 113 — the repo's first non-synthetic device text). Still owed: recordings for every wave-1 resource on a DEVICE (the M8-M9 suites are mock-driven until the live port runs), and a `fixtures:refresh` npm entry (the capability exists as `lab:probe`'s guarded fixture writes + `--fixtures-force`; wiring it as the named script is part of the remaining live lane).
- [ ] Coverage gate: per-directory thresholds (see TESTING.md), `v8` provider, report in CI artefact.
- [ ] CI: unit + typecheck + lint on PR; cEOS live job initially trusted `workflow_dispatch` only on a dedicated Linux privileged-container runner with authorized image access, no untrusted/fork PR execution or public image artifacts. Use per-endpoint concurrency locks and single-worker/file execution; assert tests actually executed and collect redacted diagnostics before always tearing down.
- [ ] Separate hardware-only tests/sweep for exact 4.28.13.1M schemas, licensing, platform limits, and physical/ASIC behavior. Container success must not mark these verified. Unsupported cEOS cases have explicit reasons; two-node MLAG/routing coverage requires its own isolated topology.

**Exit gate:** a trusted cEOS run provisions from scratch, passes readiness and wave-1
live tests, records versioned/redacted fixtures, and cleans up on success and induced
failure. Offline commands provably never contact EOS. Hardware-only gaps remain visible.

---

### M13 — Consumption, docs, release
- [ ] Add a separate opt-in Playwright cEOS E2E lane after M12 provisioning/guards and the relevant UI workflow exist: browser → same-origin proxy → real eAPI; version/status reads, VLAN/interface reads, preview/diff/abort, isolated commit/read-back/cleanup, and explicit error states. Assert EOS state, keep proxy credentials out of browser artifacts, serialize per target, and always tear down. Record actual cEOS coverage separately from mocked UI tests; no physical-switch browser E2E.
- [ ] `USAGE.md` examples verified by a `docs` test runner (`vitest` snippet test or `npm run docs:check`).
- [ ] Webui wiring: Vite dev proxy `/command-api → https://<switch>` with `configure: { secure: false }` documented as *dev-only*, plus the alternative on-device `management api http-commands cors allowed-origin https://localhost:5173` path (see CONNECTIVITY.md) → **DR-036**.
- [ ] `CHANGELOG.md` (Keep a Changelog), `0.x` versioning policy, and a "breaking changes vs pyeapi" section that points at MIGRATION.md.
- [ ] Typed show contracts published for the screens the webui needs (`show version`, `show interfaces status`, `show vlan`, `show mlag`, `show lag`).

---

## 4. Backlog — later waves (effort = pyeapi unit tests to port)

| Wave | Module | pyeapi LOC | Methods (public verbs) | Upstream unit tests | Notes for this platform |
|---|---|---|---|---|---|
| W2 | `users` | 328 | get, getAll, create, `createWithSecret`, `createWithNopassword`, delete, default, setPrivilege, setRole, setSshKey | 22 | SSH key via `{cmd, input}`? verify; role names are EOS-generic |
| W2 | `acl` | 303 (+ `mask_to_prefixlen`, `prefixlen_to_mask`) | Acls facade (`standard`/`extended`), get/getAll/create/delete, add/update/remove entry | 32 | IPv6 ACLs marked medium-high in features.md |
| W2 | `stp` | 367 | global mode, instances, interface bpduguard/portfast | 21 | Rapid-PVSTP/MST presence per matrix is 7050X-derived → verify |
| W2 | `mlag` | 302 | get, setDomainId, setLocalInterface, setPeerAddress, setPeerLink, setShutdown, setMlagId | 7 unit / 21 system | plan isolated two-node cEOS control-plane tests where supported; hardware validation still needs a physical peer |
| W2 | `varp` | 213 | get, interfaces, setMacAddress, setAddresses | 17 | |
| W2 | `ipinterfaces` | 268 | get, getAll, create, delete, setAddress, setMtu | 11 | |
| W2 | `vrfs` | 343 | get, getAll, create, delete, setRd, setDescription, set IPv4/IPv6 routing, setInterface | 10 | `vrf instance` vs `vrf definition` form differs by EOS release — pin to 4.28 |
| W2 | `staticroute` | 384 | get, getAll, create, delete, setTag, setRouteName | 8 | |
| W2 | `ntp` | 208 | get, create, delete, default, setSourceInterface, addServer, removeServer, removeAllServers | 11 | |
| W3 | `ospf` | 362 | get, create, delete, setShutdown, setRouterId, add/removeNetwork, add/removeRedistribution | 15 | |
| W3 | `bgp` | 341 | `Bgp` + `BgpNeighbors` (9 `set_*`) | 22 | |
| W3 | `routemaps` | 357 | get/getAll, match/set statements, continue, description | 18 | |
| W3 | `vrrp` | 1,493 | 15 `set_*` + 14 `_parse_*` | 23 | largest module; secondary-IP handling needs care |
| W3 | `VxlanInterface` | (in `interfaces.py`) | source-interfaces, multicast groups, udp port, vlans↔VNI, flood list | included in 72 | hardware VXLAN support on 7050TX-64 **unverified** |

Tightly-coupled helpers to schedule with their wave: `acl.mask_to_prefixlen`/`prefixlen_to_mask` (W2), `vrrp.vrconf_format` (W3), `bgp.command_builder` override semantics (W3).

---

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| pyeapi's per-method behaviour is inferred from Python, not EOS documentation (arista.com returned 403) | Wrong commands shipped to a switch | Fixtures recorded from the real device (M12); `verifyConfig` + probe before enabling a write path (M11) |
| cEOS is 4.28.14M, not the physical 7050TX-64 / 4.28.13.1M | Container success mistaken for target-platform support | Separate fixtures/capability evidence and hardware-only validation; investigate patch/model differences (DR-043) |
| cEOS requires a privileged container and authorized image access | Host compromise from untrusted test code or image redistribution | Dedicated trusted runner, opt-in jobs, no fork code or public image artifacts; always clean up run-owned resources |
| Self-signed device cert + no CORS headers on 4xx | Browser auth errors become opaque, unverifiable | Node/loopback proxy for dev; document cert import + `cors allowed-origin`; `fingerprint` pinning (M2) |
| Orphaned config sessions lock the device (1006) | UI can wedge the switch | Named sessions + journal + `recoverOrphans()` + probe-always-aborts (M5, M11) |
| `interfaces.py` (1,101 LOC) + `vrrp.py` (1,493) dominate effort | Plan slips | Split M10a-d; defer VXLAN to W3; W3 modules don't block the webui MVP |
| Local transports imply unauthenticated priv-15 | Security incident if enabled casually | Node-only, warning + explicit opt-in (M2, DR-014) |
| `features.md` describes the **7050X** matrix, hardware is **DCS-7050TX-64** | Feature assumptions wrong (FlexProfile footnotes) | [DECISIONS.md, open items](./DECISIONS.md#open-items-need-the-device) sweep on the device; capability probing instead of hard-coded support (DR-033) |

---

## 6. Definition of done (per milestone)

1. Tasks checked in this file **and** in [STATUS.md](./STATUS.md); issue updated.
2. Unit tests added per TESTING.md inventory, with the module's coverage threshold met.
3. No `any` escaping into the public API; `show`/resource returns are typed contracts.
4. MIGRATION.md row for the module flipped from `planned` → `done`, with divergences listed.
5. Docs updated in the same commit (USAGE.md snippet for any new public verb).
