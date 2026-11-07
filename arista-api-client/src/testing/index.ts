/**
 * The `./testing` entry (issue #61, epic #60 CAP-TESTING; DR-021's planned subpath, now wired).
 *
 * The **browser-safe half** of `src/testing/` — the offline seam that may ship inside a webui test
 * bundle under Vite: `MockTransport` (the scripted device answer that still runs production
 * `parseResponse`/id-correlation), `createFakeNode` (a real `Node` over it), the M1 wire-level
 * `createFakeSender`, and the recorder/replay pair (`buildRecording`, `replayRecording`,
 * `assertRecordingIdentity`, …). DR-002 pins this graph: no `node:*` may be reachable from here,
 * checked against the source graph in `src/browser-safety.test.ts` and against the emitted bundle in
 * `vite.config.ts`'s `browserSafetyGuard()` — both lists include this entry.
 *
 * The filesystem half (`recorder-node.ts`, `loopback-device.ts`, `fake-conf-fs.ts`) stays behind the
 * sibling `./node/testing` entry (`src/node-testing.ts`).
 */

export { MockTransport, mockTransport, errorEnvelope } from './mock-transport'
export type {
  CommandMatcher,
  MethodMatcher,
  MockFailure,
  MockReply,
  MockTransportOptions,
} from './mock-transport'

export { createFakeNode } from './fake-node'
export type { FakeNode, FakeNodeOptions, FakeNodeScript } from './fake-node'

export { createFakeSender } from './fake-sender'
export type { FakeSender } from './fake-sender'

export * from './recording'
