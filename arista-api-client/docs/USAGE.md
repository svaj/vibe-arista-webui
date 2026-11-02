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
  await session.apply(await node.vlans.commands.create(20, { name: 'PROD' }));
  console.log(await session.diff());                      // text diff, forced format:'text'
  await session.commit();
} catch (e) {
  await session.abort();
  throw e;
}
```

`session.apply()` takes **commands**, not magic: `node.vlans.commands.create(...)` returns the
`CommandSpec[]` a resource would send, so the UI can show exactly what will change before it runs
([ARCHITECTURE.md §9](./ARCHITECTURE.md)).

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

**Prefer sessions** for anything an operator should approve before it lands.

```ts
// terminal mode — each command applies immediately
await node.configure(['interface Ethernet1', 'switchport mode access', 'switchport access vlan 20']);

// session mode — one atomic change set, reviewable, resumable
const s = await node.configSession({ name: 'ui-42f0', description: 'webui change 42f0' });
await s.configure([...]);
const diff = await s.diff();
await s.commit();                       // running-config only; NOT persisted to startup
await node.copyRunningToStartup();      // explicit, deliberate (DR-024)
```

Recovering after a crash or a closed tab (pending sessions hold the config lock → error **1006**):

```ts
import { TransportError } from '@devhax-heavy-industries/arista-eapi';
try {
  await node.configure(['vlan 30']);
} catch (e) {
  if (e instanceof TransportError /* actually SessionError, code 1006 */) {
    const stuck = await node.listSessions();          // show configuration sessions (JSON)
    for (const name of e.likelyOrphans(node)) await node.abortSession(name);
  }
}
```

More session verbs the Python client never had: `configureReplace(url, opts)`,
`rollbackCleanConfig()`, `rollbackToSession(name)`, `commitWithRevertTimer('00:05:00')`
(verify semantics on device — [open items](./DECISIONS.md#open-items-need-the-device)).

Whole-changeset validation without guessing:

```ts
const outcome = await node.exec(configLets, { stopOnError: false, includeErrorDetail: true });
// every command's result + a per-command errorDetail[], instead of "command 7 failed"
const preview = await node.verifyConfig(['vlan 20', 'name PROD']); // normalised configlets, no writes
```

---

## 6. Resources (wave 1)

```ts
await node.system.get();                              // { hostname, ipRouting, banner }
await node.system.setHostname('sw1');
await node.system.setBanner('motd', 'Authorized use only.');   // {cmd,input} multiline under the hood

await node.vlans.get(20);                             // VlanEntry | undefined
await node.vlans.getAll();
await node.switchports.get('Ethernet1');               // { mode, accessVlan, trunkNativeVlan, … }
await node.switchports.setAccessVlan('Ethernet1', 20);
await node.switchports.setTrunkAllowedVlans('Ethernet20', '10-20,30');
await node.switchports.defaultTrunkAllowedVlans('Ethernet20');   // `default` form, not "pass null"

await node.interfaces.getAll();                        // keyed by canonical name
await node.interfaces.portChannel.setMembers('port-channel1', ['Ethernet1', 'Ethernet2'], 'active');
await node.interfaces.portChannel.setMinimumLinks('port-channel1', 1);
await node.interfaces.ethernet.setFlowControl('Ethernet1', 'send', false);
```

Conventions (full table in [MIGRATION.md §3](./MIGRATION.md#3-resource-verb-conventions)):
`setX(v)` / `unsetX()` (`no …`) / `defaultX()` (`default …`) — negation is never implied by passing a
falsy value. `create` / `delete` / `setDefault` for presence. Reads return `undefined` for
not-found; writes **throw**.

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
