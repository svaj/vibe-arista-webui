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
| `pyeapi/client.py` — `Node` | ~570 | `src/command-layer.ts` (the class; `src/node.ts` is the Node-runtime **entry** and re-exports it) | M4, M5 | 1 |
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
| 1 | `enable()` returns `result` **and** `response` (`client.py:845-856` — the deprecation note at 845-848, both keys emitted at 853-856) | `result` only | DR-007 |
| 2 | `configure()` `False` + `.error` stash (`abstract.py:103`) | throws `CommandError` | DR-005 |
| 3 | `command_builder` negates on falsy `value` (`abstract.py:160-165`, deprecated) | explicit `set`/`no`/`default`; bad input throws | DR-037 |
| 4 | 1003 → silent text retry when `strict=False` (`client.py:860-874`) | retry kept, `tolerateErrors: true` default | DR-012 |
| 5 | password leak in messages for codes ≠ 1005 (`eapilib.py:107-121`) | redacted for all codes, plus logs/fixtures | DR-011 |
| 6 | `reqid = id(self)` (`eapilib.py:354`) | `<clientId>-<seq>` | DR-017 |
| 7 | https transport disables cert verification by default (`eapilib.py:678-701`) | verify on; explicit pin/CA; loud opt-out | DR-013 |
| 8 | implicit socket localhost profile (`client.py:214-221`) | not created outside Node; unauthenticated local access is opt-in | DR-008 |
| 9 | session name = `uuid4()`, unfindable after a crash (`client.py:1003`) | named + journaled + `listSessions()`/`abortSession()` | DR-022, DR-023 |
| 10 | `diffs` sent with json encoding by the generic path | forced `format:'text'` (1003 otherwise) | DR-012 |
| 11 | no way to persist config | `copyRunningToStartup()` explicit | DR-024 |
| 12 | `_chunkify` unbounded `lru_cache` (`client.py:698`) | single hash-keyed memo, invalidated on refresh | DR-026 |
| 13 | `section()` raises `TypeError` for "not found" (`client.py:794-795`) | `NotFoundError`; resources return `undefined` | DR-027 |
| 14 | `switchports` `name=` fallback hack (`switchports.py:147-151`) | kept, guarded, documented as a known upstream defect | DR-029 |
| 15 | running-config re-read for every resource call (`abstract.py:75`) | snapshot per operation; `withConfigSnapshot()` batching | DR-030 |
| 16 | `MULTILINE:` pseudo-syntax inside command strings (`client.py:909-911`, comment at 901-908) | `{cmd, input}` objects with explicit `EOF` | DR-015 |
| 17 | `EapiConnection.execute` stores last error on the connection | nothing stashed; errors propagate | DR-005 |
| 18 | `streaming` silently added to every request (`eapilib.py:355` popped from kwargs, `:364` written into the envelope) | not sent; `runCmds` kwarg is unused server-side | DR-016 |
| 19 | 1000/1001/1002/1004 render `… [<command_error>]`; with no `error.data` Python interpolates the literal `None` → `Error [1000]: msg [None]` (`eapilib.py:106-110`) | brackets omitted entirely when `commandError` is absent; the `[…]` suffix still appears byte-for-byte when data exists | M1 (#3) — `[]`/`[None]` matched nothing in a device log and made the text harder to diff against EOS output |
| 20 | `get_trace()` pairs commands with output, then appends the never-ran tail **only if `index:` is truthy** (`eapilib.py:130-143`, guard at 138) — so when exactly one command produced output (`index == 0`) commands 2..N vanish from the trace | every command is always represented: paired with its output, or listed with `output: undefined` | M1 (#3) — a 1-of-N failure is the common case and losing the tail hides which commands never ran |
| 21 | Below JSON-RPC there are exactly two failure channels: an `OSError` → `ConnectionError(…, 'Socket error during eAPI connection: …')`, and a `ValueError` → `ConnectionError(…, 'unable to connect to eAPI')` **after** the body has been JSON-parsed (`eapilib.py:473-483`, with the 401 branch firing earlier at `:450-452`, all folded into one `ConnectionError` — the class itself at `:147-167`). A typo'd password and a proxy answering `GET` therefore report the same "unable to connect", and the HTTP status is lost | the status line is classified **before** the body is touched, and the failure keeps the facts a UI needs: `status`, `endpoint`, and `retryable` (`true` = nothing reached the device, so a re-send is safe; `false` = it may already have executed — for a config write that is the only answer that matters) | DR-019 (`src/transports/error-map.ts`) — `retryable` also decides whether the client may retry for itself |
| 22 | `timeout=60` is **seconds** — the default threads through the factory and every connection constructor (`eapilib.py:68-69`, `:172`, `:705`, and `client.py`) | `timeoutMs`, default **60 000 ms**, per transport and per call; distinct from the server-side `requestTimeout` runCmds param, which is still seconds | DR-019 — an unlabelled number invites the wrong unit |
| 23 | `http_session` and `https_session` are two classes differing only in the `http.client` base they mix in — two bodies that are literally `pass` (`eapilib.py:752-757`) | one `session` kind; the scheme comes from the endpoint | DR-002 — keeps the `TransportKind` switch exhaustive without duplicating a class per scheme |
| 24 | `path` is accepted by the connection constructor (`eapilib.py:654`, `:664`, `:674`) and then hard-coded to `POST /command-api` in `send()` (`:432`), so the option silently does nothing | `path` is honoured, and `baseUrl` (optionally with a path prefix) is added for the same-origin dev-proxy topology | DR-036 — an option that does nothing is a worse default than one that fails loudly |
| 25 | `HttpsEapiCertConnection.__init__` raises `ValueError` when `key_file` or `cert_file` is missing (`eapilib.py:706-709`); `HTTPSCertConnection` at `:215` is the lower `http.client` subclass and does not check them | `TypeError` at construction | M2 (#4) — "you handed me half an mTLS identity" is a programming mistake, not a device condition; `docs/ARCHITECTURE.md` §4 reserves `EapiError` subclasses for device/protocol conditions |
| 26 | A failed `/login` raises `ConnectionError('%s. %s' % (resp.reason, resp.read()))` — the login page's body, echoed verbatim, into the exception message (`eapilib.py:731-733`) | `AuthError` naming the status, with the body withheld; only cookie **names** may be logged | DR-011 — an echoed login page can contain the credential it just rejected |
| 27 | pyeapi never logs out: the session cookie lives until the server expires it, and the process simply stops | `close()` issues a best-effort `POST /logout`; a failed logout **warns** and never throws, so cleanup cannot mask the error the caller is already handling | DR-018 — an abandoned authenticated session on a switch is a liability, not a detail |
| 28 | One class per transport name: the `https` sender is `HttpsConnection` (`eapilib.py:202-214`), built through a factory that accepts a `context` and hands it straight to `HTTPSConnection` (`:68-69`), with `enforce_verification` as a separate knob to bend afterwards | one `kind` string, per-entry-point implementation: `https` is `FetchTransport` from the browser entry and `TlsTransport` (`node:https`) from `./node` whenever any DR-013 trust option is present — undici exposes no handle on the peer certificate, so a fingerprint pin cannot be expressed there. `enforce_verification`/`context` are **not** reproduced; explicit options replace them | DR-002 / DR-013 — a profile that says `transport = https` keeps working from either entry |
| 29 | The request id is `id(self)`, a CPython memory address (`eapilib.py:354`), and the reply's `id` is read for nothing — a response from another device, a proxy cache, or a stale pipeline is indistinguishable | `<clientId>-<seq>` per connection, and the reply's `id` is **compared** to the request it answers; a mismatch is `ProtocolError` naming both ids. An absent id is tolerated (EOS has been seen to omit one); it is never invented | DR-017 / M2 (#4) `src/transports/correlate.ts` — "the answer you rendered belongs to another switch" means configuring the wrong device |
| 30 | The session transports log in **eagerly, inside the constructor**: `HttpEapiConnection.__init__`/`HttpsEapiConnection.__init__` call `self.authentication(…)`, which for a session subclass resolves to `SessionApiConnection.authentication` and POSTs `/login` on the spot (`eapilib.py:666`, `:686`, `:721-733`). A mistyped password therefore surfaces from construction, with no commands and no request id to attach | login deferred to the first request, keeping the promise that **every** error carries its `commands` and `requestId`; concurrent callers share exactly one in-flight login | ARCHITECTURE §4 / M2 (#4) — nothing observable changes on success, and the failure is now actionable |
| 31 | The knobs are positional-or-kwargs with **no name discipline**: `enable(commands, encoding, strict, send_enable, **kwargs)` (`client.py:800`) and `run_commands(commands, encoding, send_enable, **kwargs)` (`client.py:876`), and whatever is left in `**kwargs` is folded into `params` and then filtered by a hard-coded allow-list (`eapilib.py:356-361`) — so `api_version`, `stop_on_error` or `encodingg` silently vanishes and the request simply goes out with the device defaults | one closed options object per method (`NodeRequestOptions` = the M1/M2 `TransportExecOptions` bag plus `sendEnable`), renamed to the wire vocabulary: `encoding` → `format`, `strict` → `tolerateErrors`, `send_enable` → `sendEnable`, `as_string` → `as`. An unknown key does not compile, and this layer's own knob is stripped before `execute()` so it can never reach the wire either | DR-016 / M4 (#6) — a knob the device never saw is how a UI comes to believe it set `stopOnError: false`. `sendEnable` defaults to `true` for drop-in familiarity, **not** because it is needed: see row 32's DR-009 note |
| 32 | `enable()` refuses config mode by testing the whole list against one literal — `if 'configure' in commands: raise TypeError('config mode commands not supported')` (`client.py:841-842`) — so `'configure terminal'`, `{'cmd': 'configure terminal', 'input': …}`, `configure session X` and `configure replace flash:x` all pass the check and are sent as if they were reads | `assertNotConfigMode` in `src/command-layer.ts` inspects every command's CLI text and refuses any `configure …` **except** `configure all <intf> …`, which is an executive-mode command on 4.28 and would otherwise be unsendable. Throws `NotSupportedError` before any request (0 round trips), names the offending command, and keeps the set in `error.commands` | M4 (#6) — the read path must not be able to mutate the running config; and pyeapi's own guard did not guard the common case. `ARCHITECTURE.md` §4 reserves `EapiError` subclasses for device/protocol conditions, which is why the upstream `TypeError` becomes `NotSupportedError` |
| 33 | The 1003 repair lives in `enable()` per command (`client.py:865-871`) and only on the non-strict branch, recording `encoding: 'text'` for that entry; the strict branch labels every entry with the **requested** encoding (`:856`) whether the device answered JSON or not, and no field anywhere reports that a fallback happened | the repair is the **codec's** (M1 `internal/wire.ts`, DR-012), so one request per command and one retry rule; every `ExecResult` carries `encoding` = the encoding that actually answered plus a boolean `fellBack`. `tolerateErrors: false` never repairs: one batched request, then the `CommandError` | DR-012 / M4 (#6) — `fellBack` is **additive beyond PLAN M4's field list** (`{command, result, encoding}`) because `docs/USAGE.md` §4 already promised it and a table of un-modelled text must not be rendered as if it were parsed. `exec` also returns `command` as the caller wrote it, including the object form |
| 34 | `running_config` / `startup_config` are synchronous `@property`s that lazily run `show running-config [all]` / `show startup-config` and cache the text (`client.py:519-534`), and `get_config` renders it with `str(result[0]['output']).strip()` / `.split('\n')` (`:986-989`) — so a missing `output` yields the literal string `'None'` | `getRunningConfig()` / `getStartupConfig()`: async accessors, because a TS getter cannot `await` (DR-005). Same cache, same `all` keyword gated by `configDefaults`, startup-config asked without `params` exactly as upstream; invalidated by `refresh()` or by a write while `autorefresh` is on. A reply with no string `output` member is a `ProtocolError` naming the command | DR-005 / DR-030 — a property that performs I/O cannot be awaited in TS, and "the switch is unreachable" must not look like "the config is the four-character string `None`" |
| 35 | Device identity is three lazy properties (`version`, `version_number`, `model`, `client.py:536-555`) that each call `_get_version_properties` (`:557-575`), which re-runs `show version` **each time** and renders the fields with `str()`: a reply with `"version": null` yields the literal `'None'` (`:563`), a reply without the key raises a bare `KeyError` (`:563`), and only the four-digit run from `re.search(r'\d\d\d\d', modelName)` survives — `DCS-7050TX-64` becomes `7050` and `-64` is thrown away | one memoised `getVersion()` round trip → `{version, versionNumber, model, modelName}`: the same two regexes (`/^[\d.]+/` leading run, first four-digit run) with the same no-match fallbacks (`vEOS` stays `vEOS`), `model` kept for parity, **plus** `modelName` verbatim. A missing or non-string field is a `ProtocolError`. `refresh()` deliberately leaves it set | DR-005 / DR-032 / M4 (#6) — `docs/features.md`'s capability claims are model-sensitive (7050X vs 7050TX-64), so the exact product string has to survive the parse; PLAN's "lazy, cached" is stronger here than upstream, which pays up to three `show version` requests |
| 36 | `get_config(config, params, as_string)` validates `config` against two string literals and raises `TypeError('invalid config name specified')` (`client.py:952`, `:978-979`) | one options bag; `config` is a **union** (`'running-config' \| 'startup-config'`) so a wrong name is a compile error, with the same message kept as a runtime `NotSupportedError` for a caller arriving from JS or a decoded profile. `as_string: True/False` → `as: 'string' \| 'lines'`, defaulting to `'lines'` (pyeapi's default) with the strip/no-strip parity preserved | DR-003 / DR-005 — the wire token (`running-config`) is kept instead of PLAN's shorthand (`'running'`) because it *is* the command; the runtime check stays because TS types disappear at the boundary |
| 37 | `CliVariants` is a marker object smuggled **into** the command list: `config()` finds the first one with a type scan (`client.py:628-633`) and splices alternatives in place, trying each until one succeeds and re-raising the last `CommandError` (`:645-652`); `CliVariants.expand` (`utils.py:245-269`) builds the full cross-product of several markers, which `config()` never uses and whose docstring says only one marker is supported (`client.py:605-606`) | `tryVariants(variants, send)` in `src/internal/variants.ts` plus `node.configureVariants(variants)`: variants live **beside** the command list (`CommandSpec[]` has no honest room for a foreign marker object — `buildRequest` would reject it), tried in order, first success wins, last `CommandError` re-raised, `>= 2` variants enforced with the same message shape as `utils.py:272`'s assert. Only a `CommandError` advances to the next spelling; a transport/protocol failure stops. The `expand` cross-product is **not** ported — nest `tryVariants` calls instead | DR-006 ("keep as `tryVariants()` utility, not a type-level magic") / M4 (#6) — after a round trip that never reached the switch, sending a second spelling of a config change risks applying one variant on top of a half-applied other |
| 38 | Results are paired to commands **positionally and without validation**. Strict mode enumerates the **answers** and indexes `commands[index]` (`client.py:852-856`), so a `result[]` shorter than `cmds[]` silently returns fewer entries and the unanswered command disappears; non-strict mode reads `resp[0]` (`:863`, `:870`), so the same situation dies in a bare `IndexError: list index out of range` that names nothing. Upstream's own mock shows how unnoticed this is: `test_enable_with_single_extended_command` (`test/unit/test_client.py:104-112`) scripts `result: ['enable', {'cmd': 'show cvx', 'revision': 2}]` and asserts the entry's `result` **is** the command dict (`:112`) | every read path (`show`, `showText`, `exec`, `getConfig`, `getVersion`) requires a reply object per command: a short answer is a `ProtocolError` naming the command by its **`cmd` text** — for the `{cmd, revision}` object form that is `show cvx`, never the serialised object and never an index — with the command set kept (redacted) on `error.commands` and no empty object substituted | M4 (#6), PLAN's empty-state rule — the naming follows pyeapi's own keying (results ride on the command order, `client.py:852-856`), because a UI must be able to say *which* row of the table the device left blank instead of rendering a partial answer as if it were complete |

---

## 6. Test map (upstream → ours)

Naming rule for the ported tests: `TestEthVlan::test_get_name` (pyeapi) →
`it('get: name')` inside `describe('vlans', …)` in `src/resources/vlans.test.ts`. Where pyeapi asserts
a returned `False`, ours asserts a thrown `CommandError` with the same command list.

| pyeapi unit test | methods | TS test file | Ours (planned) |
|---|---|---|---|
| `test/unit/test_eapilib.py` | 38 | `src/internal/wire.test.ts`, `src/errors.test.ts`, `src/transports/*.test.ts` | ~55 |
| `test/unit/test_client.py` | 53 | `src/command-layer.test.ts` (M4), `src/node.test.ts` (entry), `src/profiles.test.ts` (M3) | ~48 |
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
| Duplicate `response` key | `client.py:845-856` | Upstream calls it an error, slated for removal | DR-007 |
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
