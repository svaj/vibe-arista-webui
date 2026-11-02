# Testing — Vitest + oxlint conventions for `arista-api-client`

Rules that come from the owner's answers: `npm test` **never** touches a device; the offline suite is
the contract; live tests exist but are gated and single-flight ([DECISIONS.md](./DECISIONS.md)
DR-034, DR-035). Runner/tooling follows the webui: **Vitest 5**, **oxlint**, TypeScript type-checked
build (DR-039). The imported Jest skill in [`.github/skills/`](../../.github/skills/README.md) is
*not* the runner here — its patterns were translated to Vitest.

**Preferred live target:** disposable **cEOS-lab 4.28.14M**, not the home switch.
See the [cEOS runbook](../../docs/CEOS.md) for the local image/vendor instructions,
manual setup, readiness, planned harness contract, browser E2E, and CI restrictions.
The harness is still planned. cEOS is real EOS software, but it does not establish
7050TX-64 hardware behavior or exact **4.28.13.1M** compatibility (DR-043).

---

## 1. Three tiers

| Tier | File pattern | Needs a device? | In `npm test`? | Purpose |
|---|---|---|---|---|
| **Unit** | `src/**/*.test.ts` | no (MockTransport / pure fns) | ✅ | wire codec, parsers, resource command generation, error mapping, session state machine |
| **Fixture / integration** | `src/**/*.fixture.test.ts` | no (recorded 4.28 JSON + config text) | ✅ | full request→response round trips against real device output captured earlier |
| **Live** | `src/**/*.live.test.ts` | **yes** (prefer disposable cEOS) | ❌ (`npm run test:live`) | real eAPI/config-session behavior; ports of pyeapi `test/system/*`; separate opt-in hardware checks |

Tier 1 is where the **behaviour parity** with pyeapi is asserted (same commands in the same order, same
error class for the same code). Tier 2 is where *the device's* actual answers are asserted. Tier 3 keeps
tier 2 honest over time.

Browser E2E is a separate planned **Playwright** lane, not another API-client Vitest
project: browser → same-origin proxy → cEOS. Component tests remain mocked. Explicit
opt-in, endpoint guards, session cleanup, and per-target serialization also apply to E2E.

---

## 2. Configuration

`vitest.config.ts` (projects, not the deprecated workspace file):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,                     // explicit imports; matches webui
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**'],
      exclude: ['src/testing.ts', 'src/**/*.test.ts', 'src/types/**'],
      thresholds: {
        'src/internal/': { lines: 90, branches: 85 },
        'src/transports/': { lines: 85, branches: 80 },
        'src/resources/': { lines: 85, branches: 80 },
        lines: 85, branches: 75, functions: 60,
      },
    },
    projects: [
      { test: { name: 'unit', environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.fixture.test.ts'], exclude: ['src/**/*.live.test.ts'] } },
      { test: { name: 'live', environment: 'node', include: ['src/**/*.live.test.ts'], pool: 'forks', fileParallelism: false, maxWorkers: 1, testTimeout: 60_000 } },
    ],
  },
});
```

Planned `package.json` scripts: `test` → `vitest run --project unit`,
`test:watch` → `vitest --project unit`,
`test:live` → `vitest run --project live`, `coverage` → `vitest run --project unit --coverage`,
`lint` → `oxlint`, `typecheck` → `tsc -b`, `fixtures:refresh` → `node scripts/record-fixtures.ts`.

Environment is **`node`** for the whole package (unit tests exercise the Node transports too); there is
no jsdom dependency in this package — the webui owns DOM testing.

---

## 3. The offline seam: `MockTransport`

Everything device-facing is asserted on generated **commands**, not on side effects.

```ts
const t = mockTransport()
  .replies('show vlan', vlanFixture('three-vlans'))
  .rejects('vlan 20', { code: 1002, message: "CLI command 1 of 2 'vlan 20' failed: invalid command" })
  .capture();

const node = new Node(t);
await node.vlans.create(20);
expect(t.sent()).toEqual([['enable', 'configure session arista-ui-sw1-9f2c1a7b', 'vlan 20']]);
```

Requirements for the mock (build these in M1 — every later test depends on them):
- `replies(cmd | matcher, fixtureName | object)`, `repliesOnce`, `rejects`, `httpStatus(401|403|405)`,
  `tlsFailure()`, `timeoutAfter(ms)`.
- `sent()` returns the **exact command arrays** each request carried, post-prepending — the primary
  assertion surface for resource parity with pyeapi.
- `bodies()` returns the raw JSON-RPC payloads (for header/param tests: `stopOnError`, `format`).
- Unmatched command → thrown `NotSupportedError` naming the command (a loud test failure, never an
  implicit `{}` — pyeapi's `MockConnection` silently returning `{}` is the main reason upstream tests
  are weak on parsing).

For transport-level tests, mock `fetch` with `vi.stubGlobal('fetch', …)` (or `undici` `MockAgent` for
the Node TLS tests) and assert on `init.headers`, `init.signal`, and the body.

---

## 4. Fixtures: recorded, redacted, reviewable

- Directory `test/fixtures/` — `wire/*.json` (hand-authored envelope cases),
  `recordings/<host-class>/<case>.json` (captured), `config/*.conf` (4.28 running-config excerpts).
- Loader `loadFixture('recordings/…')` with a `--update-fixtures` mode; **every fixture is
  redacted on write** (`<redacted>` for `input:`/`secret:`/password args) — DR-011. A test asserts the
  fixture tree contains no `input: "<something-that-isn't-redacted>"` for `cmd: 'enable'`.
- Name fixtures after the *command* + scenario (`show-vlan--three-vlans.json`), never after the test,
  so a broken recording is obvious in review.
- Config-text fixtures must be real 4.28 output once M12 runs the device sweep; before that, mark
  hand-authored ones `# SYNTHETIC — verify on device` so nobody trusts them as truth.
- Keep `recordings/ceos-4.28.14M/` separate from `recordings/7050tx-64-4.28.13.1M/`,
  including config-text captures. Record exact version/model, image identity, commands/format,
  and topology alongside captures; redact identifying data as well as credentials.
  cEOS recordings must never overwrite hardware fixtures.

---

## 5. Live tier

```ts
// src/resources/vlans.live.test.ts
import { liveSuite, liveNode } from '../testing-live.ts';

liveSuite('vlans', () => {                    // prints "skipped: EAPI_LIVE not set" and passes
  const node = liveNode();
  test('create → diff → abort', async ({ scratch }) => {
    const session = await node.configSession({ name: `test-vlan-${crypto.randomUUID().slice(0, 8)}` });
    try {
      await session.apply(scratch.vlanCommands(4000));
      expect(await session.diff()).toContain('vlan 4000');
    } finally {
      await session.abort();                  // always (DR-035)
    }
  });
});
```

Gates, all enforced in `testing-live.ts` (a test that silently skips is worse than no test):
`EAPI_LIVE=1`, `EAPI_HOST`, `EAPI_USER`, `EAPI_PASS`; `EAPI_TARGET_CLASS=lab`
required for anything that writes; `EAPI_SCRATCH_INTERFACE` required for interface writes;
refuse a host that isn't allow-listed in `test/device-allowlist.json` (commit it — an exception, not a
secret); refuse if `show version` reports a major.minor other than `4.28`.
For cEOS also require the expected exact version/model and an allow-listed endpoint
including the published port; a lab label alone is insufficient. Verify authenticated
eAPI readiness and TLS trust before tests, and never fall back to another target.
No test may call `copyRunningToStartup()` (DR-024); a dedicated, explicitly-named
`persist-configuration.live.test.ts` is the only file allowed to, and it must be excluded from the
default live run.

Port policy for the 284 upstream system tests: port the ~70 read-mostly and wave-1 write cases.
Skip upstream system tests that (a) assume `python -m pyeapi` CLI behaviour, (b) create users/roles on
the management path, or (c) need MLAG peers until a separate two-node cEOS topology is
provisioned and support is verified. Record why, in this file, when you skip one.
Keep hardware-only cases separate; unsupported cEOS features are explicit skips, not
proof that the feature is unsupported on the physical switch. Abort uncommitted sessions
in `finally`; committed test changes require explicit reversal or container disposal.

---

## 6. Per-area test inventory (high priority)

| Area | Must-cover cases | Parity source |
|---|---|---|
| `internal/wire.ts` | param allow-list, `version:'latest'`, `cmds` coercion, `stopOnError/includeErrorDetail/requestTimeout`, id format | `test_eapilib.py` request tests |
| `errors.ts` | one case per code: -32700, -32600, -32601, -32602, -32603, 1000, 1001, 1002, 1003, 1004, 1005, 1006; `data[]` vs `errorDetail`; `trace()` alignment; `-32602` "parameter not supported in this version" decoration | `test_eapilib.py::test_error_*` |
| `internal/redact.ts` | enable input absent from message/log/fixture; `username x secret …`; multiline `input` | pyeapi's 1005-only behaviour, extended |
| `transports/fetch.ts` | headers, basic auth byte-parity, 401/403/405 mapping, abort-timeout, no auto-retry on POST, one retry when `readOnly` | `test_eapilib.py::test_send_*` |
| `transports/tls.ts`, `cookie.ts`, `unix.ts` | cert pinning accept/reject; `dangerouslyDisableTlsVerification` warns; `/login` → cookie reuse → `/logout`; unix default path + refusal from browser entry | `test_eapilib.py` `HttpsEapiCert`/`Session` cases |
| `profiles.ts` | INI valid/malformed/no-`host`/tags, `$EAPI_CONF`, unknown profile error | `test_client.py::TestConfig` |
| `node.ts` | `configure terminal` prefix + output pop; `autorefresh`; `get_config` name validation; version/model parsing on 4.28 fixture; error carries `commands` | `test_client.py` (53 — port 30) |
| `node.session.ts` | named re-attach, text-forced `diff`, commit/abort, orphan recovery, 1006, blocked `configure()` while open, journal survives reload | new (upstream has 7 weak cases) |
| `internal/config-text.ts` | nested sections (`router bgp` → `address-family`), `banner … EOF`, `code unit`, short-line error, `section()` parity, memo invalidation | upstream-weak: author from real 4.28 configs |
| `internal/ranges.ts` | `'1-3,5'`, `'Ethernet1-4'`, collapse round-trip, invalid input | `test_utils.py` (15) + property tests |
| `resources/base.ts` | builder precedence table (`set`/`no`/`default`), `configureInterface` non-mutation, throwing resources, registry identity | `abstract.py` cases embedded in module tests |
| `resources/system.ts` | hostname get/set, `ip routing` set/no/default, banner multiline payload | `test_api_system.py` (5) |
| `resources/vlans.ts` | get/create/delete/default, name, state, trunk groups add/remove, invalid vlan id, `getAll` on 4094-vlan config (perf smoke) | `test_api_vlans.py` (15) |
| `resources/switchports.ts` | mode matrix, access vlan, native vlan, allowed vlan + ranges, trunk groups, `name=` fallback regression | `test_api_switchports.py` (21) |
| `resources/interfaces/*` | name parsing matrix (incl. `Po1`, `Vxlan1` in W3), description quoting, shutdown/no-shutdown/default, sflow/flowcontrol/vrf, port-channel members add·remove·replace, lacp mode/fallback/timeout, `getAll` on 48-port fixture | `test_api_interfaces.py` (72 — port 60) |
| `capabilities.ts` | each probe outcome (1002/1004/1005/1006), always-aborts guarantee, TTL cache, `verifyConfig` payload | new |

Type-level tests (`expectTypeOf`) cover: `show('version')` narrows to `ShowVersionReply`; unknown key →
`unknown` (not `any`); `getVlan(20)` → `VlanEntry | undefined`; transport option unions are
mutually exclusive so `{ kind:'unix', host }` fails to compile.

---

## 7. Lint/format

`oxlint` from the repo root config (shared with the webui). Minimum rule expectations for this package:
typed-imports, no-unused-expressions, no-floating-promises equivalent, consistent-type-imports,
`import/no-cycle`, and no `node:` builtins under `src/index.ts`'s reachable graph. Run order in CI:
`typecheck` → `lint` → `test` → `build` (fast failures first).

---

## 8. CI

```
pr:   npm ci → typecheck → lint → test (unit+fixture) → build → coverage report artifact
main: same, plus npm pack smoke test (does the tarball's exports map resolve from the webui?)
trusted dispatch only: provision cEOS → authenticated readiness → test:live and/or Playwright → always teardown
hardware dispatch only: explicit target authorization, secrets, per-endpoint concurrency lock
```

Use a dedicated trusted Linux runner with authorized image access for privileged cEOS;
never execute untrusted/fork PR code there or publish the image as an artifact.
CI concurrency locks serialize jobs per endpoint; live-runner settings must also serialize
test files/workers, and Playwright must use one worker per shared target.
The explicitly requested live/E2E job must fail **visibly** on missing prerequisites,
readiness/target mismatch, no executed tests, or cleanup failure. Local opt-out may skip
with a reason (DR-034); that is not a successful CI cEOS run. `passWithNoTests: false`
alone cannot detect all-skipped suites, so assert that real tests executed. Archive only
redacted diagnostics, and tear down run-owned containers/networks even after failure.
