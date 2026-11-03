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
Numbering note (M7, #9, 2026-11-03): DR-001..043 are on `main`/PR #23. The bands reserved across the
branches stacked on PR #23 are DR-044..046 = M3 (#5, PR #24, not in this tree), DR-047..050 = M5 (#7,
agents/issue-7-m5-config-sessions, not in this tree), DR-051..054 = M7 (#9, below). DR-003 and DR-031
are not gaps — both exist above — but no entry in this log is ever renumbered, so the bands stay
visible here rather than in a table (this file has no index section; the milestone index is
STATUS.md §1 and the decision-to-milestone trail is each entry's `Related:` line).
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

---

## Open items (need the device)

Use cEOS first for software behavior and schema exploration, recording its model/version;
repeat target-sensitive checks on the physical 7050TX-64 / 4.28.13.1M. The physical
read-only items can be swept with `runCmds`; item 5 needs a separate authorized scratch
config session and is **not read-only**:

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

MLAG (`mlag` module, 21 upstream system tests): investigate supported control-plane
behavior in an isolated two-node cEOS topology. Physical 7050TX-64 MLAG/forwarding
validation still needs a second physical device; do not mark it verified from containers.
