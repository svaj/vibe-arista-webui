# `src/testing/` — public test helpers (offline only)

`MockTransport` (scripted `replies`/`rejects`, `sent()`, `bodies()`), the fixture loader,
and the recorder (**M1** #3 for the mock, **M2** #4 for transport seams, **M12** #14 for the
recorder). Contract and requirements: docs/TESTING.md §3.

Planned as the `@devhax-heavy-industries/arista-eapi/testing` export subpath (DR-021) once
it has an implementation, so `arista-webui` component tests can render loading/error/empty
states without a switch. It is deliberately **not** wired into `exports` during M0 (#2) —
there is nothing to point at yet.

Nothing in this directory may open a socket: `npm test` stays offline (DR-034).
