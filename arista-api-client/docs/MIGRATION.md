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
| `pyeapi/client.py` — `_chunkify`, `section` | ~90 | `src/config/{text,chunk,section,cache}.ts` — **shipped M6 (#8)**, not the planned `src/internal/config-text.ts` | M6 | 1 |
| `pyeapi/utils.py` | 304 | `src/config/ranges.ts` — **shipped M6 (#8)**; `src/internal/collections.ts`, `src/internal/variants.ts` remain M7 plans | M6, M7 | 1 |
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

<!--
Numbering note (M6, #8, 2026-11-02): rows 31-38 are RESERVED for the M4 (#6) branch, which is
recording its Node-layer divergences under those numbers; 39-40 are skipped so the M6 block starts
clean. An earlier (pre-review) draft of `src/config/*.ts` cited rows 31-40 for the content below —
every one of those citations has been renumbered to 41+ in this branch, and `grep -rn "§5 row"
arista-api-client/src arista-api-client/docs` now resolves. Row 41 documents an upstream quirk kept
VERBATIM rather than a divergence; it lives in this table because it is exactly the kind of behaviour
a reviewer must be able to find.
-->
| 41 | `_chunkify`'s EOF-terminated swallow (`banner …` at indent 0, `code unit` anywhere) terminates only on `line_rs == 'EOF'` — rstrip, but NOT de-indent (`client.py:743`), and the `banner` opener is gated on the RAW line at indent 0 (`:747`). An EOS-style indented `      EOF` therefore never ends the block, and every later section folds into the opening one; upstream's own code-unit fixture dodges this by putting the block last | kept exactly, because "fixing" it would answer with a different section set than pyeapi did for the same bytes. Both shapes are pinned from transcribed upstream runs: the swallowing form (`code-unit-control-functions.conf`, order included) and the well-behaved column-0-EOF form that DOES close and lets later sections resume normally (`chunk.test.ts`) | M6 (#8) — upstream quirk kept and pinned. Which EOF spelling EOS 4.28 actually emits inside `code unit` blocks is an open question for the §3 config-text capture (STATUS.md) |
| 42 | `_chunkify(config, indent=0)` is callable by any code at any indent; the docstring alone ("it's imperative that the most outer call is made with indent=0", `client.py:715-718`) protects the recursion invariant, and the recursion re-enters the same cached function | `chunkConfig(config)` takes ONE parameter; the recursive worker (`chunkAtIndent`) is module-private, so a non-zero indent is unrepresentable at the call site. The invariant became structural instead of aspirational | M6 (#8); PLAN M6 box 1 |
| 43 | A config whose FIRST line is indented crashes inside `_chunkify`: `sections[ key ] += line` with `key` still `None` → `KeyError: None` (`client.py:761-763`; the comment "key is always expected to be set by now" is false for this input) | `ConfigParseError` naming the 1-based line, the indent, and the offending text (structured fields for the webui panel) | M6 (#8) — a crash without a line number is not an answer an operator can act on |
| 44 | A body line shorter than its block's indent → bare `ValueError` from `is_subsection_present` (`client.py:720-730`; f-string message at `:723-726`) | Same class of explicit failure ("likely unhandled multiline literal block"), message text byte-for-byte identical (pyeapi `%r` reproduced by `pythonRepr`), but the class is `ConfigParseError` with `{sectionKey, indent, shortLine}` | M6 (#8) — wording kept so device-vs-pyeapi logs still diff; class ours so `instanceof` works. The oracle's `"type": "ValueError"` field is pinned in `chunk.fixture.test.ts` so the upstream class stays visible in the record |
| 45 | `expand_range`/`collapse_range` are **never called by pyeapi itself** — the only callers in the upstream tree are its unit tests (`test/unit/test_utils.py:51-81`) | This port's resources (M9 #11, M10 #12) DO call them for `switchport trunk allowed vlan`, member ranges, etc. PLAN's wiring claim is about THIS port, not upstream | M6 (#8) — verified by grep over `pyeapi/`; prevents reading PLAN as an upstream behaviour claim |
| 46 | `collapse_range`'s docstring says "The list of values to collapse" (`utils.py:202`) while its body calls `arg.split(value_delimiter)` (`:210`) — passing a list, as the docstring invites, raises `AttributeError` | `collapseRange(string \| readonly string[])`: both spellings work, and `collapseRangeToString` gives the device-ready join | M6 (#8) — docstring/body contradiction resolved in the caller's favour |
| 47 | Malformed range input leaks Python: `int()` raises `ValueError: invalid literal for int()` (`utils.py:190-191` expand, `:215-216` collapse), a double range raises `ValueError: too many values to unpack` (`:190`), non-integer SINGLETONS pass through untouched (`:193-194`: `expand_range('foo')` → `['foo']`, `expand_range('*')` → `['*']`, `expand_range('')` → `['']`), and the `if v2:` truthiness test (`:214`) silently corrupts instead: `collapse_range('1,2,')` → `['1-2','']`, `collapse_range('0,1')` → `['1']` (a run starting at 0 vanishes: `range_start = 0` is falsy at `:226`), `collapse_range('1,0,1')` → `['1','1']` | Every one of those inputs raises `NotSupportedError` naming the offending token; degenerate delimiter configs (`value === range`, empty) are refused up front. All upstream answers transcribed on 2026-11-02 and pinned in `ranges.test.ts` | M6 (#8) — a UI that believes `['1-2','']` or a vanished `0` renders a VLAN set the switch does not have |
| 48 | `collapse_range` emits the raw input spelling for tokens that never hit an `int()` branch (`v1` interpolated as a string at `:227`/`:231`; the closing `[str(x) …]` at `:232` never re-parses): `collapse_range('01,02')` → `['1-02']`, `collapse_range('1,07')` → `['1','07']` — and returns a LIST, leaving the join to callers (`:232`) | `collapseRange`/`collapseRangeToString` always emit canonical decimals (`['01','02']` → `['1-2']`), and `collapseRangeToString(values)` returns the one device-ready string (custom delimiters respected) | M6 (#8) — canonical spelling is what makes a diff/re-render stable; the join existed only in callers' heads upstream. `sortedRangeValues` (no upstream twin) is the documented canonical pre-collapse step |
| 49 | pyeapi has NO quote handling anywhere: `(?:name\s)…` (`api/vlans.py:58` NAME_RE) and `description (.+)$` (`api/interfaces.py:206`) capture through the quotes, so a pyeapi resource hands the caller the literal `"` characters | `unquote(value)` strips a matched `"…"` wrapper, un-escapes `\"`, keeps interior spaces verbatim, and REFUSES to repair unbalanced or ambiguous quotes (`'"a"b"c"'` returns untouched). Applied by `describeLine` — though note: as currently implemented, `describeLine` does NOT lstrip the whitespace run before the value, so `unquote` is unreachable for ordinary `keyword "quoted"` lines; **M7 (#9) must decide that one-line change** (pinned, `text.test.ts`) | M6 (#8) — the quoting RULES are ours (EOS `show running-config` quoting depth is an M12 (#14) capture question); the absence of ANY upstream twin is the divergence |
| 50 | `Node.section()` signals "no section matched" by raising `TypeError('config section not found')` (`client.py:794-795`) — same exception class as passing the wrong argument type; and it resolves the strings `'running_config'`/`'startup_config'` against `self` (`:789-791`) | `section(pattern, {config} \| {sections})` throws `NotFoundError` for absence ONLY (message ADDS the pattern: `config section not found: <source>`), `NotSupportedError` for the sentinels (it names what to pass instead), and `ConfigParseError` when the chunker fails while preparing the document. `NotFoundError` extends `EapiError`, deliberately NOT `CommandError` — it has no `code`/`results[]`/`failedCommand`, and subclassing would make `switch (e.code)` lie. Resources subclass it later (`VlanNotFoundError`, M9 #11) | DR-027 realised — row 13 planned it; M6 (#8) tests pin `NotFoundError` and comment WHY the upstream class is unmatched (verified at `client.py:794-795`, 2026-11-02) |
| 51 | `get_block` wraps `section` with `'^%s$' % parent` (`api/abstract.py:98`) and converts failure to `None` via `except TypeError` (`:100-101`) — which swallows ANY TypeError from the call, and the parent is spliced into the regex WITHOUT escaping, so a name containing metacharacters silently widens the match | `getBlock(parent, options)` returns `string \| undefined`, converting ONLY `NotFoundError`; a bad pattern's `SyntaxError` and the chunker's `ConfigParseError` propagate. Parent spliced as-written — KEPT, transcribed: `section('^vlan 11.13$')` matches the `vlan 11-13` section (the dot is a wildcard) exactly as upstream. Key ordering is load-bearing either way: first matching key wins (`client.py:796`), and sub-section keys precede their parent (`:770-771` merge) | M6 (#8) — narrower catch is the fix; the as-written splice is upstream behaviour this port keeps visible rather than papering over; callers needing literal names build their own `RegExp` |
| 52 | realized DR-026 (row 12 planned it): `@lru_cache(maxsize=None)` on `_chunkify` (`client.py:697`) keyed by full config text, cleared manually at `:665-666`/`:689-690`, and every caller receives THE SAME live dict — one mutation corrupts the cache forever. (DR-026's own text says "hash plus parsed offsets"; what shipped stores the parsed **document**, not offsets — same guarantee, simpler shape) | `createConfigChunkCache()`: exactly ONE held entry, FNV-1a 32-bit hash as a fast reject then **exact string equality** before the memo is trusted (a hash collision must not serve another config's sections — pinned by feeding the cache a real FNV-1a collision pair), explicit `invalidate()` (what M4 #6's `refresh()` calls), and the document handed out as a `ReadonlyMap` so poisoning is a compile error. Counters (`hits/misses/invalidations/holding`) exist for tests and debug panels, not as a perf API | M6 (#8) — `cache.test.ts` pins the churn behaviour that proves the entry is single: alternating two configs never hits, and only the LAST one stays memoised |
| 53 | CPython `str.rstrip()`/`str.lstrip()` treat `'\u0085'` and `'\u001c'`–`'\u001f'` as whitespace, so a line ending at an exotic C1/NEL boundary rstrips to the bare word — `_chunkify`'s keys and its `line_rs == 'EOF'` compare see that (`client.py:739`, `:743`). Transcribed: `'EOF\u0085'.rstrip() == 'EOF'`, and `chunkify('x\u001cy')` keys as `x`. JS `\s` EXCLUDES those code points | `splitLinesKeepends` splits at exactly CPython's boundary set (`\u001c-\u001e` yes, `\u001f` no), but `rstrip`/`lstrip`/`lineIndent` follow JS `\s`: the control byte survives at end-of-line, so the KEY keeps it (`x\u001c`) and an `EOF\u0085` line never closes a banner — pinned at both primitive and chunk level (flip is a decision, not an accident) | M6 (#8) — unreachable from EOS output (which uses `\n` only; the 4.28 claim waits for the M12 (#14) capture); matters only for pasted/transcoded blobs |

---

## 6. Test map (upstream → ours)

Naming rule for the ported tests: `TestEthVlan::test_get_name` (pyeapi) →
`it('get: name')` inside `describe('vlans', …)` in `src/resources/vlans.test.ts`. Where pyeapi asserts
a returned `False`, ours asserts a thrown `CommandError` with the same command list.

| pyeapi unit test | methods | TS test file | Ours (planned) |
|---|---|---|---|
| `test/unit/test_eapilib.py` | 38 | `src/internal/wire.test.ts`, `src/errors.test.ts`, `src/transports/*.test.ts` | ~55 |
| `test/unit/test_client.py` | 53 | `src/node.test.ts`, `src/node.session.test.ts`, `src/profiles.test.ts` | ~48 |
| `test/unit/test_utils.py` | 15 (6 range cases; 4 `make_iterable` → the planned M7 `toArray` boundary; 4 `load_module`/`import_module` + 1 `debug` dropped — §7) | `src/config/ranges.test.ts` (shipped M6, #8), `src/internal/variants.test.ts` (M7 plan) | 32 landed incl. property test |
| `test/unit/test_api_system.py` | 5 | `src/resources/system.test.ts` | ~12 |
| `test/unit/test_api_vlans.py` | 15 | `src/resources/vlans.test.ts` | ~22 |
| `test/unit/test_api_switchports.py` | 21 | `src/resources/switchports.test.ts` | ~26 |
| `test/unit/test_api_interfaces.py` | 72 | `src/resources/interfaces/*.test.ts` (4 files) | ~75 |
| — (framework) | — | `src/resources/base.test.ts` | ~15 |
| — (chunkify, upstream-weak) | — | `src/config/{chunk,chunk.fixture,section,cache,text}.test.ts` — **shipped M6 (#8)**, not the planned `config-text.test.ts` | 102 (28+18+21+8+27; ranges counts on the `test_utils.py` row) |
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
