# User Guide — `@devhax-heavy-industries/arista-eapi`

Status: **design target**, written before the implementation (M0–M13 in
[PLAN.md](./PLAN.md)). The snippets below are the API the milestones are built to satisfy, and each
`USAGE.md` example becomes a runnable doc test in M13. If code and this file disagree, the code is
right and this file is a bug — fix it in the same PR.

Connectivity (what to enable on the switch, browser vs proxy, TLS) is in [CONNECTIVITY.md](./CONNECTIVITY.md) — read that first.

---

## 1. Install

Workspace-local (already wired by the root `package.json` workspaces):

```bash
npm install -w arista-webui @devhax-heavy-industries/arista-eapi     # from the repo root, links the workspace package
```

- Browser/app code: `import { … } from '@devhax-heavy-industries/arista-eapi'`
- Node code (scripts, CLI, local proxy): `import { … } from '@devhax-heavy-industries/arista-eapi/node'`
- Your own tests: `import { mockTransport, loadFixture } from '@devhax-heavy-industries/arista-eapi/testing'`

Node ≥ 20, ESM only ([DR-021](./DECISIONS.md#dr-021--esm-only-exports-conditions-no-cjs)).

---

## 2. Five-minute tour

```ts
import { createNode } from '@devhax-heavy-industries/arista-eapi';            // browser-safe entry
import { readProfiles } from '@devhax-heavy-industries/arista-eapi/node';     // Node entry (optional)

const node = createNode({
  host: 'switch.home.arpa',
  username: 'ui-ro',                        // a priv-15 API user, see CONNECTIVITY.md
  password: process.env.EAPI_PASS!,
  // Node entry only: pin the device's self-signed cert
  tls: { fingerprint: 'sha256:3f2b…c1' },
});

// read a typed show
const version = await node.show('version');
console.log(version.version, version.modelName);          // "4.28.13.1M" "DCS-7050TX-64"

// read a resource
const vlans = await node.vlans.getAll();                  // { 1: {name:'default', state:'active'}, … }

// make a reviewable change
const session = await node.configSession({ name: 'ui-demo' });
try {
  await session.run(['vlan 20', 'name PROD']);       // resource .commands() accessors are M7 (#9)
  console.log(await session.diff());                      // text diff, forced format:'text'
  await session.commit();
} catch (e) {
  await session.abort();
  throw e;
}
```

`session.run()` (alias `session.commands()`) takes **commands**, not magic — a `CommandSpec[]` or
plain strings, exactly like `node.configure()`. When the resource modules land in M7 (#9) they will
hand the same `CommandSpec[]` to it, which is what lets a UI show what will change before it runs
([ARCHITECTURE.md §9](./ARCHITECTURE.md), §5 row 70).

> What is real on this branch, vs what the tour above previews: `createNode()`/`createConnection()` still
> throw until M3 (#5, PR #24) lands the profile bag, and `node.vlans` / `node.configSession()` need the
> modules that do not exist yet — M7 (#9) shipped the framework those modules will be written against
> (§6), M5's session verbs ride their own branch. §4's "What the command layer ships today" is the
> authoritative list of working verbs.

---

## 3. Connecting

```ts
// ad hoc
createConnection({ kind: 'https', host, username, password, port: 443, timeoutMs: 60_000 });

// Node: from eapi.conf (~/.eapi.conf, /mnt/flash/eapi.conf, or $EAPI_CONF)
import { readProfiles } from '@devhax-heavy-industries/arista-eapi/node';
const store = readProfiles();                   // { veos01: { kind:'http', host:'veos01' }, … }
const node = store.nodeFor('veos01');           // host defaults to the section name, as pyeapi does
await node.vlans.getAll();
for (const name of store.hostsForTag('rack-a')) { /* … */ }

// browser: profiles come from app config (never the filesystem)
const node = nodeFromProfile({ name: 'lab-switch', kind: 'https', host: '10.0.0.30' });
```

Transports (`kind`): `https` (default) · `http` (needs `allowInsecureTransport`) ·
`https-client-cert` · `http-session`/`https-session` (cookie `/login`, Node only) ·
`unix` and `http-local` (Node only, **unauthenticated priv-15 on the switch** —
[DR-014](./DECISIONS.md#dr-014--local-transports-unix--1270018080-only-and-no-8443)).
Unknown `kind` is a compile error and a runtime `NotSupportedError`.

---

### Profiles: `eapi.conf` on Node, app config in the browser (M3 #5)

Profile state is never process-global (**DR-044**): you build a `ProfileStore` and hand it to the factory, so
two switches — or one test and one app — cannot overwrite each other.

```ts
// any entry: parse text you obtained yourself (no filesystem, no globals)
import { parseEapiConf, ProfileStore, createNode } from '@devhax-heavy-industries/arista-eapi'

const store = new ProfileStore()
store.load(parseEapiConf(confText))        // problems are values too: store.issues() carries line numbers
const node = createNode({ kind: 'profile', name: 'lab-2', store })
```

```ts
// ./node only: pyeapi's search path ($EAPI_CONF, then ~/.eapi.conf, then /mnt/flash/eapi.conf)
import { loadProfileStore, createNodeFor } from '@devhax-heavy-industries/arista-eapi/node'

const node = createNodeFor('lab-2', { configDefaults: false })   // reads through injected exists/readTextFile
```

Four behaviours to check before building a UI on this:

- **Nothing is discarded silently.** configparser aborts on the first bad line and pyeapi then loses the entire
  file; `parseEapiConf` records one issue per site (blocking vs advisory) and keeps reading, so a typo in
  section 2 does not hide sections 3-N (**DR-045**, §5 row 56).
- **`%` in a password is data.** pyeapi inherits `BasicInterpolation`, so `100%` raises and costs you the file,
  and `p%%s` quietly parses as a different value. Interpolation is off here (§5 row 57 — verified by running
  this machine's `configparser`, not by reading pyeapi).
- **`connection:localhost` means the switch-local unix socket, and only on Node.** The browser default is
  `https` with an explicit host and it refuses `unix`/`http_local` by name; on Node the injected profile stays
  inert until `allowLocalUnauthenticated` states the risk (**DR-008** + **DR-014**, §5 row 55).
- **`hostsForTag(tag)` returns `undefined` for a tag nothing carries**, and `readonly []` for a tag that exists
  with no hosts. pyeapi answers `None` for both, which cannot be told apart (§5 row 60).

## 4. Reading: `show`, `exec`, and un-modelled commands

```ts
const reply = await node.show('vlan 20');                    // typed via ShowContracts
const text  = await node.showText('session-config diffs');   // never JSON-able
const rows  = await node.exec([                              // pyeapi Node.enable() equivalent
  'show interfaces status',
  'show mlap',
]);
for (const r of rows) {
  r.command;    // 'show mlag'
  r.result;     // parsed object, or { output: '<text>' } when it fell back
  r.encoding;   // 'json' | 'text'
  r.fellBack;   // true when a 1003 (no JSON model) forced the text retry
}
```

`exec` tolerates un-modelled commands by default (`tolerateErrors: true`). Set
`{ tolerateErrors: false }` to have a 1003 surface as a `CommandError` — do that in tests, so a
command that silently loses structure can't slip through.

### What the command layer ships today (M4, #6)

`createNode()`/`createConnection()` are still M3 (#5) placeholders, so today the working constructor is
a `Transport` plus a `Node` — the same shape every example below assumes:

```ts
import { createTransport, Node } from '@devhax-heavy-industries/arista-eapi';        // or '…/node'

const node = new Node(createTransport({ kind: 'https', host, username, password }), {
  enablePassword: undefined,      // only if the API user is NOT priv-15 (DR-009)
  autorefresh: true,              // re-read cached configs after a write
  configDefaults: true,           // `show running-config all`
});
// A priv-15 Basic-auth user needs no enable password and no `enable` command at all:
await node.exec('show version', { sendEnable: false });
```

| verb | returns | note |
|---|---|---|
| `runCommands(cmds, opts)` | `readonly CommandResult[]` | pyeapi `run_commands`: exactly the commands you wrote, `enable` popped; `opts` = `{ format, sendEnable, stopOnError, includeErrorDetail, requestTimeout, … }` |
| `show(k, { revision })` / `showText(cmd)` | `ShowContracts[k]` / `string` | encoding is chosen by the method, never by the caller |
| `exec(cmds, { tolerateErrors, sendEnable })` | `ExecResult[]` = `{ command, result, encoding, fellBack }` | no duplicate `response` key (DR-007); refused for any `configure …` except `configure all <intf> …` (row 32) |
| `getConfig({ config, params, as })` | `string` or `readonly string[]` | `config: 'running-config' \| 'startup-config'`; `as: 'string'` trims, `'lines'` (default) does not |
| `getRunningConfig()` / `getStartupConfig()` | cached `string` | cleared by `refresh()` or by a write while `autorefresh` is on (row 34) |
| `chunkConfig({ config })` | `Promise<ConfigSections>` = `ReadonlyMap<string, string>` | **added by M7 (#9)**: the cached text split into section keys by M6's chunker, over one DR-026 memo per source. `{ config: 'startup-config' }` to read the other one |
| `section(pattern, { config })` | `Promise<string>` | first section whose **key** matches (`pattern` is `string \| RegExp`, compiled like pyeapi's). Absence throws `NotFoundError`; a bad pattern stays a `SyntaxError` (rows 50/80) |
| `getBlock(parent, { config })` | `Promise<string \| undefined>` | anchored `^parent$` lookup, `undefined` when the switch has no such section (rows 51/80). The parent is spliced **as written**, so a name with regex metacharacters is a pattern — pyeapi parity |
| `resource(name)` / `hasResource(name)` | `ResourceKinds[K]` / `boolean` | **added by M7 (#9)**: the typed replacement for pyeapi's `node.api(name)` (DR-006/DR-052, row 79). `ResourceKinds` is empty until M8-M10 register modules, so every typed call is a compile error and every untyped one throws a `NotSupportedError` listing what is registered; `hasResource('vlans')` answers `false` today |
| `getVersion()` | `{ version, versionNumber, model, modelName }` | one memoised `show version`; `refresh()` leaves it (row 35) |
| `configure(cmds, opts)` | `readonly CommandResult[]` | prepends `configure terminal`, strips both prepended replies, throws on failure — there is no `false` to check |
| `configureVariants(variants, opts)` | same | first spelling that succeeds wins; last `CommandError` re-raised (row 37). Standalone: `tryVariants(variants, cmds => node.configure(cmds))` |
| `setEnablePassword(pw)` / `enablePassword` | — | sends `{'cmd':'enable','input':pw}`; `''`/whitespace clears it |
| `refresh()` → `void`, `close()` → `Promise<void>` | — | `refresh()` is a local cache clear (no request); `close()` releases the transport, so a cookie session logs out (DR-018) |

`show('anything-not-in-the-contract')` returns `unknown`: narrow it yourself, or extend the contract:

```ts
declare module '@devhax-heavy-industries/arista-eapi' {
  interface ShowContracts {
    'lag counters': { lagName: string; totalInOctets: number }[];
  }
}
```

---

## 5. Writing: terminal config vs config sessions

Two write paths, and the object you get back makes the difference obvious: `configure()` returns device
replies, `configSession()` returns a **handle** with a state machine behind it. Prefer a session for
anything an operator should approve before it lands — DR-025 is the rule, §5 rows 61–70 are the record.

```ts
import { createTransport, Node } from '@devhax-heavy-industries/arista-eapi';

const node = new Node(createTransport({ kind: 'https', host, username, password }));

// --- terminal: one request, applied as the device receives it
await node.configure(['vlan 21', 'name OFFICE-VOICE']);

// --- session: staged, reviewed as a diff, then committed or undone
const session = await node.configSession({ description: 'ui:vlan-21' });   // name auto-generated
await session.run(['vlan 21', 'name OFFICE-VOICE']);   // session.commands(…) is the same verb
const diff = await session.diff();                     // format:'text' on the wire, never inferred
if (approved && session.hasDiffBeenRead()) await session.commit();
else await session.abort();
session.state;                    // 'open' | 'diffed' | 'committed' | 'aborted' | 'lost'
```

What the session path guarantees, and where each guarantee comes from:

- **A diff you can actually show.** `diff()` sends `show session-config diffs` with `format: 'text'` stated
  on the request; `showSessionConfig()` sends `show session-config` and stays JSON, because that form *is*
  model-backed while `diffs` is not — so a JSON ask for `diffs` is answered `1003`. pyeapi reaches the same
  text encoding through an `encoding=` kwarg (`client.py:1008-1016`) and never says why, and there a typo in
  the kwarg silently sends JSON instead. `hasDiffBeenRead()` flips back to `false` on every staged write,
  which is the only honest way to gate a Commit button. §5 row 64.
- **Re-attach is explicit, so a reload survives.** `configure session <name>` is `cmds[0]` of **every**
  batch — the same insertion pyeapi makes (`client.py:687`) — so another process, or this page after a
  reload, reaches the same staged changes:
  `node.configSession({ name: 'ui-switch.home.arpa-p4242-9c1f2a70' })`. Nothing sends `exit` for you;
  `exit()` detaches the handle and deliberately **leaves the device-side session pending**, which is what
  `recoverOrphans()` reads back. §5 row 63.
- **One session per `Node`.** While a handle is live, `configure()` and `configureReplace()` throw before
  any request, and `exec()` keeps refusing every `configure …` spelling (§5 rows 32/62). pyeapi instead
  re-routes a terminal write into whatever session the `Node` remembers (`client.py:635-636`) — that
  behaviour is deliberately **not ported** (§7), because the diff an operator approved stops being the diff
  that lands.
- **A name another process can find.** Omit `name` and the client builds
  `ui-<host>-p<pid>-<hex8>` (`ui-<host>-<hex8>` in a browser, which has no pid), hostname-only and
  secret-free even from a malformed address (`generateSessionName`, DR-047). `SESSION_NAME_PREFIX` is also
  `recoverOrphans()`'s default name filter, and `MAX_SESSION_NAME_LENGTH` plus an unsafe-token refusal stop
  a name from splicing a second CLI verb into `cmds[0]`. What EOS itself limits is **not** captured here, so
  those bounds are ours and open item 7 exists. pyeapi fabricates a bare `uuid4()`, never sends it and never
  stores it (`client.py:1003-1006`; grepping that tree for `session_name` finds no consumer). §5 row 61.
- **Recovery, not luck.** `node.listSessions({ detail? })` reads `show configuration sessions` in JSON and
  validates the reply — one without a `sessions` object is a `ProtocolError`, never an empty table, because
  "no pending sessions" would be a claim the device never made. `node.abortSession(name)` ends one session;
  `node.recoverOrphans({ journal?, olderThan?, namePrefix? })` reconciles the journal against the device and
  returns `{ aborted, failed, skipped, remaining, reported }`. A session whose `commitBy` is armed is
  **reported, never aborted** — confirming or reverting a live change is a decision, not cleanup (DR-050).
- **1006 is a named failure.** A held config lock becomes `SessionError` with the handle marked `lost`, and
  the message names the three cleanup verbs. pyeapi cannot express it at all: the string `1006` appears
  nowhere in the pinned clone (§5 row 66, DR-023).
- **Commit is not a save.** `commit()` writes running-config only.
  `copy running-config startup-config` is sent **only** by `node.copyRunningToStartup()` (alias
  `node.writeMemory()`), or by `commit({ persist: true })` — which adds its own second round trip so a
  failure can name which half happened: *committed, but … NOT saved to startup-config, so it is lost on
  reboot*. pyeapi has no durability verb at all, which is why a pyeapi-driven change quietly evaporates on a
  reboot (DR-024, §5 row 68).
- **Rollback and replace are staged, not one-shot.** `node.rollbackCleanConfig({ groups? })` and
  `node.rollbackToSession(name)` hand back an **uncommitted** `ConfigSession`: read `diff()`, then `commit()`
  or `abort()` (`rollbackCleanConfig` is also on an open handle).
  `node.configureReplace(url, { ignoreErrors?, force?, md5?, skipCheckpoint? })` renders the device's own
  keywords, pre-validates `md5` as 32 lowercase hex digits, refuses locally while a session is live (the
  command exits any session it finds, which would strand a reviewed changeset in a session this client still
  owns), and maps the device's "session … pending commit timer" refusal — a *message*, not a code — to
  `SessionError` naming that session. §5 row 69.
- **A revert timer, with two honest gaps.** `session.commitWithRevertTimer('00:05:00')` sends
  `commit timer hh:mm:ss` inside the session; `hh:mm` and `00:00:00` are refused client-side, the zero case
  with the device's own wording so the two messages diff. Whether the timer blocks or rewrites later
  sessions, and whether a second `commit` before the deadline **confirms or resets** the revert, is not
  claimed: `confirmRevertTimer()` is named as intent, and `ConfigSessionSummary.commitBy` only says a revert
  is armed. DECISIONS open item 5 and the STATUS §3 line stay open until cEOS and the target settle it.
  §5 row 67.
- **Journal on both entries.** Node: `FileSessionJournal` from `…/node`, path from `sessionJournalPath()` →
  `$XDG_CONFIG_HOME/arista-eapi/sessions.json`, else `~/.config/arista-eapi/sessions.json`
  (`SESSION_JOURNAL_PATH`, `defaultSessionJournal()`). Browser:
  `createWebStorageJournal(window.localStorage)` from the main entry under `SESSION_JOURNAL_STORAGE_KEY`
  (`arista-eapi:sessions`). Pass one with `configSession({ journal })`. Records are rebuilt from a key
  allow-list (`name`, `endpoint`, `startedAt`, `pid?`, `description?`), so an `enablePassword` cannot ride
  from a JS caller onto disk, and a corrupted file degrades to "no entries" instead of breaking recovery
  (DR-011, DR-049). That path is **our** convention — EOS defines no journal file, and it must not be
  described as one.
- **Whole-changeset validation, which is not a dry run.** `session.validateChanges(batch)` sends **one**
  batch with `{ stopOnError: false, includeErrorDetail: true }` and returns a `ChangesetOutcome` —
  `{ ok: false, failures, staged, error }` **without** throwing — so one bad command does not kill the
  handle: `diff()` shows what did land and `abort()` undoes it. Every command it accepted *was applied*;
  there is no preview. A real preview needs `verifyConfig`, which is **M11 (#13)** and does not exist yet —
  which is why the handle has no `dryRun()` method (DR-050, §5 rows 67–68).

```ts
const outcome = await session.validateChanges(['vlan 21', 'interface Ethernet1 switchport mode access']);
if (!outcome.ok) {
  console.log(await session.diff(), outcome.failures);  // what landed, plus the per-command detail
  await session.abort();
}
```

> **Not verified on hardware or cEOS — and not claimed.** The *effect* of `commit timer`; whether a second
> `commit` before the deadline confirms or resets it; the name length and charset EOS will accept; how deep
> `description "…"` quoting goes; whether `no-commit` is accepted or answered `1002` by the 7050TX-64;
> `maxOpenSessions` / `service configuration session max pending`; whether `show configuration sessions`
> reports any start-time field (until it does, `olderThan` applies to journaled names only); and whether
> `copy running-config startup-config` behaves as expected on 4.28.13.1M. Arista's CLI-plugin Python
> (`SessionCli`, `ConfigSessionCli`, `ConfigSessionShowCli`, `ConfigSessionModel`, `CliCommon`,
> `DateTimeRule`) is not obtainable from this workspace, so §5 rows 61–70 name those classes **without**
> line numbers instead of printing references nobody can open. Each question is a STATUS §3 sweep line and a
> DECISIONS open item (5, 7, 8) for M12 (#14) to capture. DR-050 is the rule that keeps this section honest.

---

## 6. The resource framework (M7, #9), and how a wave-1 module reads config

**Reachability, stated honestly first.** M7 ships the framework — `ResourceBase`, `Entity`,
`EntityCollection`, `commandBuilder`, `submodeCommands`, `toArray`, `parseConfigBlock`, the validators,
`ResourceRegistry`/`createResourceRegistry`, and the `Node`↔`src/config/` pairing (`chunkConfig`,
`section`, `getBlock`, `resource`, `hasResource`) — but `src/index.ts`/`src/node.ts` do **not** re-export
the framework classes yet, and the `exports` map has only `.` and `./node`. So a package consumer cannot
`import { Entity } …` until that wiring lands (STATUS §1's M7 row carries it as the one open piece; M8
(#10) is its first real consumer). And **no wave-1 module exists**: `node.vlans`, `node.system`,
`node.switchports` are still future tense (M8 #10, M9 #11, M10 #12), because `ResourceKinds` is
deliberately empty (DR-052). Everything below is what the shipped code does today and what a module
writes against it — `src/resources/base.test.ts` drives exactly this shape over `MockTransport`.

### The two base classes

```ts
// a named collection — VLANs, interfaces, users
class Vlans extends EntityCollection<VlanEntry, number, VlanAttrs> {
  getAll(): Promise<ResourceTable<number, VlanEntry>>;   // ReadonlyMap: device order, real key types
  get(id: number): Promise<VlanEntry | undefined>;       // no `default=` fallback parameter
  create(id: number, attrs?: VlanAttrs): Promise<void>;  // rejects with CommandError if refused
  delete(id: number): Promise<void>;
  setDefault(id: number): Promise<void>;                 // pyeapi spells this `default(vid)`
}

// a single global-ish entity — hostname/routing/banners (M8), spanning-tree, MLAG
class SystemSettings extends Entity<SystemState> {
  get(): Promise<SystemState>;      // never `undefined`: a global with nothing configured still answers
}

const vlans = new Vlans(node);      // ResourceBase refuses a Node missing
                                    // getRunningConfig/getStartupConfig/chunkConfig/configure — at `new`
await vlans.has(20);                // and .keys() / .entries(): ONE getAll() each, never a read per element
```

pyeapi's `vlans[20]`, `len(vlans)`, `for vlan in vlans` and `vlans()` are **not** ported (DR-004, §7):
each of those was a device read in disguise, and `Vlans.getall` paid one config read **per VLAN**
(`vlans.py:191`). Writes never answer `false` and there is no `.error` to remember to check — they reject
with the device `CommandError`, `failedCommand` and redacted `commands` included (DR-005).

### Verb conventions (the whole rule, so a module never invents one)

| you want | verb | emitted command | pyeapi spellings |
|---|---|---|---|
| read everything / read one | `getAll()` / `get(k)` | — | `getall()` / `get(name, default=None)` |
| existence, add, remove, reset | `has(k)` · `create(k, attrs?)` · `delete(k)` · `setDefault(k)` | `vlan 20` / `no vlan 20` / `default vlan 20` | `create` · `delete` · `default` |
| set one field / negate it / default it | `setF(v)` · `unsetF()` · `defaultF()` | `mtu 1500` / `no mtu` / `default mtu` | `set_f(v)` · `set_f(disable=True)` · `set_f(default=True)` |
| membership inside an entry | `addX(v)` · `removeX(v)` | `trunk group red` | `add_trunk_group` · `remove_trunk_group` |

Reads answer `undefined` for not-found; writes **throw**; negation is always a mode, never a falsy value;
attributes are one options bag. `unset<Field>`/`default<Field>` are the two families this port adds —
DR-037 refuses `set_x(name, None)` meaning `no …`.

### Building a command line, and what it refuses

```ts
commandBuilder('ip routing', { value: true });                    // 'ip routing'          (value=True)
commandBuilder('mtu', { value: 1500 });                           // 'mtu 1500'
commandBuilder('mtu', { mode: 'no' });                            // 'no mtu'              (disable=True)
commandBuilder('mtu', { mode: 'default' });                       // 'default mtu'         (default=True)
commandBuilder('name', { mode: 'default', value: 'PROD' });       // 'default name'  — mode preempts value
commandBuilder('mtu', { value: 0 });                              // 'mtu 0'          — upstream answered 'no mtu'
commandBuilder('mtu', {});                                        // throws NotSupportedError (upstream: 'no mtu')
commandBuilder('mtu', { mode: 'set', value: false });             // throws — falsy is not a value
commandBuilder('mtu 1500\nno ip routing', { value: 1 });          // throws — a line boundary is TWO commands;
                                                                  // use { cmd, input } (DR-015, row 74)
submodeCommands('interface Ethernet1', ['mtu 1500']);             // ['interface Ethernet1', 'mtu 1500']
```

`submodeCommands` returns a **new** array, and every helper in the package routes command lists through
`toArray`, which copies. pyeapi's `configure_interface` does `make_iterable(commands)` then
`commands.insert(0, …)`, so it splices the parent line into *your* array and sends it again on the next
call (`abstract.py:176-177`, and again at `vlans.py:244-245`) — DR-054/rows 71-72 are the fix. Argument
guards throw too: `assertInterfaceName('Po1')` and `assertVlanId('20')` both name the rejected value, and
both are **stricter than upstream on purpose** (`isvlan('1234')` is `True` in pyeapi; `Ethernet1.100` is
refused until the interface grammar is captured — DR-053, DECISIONS open item 7).

### How a wave-1 module reads device config: through the pairing

A module never runs `show running-config`, never chunks text itself and never caches a parse — that is
the `Node`'s job (one read per config change, DR-026/DR-030):

```ts
// on ResourceBase (what a module calls) — all three delegate to the Node's memoized document:
await this.config();                    // cached text (async on purpose: DR-005)
await this.configSections();            // ReadonlyMap of section keys → text
await this.getBlock('vlan 20');         // string | undefined
await this.section(/^interface\s+Et/);  // throws NotFoundError when absent

// on Node (same code path, usable from a screen or a script):
await node.chunkConfig({ config: 'startup-config' });
await node.getBlock('vlan 20');
```

Then parse with M6's primitives, not your own regex (this is PLAN's M6 exit gate, and the reason
`parseConfigBlock` exists — upstream re-runs a bespoke regex per module, `vlans.py:57-60`,
`interfaces.py:65`/`:108`/`:206`):

```ts
const body = (await vlans.getBlock(20)) ?? '';
const parsed = parseConfigBlock(body, {
  name: (block) => findValue(block.body, 'name'),
  trunkGroups: (block) => findAllValues(block.body, 'trunk group'),
  header: (block) => block.header,               // the section header, for the key it matched on
});
// parsed's TYPE comes from the map: { readonly name: string | undefined,
//   readonly trunkGroups: string[], readonly header: string }
```

**What `parseConfigBlock` returns:** one record per call — `ParsedFields<P>`, i.e. exactly the parser
map's keys with each extractor's return type as its value type, so the entry interface and its parser
are one declaration and a forgotten field is a compile error where the module assigns the result. It runs
M6's `parseBlock` once (`{ header, body: readonly ConfigLine[] }`, `!` separator lines included) and
hands that block to every extractor. `''` is not an error: it parses to `{ header: '', body: [] }`,
because "absent" (`getBlock` → `undefined`) versus "present but empty" is ordinary wave-1 control flow.
It defines no error class of its own — a `ConfigParseError` (MIGRATION rows 43-44) surfaces from the
`chunkConfig`/`getBlock` call that produced the text, and a parse failure is reported rather than
answered with a missing field.

**The caveat a module must know today** (pinned in `text.test.ts` and `config-block.test.ts`, decided in
MIGRATION row 81): M6's `describeLine` does not `lstrip` the whitespace run after the first token, so
`findValue(block.body, 'name')` answers `' PROD'` (leading space, and therefore the quotes on
`description "WAN uplink"` are never stripped), and a two-word keyword leaves its own tail —
`findAllValues(block.body, 'trunk group')` answers `' group red'`. So today read `line.text` and slice,
rather than pretending the contract is clean (M9 (#11), the first real reader, owns the one-line fix —
not the framework milestone, which has nothing to validate the new contract against):

```ts
const trunkAllowed = (block: ConfigBlock): string[] =>
  block.body
    .filter((line) => line.text.startsWith('switchport trunk allowed vlan '))
    .map((line) => line.text.slice('switchport trunk allowed vlan '.length));
```

And after any write: `configure()` and `refresh()` drop the chunk memos unconditionally (pyeapi clears
its `_chunkify` cache before the `autorefresh` test, `client.py:665-669`), so a re-read really is a read.

### Your own resources, before the built-ins exist

pyeapi's `node.api('vlans')` loaded a **module by name** (`client.py:945`); here a resource name is a key
of a closed map, memoised per `Node` (DR-006/DR-052):

```ts
const registry = createResourceRegistry({ myThing: (node) => new MyThing(node) }, node);
registry.get('myThing');          // the same instance on every call, for this Node only
registry.has('other');            // false — and get('other') throws naming what IS registered
```

`node.resource(...)`/`node.hasResource(...)` use this same registry type; extend `ResourceKinds` by
declaration merging (the form in `arista-webui/src/eapi-show-contracts.test.ts`) — but remember a merged
type row with no factory throws by design, and that the framework's own re-export is still pending.

---

## 7. Error handling

```ts
import { CommandError, AuthError, TlsError, SessionError, EapiError } from '@devhax-heavy-industries/arista-eapi';

try {
  await node.vlans.create(4095);
} catch (e) {
  if (e instanceof CommandError) {
    e.code;            // 1002 doesn't exist · 1004 not eAPI-drivable · 1005 role denied · 1006 locked
    e.failedCommand;   // 'vlan 4095'
    e.results;         // what succeeded before the failure
    e.trace();         // [{command, output}] — pyeapi get_trace equivalent
    e.message;         // already redacted (DR-011)
  } else if (e instanceof AuthError) { /* wrong credentials (401) */ }
  else if (e instanceof TlsError)    { /* untrusted device cert — pin it, don't disable verification */ }
  else if (e instanceof SessionError){ /* open/commit/abort/lock problems */ }
  else if (e instanceof EapiError)   { /* transport or protocol */ }
  throw e;             // the UI's error boundary shows e.message + e.failedCommand
}
```

Never branch on message text. Codes are the API ([DR-010](./DECISIONS.md#dr-010--eapi-error-code-taxonomy-verified-against-the-device-build)).

---

## 8. Capabilities (is this feature even here?)

```ts
const cap = await node.capabilities.probe('mlag');
cap.supported;                       // false
cap.reason;                          // 'no-such-command' (1002) | 'not-eapi-drivable' (1004)
                                     // | 'denied' (1005) | 'locked' (1006)
cap.commands;                        // what it tried — inside a session it always aborts

await node.capabilities.invalidate('mlag');
```

The client deliberately does **not** ship a hard-coded 7050TX-64 feature matrix
([DR-032, DR-033](./DECISIONS.md#dr-033--capability-probing-beats-a-static-support-matrix)) — licensing
and ArToggles decide support on the device, not us.

---

## 9. Testing your own code against it

```ts
import { mockTransport } from '@devhax-heavy-industries/arista-eapi/testing';

const t = mockTransport().replies('show vlan', 'recordings/lab/vlan-two-vlans');
const node = new Node(t);
expect(await node.vlans.get(20)).toBeUndefined();
```

For React screens, drive the real client against a mock so loading / error / empty states are honest:
`<VlanTable node={new Node(mockTransport().rejects('show vlan', { code: 1005 }))} />`.

---

## 10. Deliberate differences from pyeapi (the ones that bite)

| pyeapi you might remember | here |
|---|---|
| `node.api('vlans').getall()` | `node.vlans.getAll()` |
| `if not node.vlans.create(20): print(node.vlans.error)` | try/catch around `create()` |
| `vlans.get(20, default={})` | `await vlans.get(20) ?? {}` |
| `set_x('Et1', None)` → `no …` | `unsetX('Et1')` |
| `node.running_config` (str property) | `await node.getRunningConfig()` |
| results have both `result` and `response` | `result` only |
| HTTPS "just works" with a self-signed cert | you must pin/CA it, or use the proxy |
| `enable()` never really fails (silently re-tries as text) | fails, or reports `fellBack: true` |
| config sessions are a uuid nobody can find again | named, journaled, `listSessions()` |

Full list: [MIGRATION.md §5](./MIGRATION.md#5-semantic-divergences-worth-reviewing).

---

## 11. Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| `TlsError: unable to verify leaf signature` | self-signed `capi.pem` not pinned | CONNECTIVITY.md §TLS |
| Browser: `TypeError: Failed to fetch`, no status | CORS: no matching `cors allowed-origin`, or a 401 whose CORS headers nginx omits | CONNECTIVITY.md §CORS |
| `CommandError 1003` on a `show` you expected JSON from | command has no JSON model; use `showText()` or leave `tolerateErrors` on | DR-012 |
| `SessionError … locked (1006)` forever | an orphaned pending session | `node.listSessions()` / `recoverOrphans()` |
| `1005 command unauthorized` | role isn't priv-15 for that command; check `show users`/role and `aaa` | DR-009 |
| Changes vanish after a reload | you committed to running-config but never `copyRunningToStartup()` | DR-024 |
| `invalid command` (1002) for something that works in the CLI | different syntax on this release/model | `capabilities.probe()`, and record it in the module |
