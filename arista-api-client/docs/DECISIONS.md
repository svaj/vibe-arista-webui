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

> **Status 2026-11-08: RESOLVED by DR-127** — the default stands; see that entry for what was settled and
> what stays open (publishing itself).

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

### DR-075 — a Port-Channel's members are read from the config relation, and the live `show` scrape stays a separate verb (M10b/M10c #12)
`get_members` (`interfaces.py:660-675`) is a text scrape: group id taken from the Port-Channel **name**
(`:671`), `show port-channel <id> all-ports` in `format:'text'` (`:672-673`), then
`re.findall(r'\b(?!Peer)Ethernet[\d/]*\b', …)` over the output (`:674-675`). Upstream treats that scrape as
the **fact** — `get` stamps it into the record (`:611`) and `set_members` diffs against it (`:700`) — so on
a unit without the command, or against a malformed reply, or for a member the scrape drops, the answer
silently becomes "no members", and the dropped member's own `channel-group` line is never removed by the
diff that believes it was never a member. **Decision:** the record's `portChannel.members` comes from the
members' own `channel-group <id> [mode <word>]` body lines, harvested across sections in one pass
(`interfacesFromSections`, deduped in device order) — the same config text upstream's `get_lacp_mode` already
greps per member (`:655-658`), so this stays upstream's source of truth for the relation while dropping the
scrape's fragility. The scrape itself is **also** ported, as the verb `getMembers`, with the look-around kept
verbatim (`membersFromOutput`) so an M-LAG `Peer-Ethernet` line can never become a member: "what the switch
reports right now" and "what the running-config declares" are two facts and a UI is allowed to see them
disagree — which is why neither is derived from the other. A scrape result this client's grammar cannot name
(`Ethernet1/1`) is returned as-is and then fails the write guards, so a member can always be removed but
never silently mis-composed. **Consequence:** `getAll()` answers the membership question with one config
read and no `show`, `getMembers()` is the only way to ask the device, and M12 (#14) still owes how
4.28.13.1M spells that show's output on the 7050TX-64 (the pinned scrape shapes are pyeapi's own fixture
text, DR-043/DR-069's caveat). §5 row 125; `interfaces.ts` divergence 15.

### DR-076 — absence outranks upstream's invented defaults on every new read (M10b/M10c #12)
The Port-Channel readers answer a question the device never answered: `_parse_minimum_links` returns `0`
when there is no `port-channel min-links` line (`interfaces.py:618-624`), `_parse_lacp_fallback` returns
`DEFAULT_LACP_FALLBACK` (`'disabled'`, `:625-631`, `:68`), `_parse_lacp_timeout` returns
`DEFAULT_LACP_FALLBACK_TIMEOUT` (`90`, `:632-638`, `:69`), and `get_lacp_mode` returns
`DEFAULT_LACP_MODE` (`'on'`) for a group with no members (`:651-653`). Upstream's own `test_get`
(`test_api_interfaces.py:318-326`) proves the confusion is load-bearing, because the fixture it pins against
writes the **negations** `no port-channel min-links` (`running_config.portchannel:18`) and
`no port-channel lacp fallback` (`:19`) — a device that turned a value off and a device that never mentioned
it both come back as a value. **Decision:** every M10b/M10c read answers `undefined` for an absent line, and
`no`/`default` forms are never read as a value — `valueAfterKeyword` anchors at the keyword (row 91), and
`lacpFallbackFromBlock` additionally skips the `port-channel lacp fallback timeout <n>` line, since the
timeout **is** the fallback keyword's sub-command and the fixture's `:19`/`:20` pair is exactly that case.
The reads are total: a non-decimal value is a `ConfigParseError` naming the section rather than a truncated
`int()` (`ipinterfaces.py:126`'s habit, DR-059). sFlow is the same decision one field over: upstream's
`'no sflow' not in config` (`:367-380`) fabricates `true` from an absence, so the field is read as exact
`sflow enable` / `no sflow enable` command lines instead — the same three-answer shape as DR-027 fixed for the
administrative state — and a `no sflow` pair is never answered as the **fabricated** `true` upstream gives a
section with no line at all; the `false` half of an explicit `no sflow enable` is reported, never invented
from silence. **Consequence:** a UI can tell "off", "not configured" and "the device did not say" apart, and
what the EOS defaults actually are stays an M12 (#14) capture (open item 1, DR-057) instead of being adopted
as a client-side constant. §5 rows 126 / 127; `interfaces.ts` divergences 13 / 16.

### DR-077 — an invalid verb argument is a refusal, never a `False`, a message-less `ValueError`, or a command the device will misparse (M10b/M10c #12)
Three upstream styles coexist in this slice: `ValueError('invalid flowcontrol value')` (`:513-515`) and
`ValueError('invalid direction specified')` (`:517-518`); a **bare** `raise ValueError` with no message on
`set_sflow` (`:542-543`); and `return False` — silently — for an unknown LACP mode (`set_lacp_mode`,
`:731-732`, pinned non-raising at `test_api_interfaces.py:424-427`) or an unknown fallback mode
(`set_lacp_fallback`, `:787-788`, `:371-373`). A fourth case has no answer at all: with no `mode` argument,
`set_members` interpolates `get_lacp_mode`'s `None` into `channel-group 1 mode None` (`:712-714`), and the
suite pins **that text** as expected behaviour (`:404-409`). **Decision:** all of them become
`NotSupportedError`s naming what upstream did (DR-005 deletes the boolean, DR-010 requires a message,
DR-053 puts the guard in the verb), and the three refusals that buy real safety are: an unknown `mode`
argument (DR-079), a `setMembers` call that has no mode to write and nothing readable to reuse — refusing
outranks sending a token whose effect on a LAG is undefined — and `setLacpFallback`'s `'disabled'`, which is
a *negation*, so it is the verb `unsetLacpFallback` and not a mode string that happens to read as one
(DR-037); `setLacpFallback('Port-Channel1', 'disabled')` composes nothing — it refuses **before** any
request, which is the shape DR-053's guards exist to guarantee. The same row also deletes the `default`/`no`
arms' ambiguity rather than reproducing it. **Consequence:** every bad-input test in this lane asserts
**zero** requests reaching the device, and the refusal texts quote upstream so a reader can tell a
client-side rule from a device rule; pyeapi's exception pins cannot be ported as-is because
`eapi_exception_config_test` ignores its own `cmds` argument (`testlib.py:121-123`). §5 rows 128 / 129;
`interfaces.ts` divergences 17 / 19.

### DR-078 — a release floor is compared as numbers, and an unclassifiable release composes no command (M10b/M10c #12)
`set_vrf` decides which keyword to send with `if self.version_number >= '4.23'` (`interfaces.py:568`, arms at
`:569-575`) — a **string** compare of the device version, so `'4.9' >= '4.23'` is true character-wise and a
4.9-era box is handed the 4.23 keyword, while `'4.100…'` compares below `'4.23'` although 4.100 is a later
release. Upstream's suite cannot surface the bug because the mock node pins `'4.17.1.1'`
(`test/lib/testlib.py:81`), the only arm it exercises being `vrf forwarding testvrf`
(`test_api_interfaces.py:297-302`). **Decision:** keep the two command texts verbatim and fix only the
comparison — `vrfKeyword()` asks `Node.getVersion()` (the DR-035 memoised `show version`) and compares the
leading `major.minor` **segments numerically** (`versionFloorCompare`); 4.9 < 4.23, 4.23 ≤ 4.28. A version
with no leading `major.minor` (an engineering build that does not start with digits, or a device that will
not answer `show version`) is **refused**, not defaulted to either arm: guessing which VRF syntax an
unnameable device accepts is exactly the claim DR-032/DR-057 forbid. **Consequence:** a VRF write costs one
memoised version read per `Node`, not per verb; both sides of the floor are pinned in the suite; and whether
the two keywords are interchangeable — or which one the v4 image this build runs actually wants — stays with
the device, so the `CommandError` arm is pinned and M12 (#14) owns the capture. §5 row 131;
`interfaces.ts` divergence 18.

### DR-079 — the channel-group mode is validated where it is captured, so one type covers the wire, the record and the arguments (M10b/M10c #12)
Upstream's mode is an unvalidated string at every step: `get_lacp_mode` hands back `re.search(...)`'s
`(?P<value>.+)` group from **one** member and returns inside the first loop iteration, so a second member is
never examined and a first member with no `channel-group … mode` line crashes on
`re.search(pattern, None)` when its block is missing (`:655-658` + `abstract.py:96-101`); its only write-side
check is `set_lacp_mode`'s `return False` (`:731-732`), while `set_members` (the verb the UI reaches through
its diff and its side call — DR-080) accepts any value and interpolates it into
`channel-group %s mode %s` (`:712-714`). **Decision:** validate the token **at the capture site**
(`readChannelGroupMode`): a section body line reading `channel-group 1 mode fast` fails the whole table read
with a `ConfigParseError` naming the section — because `getAll()` builds a typed record, and publishing a
mode this client's own verbs refuse is a promise of consistency that does not hold. `LacpMode`
(`active`/`passive`/`on`, the trio at `:731`) is then the single type of the record field, the harvested
group facts, the lookup answer `getLacpMode()` returns and the argument `setLacpMode()`/`setMembers()` take —
so a wrong type cannot express `mode None` at all (the type-system half of DR-010/DR-077). `getLacpMode`
scans **every** member for the first mode-bearing line and answers `undefined` when none names a mode
(no `DEFAULT_LACP_MODE` invention, DR-076). **Consequence:** one device typo is visible as one named parse
failure instead of a table that agrees with the next `setLacpMode` about a mode that does not exist, and the
type is narrower than the device's possible output on purpose, with the overflow reported rather than
published. §5 row 129; `interfaces.ts` divergence 19.

### DR-080 — a verb that performs writes on the way to its own answer keeps them as separate, pinned transactions (M10b/M10c #12)
`set_members` is where those verbs live. Upstream's copy
(1) asks the device for the members, (2) reads the mode from the candidates, and, when a mode is supplied and
differs, (3) performs its own remove-and-re-add rewrite before applying the diff. Upstream's single test
sees only the last call, so each side effect is invisible in review. **Decision:** port the side effects
faithfully — the rewrite stays a distinct
operation between the read and the diff rather than being folded into one batch — because collapsing
them into a single transaction would be this client inventing a device behavior that upstream, and
therefore the operator, does not expect. Each side effect is visible in the recorded `callArgs`; the
diff-then-rewrite ordering is not reordered silently. **Consequence:** a UI that calls
`setMembers` must expect more than one round trip, and the test suite's
per-side-effect pins are what keep a future "optimization" from quietly merging them —
M12 (#14) will say whether an operator should be warned that a mode change briefly removes every
member's LACP configuration. §5 row 130; `interfaces.ts` divergence 20.

---

### DR-081 — a live write is applied only through a named session that aborts on failure and never persists (M12a #14)
The `*.live.test.ts` port of the pyeapi system tests reaches the point where a mutation must actually run
on a device, and DR-035's write half — *named session, abort-on-failure, no `copy run start`* — was the part
`src/testing/live-guard.ts` did not yet encode (it gates the endpoint and the scratch-interface name, not
*how* a write lands). pyeapi makes this easy to get wrong: `configure_session()` is a lazy anonymous `uuid4`
(`client.py:1003-1006`), there is no `finally`-style rollback in its system tests, and its `abort()` never
clears `_session_name`, so a later call *re-creates* the session EOS already destroyed (row 63). **Decision:**
one helper, `runGuardedLiveWriteSession(node, {name, commands, description?})` in `src/testing/live-session-policy.ts`
(browser-safe, DR-002): the session **name is required** (DR-022/DR-047 — a live write an operator cannot
name is one they cannot abort by hand after a crash); `commands` is passed as **data**, not an open callback,
so `assertNoPersistenceCommand` inspects every command *before* the first byte is sent (the reason the
persist ban is enforceable rather than advisory); the sequence is `configSession(name)` → `run` → `commit`,
and an **`isOpen`-guarded `abort()` in a `finally`** does the rollback — the `isOpen` test is what makes the
rollback unconditional without re-aborting a handle already terminal (`committed`) or already dead (`lost`),
which the state-machine would have thrown on and hidden the real error. `commit()` is called **without**
`{persist:true}` (DR-024), closing DR-035(c). **Consequence:** every scratch-port live write in this lane
(switchports default/switchport/no-switchport/mode, interfaces description) goes through it, and the same
object is unit-tested offline (§5 rows 137-140). Cost: a write test cannot take an arbitrary callback, which
is the point — smuggled persistence then cannot happen.

### DR-082 — a port that is not an `Ethernet…` scratch name is never a live write, so whole upstream families are skipped rather than faked (M12a #14)
The pyeapi system suite is not "60 read tests": almost every case is **read-after-write on a name the run
chose by convenience** — `random_interface(dut)` for switchports, `random_int(2,4094)` VLANs, and
`Loopback0`/`Port-Channel1`/`Vxlan1`/`Management1`/`Vlan1234`/`Ethernet1.1` for interfaces. DR-035(b) allows a
live write on **exactly** `EAPI_SCRATCH_INTERFACE` (which `requireScratchInterface` pins to an `Ethernet…`,
`docs/CEOS.md:131`), and there is deliberately **no** `EAPI_SCRATCH_VLAN`/`..._PORTCHANNEL` gate in
`live-guard.ts`. **Decision:** do not widen a guard, invent a scratch-VLAN, mutate a LAG/loopback/mgmt port,
or pad the port with no-op read copies to hit a "~60" number. Port the genuinely write-free reads
(`vlans.get(1)`, `getAll()`, `interfaces.getAll()` incl. `Management1`, `system.get()` at key/type level) plus
the writes whose target *is* the named scratch Ethernet port, and record every skipped method with its reason
in the file's JSDoc ledger (a per-file table: off-limits name / global write / client-side refusal that never
round-trips / fixture-owned field). **Consequence:** the honest per-file counts are small (system 1/20,
vlans 2/15, switchports 2 reads + write-integration/8, interfaces 2/~48) and stated as such rather than
inflated; a reviewer can see which behaviours remain offline-only vs. device-touched. Risk noted: it means the
live lane does **not** exercise random-VLAN or LAG writes at all — those stay DECISIONS open items and offline
tests, which is the safer reading of DR-035, not an oversight.

### DR-083 — `MockTransport` scripts full joined session command lists, because an opener-only key silently never matches (M12a #14)
The policy helper's *only* offline proof that it aborts-but-does-not-persist depends on the exact command
arrays a config session puts on the wire, and `MockTransport.matches` (mock-transport.ts, `texts.includes(match) || texts.join('\n') === match`)
has a trap that has already cost this project time: an entry keyed `configure session <name>` matches the run
batch **only if that whole string is one list element** — but a session batch is
`[enable, configure session <name>, …tail]`, so the opener sits inside a longer list and an opener-only key
never matches → the request falls through to `NotSupportedError` with no scripted answer. **Decision:** every
script key in `live-session-policy.test.ts` spells the **full `\n`-joined list**, `enable` and the opener
included, with **separate** keys for the `…\ncommit` and `…\nabort` round trips (they are distinct batches,
each re-entering the session). A `wireKey(name, …tail)` builder makes that join once per test so the intent —
which operation — reads off the assertion, and the exact-spelling hazard cannot be re-introduced case by case.
The failure modes this pins are precisely the ones DR-035(c)/DR-023 care about: a `copy run start` in the batch
is refused with `transport.sent() === []` (guard before wire); a device `1002` **with** `errorDetail` leaves the
session `open` so the `finally` abort reaches the device; a `1006` `lost` commit must **not** re-abort (the state
machine already killed the handle). **Consequence:** the helper is falsifiable offline; live CI still owns the
one real-cEOS confirmation. This is the DR-035 write policy expressed as a *command list*, not prose.

### DR-084 — one bounded real-cEOS validation consumes the lab lane as-is and is reported, never worked around (M12a #14)
M12 (#14)'s PLAN box that stayed open through the guard/fixture/harness rows is "the live lane provably runs
*once*". This lane must prove it without owning the harness — `scripts/ceos-lab.mjs`, `docs/CEOS.md`,
`.github/workflows/ci.yml` and every `package.json` script entry belong to the sibling CI lane. **Decision:**
run the documented sequence verbatim from the repo root (`lab:up` → `lab:probe`, which prints the 0600 state
file and cross-checks the published endpoint's TLS fingerprint against the container's `capi.pem` → the eAPI
child → export those vars plus `EAPI_TARGET_CLASS=lab` and a **real, exposed** `EAPI_SCRATCH_INTERFACE` →
`test:live -w arista-api-client`), bounded to ~15 min, and **always** `lab:down` afterwards (verified by
`lab:list` showing zero leftovers), *including on failure*. If any gate refuses the run — the scratch
interface doesn't resolve, the readiness/version cross-check fails, the harness errors — the exact message is
reported to the orchestrator; the guard is **never** loosened, no lab script edited, no fixture force-written,
no fallback to a physical switch (DR-043/DR-066). **Consequence:** a pass says "the guard + transport +
resource reads + the DR-035 write helper all executed against real EOS 4.28.14M, and the container was torn
down"; a non-run or partial run says which gate said no and why, and is *not* dressed up as coverage. Container
results settle software behaviour only (§5 row 141); the DCS-7050TX-64 sweep stays open.

---

### DR-085 — a fixture refresh is a consent-gated chain over a run it owns, never a flag on probe (M12b #14)
PLAN §M12 owed "a `fixtures:refresh` npm entry (the capability exists as `lab:probe`'s guarded
fixture writes + `--fixtures-force`)". Exposing that capability as `probe --fixtures-force` again
would be the wrong shape: probe presumes someone already started a lab, and a refresh is a whole
lifecycle — start a disposable node, read it, throw it away — whose output is a **committed,
reviewed** device capture (docs/CEOS.md: "Refresh is explicit and reviewed"; DR-066 makes the
provenance envelope the thing a reviewer reads).
**Decision:** `npm run fixtures:refresh` runs `scripts/ceos-lab.mjs fixtures`, one chain
(up → probe-with-captures → down) whose `runId` is generated BEFORE `up` so the teardown names the
run this call owns on every path, including the one where `cmdProbe` throws on a version/model
mismatch. Consent is checked first, so a refusal cannot have side effects: exit 2 with no `docker
image inspect`, no container, no network, no eAPI request — a property that is *provable offline*
(a tripwire `docker` on `PATH` printing `DAEMON-TOUCHED` for any call stayed silent). The refusal
quotes what it would have done (capture count, target dir, endpoint shape) rather than asking again.
`--yes` implies `--fixtures-force` **and nothing else**: row 112's path guard still refuses any write
outside `fixtures/live/ceos-<version>/` with exit 3, so the refresh cannot be aimed at a hardware
recording (DR-043), and `fixtures --no-fixtures` is a contradiction, not a no-op. A teardown problem
turns a completed refresh into exit 9, because a leaked privileged container is not a successful run.
**Consequence:** there is exactly one way to rewrite the cEOS captures, and it names itself in the
diff review; CI's live job runs `--no-fixtures`, so no scheduled run can author committed evidence.
The rest of the refresh loop (running it for real, and reviewing 9-file diffs) stays a trusted-host
human act. **Related:** DR-066, DR-043, DR-035, DR-032; §5 rows 112 / 143.

### DR-086 — the live lane's green is asserted on the printed summary, not on the exit code (M12b #14)
DR-034's local convention is that an unconsented `test:live` prints a reason, skips everything and
exits **0**. That is right for a dev shell and is the single most dangerous thing to inherit into a
requested cEOS job: docs/CEOS.md requires failing on "missing image, credentials, readiness, trust,
target mismatch, **zero executed tests**, or teardown failure", and TESTING.md §8 already notes
`passWithNoTests: false` cannot detect an all-skipped suite. So `vitest run --project live` exiting 0
carries no information, and a CI step that only checks it manufactures coverage out of nothing.
**Decision:** `scripts/assert-live-run.mjs` reads the captured vitest output and asserts on the
summary Lines themselves: a missing `Tests` line is a failure (a crash, or the harness refusing
before the child started, looks identical to green if only the code is consulted); any failed test or
file fails; `passed == 0` fails with an explicit all-skipped reason; and **any** skip fails, because
in this lane a skip is a guard refusal (DR-065) or an unported case (TESTING.md §5), never acceptable
evidence. Counts are parsed as `<n> <word>` pairs rather than a fixed sentence, so a reporter wording
change shows up as a missing-summary failure instead of a vacuous pass. The skip/refusal lines found
in the log are printed, so the failing job explains itself before teardown destroys the evidence.
**Consequence:** the live job can only be green if device tests executed, and the rule is testable
offline: it was run against two real `vitest --project live` logs (unconsented → exit 1, executed
wiring proof → exit 0) plus synthetic failed/mixed summaries. Local `npm run test:live` keeps DR-034's
leniency untouched — the strictness lives at the CI boundary, which is where the misunderstanding
would otherwise land. `--min-passed` exists so a deliberately narrow dispatch can be honest about how
narrow it is. **Related:** DR-034, DR-065, DR-043, DR-066; §5 rows 114 / 144 / 145.

### DR-087 — the Node floor is a claim about the artifact, so it is proved on the artifact (M12b #14)
`engines.node >= 20` (DR-021) has never been exercised: M0's CI matrix had to become **22/24**
because vitest 5.0.5 (`^22.12.0 || ^24.0.0 || >=26.0.0`) and jsdom 30 die inside Node 20 — a toolchain
limitation that says nothing about the shipped bundle, and left the floor claim unmeasured. Running
the offline suite on 20 was never possible; deleting the floor would have been the usual silence.
**Decision:** the claim is tested where it is made. A `dist-node20` job runs only
`npm ci && npm run build && node scripts/dist-smoke.mjs`; the smoke has no dependencies of its own and
imports `dist/index.js` / `dist/node.js` by path, so dev tooling is a fixture of the job, not its
subject (vite/oxlint/rolldown/plugin-react all accept `^20.19.0`, the patch line `node-version: 20`
installs). What it checks is what the floor actually depends on: the entries' **relative chunk
specifiers resolve on disk** (a build/publish split that strands the shared chunk is an ESM resolution
crash on precisely the runtime the dev tooling never reaches), `./node` still is a superset of
`./index`, both entries share one `Node`/`EapiError` class, DR-002's browser refusal of
`kind: 'unix'` survives bundling, `createNode` wires the endpoint with no I/O, redaction and the
recorded cEOS spellings parse from the artifact. "No device" is mechanical, not a comment: `fetch`
and `http(s).request/get` are replaced by throwing tripwires before the import, and the floor itself
is read out of `package.json` so a runtime below it exits 1 instead of passing vacuously.
**Consequence:** the PR-safe half of M12's CI box is real and offline (header contract intact, now
explicitly scoped to push/PR jobs), and the coverage gate lands beside it as a step whose **exit code
is the assertion** — the per-directory thresholds in `vitest.config.ts` stop depending on someone
remembering to run `npm run coverage`, and the node-22-only artifact is uploaded with `!cancelled()`
so a threshold miss still ships the report showing what is uncovered, with
`if-no-files-found: error` so a run that produced no report cannot look green. Node 20 itself remains
CI-only: no 20.x runtime is installed on the lab machine and pulling an image is out of lane.
**Related:** DR-021, DR-002, DR-039, DR-066; §5 rows 145 / 146.

### DR-088 — a CI artifact never carries a lab credential: suppress at the print site, then scan at the boundary (M12b #14)
The harness prints each run's credentials once — deliberately, in `up`'s JSON, because the operator
needs them (DR-066). Under CI that same stdout is teed into a log that becomes a downloadable
artifact, so the feature becomes the leak, and docs/CEOS.md's "Archive only redacted diagnostics" has
no enforcement behind it. Deleting the print would hurt the manual recipe; hoping nobody uploads is
not a control.
**Decision:** two independent layers, both cheap enough to keep forever. (a) `--quiet` replaces the
value at the **print site** with a placeholder pointing at the 0600 state file, which remains the
only copy and is deleted by teardown; default stays un-suppressed so the operator recipe is
unchanged. (b) `scripts/assert-live-run.mjs --check-secrets` scans the log for credential-shaped text
and fails the job — and the upload step is gated on that step's success, so an unscanned log can never
be published. The scan reports the **pattern name and line number only, never the value**, which is
live-guard's refusal discipline (DR-065) applied to artifacts, and its patterns are written against
this repo's own safe output: `<withheld: --quiet>`, `<redacted-lab-secret>`, `user=eapilab…` and
`EAPI_PASS_VAR=EAPI_LAB_PW` must not match, while a literal `"secret": "…"` must.
**Consequence:** artifact hygiene is a check with both directions tested offline (a planted credential
fails; a quiet-shaped log with placeholders and correct variable names does not). A future lane that
prints something new is caught by the scan rather than by review, and a leak forces a re-collect
rather than a silent scrub. **Related:** DR-011, DR-065, DR-066, DR-013; §5 rows 109 / 147.

### DR-089 — local-user reads report a secret's format, never the secret (W2a #35)
pyeapi's `Users.get`/`getall` return the configured secret **text** — its read path puts the hash
straight out of `username … secret …` into the caller's dict (`users.py:145`; the pinned fixture's
values at `running_config.text:356-361`), and the docstring treats `format`+`secret` as ordinary
fields. This client's reads answer a **browser**: a webui table built on `node.users.getAll()` would
render, cache and re-log whatever the switch stores, and a `cleartext` (`secret 0 …`) user would ship
the operator's password. DR-088/DR-011 already treat credential leakage as a property of the *output
channel*, not of intent.
**Decision:** `User` carries `secretFormat` — the config marker (`0`/`5`/`7`/`sha512`) or `nologin`
for the `*` spelling this client's own `nologin` create writes — and the secret text is dropped at
parse time inside `users.ts`, before any record is constructed: there is no code path from a section
key to a returned `secret`. The asymmetry in upstream's favor is closed too — its reader could not
even see its own `secret *` write (row 152) — because "the account is locked out" is a fact the UI
must show. Nothing about the write path changes: secrets still go out exactly as upstream composes
them.
**Consequence:** the users table can show *that* an account is locked out or hash-protected without
the webui ever holding the credential; a future "manage this user's password" screen must be a write
only. Any later resource whose config embeds a key (`radius-server key`, `ntp authentication-key`,
the TAPS token materials siblings may meet) inherits the same rule at parse time rather than at print
time — a field is never added back "just for display". **Related:** DR-088, DR-011, DR-076, DR-027;
§5 rows 151-152.

### DR-090 — Ntp's Entity-alias presence verbs fold into one source-field verb set (W2a #35)
`ntp.py` reads like a collection and behaves like a global: `class Ntp(Entity)` with
`create(name)` that merely delegates to `set_source_interface` (`:107-116`; upstream's own test pins
`create('Ethernet2')` to the command `ntp source Ethernet2`, `test_api_ntp.py:69-72`), plus
`delete()`/`default()` that negate/default the **source word** (`:118-141`) while their names read
like "remove/default all of NTP". One write, three names, two of them misleading about their blast
radius — in a management UI whose whole safety story is that the label matches the command.
**Decision:** no aliases. The module exposes `get`, `setSourceInterface`, `unsetSourceInterface`,
`defaultSourceInterface`, `addServer`, `removeServer`, `removeAllServers` — one name per composed
write — and `removeAllServers` keeps upstream's command and verb rather than inventing a narrower
one, with its doc marking the `no ntp` scope claim (upstream's own comment, `:192-193`) as
unverified-on-hardware (M12 #14 capture) exactly so a UI can treat it as the broad negation it may
be. The upstream aliases' pinned **commands** are all ported; only their names are not.
**Consequence:** there is no `Ntp.create`/`.delete`/`.default` for a codebase — or an agent trained
on pyeapi examples — to find, and `ntp.test.ts` pins that absence on the instance so the decision
stays visible at the seam. A W2 sibling wiring another upstream `Entity` with the same alias pattern
(stp/mlag/varp lanes) has a precedent to fold toward instead of a per-module exception.
**Related:** DR-004, DR-023/DR-030 (Entity base), DR-043; §5 rows 157, 77.

### DR-091 — the `nologin` + `secret` pairing is refused, never composed with the input silently dropped (W2a #35)
`users.create_with_secret` routes on `secret is not None or encryption == 'nologin'` (`users.py:169`)
and its nologin arm then composes `username X secret *` **without the secret the caller passed**
(`:196-199`) — probe of the pinned clone 2026-11-05; upstream's own
`test_create_with_secret_nologin` (`test_api_users.py:78-81`) feeds `secret=''`
alongside `nologin` and only the command shape is asserted, so nothing upstream says the argument
survives. A form that accepts a password, then ignores it, is a UI bug generator: the operator typed
a credential, pressed save, and got a locked-out account with no signal.
**Decision:** `encryption: 'nologin'` with **any** `secret` — including `''` — is a refusal naming
both halves and the upstream line that drops it; the honest call is `nologin` alone (which composes
the same `username X secret *` line, and the read then reports `secretFormat: 'nologin'` per DR-089's
marker rule) or a real hash under its own `encryption`. The refusals run before anything is composed,
pinned with `sent() === []`.
**Consequence:** the "mutually exclusive" wording the pyeapi docstring only implied
(`:44-49`) becomes enforced vocabulary at the verb boundary; the pairing bug cannot ride into
`arista-webui` forms as a silent behavior. And the port's ledger keeps upstream's nologin **command**
pin intact — the divergence is in what inputs are accepted, recorded at row 154, not in what goes to
the device. **Related:** DR-077, DR-037, DR-089, DR-005; §5 rows 152/154.

---

### DR-092 — the ACL facade answers named verbs that resolve the ACL's kind from the switch's own header text, instead of attribute-name dispatch (W2b #37 #38)
Upstream's `Acls` object answers any method a caller invents: `__getattr__` wraps
`ProxyCall(self.marshall, name)` (`api/acl.py:114-115`) and `marshall` pulls the ACL name out of
`args[0]`, then `hasattr`/`getattr` forwards (`:117-124`). The failure modes are probe records: an ACL
the switch does not have comes back `{name: None}` from `get_instance` (`:126-135`) so a write against it
dies as `AttributeError` **on that dict** (`'{'unconfigured': None}' object has no attribute
'add_entry'`), and a type string outside `VALID_ACLS` silently becomes **the other kind** (`:137-142`) —
upstream's own `test_create_unknown_type_creates_standard` (`test_api_acl.py:112-115`) pins that
fallback, and a typo'd kind writing `ip access-list standard …` when the operator asked for an extended
ACL is a config write nobody requested (rows 73/76's widened-guard convention applies, guard asserted
rather than inherited). This is the same dynamic surface removed for `Interfaces` (DR-006) and against
per-kind objects (DR-068), now for the third time: the TypeScript type system cannot track a kind chosen
by `getattr`, and here the kind decides which **command text** goes on the wire.
**Decision:** the ported facade has named verbs only: `standard`/`extended` accessors hand out the two
kind-pinned collections (one per `Node`, DR-052/DR-026 memo), `create` takes a typed
`AclAttrs.type` defaulting to `standard` with anything else refusing, and every kind-sensitive verb —
`deleteAcl`, `setDefaultAcl`, `addEntry`, `updateEntry`, `removeEntry`, plus the abstract `delete`/
`setDefault` which route to their kind-reading twins — calls `resolveType`, which matches the committed
header grammar against the **section keys** and throws `NotFoundError` for a miss. No verb guesses the
kind, and none needs `hasattr`.
**Consequence:** every facade verb costs one chunked-config read for kind resolution, absorbed by the
DR-026 memo so guard + resolve + dispatch is still a single `show running-config` per operation (pinned:
the facade read-after-write test counts requests). Upstream's two proxy-method tests have no dynamic
counterpart to port: their intent becomes the named-verb tests and the `NotFoundError` test, and the
`AclType` union plus `Acl.type` give the UI a discriminator no `getattr` surface can offer.
**Related:** DR-006, DR-068, DR-037, DR-052, DR-004; §5 rows 160 / 163.

### DR-093 — an ACL collection answers one flat name-keyed table carrying the kind as a field, and its entries a number-keyed Map in device document order (W2b #37 #38)
pyeapi's answers are nested and stringly: `Acls.getall` returns `{'standard': {…}, 'extended': {…}}`
with each name sorted into the bucket its header spells (`api/acl.py:104-112`), `Acls.get` indexes a
probe-shape dict by the name it was handed (`:88-89`), and an ACL's rules key on the **regex string** of
the sequence number (`:180`, `:257`). Row 96 already corrected that key class for vlans (string ids no
guard accepts), and DR-068 already decided per-kind **fields** over per-kind objects — but ACLs are the
first module where the kind changes the *command*, so the field's importance is operational, not
cosmetic: a UI table that shows `test (extended)` next to `test (standard)` needs one list, and
`node.acls.get(name)` needs one answer, not "search both buckets" caller code.
**Decision:** `getAll()` returns `Map<string, Acl>` with `Acl.type` set from the header, and
`Acl.entries` is a `Map<number, AclEntry>` — keys are the **number** the rule line starts with,
insertion follows device document order, and nothing renumbers: an `addEntry` with no
`AclEntryInput.seqno` writes the bare line and lets the device number it, because re-reading to guess
the next number races any other writer. Upstream's nested pair is *reconstructible by grouping on*
`type`, and a test pins exactly that reconstruction against `test_api_acl.py:65-69`, so parity is proven
rather than assumed. A name-less `ip access-list standard` header stays an extended ACL named
`standard` — the read model keeps the grammar's artifact rather than inventing a refusal (row 158).
**Consequence:** one table shape feeds the UI, one lookup answers a name, and "sorted by kind" is a
caller display choice, never a hidden second collection. Float-key/renumbering drift is impossible
because the key type is pinned numeric-by-construction, and duplicate-name ambiguity is reported (row
162) instead of resolved by dict insertion order. **Related:** DR-068, DR-027, DR-092, DR-052, DR-026;
§5 rows 158 / 162.

### DR-094 — a device line this client cannot read fails as a ConfigParseError naming the section and the line, never as an absence, a crash, or a half value (W2b #37 #38)
Across this wave's two modules pyeapi carries four distinct ways to misreport an unreadable line, and
all four are device-state lies: (1) **crash** — the standard ACL parser calls `match.groups()` on `None`
(`api/acl.py:173-174`; probe: `10 p` raises `AttributeError`); (2) **skip** — the extended parser guards
`if match:` and drops the line (probe: `{}` where the switch has a rule); (3) **invent** —
`group(5) or 'any'` / `group(9) or 'any'` (`:250`/`:253`) and `srcaddr = ip or '0.0.0.0'` (`:177-178`)
answer destinations that were never written and turn `any` into a host `/32`; (4) **absence** —
`_parse_mac_address` answers `None` for a MAC line its pattern misses (`api/varp.py:98-100`, including
an uppercase one a real operator writes) and `(\S+)$` makes `ip virtual-router address 2.2.2.2 junk`
vanish from the interface's answer (`:196-199`). Mode (4) is the dangerous one for a management UI: a
panel would render "not configured" for a switch that *is* configured, violating the honest-state rule —
and DR-029 already fixed absence-not-equals-absence for vlans.
**Decision:** every one of those sites becomes a `ConfigParseError` with `{ sectionKey, shortLine }`
payload (both modules' `cannotParse` helpers; rows 161-162 for ACLs, rows 165-166 for VARP), while
genuine absence stays `undefined` (DR-027) and is only ever answered when the grammar says *no line is
here*. Read tolerance is paired with write refusal so bad state stays **manageable**: a `/len` VARP
address or a device-written uppercase MAC is reported, never silently dropped, and never *added* by this
client — but the device's own token is a valid removal operand, so nothing an operator can see are they
unable to clear. A parse failure also blocks dependent writes by construction: VARP's diff verb reads
first, so an unparseable line aborts before a byte is sent (pinned).
**Consequence:** the UI gets a reviewable "could not read this section" state distinct from an empty
table, fixtures may carry the weird-but-real shapes upstream would mishandle and the suite asserts the
loud answer, and a capture lane (M12 #14) that finds a real cEOS section this grammar rejects fails
somewhere a human sees the line — which is the evidence that tells the project what to learn next. No
new error class joins the taxonomy (DR-005/DR-010). **Related:** DR-005, DR-010, DR-027, DR-029, DR-053;
§5 rows 161 / 162 / 165 / 166.

### DR-095 — verbs this client's collection contract requires but pyeapi never implemented are mapped onto upstream's own emitted texts, never onto invented commands (W2b #37 #38)
`VarpInterfaces` implements exactly `get`, `getall` and `set_addresses`
(`api/varp.py:148-194`); the negative and presence texts this resource could need exist **only as flag
arms** inside `set_addresses` (`:174-177`, `:191-192`), and create/delete/default are not missing
overridable stubs — `EntityCollection` never defines them at all (`abstract.py:198-224` contributes
`__call__`/`__getitem__`/`__len__`/`__iter__` plus raising `getall`/`get` only; the same shape `Varp`
inherits while implementing one `get`). This client's `EntityCollection` contract requires presence
verbs (DR-068's typed surface says what *the client* offers), and the obvious implementations are traps:
`delete()` on an interface-keyed collection reads like `no interface Vlan10` — a lifecycle command this
module never verified, never owned, and would be catastrophic to discover in a "remove the VARP setting"
button — and `create()` is upstream a no-op arm, not an opener worth copying: the probe shows upstream's
diff with nothing to change still sends `['interface Vlan4002']`, a bare submode entry that configures
nothing (row 166).
**Decision:** every mapped verb names an upstream text and cites its line in its own doc:
`create(name, {addresses})` = `interface <name>` plus each `ip virtual-router address <addr>` add arm
(`:189-190`), with zero reads and empty-or-absent addresses a refusal (a no-op opener is not a creation
anyone asked for); `delete()`/`unsetAddresses()` = `interface <name>` plus the bare
`no ip virtual-router address` (`:177`/`:191-192`); `setDefault()`/`defaultAddresses()` = the
`default ip virtual-router address` arm (`:174-175`). Interface lifecycle stays in `interfaces.ts`,
where that text actually lives. The ACL facade's kind-reading `delete`/`setDefault` (DR-092) is the same
mapping discipline under the same reasoning: an inherited-or-invented verb must trace to a command the
module's own read model can also confirm.
**Consequence:** the scary name is not the scary command: `varp.interfaces.delete('Vlan10')` pins
`interface Vlan10\nno ip virtual-router address` in a test, and the type surface carries no way to
destroy an interface from this resource. Reviewers get line-cited arms per verb instead of prose trust,
and the deliberate *omission* of upstream's `['interface Vlan4002']` no-op artifact is visible in the
ledger (row 166) rather than discovered as a surprise transaction.
**Related:** DR-068, DR-037, DR-092, DR-032, DR-094; §5 rows 163 / 166.

---

### DR-096 — the spanning-tree mode list is this client's write grammar, checked even where upstream's own guard skips itself (W2c #39)
`stp.py` contradicts itself about its one global field three times: `get()`'s docstring draws a `mode`
key the code never reads (`:109-113` vs `:115-116`); `set_mode` hard-codes its accepted values but only
checks them when neither flag kwarg is set (`:150` wraps `:151-153`), so its `default`/`disable` arms
validate nothing; and the module calls `mode` "not defaultable" (`:135-136`) while the `default=True`
arm emits `default spanning-tree mode` anyway (pinned at `test_api_stp.py:71-74`). The list itself is
version-scoped prose — "accepted values **for this version**" (`:38-41`) — and the feature-matrix
reading this repo carries derives Rapid-PVSTP/MST presence from the 7050X family, not from this unit.
**Decision:** all three faults are corrected as **client grammar**, never recorded as hardware facts.
`get()` answers `mode`, read from the chunked document's indent-0 keys exactly like `hostname` (DR-055),
with the token kept verbatim (`string` + `isStpMode`) so a device that spells something else is
reported, not dropped or narrowed. `setMode`'s guard over `STP_MODES` is the same literal list
(`stp.py:151`) but **unconditional** — upstream's conditionality is an artifact of its kwargs folding,
and with three named verbs (DR-037) there is no arm left for a skipped check to hide in. A refusal is a
`NotSupportedError` naming the value (DR-005/DR-053) whose message points at the M11 (#13) capability
probe as the feature gate, so no hard-coded list ever pretends to know the SKU (DR-032).
`default spanning-tree mode` is sent by the verb that names upstream's arm, docstring aside: whether
EOS 4.28.13.1M accepts it, or `mstp`/`none` at all on a 7050TX-64, is an M12 (#14) capture, and every
verb has a pinned `CommandError` path as the device's answer channel.
**Consequence:** the mode set is pinned by code and tests, not by docstring prose; a device token
outside `mstp`/`none` stays visible on the read side, and widening the write side without an M11 probe
first is the anti-pattern the refusal message itself names. Upstream's behaviors (mode never readable;
flag arms unchecked; the "not defaultable" default sent anyway) stay recorded as §5 row 167's pinned
divergences rather than silently normalized. **Related:** DR-005, DR-032, DR-037, DR-053, DR-055;
§5 row 167.

### DR-097 — the same `mtu` line is owned by two resources: that is said out loud and pinned, never coordinated (W2c #40)
The indent-1 `mtu <n>` line inside an `interface <name>` section already belongs to M10a:
`interfaces.ts` reads and writes it, and its own divergence 7 records that the closest upstream code
for the field lives in a *different module* — `ipinterfaces.py`, which this lane ported. Upstream
carried the same duplication with two different guards (`ipinterfaces.py` checks `68..65535` from
constants that are an IP-MTU reading of RFC 791/8200, not a captured EOS floor or ceiling;
`interfaces.py` never carries the field at all). The two directions a repo can take — merge the field
into one resource, or add cross-resource write tracking — both invent promises this client has never
made, and PLAN's resource boundaries still mirror pyeapi's modules.
**Decision:** **no** ownership marker, invalidation hook, or coordination primitive. The reads agree by
construction — both resources parse the same section from the same chunk-and-memoized config
(DR-026/DR-030) — so one truth per line is a property of the pipeline, not of a protocol. Writes stay
independent transactions, and the contract is the honest one: whatever the device last accepted is
what the next read reports, and the client claims nothing beyond that. The guards stay different on
purpose: `ipinterfaces.setMtu` keeps upstream's `68..65535` because that module is the L3 view and that
is the range upstream ships (`:54-55`, `:246-249`, with `0` refused as out-of-range, which also closes
upstream's `value=0` → `no mtu` fall-through); `interfaces.setMtu` refuses only non-integer/non-positive
input because an L2 field should not be policed by an IP range. Each refusal names the range it checked,
so calling the wrong resource produces a wrong-range refusal with a legible reason instead of a confusing
success (DR-053/DR-032), and the range values themselves remain "unverified on hardware, M12 #14 to
capture".
**Consequence:** one pin proves the reads agree (`the same line reads identically through interfaces and
ipinterfaces`) and one pin proves the guards differ (`each refusal says which range it checked`); a UI
moving between the two resources is told which one it is holding. If a live capture shows the `68` floor
or the `65535` ceiling wrong on this SKU, it lands against row 174 and these constants, and revisiting
the split is then a spec question with evidence, not a lane-local reflex.
**Related:** DR-026, DR-030, DR-032, DR-053, DR-059; §5 rows 102 / 174.

---

### DR-099 — the VRF keyword comes from the device's own config text, never from a version-string compare (W2d #41)
pyeapi gates seven `Vrfs` verbs on `self.version_number >= '4.23'` (`vrfs.py:79, :142, :169, :186,
:201, :218, :323` — all re-verified at `6816d9e`), where `version_number` is a **string scraped from
`show version`** and the compare is character-wise: `'4.9' >= '4.23'` is True, exactly the bug class
DR-078 already recorded for `interfaces.set_vrf`. Issue #16 flagged that this lane owes the 4.28 pin,
and DR-033's probe-first rule plus DR-078's numeric-floor precedent both point away from hard-coding a
version answer.
**Decision:** `VrfsResource` never asks the device what version it is. Reads accept BOTH section
keywords in one chunked pass and record per entry which keyword the header used (`Vrf.definitionForm`),
so a mixed-form config — an upgraded box keeping `vrf definition` sections while new VRFs get
`vrf instance` — is read truthfully. Writes take the keyword from the text the device itself wrote:
any `vrf instance` header wins (the box demonstrably speaks the newer keyword), definition-only
sections answer `definition`, and no VRF sections at all fall to this repo's floor (`instance`; EOS
4.28 per AGENTS.md, which is also where upstream's own gate lands at ≥4.23) **held as a stated client
convention, not a platform claim** — a device predating the keyword answers with its own
`CommandError` and the caller sees `failedCommand` (DR-005). The detection scans the DR-026 config
memo, so it costs no extra round trip after any read, and the answer **latches per resource
instance**: the keyword a box speaks does not change mid-session, and a config write clears the
config memo, so without the latch every later form-dependent verb would re-read. The latch is
pinned by request counts. M11's `verifyConfig`/completion capability surface is deliberately NOT
consulted from this module even though it exists: a probe is a round trip and a throwaway config
session over evidence every read already carries (DR-030's budget), and a capability answer that
disagrees with the sections the device just wrote would be the worse authority.
**Consequence:** upstream's suite can never exercise the modern arm (its fake node pins
`'4.17.1.1'`, `test/lib/testlib.py:75`) while both arms are pinned here against the configs that
produce them; the drift case — `interfaces.setVrf` still version-floored per DR-078 — is recorded
rather than silently harmonised, waiting on an M12 (#14) capture of which signal the v4 image keys
the keyword choice on. The device stays the instrument; the client only reads its handwriting.
**Related:** DR-033, DR-078, DR-026/DR-030, DR-005, DR-032; §5 rows 175-177.

### DR-100 — the static-route read model is flat typed records; every ROUTES_RE quirk stays pinned where it bites (W2d #42)
pyeapi's `StaticRoute.getall` composes a dict-of-dicts per destination whose keys include a Python
`None` (the no-next-hop-ip slot, `staticroute.py:161`) and integer distances (`:162`), built by the
chained `routes[a] = routes.get(a, {})` assignments at `:170-176`; its `ROUTES_RE` (`:68-74`, verified
module-scope) requires the distance segment, demands the CIDR immediately behind `ip route ` (so every
`ip route vrf …` line is invisible), has no IPv6 half at all, and runs through `findall` over the raw
config (`:152`) so a banner body's column-0 look-alike votes.
**Decision:** `StaticRouteResource.getAll` answers `destination → readonly StaticRoute[]` — flat typed
records, `None` slots as absent optional fields, the distance/tag ints as numbers — with the chained-
assignment semantics kept where they carry meaning: an identical `(ipDest, nextHop, nextHopIp,
distance)` line collapses to ONE record, last line winning, first position kept (pinned). Candidate
lines are the chunker's indent-0 leaf keys, which removes the banner vote (the `vlans`/`vrfs`
same-rule family) but nothing else is repaired: the required-distance invisibility, the fixed
segment order, the end-open tail and the VRF/IPv6 LEAKS stay exactly upstream's, pinned by tests that
say so. The write side composes through `is not None`-style `!== undefined` appends verbatim
(so `0` is a value in both directions — the deliberate contrast with the `command_builder` falsy
family at row 73), accepts both spellings upstream's tests use (`99` and `'99'`), and adds only the
guard family that refuses what NEITHER grammar could echo back (dotted slots dotted, `\S+` slots
single-token, digit slots digits, a single shared missing-`nextHop` refusal for the positional that
the framework moved into the attrs bag). Nothing reads the device before a route write.
**Consequence:** a UI consumes the table without re-flattening, and the leaks cannot be silently
"fixed" because they wear test pins naming the line numbers that cause them. Reading vrf-bound or
IPv6 static routes is honestly recorded as a capability this module (and upstream's pinned file) does
not have — owed upward to a wave that specifies a vrf-scoped route record, not invented mid-lane.
Whether 4.28 really treats `default ip route …` as `no ip route …` (upstream's docstring equivalence
note at `:50-52`) is an M12 (#14) capture; both texts stay distinct until then.
**Related:** DR-027, DR-029, DR-053, DR-030, DR-037 (by contrast); §5 rows 178-180.

### DR-101 — the MLAG port is pinned to what 6816d9e actually says, and the dispatch's variant-shaped refs are reported, not obeyed (W2d #43)
The dispatch refs for this module (`set_interface_mlag_id :46-:70`, `verify_local :204-:218`, the
"THE interface-vs-switch command bug" for `set_mlag_id`, int-coerced `set_domain_id`, falsy-0 bugs at
`:158/:252`) and the `staticroute` dispatch refs (IPv4/IPv6 dispatch `:99-:108`, vrf create/delete
asymmetry `:244`/`:334-:335`, `_parse_*` bare-match `:357-:359`) match NO code at the pinned SHA:
`mlag.py` is 302 lines with seven public verbs and a CORRECT `configure_interface` call at `:288`,
`staticroute.py` is 384 lines and IPv4-only. The brief's own decision question — whether `Mlag.get()`
reads `show mlag` JSON, config, or both — checks out as **config text only**; the module issues no
`show` command, and the repo's real cEOS `show-mlag.json` capture is cited in the module header as
vocabulary cross-reference only (container evidence, DR-066 envelope untouched, `hardwareEvidence`
stays false — the MLAG *state* JSON contract remains an M12 #14 question).
**Decision:** implement the checked revision faithfully and record the citation drift as ledger
(row 183) rather than coding to the stale refs: `setMlagId` is an interface verb and no
`NotSupportedError` is owed for a bug this tree does not contain. The port's own divergences (rows
181-182) are the ones the clone shows: upstream's `get()` CRASHES (TypeError via a None section,
`:99/:119`) where this client answers an empty record with `shutdown` absent rather than invented;
`'no shutdown' not in config` (`:175`) is kept as a derivation but made exact-line; upstream's
substring `re.search(r'mlag (\d+)')` reads a `no mlag 7` negation as a configured id while this
reader lets only keyword-starting body lines vote (and keeps upstream's drop-unmatched for real
non-matches); and the falsy-zero family that row 73 records in the abstract builder is LIVE here
(`set_mlag_id(i, 0)` → `no mlag` upstream) and is repaired the way DR-037 chose — `0` composes
`mlag 0`, negation is the named verb. The per-interface id stays a STRING (match.group(1), `:191`);
the docstring's 1..2000 range is quoted and never enforced (DR-032). `pyeapi/test/system/
test_api_mlag.py`'s 21 paired-switch methods are declared skipped in the test header — an MLAG
domain is two boxes and this lane has one node per record; faking them would manufacture evidence
TESTING.md §5 exists to forbid.
**Consequence:** the registry's favourite wave-1 negative control (`mlag`) becomes a real row and
`stp` inherits the "still owed" slot in `registry.test.ts`/`index.test.ts`; and every future lane
gets a second worked example (after row 148's) that inherited or dispatched refs must be re-opened
at the pinned SHA before a single line is ported — several did not survive the check, and the
reporting obligation (COMMON's "citations found WRONG, with corrections") is how the orchestrator
learns which docs to distrust.
**Related:** DR-005, DR-037, DR-030, DR-029/DR-027, DR-066, DR-043, DR-032; §5 rows 181-183.

### DR-102 — registry keys and static accessors keep upstream's one-word module spellings: `staticroute`, not `staticRoute` (W2d #41 #42 #43)
Three of wave 2's modules are `vrfs`, `staticroute` and `mlag` in pyeapi's filesystem — and
`node.api('staticroute')` resolves that EXACT string as a module path (`client.py:927-950`). The
registry replaced that autoload with a closed map whose keys consumers can type AND tables can hold
as plain strings (row 79), and `Node` grew a static getter per row (DR-052). One of the three names
is multi-word to a human eye and raises the camelCase question for both the key and the getter.
**Decision:** registry keys are upstream's module spellings verbatim — `vrfs`, `staticroute`, `mlag`,
appended in order at the end of `ResourceKinds`/`RESOURCE_FACTORIES` (append-only across the sibling
lanes) — and the `Node` accessors mirror the key character-for-character (`node.staticroute`), NOT a
camel-cased alias: one spelling greps identically through pyeapi, the epics/PLAN's own wording, the
registry key, the getter and the docs. The CLASS name takes the repo's existing
`<PascalName>Resource` form (`StaticRouteResource`) because class-name casing is a TS-side concern
already settled by every sibling. The pinned spellings live in `registry.test.ts`'s `names()` array
and `index.test.ts`'s factory-keys array — the two lists a merge-conflict-prone sibling lane must
both agree on — and issue #14's epic wording (`staticroute`) is what the test message quotes.
**Consequence:** a UI table holding a `string` resource column types into `node.resource(name)` with
no translation layer, and a rename (say, to `staticRoutes`) becomes a deliberately visible breaking
change across pinned arrays, docs and upstream mapping rows rather than a silent accessor alias.
**Related:** DR-006, DR-052, DR-040; §5 row 79.

---

### DR-103 — a capture must be framed exactly as this client frames the request; a recording made with different framing records the harness, not the device (M12c #14)
The 2026-11-06 lab run answered `show running-config` (and `show running-config all`) with
**1002 invalid command** over a bare `runCmds` request — while the SAME commands preceded by
`enable` answer the full config text. `enable` is what this client itself puts first
(`command-layer.ts`'s `sendEnable` default), and pyeapi's `run_commands` does the same and pops
enable's reply (`client.py:876-925`, `:922-923`; §5 rows 73/82 already pinned that shape). Had the
harness asked bare, the committed evidence would have recorded *the harness's framing choice* as if
it were *the device's verdict* — and `show running-config`, the single most load-bearing capture of
this tranche, would have looked unsupported. **Decision:** every catalog entry is sent as
`['enable', command]` and the captured reply is `result[cmds.length - 1]`, with the capture ABORTING
(loudly, before writing anything) when `runCmds` answers fewer results than commands, so an
off-by-one indexing accident can never masquerade as a fixture. **Consequence:** fixture files are
only ever comparable to what `node.runCmds` would see, which is what makes the running-config
captures directly consumable by the M6/M9/M10 section parsers (row 184's claim); and any future
catalog entry inherits the framing rule instead of re-asking it.

### DR-104 — redaction is structural, not a name list: credential scrubbing covers the encryption-type arm and runs on object KEYS as well as values, and no scrub may silently drop an entry (M12c #14)
Two facts from the first committed `show running-config all` capture (2026-11-06) made M12b's
redactor insufficient: (1) its `json` reply keys the EOS config model's `cmds` map by the **whole
command line**, so the lab's `username … secret sha512 $6$…` line arrives as an object KEY with a
null value — a value-only scrub commits the hash; (2) M12b's patterns stopped at the `secret`
keyword, but the encryption type (`sha512`/`md5`/`plain`, or a leading `[0-7]`) is part of the
command, so even at a value position the pre-M12c regex would have committed the real `$6$…` that
follows it. (Also observed: `show interfaces`/Port-Channel models carry a MAC **per interface**, not
just the three top-level keys M12b zeroed, and a container MAC is derived from the Docker IP
allocation, which docs/CEOS.md's own redaction list names as identifying.) **Decision:** the
credential rules run through one `redactCredentialText` applied to BOTH string values and object
keys; the `username` arm accepts the optional encryption-type token; `enable algorithm … password`
and `enable password` are their own arms; a rewritten key that would collide is made unique with a
visible ` #n` suffix — losing a neighbouring entry to a scrub is forbidden; and the MAC rule is
key-name AND value-shape at any depth, so `learnedMacAddressCount: 0` stays (a count is not an
identifier) while every MAC-shaped string under a `*mac*` key zeroes. **Consequence:** the
`redactionApplied` envelope list is the contract a reviewer diffs against the code, and a committed
capture is NEVER hand-edited afterwards — if a scrub is wrong, the rule changes and the lab is
re-run (that rule re-verified itself the same day: the M12b nine re-captured under the stronger
scrub and their bodies moved only in run-dependent numbers). The scrubber is shared with the
7050TX sweep, so the hardware captures inherit the hardened machine.

### DR-105 — a device refusal is recorded evidence, never a fixture file; committed counts derive from what the device answered, and per-run identity churn is expected in diffs (M12c #14)
The catalog asks 20 commands; the run committed 16 files. `show interfaces switching` stays a 1002
behind `enable`, `show port-channel detail` is a 1002 and its `summary` sibling is deprecated by
`dense` on 4.28.14M, and `show ip interface brief` was as negative as in the 2026-11-03 run — all
printed verbatim in the probe output, none papered over with a synthetic file, none deleted from
the catalog. Two corollaries this lane holds to: a `switchports: {}` model on a container with no
configured L2 port is evidence the COMMAND exists (it partly settles the DR-018/DR-029 open item)
while the configured-port half stays open for the hardware sweep — an empty container answer must
never be quoted as "the switch answers nothing"; and re-capturing the previous nine legitimately
rewrites their identity envelopes (`runId lab-811108-5dcd01`, timestamps, published port, TLS pin,
uptime/memory), so fixture diffs are read as identity deltas, not tampering, and the reviewer's
check is the `result` BODY. **Consequence:** the §5 fixture count for a tranche is the number of
files, and each entry's `note` states what its absence or presence proved; zero-leftover teardown
evidence (no container, no network, no pinfile after `lab:down`) is part of the run report, not
optional garnish.

### DR-106 — an entity whose upstream `get()` answered `None` is typed `State | undefined`, and its no-op writes resolve with zero commands (W3a #48 #49)
`base.ts`'s `Entity` docstring prefers "a global entity with nothing configured still has an answer",
and every wave-1/2 entity honoured that because those upstream modules really do answer a dict
(`mlag.py` crashes, `ntp`/`system`/`stp`/`varp` return records). ospf and bgp are the exceptions the
upstream suite itself pins: `ospf.py:76-77` and `bgp.py:69-70` answer `None` for a missing block
(`test_api_ospf.py:143-145`), and `delete()` short-circuits to `True` with nothing sent
(`:147-149`, `bgp.py:123-125`/`:130-132`). This port parameterizes `Entity<OspfState | undefined>` /
`Entity<BgpState | undefined>` rather than inventing an empty router the switch does not run — a
fabricated record would be an empty state indistinguishable from success in the webui's panels — and
the no-op `delete`/`setDefault` resolve `void` while the pins show the read and NO config batch.
The `BgpNeighbors.get(name)` all-`None` phantom record is deliberately NOT ported (absence is
absence, DR-027's family): the table answers a row or `undefined`. §5 rows 191 and 197.
**Consequence:** wave-3's lane B/C entities check their upstream `None`-shapes the same way rather
than flattening them; a caller's empty-state branch is a `=== undefined`, and the type system
points at it.

### DR-107 — the `peer group`/`peer-group` spelling is a device read, never a version-string compare; the two bgp openers stay split as upstream left them (W3a #49)
`bgp.py` picks the neighbour keyword from `self.version_number >= '4.23'` at four sites (`:209`,
`:267`/`:271`, `:292`) — the same lexicographic-compare bug class DR-078 recorded for
`interfaces.set_vrf` and DR-099 for `vrfs` (`'4.9' >= '4.23'` is character-wise True). The port reads
the device's OWN evidence instead: the neighbours reader matches either spelling and records
`peerGroupForm` per row (no upstream twin — the `VrfDefinitionForm` shape), and the writers follow
the first spelling the block actually carries, latched per instance exactly like
`VrfsResource.resolveVrfForm`, with the modern `peer group` as the client-convention floor when the
block speaks neither (the same "floor is convention, the device decides via its own `CommandError`"
balance DR-099 struck; M11's capability surface stays OUT of read verbs for the same round-trip
reason). The row-198 opener split is KEPT, not harmonised: the entity half composes from
`_parse_bgp_as`'s whole header remainder (vrf tail included) while the neighbours half composes
from the first DIGITS run — `router bgp 100 vrf MGMT` gets two different openers upstream, and a
"fixed" single opener would silently re-route writes on a vrf-BGP box. §5 rows 198 and 201; the drift
question against `interfaces.setVrf`'s DR-078 floor stays open below. **Consequence:** a cEOS 4.28
capture of vrf-BGP and mixed-spelling blocks can retire the convention fallback; until then the
device's own refusal is the authority.

### DR-108 — silent `False` answers become out-loud refusals or modeled retries, never return values (W3a #49)
Two sites in `bgp.py` answer `False` where a caller would read the outcome as unremarkable:
`set_peer_group` on a non-address name (`:288-298` — the ispeergroup gate leaves the call a no-op
returning `False`) and the swallow-error `configure` chain behind `BgpNeighbors.delete`'s
group-keyword retry (`:265-275` reading `abstract.py:118-127`'s `except CommandError: return False`).
Both become behavior the taxonomy already supports: the peer-group gate raises `NotSupportedError`
at zero round trips (a deliberate WIDENING by asserted refusal — COMMON's rule — because a
silently-skipped config write is exactly what commit-state honesty forbids), and `delete` catches
the real `CommandError` that replaced the swallowed-`False` idiom (DR-005), retries the
group-keyword form exactly ONCE with the detected spelling, and lets a second refusal propagate.
Non-`CommandError` failures — auth, connect, TLS, protocol — never earn a second write: they are
not command refusals, and the send discipline stays in one place (ARCHITECTURE §2). §5 row 202.
**Consequence:** any later pyeapi method whose contract is "returned False on refusal" ports as
throw-or-retry, never as a boolean.

### DR-109 — the faithful-port rule outranks aesthetics: `BgpNeighbors.create` keeps its bare-shutdown wiring, flagged loudly instead of "fixed" (W3a #49)
`bgp.py:262-264` implements `create(name)` as literally
`self.set_shutdown(name, default=False, disable=False)` — the ONE arm that composes the bare
`neighbor <name> shutdown`, i.e. a create verb whose only observable effect is declaring the
neighbour AND setting it administratively down. It looks like an upstream defect (the class's real
zero-arg defaults at `:303` NEGATE, and upstream's suite has no unit test for `create` or `default`
on the neighbours half at all, which is how it survived), but this migration's rule is
port-what-the-code-does, pin the quirk, and report it — silently re-pointing a ported verb at a
DIFFERENT EOS effect would strand every downstream expectation built on pyeapi parity, and what
`neighbor X shutdown` even does to a name the router never had IS a capture question (M12 #14).
The TS verb therefore KEEPS the text (pinned: `router bgp 65000` + `neighbor newpeer shutdown`), the
doc block reads as a warning label, and the operator intent "this peer is UP" is `unsetShutdown` —
upstream's own zero-argument default. The webui's destructive-action rules (clear labeling,
confirm-for-risky) apply on top of that, not instead of it. §5 row 199. **Consequence:**
suspected-upstream-defect ports carry their real behavior plus a pinned test and a row; "obvious
fix" substitutions are refused at review.

### DR-110 — a hard third-party dependency becomes a conservative local check with the narrowing pinned, rather than widening the dependency graph (W3a #49)
`ispeergroup` is one line of `netaddr` (`:257`), and netaddr parses far more than an operator would
ever name a BGP peer with: partial dotted quads (`'1.2.3'` → 1.2.0.3), plain decimal and hex
integers, leading-zero octets. The repo's dependency posture (no new runtime deps without a
milestone that justifies one; the client ships browser-facing through `./index`) puts a netaddr port
out of reach for one gate, so the check is a local, conservative IPv4-full-dotted-quad /
IPv6-colon-literal test — deliberately NARROWER: this client treats MORE names as group-shaped than
netaddr does, and every consequence is pinned in direction (`'1.2.3'` is a group name here, so a
`setPeerGroup('1.2.3', …)` refuses where pyeapi would have written a member line). The refusal
direction is the safe direction: it can never write a device line the operator did not ask for.
§5 row 201. **Consequence:** when a ported library leans on a third-party parser, the port names the
parser, states which accepted forms its replacement does NOT accept, and pins at least one narrowed
case per family; if a capture ever shows those exotic spellings in real configs, widening gets its
own row and its own review.


### DR-111 — a route-map clause is a THREE-coordinate identity, and the typed model keeps upstream's nesting rather than inventing coordinates (W3b #50)
pyeapi's `Routemaps` is an `EntityCollection` keyed by ONE word (the name) — `getall` builds
`resources[name]` (`routemaps.py:101-109`) — while every verb that changes anything addresses a
clause by `(name, action, seqno)`: `create`/`delete`/`default` take the triple positionally
(`:161`, `:180`, `:199`), as do the field writers (`:222`, `:259`, `:295`, `:323`). `get(name)`
answers `{action: {seqno: attr}}` (`:57-99`, materialised by `_parse_entries` `:110-128` and
`_merge_entries` `:130-139`), and `_merge_entries` **throws away** the `name`/`action`/`seqno`
fields `_parse_entries` built at `:121`, keeping them only as the two dict levels it indexes
(`:133-134`, `:137`). The framework this module is built on cannot express that in its presence
verbs at all: `EntityCollection.create(name, attrs)` has one coordinate slot (row 78). So the
lane had to choose between flattening the identity into the leaf record (the shape a consumer
would find convenient) and keeping a nesting that no other module in the registry has.
**Decision:** keep upstream's shape, and say what the three coordinates are. `K = string` (the
name); `RoutemapEntry = ReadonlyMap<action, ReadonlyMap<number, RoutemapEntryAttrs>>`
(`routemaps.ts:214`) carries the other two as levels, with the seqno level keyed by a `number`
because `_merge_entries` coerces with `int()` (`:134`); `RoutemapEntryAttrs` (`:195`) carries
**exactly** upstream's four `attr` keys, with no `name`/`action`/`seqno` fields added, because
upstream has none at that level and this client does not manufacture fields the device never
answers. The clause verbs take the triple positionally ({@link setMatch} `:441`,
{@link setContinue} `:527`, {@link setDescription} `:552`) — a deliberate mismatch with the
one-key collection verbs, matching upstream's own signatures; and where the framework's
`create`/`delete`/`setDefault` cannot express it, the missing two coordinates ride
`RoutemapClauseAttrs` (`:227`) and `requireClause` (`:626`) refuses a half-filled bag before any
traffic rather than composing the truncated `route-map NAME` line that the reader's own grammar
(`:103`) could never match. **Consequence:** a UI table iterates one collection read and gets a
clause keying that matches what the CLI writes and what `get` returns — the same triple is the
lookup key for `setMatch`-style diffs, so no caller can address a clause the read never reported.
The cost is one shape in the registry with two nesting levels, which is why the type alias (not
an interface) and the coordinate names are documentation-bearing; and DR-093 (a name-keyed table
with a number-keyed Map in document order) and DR-100 (a composite identity flattened into
records) now have a third point in the family: an identity the framework has **no** slot for.
**Related:** DR-093, DR-100, DR-027/DR-029, DR-030, DR-052; §5 rows 203-206.

### DR-112 — an upstream unit fixture is quoted verbatim or edited with the edit declared, and the reason an inline block beats a fixture file is stated (W3b #50 #52)
Both modules needed the config text pyeapi wrote for its own tests: the route-map collection's
47-line `test/fixtures/running_config.routemaps` and `VxlanInterface`'s 50-line
`running_config.vxlan`. Neither is a device capture — they are hand-written test material, and
this repo's fixture box requires every file under `test/fixtures/config/` to carry a
`manifest.json` entry, an oracle regeneration (`scripts/config-chunkify-oracle.py`) and a README
row, with an inventory guard test that fails when the manifest, the oracle and the files on disk
disagree. Two W3 lanes touching those three files in parallel is the collision W2d already avoided
by going inline — `vrfs.test.ts:5-9` and `staticroute.test.ts:4-6` say so in their headers — and the
wave-3 brief reserved fixture work to neither lane. Meanwhile the route-map fixture has a real
problem for a port that wants to pin a rule: its doubled `route-map FOOBAR permit 20` headers
(`:24` and `:30`) carry byte-identical bodies, so `_merge_entries`' last-wins replacement
(`routemaps.py:137`) cannot be observed with upstream's own text.
**Decision:** quote pyeapi verbatim and put the text inline. `interfaces.test.ts`'s `VXLAN_FIXTURE`
is a byte-exact copy of all 50 lines (`interface Vxlan1` at `:1`, the VXLAN family lines at `:39-49`,
the closing `!` at `:50`) labelled at the const as pyeapi's own test material and never a device
capture;
`routemaps.test.ts` inlines a reduced copy whose TEST/FOO/FOO-BAR bodies are verbatim, with ONE
declared edit — the two FOOBAR bodies are made different (`as 1111`/`continue 200` and
`as 2222`/`continue 300`) so the winner of `:137` is observable and the collision itself is still
exercised. The header states what was copied, what was edited, and why; nothing is presented as a
capture. pyeapi's orphan `test/fixtures/vxlan.json` (referenced by no upstream test at the pinned
SHA) is recorded, not ported. **Consequence:** the fixture inventory stays a single-writer file
across the parallel lanes, each lane's provenance claim is greppable in the file that makes it, and
an intentional deviation from upstream data is auditable instead of looking like a transcription
error — the price is two inline blocks that a future fixture-consolidation lane must reconcile with
the manifest, which is a cheaper conflict than four lanes editing one oracle at once.
**Related:** DR-043, DR-105, DR-066; §5 rows 205, 209, 212.

### DR-113 — the statement-list writer that upstream ships is a REPLACE, so the port names it as one and refuses to invent the add/remove half the issue asked about (W3b #50)
The dispatch's question — add or replace? — has a documented answer: `set_match_statements`
states the semantics in its own docstring ('match statements found in the routemap that are not
specified in the statements attribute will be removed', `routemaps.py:222-227`, mirrored at
`:259-264`) and implements it as a set-diff against the CURRENT clause list (`:247-255`,
`:283-291`) whose final state equals the passed list exactly. And there is no add/remove pair for
route-maps anywhere in this revision of `pyeapi/api/` — contrast `switchports.py:379`/
`:392`, whose `add_trunk_group`/`remove_trunk_group` are the real thing `base.ts`'s `add<X>`/`remove<X>` naming
rule exists for. So naming this verb `addMatch` would be doubly wrong: the framework reserves that
spelling for membership, and the semantics are replacement. Upstream's diff also runs through
CPython `set(...).difference(...)` (`:248`, `:253`), so an emission order cannot be asserted at
all, and upstream's `testlib` cannot pin one even if it were deterministic.
**Decision:** port the replacement, name the replacement, and pin the multiset. {@link setMatch}
/ {@link setSet} (`routemaps.ts:441`, `:453`) are `set<Field>` verbs; the module's header says in
plain words that an additive single-statement verb is NOT shipped because upstream has none, and
that an `add`-shaped verb is a new capability owed upward with its own decision and its own §5
row, not a lane-level improvisation (DR-015/DR-016). One shared `replaceStatements` (`:466`)
keeps upstream's emitted lines and its header-before-every-body-line structure verbatim (so the
joined-script pins compare against the same text a pyeapi caller sent) and makes exactly one
improvement: the emission order becomes deterministic — removals in current order, then additions
in argument order — while nothing is added, dropped or deduplicated differently, which is what
makes the ORDER pinnable at all (pinned by a five-clause diff, and by the two upstream
`_remove_extraneous` cases `test/unit/test_api_routemaps.py:87-94`, `:102-109` ported as 'an
omitted statement is removed'). **Consequence:** a UI that shows a clause's statement list has one
verb whose contract is 'this becomes the list', and the diff it previews is the diff the client
sends; a caller wanting a single-statement add composes it explicitly (read, then send the union),
which keeps that choice visible instead of hiding a second semantic in one verb name. Upstream's
own comment sloppiness — its match body's inline comments say 'set statements' (`:247`, `:252`) —
is recorded in the JSDoc rather than inherited as a claim about behaviour.
**Related:** DR-080 (`interfaces.setMembers`, the same diff-shape reasoning), DR-037, DR-015/DR-016,
DR-083 (joined-script keys are what make an order assertable); §5 rows 205-206.

### DR-114 — an upstream `CliVariants` site is ported as an ordered PAIR of transactions whose first attempt keeps the marker artefact, and the spec pins what upstream's own harness cannot see (W3b #52)
`set_multicast_group` composes both spellings and hands them to `CliVariants(cmds_new, cmds_dpr)`
(`interfaces.py:966-967`): the decap-integrated keyword `vxlan multicast-group decap <value>` is
attempted FIRST, the legacy `vxlan multicast-group <value>` second — and upstream's own pin at
`test/unit/test_api_interfaces.py:458-472` shows only the legacy text. `remove_vlan` is stranger:
the FIRST variant is the literal `f'vxlan vlan remove {vid} vni $'` (`:1089`, trailing `$` and all)
with the clean text second (`:1090`), and its pin (`:508-512`) shows the clean version. Both are
real on the wire: `client._configure` scans the command list for the marker (`:628-633`), splices
each alternative into the submode list at the marker's position (`:647`) and issues one config call
per alternative, re-raising the last `CommandError` (`:652`). What hides the ordering is upstream's
harness: `test/lib/testlib.py:97-107` expands EVERY variant and accepts a pin matching ANY of them,
so upstream's suite proves only that one of the pair was sent — the attempt order, the existence of
the `$` opener, and the number of transactions are invisible to it.
**Decision:** port the order and the marker verbatim, and pin both transactions. The resource's
private `configureInterfaceVariants` (`interfaces.ts:2339`) wraps every alternative in its own
`interface <name>` submode through `submodeCommands` — which is what upstream's in-list splice means
once `configure_interface` has inserted the opener (`abstract.py:176-177` plus `client.py:646-652`)
— and hands the list to `internal/variants.ts`'s `tryVariants`, the row 37 re-shape of
`CliVariants` (DR-006) whose contract is already 'first success wins, last `CommandError`
re-raised, fewer than two variants is a caller error'. The `$`-suffixed text really is what
`removeVlan` attempts first, because pyeapi really sends it; the three group arms (value, `no`,
`default`) each keep their decap-first pair; and the spec scripts the rejection between the two
legs so BOTH transactions and the re-raise are asserted — with a fresh transport per
double-failure case, since `MockTransport` keeps its first matching answer (DR-083). The one
thing NOT ported is upstream's blindness: a lane may not let a variant pair pass by pinning only
the second spelling. **Consequence:** `setMulticastGroup` against a real switch costs two config
transactions when the image rejects the integrated form, and that cost is visible in a test, not a
log; the fallback stays honest about WHY it exists — which keyword 4.28.13.1M carries is unverified
(DR-033), so neither spelling is promoted based on a preference, and no lane can silently reorder
the pair without breaking a pin. **Related:** DR-006, DR-033, DR-080, DR-083, DR-078; §5 rows 37, 210.

### DR-115 — shipping a pyeapi-faithful VXLAN port is not a statement that this switch does VXLAN: the platform question is a row, a probe, and an open item, never a code comment alone (W3b #52)
`VxlanInterface` is the first wave-3 module whose DOMAIN may not exist on the target SKU. The repo's
own evidence points are open: DECISIONS' open item 2 asks whether VXLAN, VRF routing and MLAG are
licensed on the DCS-7050TX-64 (the item that literally says it 'decides whether `VxlanInterface`
belongs in wave 3 or never'), and open item 6 records that `docs/features.md` is the 7050X matrix
while the hardware is 7050TX (§5 row 187/DR-105's related questions, DR-004). pyeapi offers no help:
it never issues a support or licensing query, its `EosVersion:` docstring tags (`interfaces.py:947-948`,
`:973-974`) are notes about the author's test image, and its two-spelling hedge at `:966-967` exists
precisely because it does not know which keyword an image carries. The slice's unit tests answer the
client's questions and nothing else, so the honest state is: command texts verified against pyeapi,
device behaviour unverified.
**Decision:** the VXLAN resources stay capability-AGNOSTIC, and the honesty is recorded where it can
be cited, not only where it is convenient. `VxlanResource` models the FIELD GROUP and the VERBS on
`Interface.vxlan` (kind-gated per DR-068), every command text is a pyeapi-faithful port with a line
reference, and nothing in the module claims SKU support: no probe answer is invented, no
`NotSupportedError` stands in for 'this switch may not do VXLAN' (that is the device's answer to
give, as a `CommandError`, DR-005/DR-033), the guard refusals are labelled as this client's
round-trip rules and client policy, never as platform bounds (DR-032/DR-057), and the section's
code note says the fixture material is pyeapi's, never a capture (DR-043). Feature presence is what
M11 (#13)'s capability probe answers (§5 rows 141-143, DR-063's cache), and the licensing question
stays open item 2 for the #14 hardware sweep. **Consequence:** the UI can show a `Vxlan1` section
that exists in the running-config and must still ask the probe before offering VXLAN controls —
reading a section is evidence the TEXT is there, not that the feature is licensed; and the next
lane that wants to add VXLAN state (or an IPv6 VTEP spelling, or the decap keyword question) is
pointed at a capture, not at a guess, because this row says what is unverified and by whom it gets
settled. **Related:** DR-033, DR-063, DR-004, DR-032/DR-057, DR-043, DR-068; §5 rows 208-212,
DECISIONS open items 2 and 6.

### DR-116 — vrrp's keyword family is detected from the device's own config text, never from a version string (W3c #51)
`vrrp.py` gates ten readers and every form-dependent stem on `self.version_number >= '4.21.3'`
(`:254`, `:263`, `:273`, `:283`, `:299`, `:309`, `:346`, `:356`, `:366`; writes `:481`, `:486`, `:530`,
`:537`, `:542`, `:587`, `:628`, `:673`, `:745`, `:751`, `:1155`, `:1171`), which is row 131/row 155's
lexicographic-compare bug class AND a posture that reads one dialect per verb: a 4.28-era box still
writing `vrrp 10 track …` reads `enable: True` because only the `disabled` pattern was searched
(`:253-:260`). This port asks the text instead: `detectCommandFamily` votes modern on any modern-era
`vrrp` line, else legacy on any legacy-era line, else this repo's modern floor (AGENTS.md's 4.28 =
upstream's own `>= '4.21.3'` arm), and the era-neutral lines (`mac-address advertisement-interval`
`:319`, `bfd ip` `:337`/`:1217`, `preempt` `:292`, the two `preempt delay` stems, `authentication` and
`ipv6`, which upstream never parses at all) vote on neither side — mirroring upstream's own ungated
readers. **Consequence:** reads vote per interface block (the text about to be parsed) while
form-dependent writes scan the whole config once and latch, exactly the DR-099/`resolveVrfForm`
precedent, so a dry-run batch costs one config read; the floor is a CLIENT convention only — a device
older than it answers its own `CommandError` (DR-032), no EOS grammar is claimed from unit tests, and
M12 (#14) owns what cEOS-lab 4.28.14M and the 7050TX-64 actually spell. §5 row 213.
### DR-117 — a vrrp dry run is a typed command value, and the executed verb resolves to that same value (W3c #51)
Upstream's setters have two return shapes: the formatted string when `run=False` (`:503` and its
`if run:` twins, `:767`/`:1190` for the diffing verbs) and `True`/`self.error` when they run — `False`
plus a stashed `.error` on failure, row 2's family. `_vrrp_set` runs a whole transaction built from
`run=False` legs (`:1241-:1412`), so upstream's own create path depends on the dry-run half. Here every
setter `async`-resolves to what it composed (the string, or the sorted list for `setSecondaryIps` and
`setTracks`) and executes unless `options.run === false`; a failure rejects (DR-005). **Consequence:**
the UI can stage a device change, show the exact line staging, and still never mistake a stale or
blank panel for success — there is no falsy success value to forget and no `.error` side channel to
remember; the two multi-command verbs resolve to a LIST, so a caller cannot mistake "the opener was
sent" for "nothing happened" (row 221 pins that wire shape). §5 row 214.
### DR-118 — negation is a mode; `create`'s sentinel bag is kept verbatim, with exactly one widening (W3c #51)
`disable=True`/`default=True` kwargs become `{ mode: 'no' | 'default' }` (DR-037), and `VrrpAttrs`
keeps upstream's in-bag sentinel spellings because `_vrrp_set` dispatches on them: `('no', None)` for
twelve properties and `('no', False)` for `preempt` (`:1248`, `:1261`, `:1273`, `:1286`, `:1305`,
`:1322`, `:1341`, `:1353`, `:1369`, `:1385`, `:1404`), with `'default'` the next arm. The deprecated
falsy fall-through is NOT reproduced (row 73): `command_builder`'s `else:` (`abstract.py:158-:161`)
would negate `set_description`/`set_bfd_ip` on an empty value upstream composes happily. The one
deliberate widening is `preempt: null` in a create bag: upstream's tuple does not list `None`
(probe: `None in ('no', False)` is False), so `None` reaches `set_preempt`'s strict guard
(`:886-:888`) and raises `ValueError` — this client routes null to the same negate arm as `'no'`/`False`
and pins the resulting `no vrrp N preempt` text. **Consequence:** the widening is a CLIENT refusal-free
path, not a device claim: the line still goes to the image for judgement (DR-032), the divergence is
pinned instead of asserted sane, and the pair `VRID/primary-ip` refusals in DR-119 stay refusals.
§5 row 215.
### DR-119 — where `vrrp` upstream crashes or interpolates `None`, this client refuses naming the pair (W3c #51)
`set_primary_ip`'s negation arms read the current address with no guard — `vrrps = self.get(name)` then
`vrrps[vrid]['primary_ip']` (`:528-:529`, `:535-:536`): an interface with no vrrps is
`TypeError: 'NoneType' object is not subscriptable`, an absent vrid a `KeyError`, and a pair with no
primary ip composes the literal wire text **`no vrrp 10 ip None`** through `'%s'` interpolation
(`:531-:533`, `:538-:540`). Two more accidents sit next to them: `set_primary_ip` with no value and no
mode negates through its own default kwarg (`:534`), and `set_description` with no value composes
`no vrrp 10 description` (the falsy fall-through). `currentPrimaryIp` refuses all three shapes with
`NotFoundError` naming `interface/vrid`, and an omitted value with no mode refuses in both verbs.
**Consequence:** a config write that would have shipped garbage is a client-side rejection with a
readable cause and zero device traffic (pinned: the refusal tests assert the transport saw reads only),
which is the honest state for a destructive-capable UI action; the refusal is not evidence that the
device would have refused the same text, and no `CommandError` is invented on its behalf. §5 row 216.
### DR-120 — the vrrp guards police grammar, not device bounds (W3c #51)
Upstream validates nothing about a VRID (`"%d"` at `:436`/`:458`, the enable stems `:482-:489`, read back
as `(\d+)` at `:200`) and validates numbers by coercion: `int(value)` INSIDE the condition (`:792`,
`:843`, `:927`, `:969`, `:1011`) lets a numeric string through a guard that reads like a type check,
priority instead uses `str(value).isdigit()` plus `1..254` (`:584`), and three guard messages say
"0-3600" while their code tests `>= 1` (`:928-:929`, `:970-:971`, `:1012-:1013`) — the code wins, and the
port keeps that asymmetry rather than the prose. `assertVrrpId` requires exactly the grammar the round
trip supports (non-negative integer; `vrid 0` is accepted and read back by the census); numeric fields
require `Number.isInteger` inside upstream's own ranges; ip-address fields keep upstream's dotted-quad
regex (`:541`, `:731-:732`, `:1214`) WITHOUT octet bounds. **Consequence:** nothing here claims an EOS
limit — whether the image caps VRIDs, octets or the delay ranges is a device answer (DR-032), so the
guards exist to keep the composed command and the census readable, and every refusal is a
`NotSupportedError` the UI can show without implying the switch agreed or disagreed. §5 row 217.
### DR-121 — the vrrp read model and `vrconf_format` are ported as upstream's, contradictions included (W3c #51)
Upstream's `Vrrp(EntityCollection)` (`:167`) does not honour the contract its verbs use: `get` takes an
interface and answers a per-vrid dict (`:174-:229`), `create`/`delete`/`default` take the pair
(`:391`, `:418`, `:439`), its readers answer four kinds of nothing (`None` for eight scalars, `''` for
`description` `:317` and for no `bfd ip` line `:343`, the empty-group `None` for a BARE
`vrrp N bfd ip` line `:338-:342`, `[]` for the two lists), and `vrconf_format` — the helper PLAN §4
asked to keep as surface — contradicts its own parsers: `description` normalises to `None` (`:1442-:1443`)
where the parser answers `''` (`:317`), `preempt` normalises only `('no', 'default')` so `None` rides
through unnormalised (`:1460`), every scalar key is indexed unguarded (`KeyError` on a partial bag,
`:1436`-`:1477`) while the two list keys are `in`-guarded (`:1446`, `:1473`), and both sorts key on
`(name, action)` alone (`:388`, `:1473-:1475`) so equal keys keep input order. **Consequence:** the pair
identity becomes the two-level `Map` (absent-optional fields where upstream answers `None`, `string |
null` where it has three answers), and the formatter is NOT reconciled with the parser — a round-trip
validator built on it behaves like pyeapi's, which is its documented purpose ("validating updated vrrp
configurations", `:1430`); the only softening is type-honest (optional keys pass through instead of
raising), never a re-normalisation. §5 rows 218/224.

### DR-122 — the capture lab is a provisioned switch, not a bare container: staging-then-commit setup with abort semantics, a deliberately-pending session, and capability negatives kept as findings (#62)
The 2026-11-06 re-capture proved an unconfigured node records mostly-empty models (`interfaceStatuses: {}`,
`{"portChannels": {}}`, empty `switchports`) — the exact shapes that would have baked fictional field sets
into UI ShowContracts (DR-043's pattern, at the capture layer). The #62 batch therefore makes `lab:up`
apply a **representative config** before anything is read: vlans 10/100/110 (+names in `vlan` sub-mode —
SVI-stanza `name` is `% Invalid input` on 4.28.14M), one routed L3 access port (Ethernet1 + VRRP/ACL
attachment lines), Po1 LACP trunk (native 10, allowed 100-110, `switchport trunk group LABGRP`), Eth2 as
an inactive member, two SVIs, a static route, an `ntp server`, STD+EXT ACLs, and `spanning-tree` touched
(MST0 present after `spanning-tree`); MLAG stays OFF on a single node (#84's foot-gun rule). It is staged
in the named session `lab-provision` and only `commit`s if the staging transcript shows **zero fatal `%`
errors** — EOS itself echoes `at line N`, and the transcript classifier maps each error back to its fed
line (unattributed errors stay fatal); tolerated refusals are recorded in the up JSON and in the session
transcript, never silently. On any fatal staging error the sandbox `abort`s (running-config returns to
bootstrap state — the half that DR-035 cares about) and the run refuses; there is no half-provisioned
capture. `copy running-config startup-config` is never issued (bootstrap afresh, docs/CEOS.md). A
second zero-change session (`lab-pending-capture`, staged only) is left **deliberately open** so
`show configuration sessions [+detail]` — a #62 capture feeding B4/S9's questions — lists a real session
instead of an empty map. **Answers this batch settles for cEOS** (container-only, never 7050TX evidence,
DR-043 enforced per file): `switchport trunk group` ACCEPTED on cEOS-lab 4.28.14M (item 4's cEOS half;
open item 7's `lab-provision`/pending names rode the wire fine); sessions model reports
`maxOpenSessions: 5` / `maxSavedSessions: 1` and no start-time-family key in the sessions entry (item 8's
"related known-unknown" gets its cEOS answer; the 4.28.13.1M half stays in #14 §3); `ip routing`, SVI
`vrrp … ip` and SVI `ip access-group …` answer `% Unavailable command (not supported on this hardware
platform)` on the container (so the provisioner keeps them as **tolerated** probes and the transcript is
the evidence); `show lag` and `show port-channel summary` stay capability negatives (cEOS-lab refuses
them — recorded as negative results, never files). **Capability claims are transport-specific on this
image:** `show port-channel detail` and `show vrrp` answered 1002 via eAPI in the 2026-11-06 pass but
reply over the container CLI — so fixture envelopes now always name their collection transport, and
capability rows must say *which* transport refused (#62 PR note; the catalog's negative semantics
unchanged). §5 row 225; harness changes in `scripts/ceos-lab.mjs` (see DR-035/DR-103/DR-104 for the
write-policy/redaction machinery this reuses).

### DR-123 — the fixtures lane may collect through the container CLI when this daemon's published port flakes; the live-test lane never may
On docker 29.9.2/this host, a cEOS container with **more than one Docker endpoint** port-flakes: the
published loopback port answers TLS on some boots and RSTs `show management api`-verified-alive servers
on others, stable across restarts and data-NIC detach, while `docker exec … Cli` and direct kernel-path
port 443 keep answering (the live kernel path is the lone Management1 address; `curl -k` to it returns
405). #62's capture batch REQUIRES extra NICs (front-panel Ethernet ports bind at boot only — a
single-endpoint cEOS has none, and connected-after-boot NICs insert nothing), so `fixtures` grew
`--capture-via=auto|eapi|cli`: after the published-eAPI probe refuses for endpoint/reachability reasons
(model/version/cert pins still enforced from the **container's own** `show version` and the anchor file),
the same `CAPTURE_CATALOG` is re-run via `Cli -p 15` inside the run-owned container. This is a transport
fallback, never an identity or consent relaxation: `cliCapture: true`, the eAPI refusal reason and the
`docker exec Cli…` transport string land in **every** fixture envelope, the identity guards re-run before
any write, and `hardwareEvidence`/path rules are untouched. The live suites and the CI live job
(`lab:run`, `cmdRun`, `*live.test.ts`) keep the strict published-eAPI path — they test THIS client's
transport stack, so a Cli fallback would prove nothing (a `lab:run` that flakes under the daemon stays a
red CI lane with the finding above as the diagnosis, not a silent fallback). `--capture-via=eapi`
restores strict fixtures behavior for trusted runners. §5 row 225; docs/CEOS.md §Manual-now records the
NIC recipe; open follow-up (filed on #14): whether live-lane provisioning should pin the endpoint order
experimentally or move CI to a daemon where single-endpoint-forward determinism holds.

### DR-124 — a physical switch becomes addressable through a second live-guard class, gated stricter than the lab class, never looser
DR-043 always separated hardware *evidence*; #14 §3 needs hardware *addressing*, and the user locked
the decision to build that lane in-repo. `live-guard.ts` therefore gains `EAPI_TARGET_CLASS=hardware`
beside `lab`: **no default hosts and no default ports** (both endpoint parts must appear in
`EAPI_ALLOW_HOSTS`/`EAPI_ALLOW_PORTS`), https-only (the insecure-http flag cannot rescue a switch
session — credentials cleartext next to a running production box), exact pins
(`DCS-7050TX-64` ∈ `HARDWARE_MODEL_NAMES`, `HARDWARE_IMAGE_VERSION='4.28.13.1M'` — never-widen
applies upward: a fix release is a new decision, not a prefix), and an `EAPI_HW_CONSENT` token that
must echo the model name (wrong box fails the echo; a leftover lab env cannot quietly become a
hardware env). The lab half of every gate is untouched, including its two crossover refusals
(`EAPI_LAB_VERSION_NOT_IMAGE`, `EAPI_LAB_MODEL_IS_HARDWARE` — the second now points at the class that
exists instead of being a dead end). Loopback for hardware is accepted only by explicit allow-list —
legitimate for an operator `ssh -L` tunnel — and the device's own `show version` answer
(`matchesDeviceIdentity`) is what finally decides, so even a mislabeled tunnel to a lab container
refuses. Scratch-interface and persistence guards are class-agnostic (`requireScratchInterface`
refused a management path on hardware in the unit matrix); `recording.ts` already carried
`'hardware'` in `TARGET_CLASSES`, so the two vocabulary layers now meet at one meaning. Mutation-
checked: disabling the consent echo, or giving the hardware lane loopback/8443 defaults, each fails
its named case (§5 row 226). Tests: `live-guard.test.ts` hardware matrix (+10).

### DR-125 — the switch capture lane lives in the live-test lane + a mechanical probe spec, not a standalone script
The hardware executors are `src/hw-inventory.live.test.ts` (batch 1 read-only: `HW_INVENTORY_CATALOG`
= the full cEOS-mirrored family set + §3's target-sensitive shows) and
`src/hw-session-probe.live.test.ts` (batches 2/3), both gated on the hardware class PLUS their own
write opt-ins (`EAPI_HW_CAPTURE=1` / `EAPI_HW_SESSION_PROBE=1`) so a hardware *readiness* run never
rewrites committed evidence — the PLAN.md:395 overwrite lineage moved onto the switch lane. They
reuse the recorder/writer pair (`buildRecording` → `sanitizeHwRecording` → overwrite-true
`writeRecording` under identity guards), live because a script re-implementing the guard checks is
exactly the drift DR-034/DR-035 forbid. Hardware-specific strictness lives in `src/testing/hw-capture.ts`:
serials under any serial-named key, MACs **anywhere** (whole values and embedded strings — closing
the cEOS lane's recorded non-`*mac*-key` gap on this lane), `secret sha512/md5`, PEM blocks, and
operator-supplied `EAPI_HW_SCRUB` literals, each rewrite logged by path-without-value; the recorder's
own enable-input gate still refuses at `recordingText`. Config-session probes run ONLY batches from a
pre-reviewed JSON spec (`docs/hw-session-probes.draft.json`, committed and parsed by
`parseHwProbeSpec`, whose own unit tests are the review surface): listener/user/management-path/ZTP/
rollback/replace/persistence lines are refused in EVERY batch, `allowCommit` is granted only to
batches that open with exactly `interface {{SCRATCH}}` and keep every other line an indented child,
and at run time a commit batch refuses if the scratch port reports `connected`/`errdisabled` —
"unused" is the operator's declaration, the link is the device's contradiction. Device refusals are
recorded as answers (which commands the SKU supports IS evidence); transport failures abort. Runbook:
[docs/HARDWARE-CAPTURE.md](./HARDWARE-CAPTURE.md). **No switch bytes exist yet — the lane is
implemented-and-waiting-for-the-session; every hardware claim in this repo stays
`hardwareEvidence:"none"` until §5 row 226's first executed run replaces it.**

### DR-126 — the full-write lab lane: `EAPI_LAB_FULL_WRITE=1` widens DR-035(b) for the throwaway container ONLY, and the self-lockout set is refused before the wire at the shared transport seam
The locked decision (2026-11-07) ports `pyeapi/test/system/*` **fully** (users, VLANs, routes,
protocols, `system` setters) against disposable cEOS. DR-035(b)'s scratch-only rule was written when
that was forbidden; it is amended, not deleted: `live-guard.ts:requireLabFullWrite(target, env)`
accepts the widening for `targetClass=lab` + `EAPI_LAB_FULL_WRITE=1` only — the hardware class gets
`EAPI_FULL_WRITE_NOT_LAB` unconditionally (its writes stay inside the `hw-session-probe` reviewed
fence, DR-125), and lab suites that do not opt in keep the old rules untouched. `EAPI_SCRATCH_VLAN`
(`requireScratchVlan`) joins `EAPI_SCRATCH_INTERFACE`: single declared spare VLAN, digits 2–4094,
VLAN 1 (the default every port starts on) and the reserved 1006–1199 window refused so the lane
cannot pass on a container and answer differently on the SKU. What the widening does NOT touch:
`live-session-policy.ts:labWriteScopeRefusal` + `withLabWriteScope` — the listener, the built-in
`admin`/`netadmin`, the API user in use, the management path and `copy run start` are self-destruct
even in a throwaway box (a killed session is a dead run), so they are refused **before**
`Transport.execute` sends anything, at the one choke point every resource facade shares — a policy
only hand-written suites remember is a policy the ported half forgets. Config-batch detection keys on
the `configure terminal|session` marker (every session batch carries its opener — documented at
`live-session-policy.test.ts`), `input` bodies are scanned line-wise, and the refusal prints the
first two words only (a staged line can carry a `secret <hash>` tail; DR-011 covers test output).
`Node.callMethod` (verifyConfig/completions/help) passes through: those verbs answer *about* commands
and never apply them. Mutation-checked: forcing the scope check to return no-refusal fails 5 named
cases; admitting VLAN 1 fails its case; admitting full-write on hardware fails its case. §5 row 227.

### DR-127 — the package name ships: `@devhax-heavy-industries/arista-eapi` closes DR-020, version 0.1.0 per DR-040, tag local, publish still off
The 0.1.0 wrap-up needed DR-020's "decision before first tag" settled, and the user chose (2026-11-08)
to keep the working name that every artifact already carries: root and client `package.json`, README
banners, the USAGE fences that `docs:check` now compiles, the webui imports, and 220+ MIGRATION/
DECISIONS references. The two DR-020 considerations survive: the scoped `devhax-heavy-industries`
org never implies an Arista package (that constraint was actually load-bearing — an unscoped
`arista-*`/`eos-*` name would), and any future webui publishing happens under the same scope.
What DR-127 does NOT do: it does not open the registry. `private: true` stays, no `npm publish` was
done, and the `v0.1.0` tag stays **local** to the working clone (the user's chosen release shape).
When publishing becomes a decision, that decision reopens naming only if the scope turns out wrong —
the name itself is no longer a blocker, the version policy (DR-040: `0.x.y`, semver at 1.0) is what
governs bump semantics from here. `CHANGELOG.md` (Keep a Changelog) now exists and 0.1.0 is its
first stamped entry; the pyeapi-divergence pointer convention from DR-040 is honored by linking the
migration rows instead of restating each rename. Supersedes nothing; closes DR-020's OPEN marker
without rewriting its text.

### DR-128 — the lab endpoint is a harness-owned loopback relay, the live child gets the full TLS trust triple, and the hardware lane is EXCLUDED from the CI live job, never skipped
The first EXECUTED run of the live corpus (2026-11-08, WSL2 restart, docker 29.9.2 / kernel
6.18.33.2-microsoft-standard-WSL2) exposed two stacked host facts and one lane-convention gap,
each now closed mechanically.

**(a) No Docker publish, ever, for the lab lane.** Docker's `-p 127.0.0.1:N:443` resolved its
`docker-proxy` target to the run's **data1** bridge endpoint (`-container-ip 172.19.0.2` observed in
the proxy cmdline) even in the vendor-shaped single-create-attach topology DR-122's note leaned on —
cEOS owns those data NICs as front-panel Ethernet with no eAPI listener, so every handshake
ECONNRESET'd at the Docker hop while EOS itself served on the mgmt bridge (`Hits: 0, Bytes in: 0`
server-side; a host-direct connect to the mgmt-bridge IP answered normally). The CLI has no way to
qualify `-p` with the container endpoint, so `createArgs` dropped the publish entirely and `up` now
starts `scripts/eapi-port-forward.mjs`: a detached, **literal-127.0.0.0/8-bind-only**, pure-byte relay
to the mgmt address the harness itself pinned (`forwarderPid` in state schema 3, timeout-path and
teardown SIGTERM behind a `/proc/<pid>/cmdline` ownership check, 3 h max-life and 60 m idle
self-exits, and a state-file watch so an orphan can never outlive its run nor its credentials).
A byte relay adds no TLS peer: the pinned container certificate still verifies byte-for-byte through
it, and probe refusals now print the attribution mechanically (relay-vs-direct cert peeks +
forwarder liveness). The first probe against a just-booted node is expected to absorb
`upstream error … ECONNREFUSED` while CApi binds — it recovered at 30.5 s in run 9; readiness stays
EOS-side, not Docker-side (DR-034 unchanged).

**(b) The live child gets the trust TRIPLE.** cEOS's `capi.pem` ships `subject CN=self.signed` and
**no subjectAltName whatsoever**, and this client deliberately never lets a fingerprint pin waive
hostname verification (`node-tls.ts`), so the previous CA-only alias failed **every** live suite with
`Hostname/IP does not match altnames: IP: 127.0.0.1 is not in the cert's list`. `childEnv` now
aliases `EAPI_CA_FILE` + `EAPI_FINGERPRINT` (the run's own anchor fp) + `EAPI_SERVER_NAME` (the CN
read out of the container's own file — Node's name check falls back to the subject CN only for a
DNS-shaped authority, which is why the CN must ride as the identity). Trust is chain + exact pin +
CN — strictly stronger than the harness probe's own posture (DR-013 tightened, not relaxed;
`EAPI_INSECURE_TLS` stays refused). Suites self-report `tls=pinned`.

**(c) CI live lane = exclude the hardware runners.** `src/hw-inventory.live.test.ts` and
`src/hw-session-probe.live.test.ts` (DR-124/DR-125) require supervised `EAPI_TARGET_CLASS=hardware`
consent no CI job can hold; `assert-live-run.mjs`'s zero-skip rule correctly refused them as
*skipped* on an executed-green corpus. The workflow now passes `--exclude 'src/hw-*.live.test.ts'`:
every test the job CAN run must EXECUTE and pass, "skipped" keeps its "something went wrong" meaning,
and the local `npm run test:live` target keeps those two files' loud skips. DR-125's "hardware never
runs in CI" now has a gate shape. Run 10 (CI shape, `--quiet`) is the referenced execution; §5 row
230 records what the executed corpus found (default-body materialisation across bgp/vrrp/staticroute,
the one-line preempt-delay fold, `next-hop-self` sub-feature renderings, committed-named-session name
reuse, and the pyeapi `portfast edge` pair that re-types itself — upstream parity kept, expectations
re-pinned to the device's own words).

### DR-129 — the mgmt bridge's subnet is create-verified-retried against LIVE host routes, the pool gained a 10.177 band, and a mid-run route deletion fast-fails the probe
The first trusted `workflow_dispatch` (actions run 42525119847, this repo, label `eos-lab`) died the way
local runs 10-11 had: `EHOSTUNREACH` at the relay's upstream socket — but the runner's own machine was
fresh (container booted, CLI answered, cert anchor written), and `ip route get 172.31.193.10` on that
host resolved **via the LAN default gateway**, not the just-created bridge. Root cause: WSL >=2.6
**mirrored-mode** networking keeps Windows authoritative over `172.16.0.0/12`-class space; its route
reconciliation (and HNS's own /24 allocations inside that band) can void the kernel route a new Docker
bridge settles — deterministically per-subnet-lucky (.70/.132/.189 fine, .159/.193 class dead), which
no retry of the published-port path or single-band picker can out-guess. Decision (harness-side,
`scripts/ceos-lab.mjs`): (1) the picker yields candidates band-major — documented `172.31.16-255`, then
`10.177.16-255` — still filtered against docker networks AND host route/addr CIDRs; (2) `cmdUp` creates
each candidate, **verifies** the connected route twice over (`ip route show <cidr>` must hold a
`scope link … dev br-` entry and `ip route get <mgmtIp>` must resolve `dev br-`, never `via` a
gateway), rm-s and re-draws otherwise, bounded at 40 and refusing with the reason list; (3) during
probing, after two failed handshakes the same verifier runs live and an unlive route refuses
immediately with reason `mgmt-route-lost-mid-run` (the remaining window cannot restore a deleted
kernel route), and refusal diagnostics print `route: live|BROKEN`. What this does NOT do: it does not
make a route-eating host a usable lab runner — docs/CEOS.md §mirrored-mode names the fixes
(`[wsl2] networkingMode=NAT` + `wsl --shutdown`, or a native Linux host for the `eos-lab` runner);
the endpoint contract (relay, loopback, locks, TLS triple) is untouched, and the refusal reuses
`EXIT.readiness` because no container is started and no eAPI call is attempted until the path is
proven. Evidence: create-verify retry proven against the live host on the dispatch branch; the failed
dispatch log is itself the poisoned-case record.

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
   `show interfaces switchport json` actually return? **(cEOS half settled 2026-11-07: the command is
   ACCEPTED on cEOS-lab 4.28.14M and the switchports model answers populated groups for configured
   ports — `show-interfaces-switchport.json`, run `lab-1899774-8d6173`, DR-122. The 7050TX-64 half stays
   open and is a #14 §3 line.)**
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
   M13 (#15)'s transaction UI offers the verbs. **(cEOS half of the field-set question settled
   2026-11-07: `show configuration sessions` reports `maxOpenSessions: 5` / `maxSavedSessions: 1`, and a
   listed pending session's entry carries `instances/state/commitUser/description` with no start-time
   key — `show-configuration-sessions[.detail].json`, run `lab-1899774-8d6173`, DR-122. The boundary and
   `no-commit`/rollback-verb attempts still need the authorized scratch session on both targets.)**

MLAG (`mlag` module, 21 upstream system tests): investigate supported control-plane
behavior in an isolated two-node cEOS topology. Physical 7050TX-64 MLAG/forwarding
validation still needs a second physical device; do not mark it verified from containers.

10. **The operator's own `eapi.conf` on the target**: does `/mnt/flash/eapi.conf` exist on the 7050TX-64 (and
    in cEOS), and which keys and transport spellings does it actually carry? DR-045's report and DR-046's alias
    table were written against this machine's `configparser` and pyeapi's fixtures — capture the device file in
    M12 (#14) and diff both against the image's own Python before claiming parity for hand-edited device files.
