# `src/testing/` — public test helpers (offline only)

`MockTransport` (scripted `replies`/`rejects`, `sent()`, `bodies()`), the fixture loader,
and the recorder (**M1** #3 for the mock, **M2** #4 for transport seams, **M12** #14 for the
recorder). Contract and requirements: docs/TESTING.md §3.

**Wired as public subpaths by #61 (DR-021's planned entry, M0's deferral now closed):**

- `@devhax-heavy-industries/arista-eapi/testing` — the browser-safe half (`src/testing/index.ts`):
  `MockTransport`/`mockTransport`, `createFakeNode` (a real `Node` over the mock with the enable
  framing folded for one-command reads), `createFakeSender`, and the record/replay pair. This is
  what `arista-webui` component tests import — DR-002 binds it as hard as the browser entry,
  from both the source graph (`browser-safety.test.ts`) and the bundle (`browserSafetyGuard`).
- `@devhax-heavy-industries/arista-eapi/node/testing` — the fs/socket half (`src/node-testing.ts`):
  the fs recorder (`recorder-node.ts`), loopback device/TLS fixtures (`loopback-device.ts`), and the
  fake `eapi.conf` filesystem (`fake-conf-fs.ts`). Never reachable from any production entry, and
  the seam modules themselves are not reachable from `src/index.ts`/`src/node.ts` — shipped code
  does not import its own test scaffolding.

Nothing in this directory may open a socket: `npm test` stays offline (DR-034). The loopback
devices are constructed only by explicit Node tests, exactly as before.
