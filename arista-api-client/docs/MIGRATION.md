# pyeapi → TypeScript map

How to read this file: it is the translation contract. If you know pyeapi, every row tells you where
its behaviour lives in the TS client, what it is called, and — where the behaviour differs — why
(link to a decision in [DECISIONS.md](./DECISIONS.md)). When a module is finished, its row in
[STATUS.md](./STATUS.md) flips to `done`; this file is the authority on naming and semantics.

Baseline: pyeapi **1.0.4-rc0**, `/home/svaj/development/arista/pyeapi` @ `6816d9e`.

---

## 1. File-level map

| pyeapi file | LOC | TS target | Milestone | Wave |
|---|---|---|---|---|
| `pyeapi/eapilib.py` | 757 | `src/internal/wire.ts` (codec), `src/internal/redact.ts`, `src/errors.ts`, `src/transports/*` | M1, M2 | 1 |
| `pyeapi/client.py` — `Config`, `connect*`, `config_for`, `hosts_for_tag` | ~320 | `src/profiles.ts` (Node entry only) | M3 | 1 |
| `pyeapi/client.py` — `Node` | ~570 | `src/node.ts` | M4, M5 | 1 |
| `pyeapi/client.py` — `_chunkify`, `section` | ~90 | `src/internal/config-text.ts` | M6 | 1 |
| `pyeapi/utils.py` | 304 | `src/internal/ranges.ts`, `src/internal/collections.ts`, `src/internal/variants.ts` | M6, M7 | 1 |
| `pyeapi/api/abstract.py` | 224 | `src/resources/base.ts` | M7 | 1 |
| `pyeapi/api/system.py` | 186 | `src/resources/system.ts` | M8 | 1 |
| `pyeapi/api/vlans.py` | 372 | `src/resources/vlans.ts` | M9 | 1 |
| `pyeapi/api/switchports.py` | 417 | `src/resources/switchports.ts` | M9 | 1 |
| `pyeapi/api/interfaces.py` | 1,101 | `src/resources/interfaces/{index,base,ethernet,port-channel}.ts` (+ `vxlan.ts` wave 3) | M10 | 1 |
| `pyeapi/api/users.py` | 328 | `src/resources/users.ts` | W2 | 2 |
| `pyeapi/api/acl.py` | 303 | `src/resources/acl/{index,standard,extended}.ts` | W2 | 2 |
| `pyeapi/api/stp.py` | 367 | `src/resources/stp.ts` (+ `stp-interfaces.ts`, `stp-instances.ts`) | W2 | 2 |
| `pyeapi/api/mlag.py` | 302 | `src/resources/mlag.ts` | W2 | 2 |
| `pyeapi/api/varp.py` | 213 | `src/resources/varp.ts` (+ `varp-interfaces.ts`) | W2 | 2 |
| `pyeapi/api/ipinterfaces.py` | 268 | `src/resources/ip-interfaces.ts` | W2 | 2 |
| `pyeapi/api/vrfs.py` | 343 | `src/resources/vrfs.ts` | W2 | 2 |
| `pyeapi/api/staticroute.py` | 384 | `src/resources/static-routes.ts` | W2 | 2 |
| `pyeapi/api/ntp.py` | 208 | `src/resources/ntp.ts` | W2 | 2 |
| `pyeapi/api/ospf.py` | 362 | `src/resources/ospf.ts` | W3 | 3 |
| `pyeapi/api/bgp.py` | 341 | `src/resources/bgp/{index,neighbors}.ts` | W3 | 3 |
| `pyeapi/api/routemaps.py` | 357 | `src/resources/route-maps.ts` | W3 | 3 |
| `pyeapi/api/vrrp.py` | 1,493 | `src/resources/vrrp.ts` (+ `vrrp-config.ts` for `vrconf_format`) | W3 | 3 |
| `pyeapi/__init__.py` | — | `src/index.ts` re-exports | M0 | 1 |
| test/unit, test/system, test/fixtures | 10k | `src/**/*.test.ts`, `src/**/*.live.test.ts`, `test/fixtures/` | per module, M12 | 1 |

Nothing from `pyeapi/docs/` (RST) or `examples/` is ported; USAGE.md is written fresh.

---

## 2. Core symbol map

| pyeapi | TypeScript | Notes |
|---|---|---|
| `client.connect(...)` | `createConnection(options)` / `createNode(options)` | no positional args, no `**kwargs`; `return_node` disappears — pick the function |
| `client.connect_to(name)` | `createNodeFromProfile(name)` | Node entry only (DR-038) |
| `client.make_connection(transport, **kw)` | `createTransport(options)` | exhaustive switch over `TransportKind`, no string dict |
| `client.config` (module singleton) | `loadProfiles()` returning a `ProfileStore` | no import-time filesystem side effect — pyeapi's `Config()` autoloads at import (`client.py:318`) |
| `client.Config.get_connection` | `ProfileStore.get(name)` | |
| `client.hosts_for_tag` | `ProfileStore.hostsForTag(tag)` | |
| `client.Node` | `Node` class | |
| `Node.connection` (with `.error`) | `Transport` — errors are thrown, no `.error` (DR-005) | |
| `Node.running_config` / `startup_config` | `getRunningConfig()` / `getStartupConfig()` | async, cached, `invalidate()` via `refresh()` |
| `Node.version`, `version_number`, `model` | `getVersion()` → `{version, versionNumber, model}` | one round trip, memoised (pyeapi calls `show version` three times lazily) |
| `Node.enable_authentication(pw)` | `node.setEnablePassword(pw)` | DR-009 |
| `Node.enable(cmds, strict, send_enable)` | `node.exec(cmds, { tolerateErrors, sendEnable })` | DR-012, no `response` key (DR-007) |
| `Node.run_commands` | `node.runCommands` | returns `result[]` only |
| `Node.config(cmds)` | `node.configure(cmds)` | throws (no bool return) |
| `Node.section(regex, config)` | `node.configSection(pattern, { source })` | throws `NotFoundError` (DR-027) |
| `Node.get_config(config, params, as_string)` | `node.getConfig({ config, params, as })` | |
| `Node.refresh()` | `node.refresh()` | |
| `Node.api(name)` | `node.vlans` … / `node.resource(name)` | DR-006 |
| `Node.configure_session/diff/commit/abort` | `node.configSession()` → `ConfigSession` object with `.diff() .commit() .abort()` | DR-022…DR-025; **new**: `listSessions`, `abortSession`, `configureReplace`, `writeMemory` |
| `eapilib.EapiConnection.request` | `buildRequest()` (pure) | DR-016, DR-017 |
| `eapilib.EapiConnection.send` | `Transport#execute` internals | DR-010…DR-013 |
| `eapilib.EapiConnection.execute` | `Transport#execute` | |
| `eapilib._parse_error_message` | `parseErrorEnvelope()` | handles both `data[]` and `errorDetail` shapes |
| `eapilib._sanitize_request` / `_find_sub_json` | `redactSecrets()` — narrow, purpose-built | DR-011; generic JSON matcher **not** ported |
| `eapilib.CommandError/ConnectionError/EapiError` | `CommandError` / `TransportError`(+`AuthError`,`TlsError`,`ConnectError`,`TimeoutError`) / `EapiError` | DR-010 |
| `SocketEapiConnection` etc. (7 classes) | `unixSocket`, `httpLocal`, `http`, `https`, `httpsClientCert`, `httpSession`, `httpsSession` transports | DR-014, DR-018 |
| `abstract.BaseEntity` | `ResourceBase` | |
| `abstract.Entity` | `EntityResource<T>` (`get()`) | drop `__call__` |
| `abstract.EntityCollection` | `CollectionResource<T, K>` (`getAll/get/create/delete/defaults`) | drop `Mapping`/`__len__`/`__iter__` |
| `abstract.configure` | `ResourceBase#configureUnsafe()` — internal | bool return dropped |
| `abstract.command_builder` | `cmd(string, { mode })` | DR-037 |
| `utils.make_iterable` | `toArray()` at explicit boundaries | DR-041 |
| `utils.expand_range` / `collapse_range` | `expandRange` / `collapseRange` | |
| `utils.CliVariants` | `tryVariants()` | DR-006 |
| `utils lookahead / debug / islocalconnection / load_module / import_module` | not ported | DR-041 |

---

## 3. Resource verb conventions

pyeapi's resource verbs keep their names in TS — only the *shape* changes. This keeps the upstream unit
tests portable by behaviour and keeps MIGRATION rows 1-word different.

| pyeapi pattern | TS | Example |
|---|---|---|
| `getall()` | `getAll(): Promise<Record<K, T>>` | `vlans.getAll()` |
| `get(name, default=None)` | `get(k): Promise<T \| undefined>` | `vlans.get(20)` |
| `create(name, **attrs)` | `create(k, attrs?)` | `vlans.create(20, { name: 'PROD' })` |
| `delete(name)` / `default(name)` | `delete(k)` / `setDefault(k)` | |
| `set_x(name, value=…, default=…, disable=…)` | `setX(k, value)` · `unsetX(k)` · `defaultX(k)` | `switchports.setAccessVlan('Et1', 20)` |
| `add_x` / `remove_x` | `addX` / `removeX` | `vlans.addTrunkGroup` |
| `_parse_*(config)` | internal pure parsers, unit-tested directly | `_parse_trunk_allowed_vlans` → `parseTrunkAllowedVlans` |
| `isvlan(v)` / `isvalidinterface(v)` | `isVlanId` / `parseInterfaceName` → discriminated union | DR-004 |
| module-level `instance(node)` | the static accessor on `Node` | DR-006 |
| `api.py` `Acls.__getattr__` + `marshall` | explicit `acls.standard` / `acls.extended` | DR-006 |

---

## 4. Type mapping

| Python | TypeScript |
|---|---|
| `None` | `undefined` (missing key), never `null`, with `exactOptionalPropertyTypes` |
| `dict` (str→str) | `Record<string, string \| undefined>` for parsed config; a named `interface` for API results |
| `str` | `string`, or a string-literal union when EOS has a closed set (`mode: 'access' \| 'trunk' \| …`) |
| `int` | `number` — VLAN ids stay `number`, **but `switchports` keeps interface names as `string` keys** (they are not `Number.parseInt`-able) |
| `list[str]` | `string[]`; immutable-by-default at API boundaries (`readonly string[]`) |
| `**kwargs` | one `options` object per method (`{ mode, description, … }`) — never positional flags |
| bool return (`configure()` → `True/False`) | `void`, throwing on failure (DR-005) |
| lazy `@property` | explicit accessor method (DR-005) |

---

## 5. Semantic divergences worth reviewing

| # | pyeapi behaviour (ref) | TS behaviour | Decision |
|---|---|---|---|
| 1 | `enable()` returns `result` **and** `response` (`client.py:845-852`) | `result` only | DR-007 |
| 2 | `configure()` `False` + `.error` stash (`abstract.py:103`) | throws `CommandError` | DR-005 |
| 3 | `command_builder` negates on falsy `value` (`abstract.py:160-165`, deprecated) | explicit `set`/`no`/`default`; bad input throws | DR-037 |
| 4 | 1003 → silent text retry when `strict=False` (`client.py:860-874`) | retry kept, `tolerateErrors: true` default | DR-012 |
| 5 | password leak in messages for codes ≠ 1005 (`eapilib.py:107-121`) | redacted for all codes, plus logs/fixtures | DR-011 |
| 6 | `reqid = id(self)` (`eapilib.py:347`) | `<clientId>-<seq>` | DR-017 |
| 7 | https transport disables cert verification by default (`eapilib.py:678-701`) | verify on; explicit pin/CA; loud opt-out | DR-013 |
| 8 | implicit socket localhost profile (`client.py:214-221`) | not created outside Node; unauthenticated local access is opt-in | DR-008 |
| 9 | session name = `uuid4()`, unfindable after a crash (`client.py:1003`) | named + journaled + `listSessions()`/`abortSession()` | DR-022, DR-023 |
| 10 | `diffs` sent with json encoding by the generic path | forced `format:'text'` (1003 otherwise) | DR-012 |
| 11 | no way to persist config | `copyRunningToStartup()` explicit | DR-024 |
| 12 | `_chunkify` unbounded `lru_cache` (`client.py:698`) | single hash-keyed memo, invalidated on refresh | DR-026 |
| 13 | `section()` raises `TypeError` for "not found" (`client.py:794`) | `NotFoundError`; resources return `undefined` | DR-027 |
| 14 | `switchports` `name=` fallback hack (`switchports.py:147-151`) | kept, guarded, documented as a known upstream defect | DR-029 |
| 15 | running-config re-read for every resource call (`abstract.py:75`) | snapshot per operation; `withConfigSnapshot()` batching | DR-030 |
| 16 | `MULTILINE:` pseudo-syntax inside command strings (`client.py:900-906`) | `{cmd, input}` objects with explicit `EOF` | DR-015 |
| 17 | `EapiConnection.execute` stores last error on the connection | nothing stashed; errors propagate | DR-005 |
| 18 | `streaming` silently added to every request (`eapilib.py:360`) | not sent; `runCmds` kwarg is unused server-side | DR-016 |
| 19 | 1000/1001/1002/1004 render `… [<command_error>]`; with no `error.data` Python interpolates the literal `None` → `Error [1000]: msg [None]` (`eapilib.py:106-110`) | brackets omitted entirely when `commandError` is absent; the `[…]` suffix still appears byte-for-byte when data exists | M1 (#3) — `[]`/`[None]` matched nothing in a device log and made the text harder to diff against EOS output |
| 20 | `get_trace()` pairs commands with output, then appends the never-ran tail **only if `index:` is truthy** (`eapilib.py:130-143`, guard at 138) — so when exactly one command produced output (`index == 0`) commands 2..N vanish from the trace | every command is always represented: paired with its output, or listed with `output: undefined` | M1 (#3) — a 1-of-N failure is the common case and losing the tail hides which commands never ran |

---

## 6. Test map (upstream → ours)

Naming rule for the ported tests: `TestEthVlan::test_get_name` (pyeapi) →
`it('get: name')` inside `describe('vlans', …)` in `src/resources/vlans.test.ts`. Where pyeapi asserts
a returned `False`, ours asserts a thrown `CommandError` with the same command list.

| pyeapi unit test | methods | TS test file | Ours (planned) |
|---|---|---|---|
| `test/unit/test_eapilib.py` | 38 | `src/internal/wire.test.ts`, `src/errors.test.ts`, `src/transports/*.test.ts` | ~55 |
| `test/unit/test_client.py` | 53 | `src/node.test.ts`, `src/node.session.test.ts`, `src/profiles.test.ts` | ~48 |
| `test/unit/test_utils.py` | 15 | `src/internal/ranges.test.ts`, `…/variants.test.ts` | ~26 (incl. property tests) |
| `test/unit/test_api_system.py` | 5 | `src/resources/system.test.ts` | ~12 |
| `test/unit/test_api_vlans.py` | 15 | `src/resources/vlans.test.ts` | ~22 |
| `test/unit/test_api_switchports.py` | 21 | `src/resources/switchports.test.ts` | ~26 |
| `test/unit/test_api_interfaces.py` | 72 | `src/resources/interfaces/*.test.ts` (4 files) | ~75 |
| — (framework) | — | `src/resources/base.test.ts` | ~15 |
| — (chunkify, upstream-weak) | — | `src/internal/config-text.test.ts` | ~25 |
| `test/unit/test_api_*.py` (W2/W3, 9 modules) | 186 | matching `src/resources/*.test.ts` | ~230 |
| `test/system/*` (284 methods) | | `src/**/*.live.test.ts` (subset, gated) | ~70 |

Total planned offline tests for wave 1 + framework: **~300**; wave 2 adds ~230.

---

## 7. Dropped on purpose

Each with the upstream location it came from, so a reader can confirm nothing was missed by accident.

| Dropped | pyeapi ref | Why | Decision |
|---|---|---|---|
| `Node.api()` string autoload, `utils.load_module`/`import_module` | `client.py:927`; `utils.py:60-108` | No runtime import in a bundled browser app; typed accessors are better | DR-006 |
| Duplicate `response` key | `client.py:845-852` | Upstream calls it an error, slated for removal | DR-007 |
| `.error` property on `BaseEntity`/`EapiConnection` | `abstract.py:79`, `eapilib.py:285` | Swallowed failures; TS uses exceptions | DR-005 |
| Negation-by-falsy `value` in `command_builder` | `abstract.py:160-165` | Deprecated upstream with a commented-out `ValueError` | DR-037 |
| `_find_sub_json` general JSON matcher | `eapilib.py:502-566` | Only consumer is secret redaction; needs a 10-line purpose-built function | DR-011 |
| `utils.debug`, `islocalconnection`, `lookahead`, `_interpolate_docstr`, `ProxyCall` | `utils.py:109-277` | Python/doc-generation scaffolding | DR-041 |
| `streaming: false` field added to every request | `eapilib.py:360` | Server kwarg documented `Unused. # BUG652139`; changes envelope shape | DR-016 |
| `enforce_verification`, `context=` SSL knobs | `eapilib.py:676-687` | Replaced by explicit trust options | DR-013 |
| `DEFAULT_HTTPS_LOCAL_PORT = 8443` | `eapilib.py:63` | No such listener in 4.28.13.1M | DR-014 |
| `SocketConnection`/`HTTPSConnection` subclasses | `eapilib.py:170-273` | `http.client` plumbing; replaced by `fetch`/`node:tls` transports | DR-002 |
| `__getattr__`+`marshall` attribute fakery (`Acls`, `Interfaces`) | `acl.py:114`, `interfaces.py:117` | Uninspectable at compile time | DR-006 |
| `EntityCollection` `Mapping` protocol (`len()`, iteration, `[]`) | `abstract.py:198-224` | No operator overloading in TS; explicit `getAll()`/`has()` | DR-004 |
| `ConfigParser` INI at import time (module-global `config`) | `client.py:127-318` | Side effects on import; Node-only, explicit | DR-038 |
| `EapiError.message`/`commands` mutable attributes | `eapilib.py:84`, `client.py` `execute` | Errors are immutable in TS | DR-005 |

**Kept as-is even though surprising** (documented in the module they live in): the
`forwarding:trunk:allowed-vlans` parse path (DR-028), the `name=` switchports fallback (DR-029), the
`_chunkify` special cases for `banner`/`code unit` (M6), `vlans._parse_vlan_id` returning `None` on a
non-numeric name (DR-027), pyeapi's `Error [code]: msg [err]` message rendering (M1).

---

## 8. Adding the next module — checklist

1. Read the pyeapi module + its `test/unit/test_api_*.py` **first**; list every verb and the exact
   command strings the tests expect. Add the list to this file (§1 row → `planned`).
2. Decide the read strategy: model-backed `show` vs config text (DR-031), and say which in the module
   header comment.
3. Write the types (`interface XyzEntry`), the parsers (pure, no I/O), then the resource class.
4. Port the unit tests one verb at a time; where pyeapi asserted `False`, assert the thrown error.
5. Add a `*.live.test.ts` pair (read + write in a named session) and mark it gated (DR-034/DR-035).
6. Update [STATUS.md](./STATUS.md), this file's §5 if behaviour differs, and USAGE.md with one example.
7. Update the corresponding GitHub issue and check the milestone box in [PLAN.md](./PLAN.md).
