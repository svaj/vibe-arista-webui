# Decisions Log — `arista-api-client`

Format: a numbered record of choices that shape the codebase. Append; do not rewrite history — supersede
with a new entry and cross-reference. Each entry states the *evidence* when the choice depends on EOS
behaviour, and links the [open items](#open-items-need-the-device) that could change it.

Baseline: pyeapi **1.0.4-rc0** (`/home/svaj/development/arista/pyeapi`). Device: **DCS-7050TX-64**,
**EOS 4.28.13.1M**. Owner sign-off for DR-002, DR-003, DR-004, DR-034, DR-038, DR-039 came from the
scoping questions on 2026-11-01.

---

### DR-001 — License and attribution
pyeapi is BSD-3-Clause (Arista Networks). The TS client is a derivative port, so: retain Arista's
copyright in `LICENSE` (BSD-3-Clause), add a `NOTICE` naming pyeapi as the upstream and the commit
it was taken from, and keep a short attribution header on each file that is a direct translation of a
pyeapi function. Original code (session recovery, capability probing, wire types) is ours.
**Consequence:** no relicensing under a stricter term; upstream docs/tests may not be copied verbatim
without the notice.

### DR-002 — Dual runtime behind a `Transport` seam *(owner)*
One core (protocol codec, Node/command layer, resources) with two entry points:
`@devhax-heavy-industries/arista-eapi` (browser-safe: `fetch` only, no Node built-ins) and `@devhax-heavy-industries/arista-eapi/node`
(Node-only: unix socket, client certs, cookie jar, profile files).
**Why:** the webui is the primary consumer, but `http_local`/unix-socket eAPI, self-signed cert pinning,
and `eapi.conf` all require Node. Also lets Node run CLI scripts against the switch later.
**Enforcement:** a build check fails the browser bundle if it pulls `node:*`.

### DR-003 — Idiomatic TypeScript, not a line-by-line port *(owner)*
Correctness of the *wire protocol* is mirrored; the *shape of the API* is ours. Every divergence is
recorded in [MIGRATION.md](./MIGRATION.md) so a reader with pyeapi knowledge can translate on the fly.
**Consequence:** upstream unit tests are ported by **behaviour**, not by copy — assertion targets stay
identical (same commands sent, same errors raised) so the two suites remain comparable.

### DR-004 — Wave 1 = `system`, `vlans`, `interfaces`, `switchports` *(owner)*
Chosen because they map to the high-priority items in
[`docs/features.md`](../../docs/features.md) (VLAN segmentation, LAG/LACP, command execution) and
because those four modules exercise every framework seam (entity vs collection, interface sub-kinds,
multiline input, ranges) without needing a second switch (MLAG) or routing licenses (BGP/OSPF).
`VxlanInterface` is deliberately pushed to wave 3 — see [open items](#open-items-need-the-device).

### DR-005 — Errors throw; I/O is always async
pyeapi mixes two idioms: `CommandError` exceptions *and* `BaseEntity.error`/`configure()` returning
`False` (`api/abstract.py:103-128`). Resource methods **only throw**; there is no `.error` property, and
no lazy synchronous property performs I/O (`running_config` becomes `getRunningConfig()`).
**Consequence:** no forgotten `ifnotresult:` class of bug; `await` makes the device round-trip visible
in the UI's loading state, which is what the webui needs anyway.

### DR-006 — Static typed accessors replace `node.api('vlans')` autoload
pyeapi imports a module by string at runtime (`client.py:927-950`) and several modules fake attributes
with `__getattr__`/`marshall` (`acl.py:114`, `interfaces.py:117`). TS: `node.vlans`, `node.interfaces`,
`node.switchports`, `node.system` are typed getters; `node.resource('vlans')` exists only as an
escape hatch for dynamic tables, typed off a `ResourceRegistry` map. **Not** ported: `pyeapi.utils.
load_module`/`import_module` (they exist solely to serve the autoload hack).

### DR-007 — Drop pyeapi's duplicate `response` key
`Node.enable()` returns dicts carrying both `result` and `response` holding the same value; pyeapi's own
comment says `response` was added "in error" and is slated for removal (`client.py:845-852`). There is
no such key in the eAPI protocol (`JsonRpcBase.py:319-333` emits `result` or `error` only).
**Decision:** TS exposes `result` only.

### DR-008 — `http_local` / unix-socket defaults exist only in Node
pyeapi silently injects a `connection:localhost` → **socket** profile into every config
(`client.py:214-221`). On 4.28.13.1M those listeners are configured with `DISABLE_AAA 1`
(`HttpServicePlugin/Capi.py:83-124`), i.e. **unauthenticated priv-15**, and are reachable only from the
switch itself. In the browser build the default profile is `https` + explicit host; the socket/local
transports are not constructible. In Node they require an explicit `allowLocalUnauthenticated: true`.

### DR-009 — Enable mode: prefer a privileged user, keep `enable` as an option
pyeapi always prepends `enable` (or `{'cmd':'enable','input':pw}`) unless `send_enable=False`. On EOS,
Basic-auth sessions land at the user's `privLevel` (`UwsgiRequestContext.py:150-165`), so a
`privilege 15` user needs no `enable` command at all. **Decision:** `sendEnable` defaults
`true` for drop-in familiarity, but USAGE.md recommends a dedicated priv-15 API user with
`sendEnable: false`, and the client must never log an `input:` password (DR-011).

### DR-010 — eAPI error-code taxonomy, verified against the device build
From `Base.sqsh:/usr/lib/python3.9/site-packages/CliCommon.py:11-33` (marked *"part of the public
API"*): JSON-RPC `-32700 -32600 -32601 -32602 -32603`, plus `1000 COMMAND_FAILED`,
`1001 COMMAND_EXCEPTION`, `1002 COMMAND_INVALID`, `1003 COMMAND_UNCONVERTED`,
`1004 COMMAND_INCOMPATIBLE`, `1005 COMMAND_UNAUTHORIZED`, `1006 COMMAND_CONFIG_LOCKED`.
**There is no 1007** in 4.28 and the old `EAPI_E_*` names are not in this build — do not encode them.
**Consequence:** one frozen `EapiErrorCode` map + `instanceof CommandError` + `error.code` narrowing;
`1004` means "command exists but cannot be driven over eAPI", which the capability probe (DR-033)
reports distinctly from `1002` ("command does not exist on this model").

### DR-011 — Secret redaction everywhere, not only on code 1005
pyeapi scrubs `input=` from the message **only for 1005** (`eapilib.py:111-116`). The server builds
error text as `CLI command N of M <cmd> failed: …` and `CliCommand.__str__` appends `input=%r`
verbatim (`JsonCli.py:437-444`, `CliApi.py:277-287`) — for **any** code. **Decision:** redact
`input` (enable passwords) and `secret`/`password` arguments in (a) thrown messages, (b) logs,
(c) recorded fixtures, (d) the webui's error panel. Redaction is lossless for the operator (structure
kept, value replaced with `<redacted>`).
Ported from `pyeapi/eapilib.py:488-566` conceptually, but implemented inline and narrowly: the general
`_find_sub_json` matcher is **not** ported.

### DR-012 — 1003 means "no JSON model" → automatic text retry; rename `strict`
`show session-config diffs` (and any un-modelled `show`) returns `NOT_CAPI_READY` → **1003**, because
the CLI has no `cliModel` (`ConfigSessionShowCli.py:64-79` vs `:37-62`). pyeapi handles this by
re-running the single command with `format:'text'` when `strict=False` (`client.py:866`).
**Decision:** keep the automatic retry, name the option `tolerateErrors` (default `true`) — `strict`
means "do you get an exception or a repaired response list", and the negated flag reads better than
pyeapi's `strict=False`.

### DR-013 — TLS posture: explicit trust, loud escape hatch
EOS auto-generates a self-signed cert at `/persist/secure/capi.pem`
(`HttpServiceConstants.py:30-33`, `SuperServerPlugin/HttpService.py:500-530`), so verification always
fails by default — pyeapi simply disables verification (`eapilib.py:688-701`, with a "WARNING: security
risk" TODO). **Decision:** Node transport takes `ca` | `fingerprint` | `serverName`; verification is
**on** unless `dangerouslyDisableTlsVerification: true`, which must log a warning once per process and
is refused in the browser build. pyeapi's `enforce_verification` and `context=` knobs are not
reproduced (they invert the default and expose Python-SSL internals).

### DR-014 — Local transports: unix socket + `127.0.0.1:8080` only, and no 8443
4.28.13.1M generates exactly one loopback listener: **plain HTTP on 8080**
(`SuperServerPlugin/HttpService.py:563-565`). pyeapi's `DEFAULT_HTTPS_LOCAL_PORT = 8443`
(`eapilib.py:63`) maps to nothing we can find in this build. The unix socket is
`/var/run/command-api.sock`. **Consequence:** `http_local` in TS means `http://127.0.0.1:8080`;
there is no https-local transport. Node-only (DR-002) and gated (DR-008).

### DR-015 — Multiline commands use `{cmd, input}` with an explicit `EOF`
`banner motd` takes no inline argument; EOS reads stdin until a line starting `EOF`
(`Banner.py:23-30`, `BasicCliUtil.py:100-152`). Command objects accept only
`cmd`, `revision`, `input` (`JsonCli.py:36-39`). pyeapi's `MULTILINE:` pseudo-syntax
(`client.py:900-906`) is a string protocol that collides with real config text.
**Decision:** resources emit `{cmd:'banner motd', input:'text\nEOF\n'}`; the `MULTILINE:` form is kept
**only** when ingesting config text, and is documented as an ingestion convenience, not an API.

### DR-016 — Extend the `runCmds` parameter allow-list
pyeapi whitelists `version, format, cmds, autoComplete, expandAliases, timestamps`
(`eapilib.py:352-355`). The server signature is
`runCmds(version, cmds, format, timestamps, stopOnError=True, autoComplete, requestTimeout,
expandAliases, includeErrorDetail, streaming)` (`JsonCli.py:335-344`).
**Decision:** TS exposes `stopOnError`, `includeErrorDetail`, `requestTimeout` too. `streaming` is
**not** exposed: the server's own docstring marks the `runCmds` kwarg `Unused. # BUG652139`, it changes
the failure envelope shape (`JsonRpcBase.py:142-154`), and it is rejected with 1004 when `format:text`
is combined with it. Revisit only if the webui needs progressive output for long-running commands.

### DR-017 — Request ids: monotonic per connection + nonce
pyeapi defaults `reqid` to `id(self)` (a CPython memory address) — useless for correlation across
processes and logs (`eapilib.py:347`). **Decision:** `<clientId>-<seq>`, echoed into logs and into the
error object, since EOS echoes `id` back and the webui's console is the only trace we get.

### DR-018 — Cookie/session transports are Node-only and must log out
`/login` returns a `Set-Cookie` and pyeapi reuses it (`eapilib.py:720-756`) but never logs out, leaving
a device-side session. A cross-origin browser fetch cannot set `Cookie` on its own request.
**Decision:** port `http_session`/`https_session` to Node only, add `close()` → `POST /logout`, and
document that cookie auth is for the *proxy/CLI*, while the browser path uses Basic auth (DR-036). The
`Session=` cookie is also the CSRF-ish surface (no Referer/CSRF check exists on eAPI), so the client
must never mix cookie auth with a browser origin.

### DR-019 — Retry policy: none by default
eAPI commands mutate device state and each `runCmds` is its own CLI session. **Decision:** no automatic
retry. `readOnly: true` requests may retry once on `ConnectError` (opt-in). Timeout default 60 000 ms,
matching pyeapi's `timeout=60`, overridable per node and per request.

### DR-020 — Package name — **OPEN**
Directory is `arista-api-client`; working name `@devhax-heavy-industries/arista-eapi`. Considerations: avoid implying an
official Arista package; scope must match however the webui is published. Decision needed before the
first `npm publish`/tag. Default assumption in all docs: `@devhax-heavy-industries/arista-eapi`.

### DR-021 — ESM-only, `exports` conditions, no CJS
Both packages are `"type": "module"` (webui already is). `exports`: `"."` → browser build,
`"./node"` → Node build, `"./testing"` → mock helpers used by the webui's own tests. Types ship as
`.d.ts` from `tsc --emitDeclarationOnly`; runtime bundle from Vite/Rolldown lib mode
(the webui's existing pipeline). Node ≥ 20 (fetch is global). **Consequence:** nothing in this repo can
be consumed from a CommonJS project without a bundler — acceptable for a private workspace.

### DR-022 — Named, persisted config sessions instead of anonymous `uuid4`
pyeapi generates a `uuid4` on first `configure_session()` and re-sends `configure session <uuid>` for
every call (`client.py:1003-1027`, `676-696`). If the client dies, the pending session survives
indefinitely and nobody knows its name. **Decision:** default session name
`arista-ui-<host>-<uuid8>`, written to a recovery journal (Node file / browser
`localStorage`), so any later process can `listSessions()` and clean up. Re-attaching by name is the
intended EOS behaviour (`SessionCli.py:64-77`).

### DR-023 — Session recovery is a first-class feature
Pending sessions consume `service configuration session max pending` and hold the config lock, which
surfaces to the *next* client as **1006 COMMAND_CONFIG_LOCKED**. `show configuration sessions` **is**
JSON-model-backed (`ConfigSessionShowCli.py:85-119`), so recovery is cheap and reliable.
**Decision:** `node.listSessions()`, `node.abortSession(name)`, `node.recoverOrphanSessions()`; the
capability probe (DR-033) must abort its session even on throw.

### DR-024 — Durability is explicit: `writeMemory()` is a client verb
Nothing in pyeapi ever persists config (`copy running-config startup-config` is absent; a server-side
`writeMemoryOnCommit` exists in `editConfig` but pyeapi doesn't use it — `JsonCli.py:211`). A committed
config session changes **running-config only**. **Decision:** add
`node.copyRunningToStartup()` and keep it out of `commit()` — the UI decides when to persist.
Auto-commit + auto-save is a footgun (see also live-test policy DR-035).

### DR-025 — Config session is a state machine
`open → (configure | diff)* → commit | abort | lost`, enforced in the client; `node.configure()`
(terminal mode) while a session is open raises `SessionError`, because EOS would interleave two
configuration contexts and the diff we showed the operator would no longer be what gets committed.

### DR-026 — `chunkify` caching: content-hash memo, not `lru_cache` on the instance
pyeapi decorates `_chunkify` with `@lru_cache(maxsize=None)` and manually
`cache_clear()`s after every config change (`client.py:655-676`) — unbounded memory keyed by full
config text. **Decision:** single-entry memo keyed by config hash plus parsed offsets, invalidated on
`refresh()`. Same recursion invariant (outer call must be `indent = 0`).

### DR-027 — Not-found semantics
`Node.section(regex)` raises `TypeError('config section not found')` in pyeapi (`client.py:794`) —
an exception *type* that means "not found". Resources return `undefined` for a missing entity
(`Vlans.get()` → `Vlan | undefined`) and throw `NotFoundError` only when a *required* lookup fails.
Chosen because the webui renders tables of resources; `undefined` is the ergonomic answer, and
`TypeError` is never a meaningful catch target in TS.

### DR-028 — Keep pyeapi's odd `switchport trunk allowed vlan` parse, with a comment
`switchports.py:117-124` reads `forwarding:trunk:allowed-vlans` from `show interfaces … json` rather
than parsing running-config. The reason is not documented upstream. **Decision:** preserve the
behaviour, add a `// unverified: why?` note, and pin it with a fixture test; revisit during the
device sweep in [STATUS.md](./STATUS.md).

### DR-029 — Keep then fix the `name=` fallback in switchports
`switchports.py:147-151` has a self-described hack falling back to `name` when an interface parse
comes up empty. **Decision:** port it guarded behind a regression test that documents the failure mode
(it silently hides "interface has no switchport config"), then replace it with the real EOS form once
the device answers `show interfaces switchport json`.

### DR-030 — One config read per collection operation
pyeapi re-parses `show running-config` on **every** resource call (`abstract.py:75`, per-module
`get_block`) — a `getAll()` over 48 ports plus a write is many round trips. **Decision:** resources
cache the parsed running-config for the lifetime of one client method call (and across
`getAll()`/`getMany()` via a batched `withConfigSnapshot(fn)` helper). Cache invalidation via
`refresh()` only (DR-026).

### DR-031 — Hybrid read strategy: model-backed `show` first, config text second
Arista docs are unreachable from this environment (arista.com returned HTTP 403); the reliable signal
is which show commands carry a `cliModel` in the 4.28 image. `show configuration sessions`,
`show vlan`, `show port-channel <id> all-ports`, `show banner login/motd` are model-backed;
`show session-config diffs` is not (1003). **Decision:** each resource documents *which* of its fields
came from a model-backed `show` vs parsed config text, because the former is stable across releases and
the latter is not.

### DR-032 — No hard-coded platform limits
MTU ceilings, LAG member counts (features.md claims "16 ports per LAG, 64 members" — that row came from
the **7050X** matrix, not DCS-7050TX-64), VLAN ranges beyond the EOS-wide 1-4094: read them from
`show version` / `show platform` output or enforce nothing, and let the device reject with 1002/1003.
**Reason:** feature presence on 4.28 is gated per model through ArToggles (`/etc/toggles.d/*.json`,
e.g. `Vxlan.json`, `Mlag.json`) and licensing we cannot enumerate from the available artifacts.

### DR-033 — Capability probing beats a static support matrix
Arista enforces feature availability through ArToggles, license files (`show license features`) and
per-model builds. **Decision:** `node.capabilities.probe(feature)` issues the candidate commands inside
a throwaway config session with `stopOnError:false` + `includeErrorDetail:true`, then **aborts**, and
records: `1002` unsupported here · `1004` exists but not eAPI-drivable · `1005` role denied ·
`1006` locked. Results cached per device (TTL 24 h, `invalidate()` manual).
`verifyConfig` (`JsonCli.py:275-329`) provides a real dry-run of aggregated configlets — expose it as
`node.verifyConfig()` for the review-before-commit screen.

### DR-034 — Live tests must skip loudly, never silently *(owner)*
`*.live.test.ts` runs only when `EAPI_LIVE=1` **and** `EAPI_HOST`/`EAPI_USER`/`EAPI_PASS`
(or `EAPI_PASS_VAR`) are set; otherwise it reports `skipped: <reason>` and the run still passes.
`npm test` never touches a device. `npm run test:live` is the only path that can.

### DR-035 — Live/CI device policy
*The disposable cEOS target and CI/E2E refinements are recorded in DR-043 below;
the original physical-switch rationale is retained here.*

Live tests (a) always inside a named config session, (b) only touch the interface named by
`EAPI_SCRATCH_INTERFACE`, (c) never call `copyRunningToStartup()`, (d) `abort()` in a `finally`,
(e) refuse to start unless `EAPI_TARGET_CLASS=lab`, and (f) assume single-flight execution (CI
concurrency group of 1). Rationale: this is one production-ish home switch, not a disposable vEOS farm.

### DR-036 — Browser connectivity: dev proxy by default, on-device CORS as the advanced path
Verified on 4.28.13.1M: nginx in front of eAPI emits CORS only when the `Origin` matches a configured
`management api http-commands cors allowed-origin <origin|all>` entry, answers `OPTIONS` with 204, and
**omits CORS headers on 4xx** (no `add_header … always`) — so a wrong password presents to the browser
as an opaque network error. Also mutually exclusive server-config modes
(`management api http-commands` vs `management http-server`).
**Decision:** default = same-origin through Vite's dev proxy (Node), which can verify the device cert
against a pinned CA/fingerprint and translate 401 into a readable JSON error. Documented alternative =
direct browser access after `cors allowed-origin` + trusting the device cert (DR-013). The client gets
a `baseUrl` option so both work without code changes.

### DR-037 — Command builder: explicit `set` / `no` / `default` modes
`abstract.command_builder(string, value, default, disable)` (`abstract.py:129-165`) evaluates in order
default → disable → value, and its `else: return 'no %s'` branch (with a commented-out
`ValueError`, i.e. "negate by passing None") is explicitly deprecated upstream.
**Decision:** TS builders take `{ mode: 'set' | 'no' | 'default' }` or dedicated `unsetX()` /
`defaultX()` methods; passing "no value" is an error, never a silent `no` form. Keep the ordered
semantics only where a ported pyeapi test depends on them, and test the precedence table.

### DR-038 — Config profiles: file-based in Node, injected in the browser
pyeapi's `Config` parses INI from `~/.eapi.conf` + `/mnt/flash/eapi.conf` (or `$EAPI_CONF`) with
tag support (`client.py:127-318`). Ported **only** into the Node entry. The browser gets
`createProfiles(record)` from app state; it never reads a file and never falls back to a hidden default
host (DR-008). Preserved quirks: parse errors logged and ignored, `host` defaulted to the section name.

### DR-039 — Testing toolchain: Vitest 5 + oxlint, matching the webui *(owner)*
`vitest run` (node environment for the client package — no jsdom), `*.test.ts` colocated with source,
`*.live.test.ts` excluded from the default project, `@vitest/coverage-v8` thresholds,
`expectTypeOf` type assertions for the contracts, and `oxlint` with a shared root config.
**Not used:** Jest (the imported `.github/skills/javascript-typescript-jest` guidance describes Jest;
Vitest is the actual runner in this repo) — see [.github/skills/README.md](../../.github/skills/README.md).

### DR-040 — Versioning, changelog, breaking changes
`0.x.y` while pre-1.0; `CHANGELOG.md` (Keep a Changelog); every pyeapi-diverging rename gets a
migration row and a deprecation-period entry rather than a surprise. Public surface = exports of
`index.ts` / `node.ts` only; `src/internal/**` is not API.

### DR-041 — Utility surface is deliberately small
`pyeapi/utils.py` is 304 lines, but only `make_iterable` (implicit array coercion), `expand_range`,
`collapse_range`, `lookahead`, and `CliVariants` carry behaviour. `debug()`,
`islocalconnection()`, `load_module`/`import_module`, `_interpolate_docstr` are Python scaffolding —
not ported. `make_iterable`'s implicit coercion becomes explicit `toArray()` at the boundary, because
silent coercion + `undefined` is the top source of Python-isms leaking into a TS API.

### DR-042 — Resources model 4.28 syntax, and say so
`vrfs` (`vrf instance` + `vrf definition` split happened across releases), `stp` (`spanning-tree
mode …` per-VLAN forms), `mlag` (`mlag configuration` submode exists in 4.28:
`MlagGlobalConfigMode.py:22`) — each module pins the *4.28.13.1M* command form and refuses to claim it
works elsewhere. A later abstraction (per-release command tables) is out of scope until a second EOS
version is actually supported.

### DR-043 — Prefer disposable cEOS for real-EOS tests; keep hardware evidence separate *(owner)*

The owner supplied Arista's **cEOS-lab 4.28.14M** tar and generic installation README
under `/home/svaj/development/arista/cEOS/`. Prefer this real EOS software target for
opt-in API integration/live tests and Playwright browser E2E, rather than writing to the
home switch. Setup and the implementation contract are in the [cEOS runbook](../../docs/CEOS.md);
availability of the image is not evidence that boot or the test harness has been validated.

This refines DR-034/DR-035: default `npm test` stays offline; local live opt-out reports a
reason, but explicitly requested CI cEOS/E2E runs fail on missing prerequisites, readiness
failure, wrong endpoint/model/version, no executed tests, or cleanup failure. Live guards,
allow-listing, named sessions, explicit scratch interfaces, no persistence, and
serialization per endpoint also apply to cEOS and browser E2E. Disposable bootstrap
is separate from test mutations; abort uncommitted sessions, and reverse committed
changes or dispose of the container. Never fall back to hardware or mocks.

Initially use trusted manual-dispatch CI on a dedicated Linux runner: the vendor recipe
uses `--privileged`, so untrusted/fork PR code must never run there. Keep image access
authorized and private; always remove run-owned containers/networks after diagnostics.

Record cEOS **4.28.14M** fixtures/capabilities separately from **DCS-7050TX-64 /
4.28.13.1M** evidence. Container results establish only the tested software behavior,
not the physical platform's feature support, licenses, ASIC limits, or patch-exact schemas.
DR-032/DR-033 and the physical device sweep remain necessary. Two-node cEOS topologies
can be investigated for supported MLAG/routing control-plane tests without claiming
physical forwarding parity.

<!--
Numbering note (updated on the M12 branch after merging post-M8/M9 `main`, 2026-11-04): **DR-001..060 are on `main`** (through PRs #26/#27/#28, in file order above). This branch claims its reserved band **DR-064..066 (M12, #14)** below. **DR-061..063 stay reserved for M11 (#13)** and are in no tree yet. DR-003 and DR-031 are not gaps — both exist above — but no entry in this log is ever renumbered, so the bands stay visible here rather than in a table (this file has no index section; the milestone index is STATUS.md §1 and the decision-to-milestone trail is each entry's `Related:` line).
-->

### DR-051 — a command builder answers with a string, or it refuses
`abstract.command_builder(string, value=None, default=None, disable=None)` (`pyeapi/api/abstract.py:129`)
always answers a string: its precedence is stated in its own docstring at `:137` ("Parameters are
evaluated in the order 'default', 'disable', 'value'") and coded at `:152-161`, and the final `else:`
(`:160-161`) returns `'no %s'` for a call that supplied **no value at all** — upstream marking that line
"to be deprecated and replaced with the error below" with the replacement `raise ValueError` commented
out at `:162-164`. Upstream's own suites are pre-armed for that fix: 12 sites read "If command_builder
fails because value is None, uncomment" (9 in `test_api_bgp.py` incl. `:117`, 2 in
`test_api_ipinterfaces.py` at `:104`/`:135`, 1 in `test_api_routemaps.py:154`).
**Decision:** one free function, `commandBuilder(command, { mode, value }) → string`
(`arista-api-client/src/resources/command-builder.ts`), with a thin `protected` delegate on
`ResourceBase` so modules call it the way pyeapi's do. The precedence is preserved — `mode: 'default'`
preempts `mode: 'no'` preempts a left-over `value`, so a verb that forwards both cannot flip an
explicitly negated command into a write. The two fall-throughs are deleted: no `mode` + no `value`, or
`mode:'set'` with nothing to set, raises `NotSupportedError` naming the rejected input. The result is
always a `string`, never a boolean, never a `{ok,error}` bag, and nothing is stashed for later
inspection.
**Consequence:** 45 cases in `command-builder.test.ts` are the truth table; the `cmd()` spelling that
MIGRATION §2's row planned did not ship — `commandBuilder` is the shipped name, and a **free function**
(not a method) is what lets the whole table be tested with no `Node` at all. A numeric `0` keeps its
value (`mtu 0`), where pyeapi's `elif value:` produced the `no` form.
**Related:** DR-037 (this decides the *result shape*; DR-037 decided the *modes*), DR-005, DR-015,
DR-031; [MIGRATION.md §5](./MIGRATION.md#5-semantic-divergences-worth-reviewing) rows 3 / 73 / 74 / 82.

### DR-052 — resources come from a closed registry, never an autoloaded name
pyeapi resolves a resource name as a **filesystem path**: `Node.api(self, name, namespace='pyeapi.api')`
(`client.py:927`) calls `load_module('{}.{}'.format(namespace, name))` (`:945`), then
`module.initialize(self)` / `return module.instance(self)` (`:946-949`), so a typo is an import error at
first use and **every call constructs a fresh resource object** — which is why `Interfaces` needed its
own `_instances` dict (`interfaces.py:90`, read at `:122-126`) to behave statefully. Upstream's entire
coverage of the mechanism is `test_api_autoloader` (`test/unit/test_client.py:210-212`), asserting only
`assertIsNotNone`.
**Decision:** keep DR-006's rule that an `api()`-shaped call stays **out of the type**. The seam that
ships is `node.resource(name)` / `node.hasResource(name)` over `ResourceKinds` — an augmentable interface
in the same style as `ShowContracts` — backed by the frozen `RESOURCE_FACTORIES` table and a
`ResourceRegistry` memoised **per `Node`**. Compile time and runtime both check the name, because
declaration merging can add a type row whose factory was never registered; that case throws a
`NotSupportedError` listing registered names rather than returning `undefined`. Apps with dynamic tables
build their own map with `createResourceRegistry(factories, node)`.
**Consequence:** `ResourceKinds` is **empty at M7**, and that is deliberate — the static
`node.vlans`-style getters DR-006 also names are deferred to M8 (#10)/M9 (#11)/M10 (#12), since a
getter's return type is the module's class and no module exists yet. What M7 measured instead is the
cost of adding one: one interface row plus one factory, on top of a 19-line entity in
`src/resources/base.test.ts` (the exit-gate count, §5 row 82). Also honestly open after this milestone:
`src/index.ts`/`src/node.ts` do **not** re-export the framework yet, so it is reachable in-repo and to
M8-M10 but not to a consumer of the package (STATUS.md §1's M7 row carries that as the remaining piece).
**Related:** DR-006 (title: "Static typed accessors replace `node.api('vlans')` autoload"), DR-038,
DR-040, ARCHITECTURE.md §7; §5 rows 79 / 82.

### DR-053 — throwing validators replace pyeapi's predicate-plus-`False` guards
`isvlan(value)` (`api/vlans.py:63-80`) runs `value = int(value)` (`:77`) and `value in range(1, 4095)`
(`:78`), so `'0020'` is a VLAN and `20.5` is truncated to `20`, while `isvlan(None)` escapes as a bare
`TypeError` because the handler catches only `ValueError` (`:79-80`); call sites then fold the guard
into the swallowed `return self.configure(command) if isvlan(vid) else False` (`:204`, `:216`, `:232`).
There are **two different** `isvalidinterface` predicates: `interfaces.py:81-83`, an unanchored
`re.match(r'([EPVLM][a-z-C]+)', value)` followed by set membership in `VALID_INTERFACES` (`:71-78`), and
`stp.py:346-363`, which tests `value[0:2] in ['Et', 'Po']`. Both were opened and run against Python 3 on
2026-11-03: `Ethernet1` → `Ethernet`, `Port-Channel1` → `Port-Channel`, `Po1` → `Po` (rejected by the
set), `Et1` → no match, and a bare `Vlan` with no index **passes**.
**Decision:** one name per concept in `arista-api-client/src/resources/validators.ts`:
`assertVlanId`/`isVlanId` (`Number.isSafeInteger`, 1..4094, no string coercion) and
`assertInterfaceName`/`isInterfaceName` (anchored `^(kind)digits+$` over upstream's six kinds). Every
refusal is a `NotSupportedError` naming the rejected value with the same `%r` rendering pyeapi uses, and
`configureInterface` applies the interface guard **before** anything is built, because the dynamic
`marshall` dispatch that enforced it upstream is not ported (DR-006).
**Consequence:** two of upstream's own assertions are inverted deliberately —
`test_api_vlans.py:54-55` requires `isvlan('1234')` to be `True`, and ours refuses any string, because a
string at that point means a UI forgot to parse a form field. The guards are input guards, not platform
claims: the kind list is upstream's, not an EOS 4.28 statement, and the widening (subinterfaces, slot
forms) is refused until there is device evidence. **Open item 7** below tracks it, in the same class as
`modelName` (open item 1). M10 (#12) replaces the regex with the per-kind discriminated-union parser
PLAN asks for.
**Related:** DR-004, DR-005, DR-032, DR-042, DR-006; §5 rows 76 / 74 / 77.

### DR-054 — `toArray` is the package's only implicit-coercion boundary, and it copies
`make_iterable(value)` (`pyeapi/utils.py:147-166`) turns a `str`/`dict`/`CliVariants` into a one-element
list (`:159-161`) and lets everything else through **by identity** (`:163-166` returns the same object),
which is the whole cause of the mutation bug at `api/abstract.py:176-177`: `configure_interface` runs
`commands = make_iterable(commands)` and then `commands.insert(0, 'interface %s' % name)`, splicing the
parent line into the caller's array — permanently, on a reused list. Upstream's four
`test_make_iterable_*` methods (`test/unit/test_utils.py:23-41`, on the single `TestUtils` class at `:8`)
never assert anything about aliasing, and no upstream suite exercises the bug.
**Decision:** `toArray<T>(value: T | readonly T[]): T[]` in
`arista-api-client/src/internal/collections.ts`. An array in always yields a **new** array; the only
accepted shapes are one value or an array; `undefined`/`null` raises `NotSupportedError` naming the
expectation instead of a `TypeError` from a later frame. Every command-list helper in the package
(`configure`, `configureInterface`, `submodeCommands`) routes through it, so no exported verb can be
handed a caller array that comes back modified.
**Consequence:** a `Set`, `Map` or generator is treated as ONE value, never spread — `Array.from` is the
caller's explicit step, since guessing "one value or its spread?" is exactly the duck typing DR-004
removes. DR-041's rule ("`make_iterable`'s implicit coercion becomes explicit `toArray()` at the
boundary") now has a second, concrete justification beyond typing: aliasing corrupts a caller's state.
**Related:** DR-041, DR-004, DR-003; §5 rows 71 / 72 / 74.

### DR-055 — wave-1 global reads go through the chunker; `parseConfigBlock` is the exception, not the rule
A wave-1 module reads device config, and M6 + M7 shipped two engines for that: the `Node` chunker
(`configSections()` over the DR-026 memo) and `parseConfigBlock` (row 81). pyeapi had neither: each
`_parse_*` re-read `self.config` — one `show running-config` **per field** (rows 15/75) — and matched
over the whole flat document, so a `hostname …` line inside a banner body answers as the hostname and a
banner reciting `no ip routing` turns routing off (probes, `system.py:82`/`:94`; §5 row 84).
**Decision:** the first module settles the pattern: reads that describe **global scope** anchor on the
chunker's indent-0 section keys — the one structure in the package where "this line is a top-level
command" is decided by M6's reviewed rules, not by a module regex — and cost ONE request off the memo
(pinned in `system.test.ts` by the transport's command list). `parseConfigBlock` is deliberately NOT
used there or by any byte-fidelity body: its extractors run over `parseBlock`, which strips indent and
unquotes per line (`config/text.ts` `describeLine`, row 81) — right for `name PROD`, wrong for a banner
body that must survive verbatim (upstream's own fixture keeps a 9-space line inside `banner login`,
`test/fixtures/running_config.text:410`), and for a global entity the block header `parseBlock` drops
would be the `hostname` line itself.
**Consequence:** PLAN's M6 exit gate ("every wave-1 resource can be parsed from text config with no
bespoke regex") is now observable in a shipped module: `src/resources/system.ts` contains no config-text
regex beyond exact section-key matches. M9/M10 follow the same split — scalars anchor on chunk keys,
sub-mode bodies use `parseConfigBlock`, EOF-delimited bodies read the section text verbatim. The
known `describeLine` whitespace gap (row 81: `' PROD'`, `' group red'`) is M9's to settle as its first
real reader, exactly as M7 recorded rather than silently widening a pinned primitive.
**Related:** DR-026, DR-030, DR-005; §5 rows 15 / 75 / 81 / 84 / 85 / 86 / 87.

### DR-056 — the `EOF` terminator is part of the banner verb's contract: strict write, lenient read
pyeapi never sends the terminator: `set_banner` writes `input = value` plus at most one appended newline
(`system.py:177-178`) and nothing closes the block (`:179`, pinned verbatim by `test_api_system.py:88`),
while its reader demands a newline **after** `EOF` (`\nEOF$\n`, `:108`) and silently drops a trailing
banner that lacks one (probe). DR-015 made multiline payloads `{cmd, input}` objects; nothing yet said
whose job the terminator is.
**Decision:** the client owns it. `setBanner` always sends `{ cmd: 'banner <kind>', input: body +
'\nEOF\n' }`; exactly one caller-supplied trailing newline **folds into** the terminator (so `'x'` and
`'x\n'` are byte-identical on the wire — the inverse of upstream, which appends toward a form that never
closes). The write is refused locally, before any request, for bodies this client could not read back: an
empty body, a line reading `EOF` after `rstrip` (the chunker's own comparison, `client.py:743`), or a CR
(a line boundary for `splitLines`, so the read would not round-trip). The read side is deliberately
more lenient — `EOF` accepted as the document's last line, opener spaces `rstrip`ped. Which rules EOS
itself applies (terminator case, CR handling, whether it writes `banner exec`) is unverified on
hardware, M12 (#14) to capture.
**Consequence:** no banner write can leave an open input mode on the wire, and the payload a mock
asserts is exactly the payload a device needs. Redaction keeps working: only `enable` **inputs** are
secrets (DR-011, `internal/redact.ts`'s `ENABLE_COMMAND`), so a refused banner write still carries its
body in `CommandError.commands` — pinned, because banner text is operator content, not a credential.
**Related:** DR-015, DR-011, DR-032, DR-055; §5 rows 16 / 86 / 87 / 88.

### DR-057 — an unverifiable device rule ships as named client policy, never as an invented EOS fact
PLAN's M8 box asks for `setHostname` "with EOS name rules validated (length, no leading digit/space)."
Those rules are **not knowable in this workspace**: no device in unit tests, no readable CLI sources in
the image split (`arista/_rea_swi` yields one `.py*` file; the `*Cli.py` files M5 had to demote are not
here), and pyeapi itself validates nothing on this path (`system.py:118-134` interpolates straight into
the command; whole-file check 2026-11-03). Inventing numbers and calling them EOS behaviour is exactly
the failure this project's evidence discipline exists to prevent.
**Decision:** encode only (a) refusals derivable from **this client's own reader** — a single token with
no whitespace or control characters (the reader reads one token, `:82` is upstream's version of the same
fact), no `"` (the reader unquotes a balanced pair, so such a name could not round-trip), non-empty (the
builder refuses a trailing-space command; `unsetHostname()` is the spelled-out negation, DR-037) — and
(b) clearly-labelled **policy** for the rest: a generous `≤ 128` bound and a no-leading-digit
convention, each refusal message stating "client-side rule … unverified on hardware, M12 (#14) to
capture." The device keeps the authority: every verb has a pinned `CommandError` path (DR-005 — the
device's refusal, `failedCommand` intact, never a `False`).
**Consequence:** no line of docs or code asserts an unsourced EOS fact; the open questions ride along
where they can be answered — M12 (#14)'s capture list grows hostname charset/length/leading-digit
 behaviour, whether config text ever quotes a hostname, and the `banner exec` write form — and a later
capture revises a *policy* row without contradicting a claimed *fact*. The same labelling discipline
already retired M5's unverifiable `*Cli.py` citations to demoted carried claims; this makes it the
pattern for wave 1, including M10's interface grammar (DECISIONS open item 7).
**Related:** DR-053, DR-032, DR-043, DR-029 (recorded as upstream defect, not quietly fixed); §5 rows
83 / 89.

### DR-058 — the keyword gap is settled at the keyword: a shared extractor, not a pinned-primitive rewrite
Rows 49 and 81 left a chain of promises: `describeLine` does not `lstrip` the run between the first
token and the value (so `findValue` answers `' PROD'` and `unquote` can never fire), a two-word keyword
keeps its own tail, and `text.test.ts:204-211` calls it "a one-line implementation fix" deferred to the
first real reader — M9. That reader arrived in two modules at once (`vlans`, `switchports`), both needing
the same normalisation at DIFFERENT keywords (`name`, `trunk group`, `switchport mode`, …).
**Decision:** neither of the two obvious moves. Not "edit `describeLine`": a first-token `lstrip` is the
wrong scalpel — the tail of `trunk group` survives any lstrip, a resource that ever wants the raw
remainder loses it, and the primitive is pinned by M6's suite AND by the pyeapi oracle-parity harness
(`scripts/config-chunkify-oracle.py`); a device-validated reason could reopen it, mid-stream convenience
could not. Not "each module re-splits": that is two copies of one rule and a breach of PLAN's M6 exit
gate. The fix is **extraction at the keyword**: `valueAfterKeyword` / `valuesAfterKeyword`
(`src/resources/config-block.ts`) compose M6's own pieces — the whole-command word-boundary rule
(`text.ts:215`) + `lstrip` (`:92`) + `unquote` (`:235`) — over the parsed body lines. `src/config/**` is
untouched by this branch; its pins stay green; the primitive's doc gap is reported upward, not patched
under cover.
**Consequence:** the two modules read through ONE implementation and cannot drift. Direct specs land in
`config-block.test.ts` (13 new cases incl. mutation-proofed word-boundary, whitespace-run, two-word
keyword, balanced/unbalanced quoting, bare-keyword skip), keeping the file at 100% lines/branches as M7
shipped it. As-built honesty pins two edges rather than blessing them: an explicitly empty quoted value
(`name ""`) joins the "no value" bucket (unquote runs before the emptiness test — the quoting DEPTH is
row 49's M12 #14 capture anyway), and `vlans.py:60`'s `(?:trunk\sgroup\s)(?P<value>.*)$` turns out to
allow an EMPTY value (the ≥1-char claim rests on `switchports.py:115` alone) — unreachable from
device-shaped text because `describeLine` rstrips, pinned as such. Row 81's forward promise and row 49's
pointer now tell this story; a module that wants `findValue`'s raw contract must justify it, not default
to it.
**Related:** DR-055 (chunker authority), DR-027; §5 rows 49 / 81 / 91.

### DR-059 — a collection read reports, keeps, or fans out — it never invents, truncates, or strands
pyeapi treats read validity and write validity as one question and answers both badly: `isvlan` gates the
writes (and swallows refusals into `False`), while the readers invent (`vlan 10x` → `'10'`), truncate
(`access vlan 20 extra` → `'20'`), and key ranged headers as ONE string entry (`'200-202,204'`) that
`isvlan` then refuses — so a range section exists in `getall` but can **never be deleted through pyeapi at
all** (probe: `create`/`delete` return `False` and send nothing). A UI cannot render "a VLAN you can see
but cannot touch".
**Decision:** split the question. The read answers three ways: a well-formed value → typed field; a value
the grammar cannot parse (`vlan 1,`, `vlan 1-`, `switchport access vlan 20 extra`) → `ConfigParseError`
naming the section (rows 43/44's rule: a parse failure is never answered as a missing field); a value
inside the grammar but outside the client's write range (`vlan 99999`) → **kept** (the switch wrote it;
answering nothing would be the lie) while `delete(99999)` refuses via `assertVlanId`. And a
ranged/enumerated header **fans out** through M6's `expandRange` so every member id is addressable —
`delete(201)` on a `vlan 200-202` section sends `no vlan 201`, what EOS makes of that is a labeled M12
(#14) capture, not a documentary refusal. A run whose endpoints exceed the expansion bound is refused as a
`ConfigParseError` rather than expanded: unbounded client-side work is refused for the same reason
DR-032 refuses invented platform ceilings, not because a number is sacred.
**Consequence:** write-side `1..4094` stays pyeapi's own figure (`range(1, 4095)`, `vlans.py:78`); nothing
in this decision claims what EOS stores. The parity board says "all 15 + 21 upstream methods ported"
truthfully: their COMMAND texts are reproduced, their malformed-value ANSWERS deliberately are not.
**Related:** DR-027, DR-032, DR-053, DR-057, DR-029 (name-fallback half closed at the key, §5 row 96);
§5 rows 95 / 96.

### DR-060 — set-diff writes are ONE transaction in a deterministic order; Python's hash order is not ported
`set_trunk_groups` (`vlans.py:314-325`, `switchports.py:364-375`) computes `set(...).difference(...)` for
adds and removes and sends a **separate `configure` per element** — with more than one change the wire
order is Python's per-process hash order (not caller order, not reproducible in a log or an audit), a
refusal mid-list leaves the device **partially applied**, and reading current state through
`self.get(…)['trunk_groups']` raises `TypeError: 'NoneType' is not subscriptable` for an absent VLAN
(probe).
**Decision:** one read, a set-diff, **one** `configure()`: adds in the caller's order, removals in device
order, mode line first inside `setTrunk`'s combined write. The ordering is explicitly **this client's**
choice — the CLI applies the lines sequentially and the members are independent, so the final state does
not depend on it — but a deterministic cmds[] is what a diff-before-commit UI and a recording fixture can
show and promise; upstream's is what a replayed capture cannot. Empty diff → nothing goes out (upstream
agrees, probe); absent entry → `NotFoundError` (DR-027's required-lookup arm), never `TypeError`, never a
silent pass.
**Consequence:** every multi-change verb in wave 1 has the same shape to be tested against (exact `cmds`
arrays), and `setTrunk` lands as PLAN §M9's one verb where upstream needs three calls. If M11 (#13)'s
probe finds `switchport trunk group` unsupported on the target (open item 4), that changes the
CAPABILITY table, not these verbs' spellings.
**Related:** DR-037, DR-027, DR-005, DR-050 (never call a staged write a preview); §5 row 97.

### DR-061 — non-runCmds eAPI methods ride a validated method table over an optional `Transport#callMethod` seam; they are never faked with `runCmds` (M11 #13)
pyeapi has no client half for the methods PLAN §M11 builds on: grepping `verifyConfig`,
`getCommandCompletions` and `getCommandHelp` through the pinned clone (`develop` `6816d9e`) matches
nothing in `pyeapi/` — they exist only as SERVER procedures (`JsonCli.py:275-279`, `:174`, `:200`).
**Decision:** the codec carries `WIRE_METHODS` (`src/internal/wire.ts`): per method a parameter
allow-list (unknown keys are a local refusal), the one parameter `JsonRpcBase.py:288-293` makes
required (`configList` / `command`), and a fixed `resultShape` — `array` (list-shaped like
`runCmds`, `JsonRpcBase.py:160`) or `object`; an answer of the other shape is a parse refusal, never
a guess (the same do-not-assert-unverifiable stance DR-032 states for limits, now stated for
answers). Transports gain an optional `callMethod` (`transports/contract.ts`): all seven built-in
senders and `MockTransport` implement it; a hand-rolled `Transport` without it gets a
`NotSupportedError` spelling the reason — a configlet sent as a command batch **gets applied**,
whereas `verifyConfig` runs inside a session the device opens AND aborts itself
(`JsonCli.py:293-305`), so faking it with `runCmds` is off the table by safety, not laziness.
**Consequence:** a third request shape crosses the seam (`SentMethodCall` mirrors `SentRequest`),
`WireMethodResultOf` types each method's parsed answer, every outcome keeps `raw` so unknown fields
survive (row 8's rule), and the param validators refuse preamble control characters because the
device executes each preamble entry as one CLI line (`CliApi.py:659-663`).
**Related:** DR-016, DR-010, DR-011, DR-017 (the id policy covers method calls too), DR-062, DR-063; §5 rows 115-117.

### DR-062 — the probe stages candidate commands in a throwaway named config session, always aborts it, and its verdict set claims nothing beyond a `1002` (M11 #13)
DR-033 forbids any hard-coded "supported on the 7050TX-64" list, and the per-model feature matrix
(ArToggles, licensing) cannot be enumerated from offline artifacts — so presence is **probed**, at
the level the device can actually answer: candidate command TEXTS, never feature names.
**Decision:** `probeCommands` (`src/capabilities.ts`) stages the candidates as a `stopOnError:false`
batch inside one throwaway **named** session and classifies each command from
`errorDetail[]` (`JsonCli.py:441-446`). The abort is guaranteed on every path — including when the
`onBatch` progress sink throws — and an abort that itself fails is reported through
`onCleanupFailure` (default: the package's loud `warnOnce`), the one case where a session can
outlive the function. The session keeps M5's DEFAULT name prefix (DR-047) on purpose:
`recoverOrphans()`'s filter is prefix-based, so an orphaned `probe-…` name would hide the session
and leave the config lock held (DR-022/DR-023). Candidates this client refuses to probe — `abort`,
`commit`, `configure session`, `configure replace`, `copy running-config startup-config`, `reload`
— are OUR rule, not the device's (a session would run all of them): each would end, commit, replace
or persist the probe's own state (DR-050's preview rule, DR-024's explicit durability), and
`reload` reboots the switch. The seven verdicts are the honest version of yes/no: **only `1002` is a
statement that a command is unavailable**; `1004` (context, not feature), `1005` (privilege),
`1006` (nothing was probed) and `unknown` are inconclusive by construction, and `supported`
(observed acceptance) is named apart from `not-rejected` (absent from `errorDetail`) so no caller
can confuse a reading of vendor-side prose with evidence. Classification keys on the command TEXT,
never the `errorDetail` index (whose base is the whole wire list, `enable` and opener included),
and each result records `codeSource` because a batch-level `error.code` is only the FIRST failure
(`JsonCli.py:436`) — weakest evidence, labelled as such. Feature lists (`FeatureProbeCommands`) label
verdicts only; the package interprets no name and ships no built-in table (DR-033).
**Consequence:** the probe cannot change running-config, but it is not free (one session + a batch
per chunk) — which is why DR-063 exists; every "what the session does on hardware" claim stays
carried offline evidence inherited from M5's header (the STATUS §3 sweep remains open).
**Related:** DR-033, DR-050, DR-022, DR-023, DR-024, DR-047, DR-010, DR-011, DR-061; §5 rows 118-121.

### DR-063 — capability answers are cached per endpoint with an explicit TTL, and an inconclusive probe is never a stored fact (M11 #13)
A probe costs a session, so per-render probing is unusable and per-process caching is wrong: EOS has
nothing that invalidates a capability answer, and what would change one (an `eos` upgrade, a
`feature` toggle, an AAA change) is unbounded by offline evidence.
**Decision:** `createCapabilityCache` stores each probe under endpoint (`Transport#address` — the
identity an answer belongs to; no globals, no per-`Node` guessing) plus the exact candidates plus
`batchSize` (both change the answer, so both are in the key). The default TTL
(`DEFAULT_CAPABILITY_TTL_MS`, 15 min) is OUR rule; `ttlMs: 0` means "store nothing", never "cache
forever"; the clock is injectable because the offline suite never sleeps. Inconclusive verdicts
(`config-locked`, `unknown`) and `configLocked` runs are NEVER stored — an unverifiable answer must
not become a cached fact, the same stance DR-032 takes for limits applied to verdicts (the earlier
draft citations here said DR-032; they are retargeted to this entry). `peek` reports freshness and
even a negative remainder so a UI can print "stale since"; `invalidate(endpoint)` belongs after a
config change the operator made on purpose; `entries()`/`endpoints()` drive a settings screen
without re-probing.
**Consequence:** "review changes" screens can answer what the switch SAID without touching the
switch, and always know when that answer stopped being trusted — the TTL is a trust boundary, not a
performance knob.
**Related:** DR-062, DR-033, DR-032 (same stance at the limits), DR-043 (capture separation: an
answer is worth exactly its endpoint); §5 row 122.

### DR-064 — recordings are wire artefacts taken at the transport seam, redacted before they exist
Fixture harnesses usually sit above the client ("capture what the code sent"), which means a
recording file is built from already-parsed, already-transformed data — anything the harness author
forgot to redact at that level is committed forever, and enable inputs must survive to the wire
un-redacted (M1's carried note) so SOMETHING in the path is secret-bearing. pyeapi ships no
harness at all: its system tests lean on a live device with no capture, no replay and no provenance.
**Decision:** the recorder wraps the transport's `trace` seam (`src/testing/recording.ts`), where
`src/transports/base.ts` already runs every body through `redactWireText` — redaction happens on
CAPTURE, before a value is ever held for later, and `buildRecording` re-runs the same rules on the
way OUT, so even a caller who bypassed `trace` cannot write an unredacted fixture.
`findUnredactedEnableInput` is asserted on WRITE **and** LOAD, so repository review is not the
protection. The browser/Node split holds: `recording.ts` is browser-safe (DR-002) and webui tests
may record/replay; only `recorder-node.ts` touches the filesystem, behind `./node`. Replay targets
`MockTransport` verbatim (`replayRecording`), making a committed fixture the offline contract for
the command layer.
**Consequence:** the fixture directory becomes reviewable evidence (`{cmds → reply}` + identity
envelope + the redaction lists of DR-066), and TESTING.md §4's "redacted on write" is now enforced
by code on both ends rather than by convention. `recorder.ts` as PLAN named it does not exist —
the seam landed as `recording.ts` + `recorder-node.ts` precisely so the fs half cannot leak into the
browser entry; PLAN's §M12 box records the rename.
**Related:** DR-011, DR-017 (exchanges key by request id), DR-002; §5 rows 107 / 109.

### DR-065 — a live target is a set of independent consents; a loopback address is never consent by itself
The obvious guard — "host is loopback ⇒ must be the lab" — is false on this very project: the
**physical switch's** local eAPI is a unix socket plus `localhost:8080` plain HTTP, unauthenticated
priv-15 on the device itself (verified image evidence, DECISIONS open items). A developer with a
mis-set environment could write to real hardware through a guard that only checks the host.
**Decision:** `resolveLiveEnv(env)` composes independent gates, all of which must pass, none of
which can vouch for another: `EAPI_LIVE=1`; an explicit endpoint (profile inheritance is refused);
`EAPI_TARGET_CLASS=lab` — checked FIRST, so `prod`/`hardware`/blank refuses even when host and port
both spell lab; an allow-listed loopback HOST *and* the run-owned published port 8443 — so
`localhost:8080` (the physical switch's own port) is refused by the port gate **before** any
cleartext opt-in can reach the transport gate; the expected model + exact `4.28.14M` image version.
Refusals are **data** (`{ok:false, code, reason}`), never exceptions — a guard refusal is not a wire
condition (DR-010's taxonomy stays clean) — and no reason ever echoes a secret value, only the
variable name. The whole matrix — 27 distinct refusal codes — is unit-tested offline (injected env, zero real
`process.env`, 63 cases), and the tests were mutation-verified: disabling the target-class gate
fails 7 named cases. The known
over-strictness (`::1` never reaches the allow-list because a bare IPv6 host is parsed as host+port)
is deliberately NOT widened (§5 row 111): under-refusal is the dangerous direction.
**Consequence:** there is no env spelling this guard accepts that could address the physical switch;
DR-035's "lab class" plus a run-scoped published port is what makes an accidental `EAPI_PASS`
against real hardware unexpressible. Future gates follow the asymmetry rule recorded in row 111:
refuse-with-a-reason when unverified, and make every widening a deliberate, separately-reviewed act.
**Related:** DR-034, DR-035, DR-043, DR-032, DR-010, DR-011; §5 rows 110 / 111 / 114.

### DR-066 — every capture records its own evidence class, and the lifecycle proves it reached a device
A fixture with no provenance is a guess someone committed. DR-043 already forbids container
results from establishing hardware behaviour — but a rule nobody can check after the fact decays
fast, and the first harness run on this repo proved the failure is real: a published-port mapping
looked attached while every connect reset (30/30 ECONNRESET) — the docker-side "it's running" said
one thing and the device-side "eAPI answers" another.
**Decision:** (a) every recording/fixture carries a **metadata envelope** — `targetClass`,
`targetKind`, `imageTag` + `imageId` digest, exact `aristaVersion`, `modelName`, `runId`,
`capturedAt`, endpoint, TLS pin fingerprint, and explicit `redactionApplied` + `hardwareEvidence`
fields; the hardware field for a container capture states `none — … not DCS-7050TX-64 / 4.28.13.1M
evidence (DR-043)` **inside the file**, not in a README someone will stop reading.
(b) the filename path enforces the class split (`targetSlugFor` separates model from version, so
cEOS and hardware directories can never collide or merge). (c) readiness is proven through the
device's own answers, never the runtime's: TLS identity cross-checked endpoint-vs-container file
before an authenticated call; EOS polled through `Cli`, not `docker ps`; credentials random per
run, 0600 state, printed once; fixture writes refuse overwrite without `--fixtures-force`; teardown
label-verified and always — and post-reboot verification is part of the lane's definition of done
(this branch re-ran up→probe→down after a fresh boot, found the dual-network endpoint-selection
bug, and the fix comment at the patch site carries the isolation matrix).
**Consequence:** the nine committed cEOS captures are the repo's first real device evidence and can
be cited with class limits visible; the physical sweep (§3) stays visibly open — no container file
quietly answers it. Harness claims (readiness/cleanup/no-secrets) are checkable artefacts, and the
coin-flip mode of publishing multi-NIC containers is dead history.
**Related:** DR-043, DR-011, DR-035, DR-032; §5 rows 108 / 112 / 113.


---

### DR-044 — profile state is a value you pass, never a module global
Upstream keeps one process-wide `Config` (`client.py:127`) and mutates it through free functions
(`load_config` `:321`, `config_for` `:334`, `hosts_for_tag` `:352`, `connect_to` `:1040`), so two libraries in
one process overwrite each other's profiles and a test cannot isolate a profile set. Here `parseEapiConf` is
pure, `ProfileStore` is caller-owned, and the factories take the store as an argument; the file search lives in
`src/internal/eapi-conf.ts` with `exists`/`readTextFile` as parameters and is reachable only from `./node`.
**Consequence:** one extra argument compared with a pyeapi transplant, in exchange for 84 specs that never touch
a real filesystem and a DR-002 rule that stays structurally enforceable.
**Related:** DR-038, DR-002, §5 rows 54/55/58.

### DR-045 — an unreadable or malformed `eapi.conf` yields a report, never silence
`configparser` raises on the first bad line and pyeapi discards the whole file (`client.py:199-203`);
directories and unreadable paths disappear inside `configparser.read()`; and `BasicInterpolation` turns a
password containing a bare `%` into a crash — verified here: `100%` raises `InterpolationSyntaxError`, and
`p%%s` parses silently as the *different* value `p%s`. An operator hand-editing `/mnt/flash/eapi.conf` on a
switch gets no diagnostics at all. Here every rejection is a typed `ProfileIssue` with a 1-based line number
(blocking vs advisory), reading continues, duplicate sections merge first-value-wins, `[DEFAULT]` merging is
kept, and interpolation is off so `%` is data. A blocking issue makes the factory refuse the profile rather than
half-apply it. **Consequence:** three deliberate parse divergences (§5 rows 56-58), each pinned by a fixture —
including upstream's own five `eapi.conf` files, which still parse to the same values. Open item 10 captures a
device-written file so this can be compared against the image's own Python.
**Related:** DR-044, DR-046, §5 rows 56-58.

### DR-046 — transport spellings resolve through one table and fail before anything is sent
Upstream validates the transport name where a connection object is built (`make_connection`, def
`client.py:370`; unknown key ⇒ `TypeError('invalid transport specified')` at `:388-389`), applies
`DEFAULT_TRANSPORT` at `:452`, and has no alias concept at all. A browser bundle cannot open a Unix socket or a
switch-local loopback hop, and discovering that on the first request is exactly what DR-002 exists to prevent. So
every pyeapi spelling maps through M2's `TRANSPORT_ALIASES` to the typed `TransportKind`;
`acceptedTransportNames()` is **derived from that map** so the two cannot drift; and each entry point decides
which kinds it may build — the browser refuses `unix`, `http_local`, `https-client-cert` and `https-session` by
name (naming `./node`), Node keeps them inert until `allowLocalUnauthenticated`. `http_cache`, which pyeapi's
docs name, is recorded in MIGRATION §7 because upstream implements no such key. **Consequence:** one validation
path, a typed error before any socket exists, and pyeapi's own spellings (`socket`, `local_api`, `https_certs`)
keep working. **Follow-up:** wave-1 runtime validators (`assertInterfaceName`, `assertVlanId`) are M7's (#9) and
follow the same derive-don't-duplicate rule.
**Related:** DR-008, DR-014, DR-002, DR-009, §5 rows 55/59.

---
### DR-047 — session names are prefixed and endpoint-scoped, and the journal path is ours (M5 #7)
pyeapi fabricates `uuid4()` inside `configure_session()` and keeps it only in `Node._session_name`
(`client.py:1003-1006`, re-verified): nothing is sent, nothing is stored, and grepping the pinned tree for
`session_name` shows no other consumer. EOS keeps a pending session until something commits or aborts it,
so the one artefact a **restarted** client needs in order to clean up after a crashed one is exactly the
value pyeapi generates randomly and discards. **Decision:** `generateSessionName` builds
`ui-<host>-p<pid>-<hex8>` from `Transport#address` — hostname only, because an explicit port, path or
userinfo cannot be spelled in a token the CLI matches with `\S+`; userinfo is dropped so a generated name
stays secret-free (DR-011); no `p<pid>` segment where there is no process (a browser). `{ name }` still
overrides it. The prefix (`SESSION_NAME_PREFIX = 'ui-'`, spelled with its trailing dash) is also
`recoverOrphans()`'s default name filter, and `MAX_SESSION_NAME_LENGTH = 64` plus the unsafe-token refusal
exist because the name is spliced into `cmds[0]` of every batch — `x abort` would inject a second CLI
verb. This refines DR-022's sketched `arista-ui-<host>-<uuid8>` rather than contradicting it.
**Consequence:** sessions are recognisable in `show configuration sessions`, which is what makes an
operator willing to let the UI hold one; and the recovery file needs a location, so
`sessionJournalPath()` → `$XDG_CONFIG_HOME/arista-eapi/sessions.json`, else
`~/.config/arista-eapi/sessions.json`, exported as `SESSION_JOURNAL_PATH` from `./node` only (DR-002) —
a path **we** chose; EOS defines no such file, and it must never be described as one. Any EOS limit on
session-name length or charset is *referenced from the 4.28 image notes — NOT re-verified in this tree*
(`CliPlugin/SessionCli.py` is absent here), which is why the refusal message says the bound is ours and
open item 7 exists.

### DR-048 — the `ConfigSession` handle is a state machine that ends (M5 #7)
`abort()` is `_configure_session(['abort'])` and **leaves `_session_name` set** (`client.py:1023-1026`),
while only `_configure_and_exit_session` clears it (`:1028-1035`); because `_configure_session` prepends
`configure session <name>` (`:687`) and `config()` picks its callee off that one string (`:635-636`), a
later terminal write re-enters — or re-creates — a session the device has already destroyed. That is not a
wrong answer, it is a command written into a session nobody reviewed. **Decision:** (b) of the options
considered — each handle is terminal. `open | diffed | committed | aborted | lost`; the terminal verbs end
the handle and every later verb refuses with a `SessionError` **naming the state** (pyeapi's invented
`CommandError(-1, 'Not currently in a session')` at `:680-681` is not reproduced: `-1` is outside DR-010's
frozen set, so a caller could not `switch (e.code)` on it honestly). `exit()` deliberately sends **nothing**
and leaves the journal record, because the *device* still holds the session — that is the case
`recoverOrphans()` exists for. Re-attaching is an explicit `node.configSession({ name })`; pyeapi's silent
re-routing is not ported (§7). `assertNoSessionConflict`/`assertTerminalModeAllowed` refuse `configure()`,
`configureReplace()` and a second live `configSession()` on the same `Node`, realising the guard DR-025
planned.
**Consequence:** `diffed` is cleared by the next staged write (`diffed → open`, and
`hasDiffBeenRead()` goes false with it), so a Commit button cannot approve a diff that stopped being
current; one promise in the future transaction UI (M13 #15) owns one handle. Every promise-returning verb
is `async`, refusals included — `Node.configureReplace` had to change from a sync guard to an async one so
a pre-flight `SessionError` rejects like every other failure on the path instead of walking past a caller's
`.catch` (and leaving the `session.abort()` promise already built in front of it unhandled).

### DR-049 — the session journal: one interface, two implementations, allow-listed fields (M5 #7)
Neither pyeapi nor EOS keeps a session journal, and `olderThan`-style questions cannot be answered from
the device either, because the model `show configuration sessions` answers reports `state`,
`description`, `commitBy`, `completedTime`, `commitUser` and `instances` and **no start time** — that
field set is *image-note sourced* (`ConfigSessionModel.py` is absent from this workspace) and is exactly
what the §3 sweep captures; the TS type `ConfigSessionSummary` carries only those members and keeps the
raw reply in `raw`. **Decision:** a `SessionJournal` interface (`read`/`record`/`forget`) with two
implementations behind the entries the package already separates (DR-002): `FileSessionJournal` on Node,
exported only from `./node` at the path DR-047 defines, and `createWebStorageJournal(storage)` in the
browser over an injected storage object (so the spec runs without a DOM) under
`SESSION_JOURNAL_STORAGE_KEY`. Records are rebuilt field by field (`name`, `endpoint`, `startedAt`,
`pid?`, `description?`) — an unknown key is dropped, never copied — because the obvious
`JSON.stringify(record)` would carry an `enablePassword` from a JS caller straight onto disk (DR-011).
**Consequence:** `recoverOrphans()` reconciles journal **against** `listSessions()`, so a machine whose
journal was deleted or never written is still cleanable (DR-023's fallback stays real); `olderThan`
applies to journaled names only, and an un-journaled pending name has no age, so it is skipped rather than
guessed at — and `olderThan` without a journal aborts nothing. Corruption degrades to "no entries" with a
`console.warn`, never to a failed recovery. Only the Node half touches the filesystem, and in tests only a
temp directory.

### DR-050 — attribute every session claim, and never call a staged write a preview (M5 #7)
This milestone rests on a device we are not allowed to touch **and** on Arista's image, whose CLI-plugin
Python is not in this workspace (`SessionCli.py`, `ConfigSessionCli.py`, `ConfigSessionShowCli.py`,
`ConfigSessionModel.py`, `CliCommon.py`, `DateTimeRule.py` — `find` turns up nothing; the older DRs quote
them from an out-of-tree `Base.sqsh` extraction no reviewer can open). It is easy for names and comments
in this area to imply the device agreed. **Decision:** (b) of the options considered — ship the verbs and
label the evidence boundary in code, ledger and STATUS instead of laundering it: each §5 row states which
side was read (`pyeapi/…:LINE` re-opened, or "image notes, NOT re-verified here"), no CLI-plugin line
number is printed as fact, the unverified behaviours are STATUS §3 sweep lines with DECISIONS open items
5/7/8, and the tests pin **command lists and reply shapes** rather than device outcomes (the `commit
timer` `describe` title says the device semantics stay an open item on purpose). Extending DR-033's
promise: **no** `dryRun()` is exposed and `validateChanges` is documented as "the device applied these;
here is the per-command detail", since a real preview needs `verifyConfig` (M11 #13).
**Consequence:** `commitWithRevertTimer` and `configureReplace` ship with named gaps rather than not
shipping, and `confirmRevertTimer()` is named *as intent* (`ConfigSessionSummary.commitBy` tells a UI a
revert is armed; the client states nothing about what cancels it). A later sweep converts the gaps into
assertions instead of deleting capability a UI needs. Risk accepted: a reader may still over-trust a verb,
which is why the wording is repeated in USAGE §5 and in the code comments that make a claim.

### DR-067 — an interface name is read by one per-kind grammar, not by a prefix or one shared regex (M10a #12)
pyeapi answers "what kind of interface is this?" twice and wrongly both times:
`isvalidinterface` is an **unanchored** `re.match(r'([EPVLM][a-z-C]+)', value)` ∩ `VALID_INTERFACES`
(`interfaces.py:81-83`, `:71-78`) called only from `marshall` (`:129-133`, the dispatch DR-006 drops), and
`stp.py:346-363` re-derives the same answer from `value[0:2] in ['Et','Po']`. M7 shipped one compromise
regex (row 76) whose own doc promised M10 would replace it. **Decision:** one grammar table
(`INTERFACE_GRAMMAR` in `src/resources/validators.ts`), fully anchored, one row per kind, returning a
discriminated union `{ kind, index, name, subinterface? }`; only Ethernet and Port-Channel have the `.<n>`
arm, because those are the two kinds upstream lets carry a suffix at all (`:271-277` plus its own
`interface Ethernet48.2044` fixture header, `running_config.text:1468`). Reading is total and write-side
guards are opt-ins over the same answer: `parseInterfaceName` never throws (a reader needs to be able to
report a header it cannot parse), `isInterfaceName`/`assertInterfaceName` add "and no suffix" —
**keeping M7's/M9's refusals exactly where open item 7 is still uncaptured**, so widening the guard is a
one-line change after a capture, not a parser rewrite. An index or suffix that cannot survive
`Number.isSafeInteger` fails the **parse** rather than answering partially (DR-059's no-invention rule),
while a legal-but-out-of-range index (`Vlan9999`) stays a valid *name* — the id guard is a different guard
on a different verb (DR-053). **Consequence:** a consumer switches on `kind` instead of re-testing
prefixes, so M10b/M10c add fields, not new routing rules; a `Peer-Ethernet1` or `Ethernet1/1` header is a
parse miss rather than a wrong kind. Risk: the six kind names are still upstream's list, not an EOS 4.28
claim (open item 1's class of problem), and the code says so. §5 rows 100 / 103.

### DR-068 — a resource models per-kind **fields**, never per-kind **objects** (M10a #12)
Upstream's `Interfaces` facade hands back a different Python class per interface
(`INTERFACE_CLASS_MAP` `interfaces.py:1093-1097`, `get_instance` `:120-127`) and stamps the answer with
`type` — the name of the class that answered (`:174`, `:361`, `:609`, `:851`) — which is why `Vlan1`,
`Loopback0` and `Management1` quietly fall through to `BaseInterface` while `Ethernet1` reaches
`EthernetInterface` only through `__getattr__`/`marshall` (DR-006's dropped path). Copying that shape into
TS would mean a union of classes plus a runtime cast at every call site. **Decision:** one
`Interface` record whose `kind` field says what the **name** is (DR-067's parse), read the same way for
every kind today; the behaviour that genuinely differs by kind becomes a statement in the verb
(`assertPresentName` refuses an Ethernet create/delete and names M10b as the owner;
`assertEncapsulationName` requires a suffix-capable kind), and per-kind **fields** arrive as optional
record members in M10b/M10c rather than as new objects. **Consequence:** `get()`/`getAll()` can never
disagree, a UI table gets one type, and a name this client cannot parse still keeps its row with
`kind: null` — a device fact (the switch has that section) rather than a silent drop. Cost stated: the
shared field set means an Ethernet record today looks like every other one, which is *less* specific than
upstream's M10b answer; `interfaces.ts` divergence 2 pins that the fields, not the label, are what M10b
adds. §5 row 100.

### DR-069 — a recording outranks a guess: captured field spellings are read first, and any fallback is labelled (M10a #12)
`show interfaces status` is the first command this client reads whose **own** JSON has been recorded rather
than inferred — and the guess was wrong in a way nothing else would have caught: the reader shipped with
pyeapi's vendor-shipped `test/fixtures/show_interfaces.json` spellings (`interfaces` / `interfaceStatus` /
`hardware` / `mtu`, which belong to the **sibling** `show interfaces` command), while the cEOS-lab 4.28.14M
recording (`test/fixtures/live/ceos-4.28.14M/show-interfaces-status.json`, PR #29) answers
`interfaceStatuses` with `linkStatus`/`lineProtocolStatus`/`description`/`bandwidth`/`duplex`/
`interfaceType`/`vlanInformation` and **no** `mtu`, `hardware` or `interfaceStatus` key at all. Read in the
guessed spelling, every real device answer silently yields an unenriched table — the failure DR-043 warns
about, one level down. **Decision:** every such reader names its sources in a **capture-ordered list**
(`STATUS_ROW_MAP_KEYS`, `STATUS_LINK_COLUMNS` here): the recorded answer for this exact command first, a
sibling-command spelling only as an explicitly-labelled fallback. A column present in neither capture is
not read, and a same-sounding key is never substituted (`interfaceType: "EbraTestPhyPort"` is a PHY name,
not `hardware: "ethernet"`); a wrong-typed column reads absent rather than `0` (row 105's discipline).
Nothing is concluded about the target from a container answer: the capture itself carries
`hardwareEvidence:"none"` (DR-043/DR-066) and §3 keeps the 7050TX spelling open. **Consequence:** merging
a capture forces a re-read of the readers that had guessed — that check is now part of landing M12
fixtures, and each spellings list cites the file it came from, so a reviewer can open the evidence.
§5 row 106; `interfaces.ts` divergence 12.

---

## Open items (need the device)

Use cEOS first for software behavior and schema exploration, recording its model/version;
repeat target-sensitive checks on the physical 7050TX-64 / 4.28.13.1M. The physical
read-only items can be swept with `runCmds`; items 5, 7 and 8 need a separate authorized scratch
config session and are **not read-only**:

1. `modelName` exact string on this unit (`DCS-7050TX-64` vs `-SSD`) and `version`; drives DR-032.
2. `show license features` + `show license all` + ArToggle state: whether VXLAN / VRF routing / MLAG are
   licensed on this SKU (decides whether `VxlanInterface` belongs in wave 3 or never — DR-004).
3. `show management api http-commands` + `show management api http-commands https certificate`:
   TLS versions/ssl-profile support (7050TX is ALE-era; `DEFAULT_TLS_PROTOCOLS = ['1.0','1.1','1.2']`
   in `HttpServiceConstants.py:44` looks stale but unconfirmed), and whether the intended config style
   uses `management api http-commands` or `management http-server` (mutually exclusive — DR-036).
4. Does `switchport trunk group` exist on this SKU (DR-028) and what does
   `show interfaces switchport json` actually return?
5. `configure session <name> commit timer <hh:mm:ss>`: semantics of the confirming second `commit`
   (python layer verified, native `ConfigAgent`/`libCliSession` not inspected — DR-022).
6. `features.md` is titled "Supported Features — Arista **7050X**" and carries FlexProfile footnotes,
   while the hardware is **DCS-7050TX-64** and this build exposes ALE `hardware tcam` /
   `system profile` instead. The feature matrix needs re-deriving from the correct SKU page — affects
   which modules ever get promised to the UI.
7. **Interface-name grammar on this unit** (DR-053): `assertInterfaceName` accepts exactly the six kind
   spellings pyeapi's `VALID_INTERFACES` lists (`interfaces.py:71-78`) plus an all-digit index. Unverified
   on the 7050TX-64 / 4.28.13.1M — and refused here rather than guessed — are subinterface forms
   (`Ethernet1.100`), slot/chassis numbering, `Peer-Ethernet`, and whether MLAG/Fabric endpoints imply a
   kind upstream omits. Needs a `show interfaces description` (or equivalent) capture from the M12 (#14)
   sweep; M10 (#12) will widen the parser to the discriminated union PLAN asks for only once that
   evidence exists. Same class of open identifier question as item 1's `modelName`.

7. **Config-session name grammar on the 4.28.13.1M target and in cEOS** (DR-047): the longest
   `configure session <name>` EOS accepts and the character set it matches. `MAX_SESSION_NAME_LENGTH = 64`
   and the unsafe-token refusals are **this port's** bounds, chosen because the name is spliced into
   `cmds[0]`; they are not a captured device limit, and `CliPlugin/SessionCli.py` is not present anywhere
   in this workspace to read the parser from. Decide by capturing `show configuration sessions` after
   attempts at the boundary, not by reading our own constant back as evidence.
8. **Sessions grammar and which verbs answer `1002` where** (DR-050): `configure session <name>
   description <d>` — how deep the quoting goes, and what an embedded `"` does to the one-token rule this
   port's `quoteDescription` assumes; `configure session <name> no-commit` — accepted, or refused with
   `1002`/hidden-and-therefore-unusable over eAPI; and `copy running-config startup-config`,
   `rollback clean-config [ { <configGroups> } ]` and `rollback <name>` on the 7050TX-64 (platform
   dependency of exactly the kind DR-042 warns about). Add a related known-unknown: whether
   `show configuration sessions` reports `maxOpenSessions`/`maxSavedSessions` and any start-time field,
   since `olderThan` and the "pending sessions consume the cap" reasoning in DR-023 both currently rest
   on image notes. Capture each answer as a fixture in `test/fixtures/show/` during M12 (#14) **before**
   M13 (#15)'s transaction UI offers the verbs.

MLAG (`mlag` module, 21 upstream system tests): investigate supported control-plane
behavior in an isolated two-node cEOS topology. Physical 7050TX-64 MLAG/forwarding
validation still needs a second physical device; do not mark it verified from containers.

10. **The operator's own `eapi.conf` on the target**: does `/mnt/flash/eapi.conf` exist on the 7050TX-64 (and
    in cEOS), and which keys and transport spellings does it actually carry? DR-045's report and DR-046's alias
    table were written against this machine's `configparser` and pyeapi's fixtures — capture the device file in
    M12 (#14) and diff both against the image's own Python before claiming parity for hand-edited device files.
