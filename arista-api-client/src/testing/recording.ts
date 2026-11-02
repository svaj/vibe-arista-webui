/**
 * Recording-mode stub for the fixture recorder — M2 (#4), used by M12 (#14).
 *
 * The point of putting this in the transport layer (rather than in a device-facing script) is that a
 * recording is a **wire** artefact: `src/transports/base.ts` already runs every traced body through
 * `redactWireText`, so an exchange captured here cannot contain an enable password or a
 * `username … secret …` value (DR-011). TESTING.md §4 requires "every fixture is redacted on write";
 * with this seam, redaction happens on *capture*, which is the safer of the two orders.
 *
 * What M12 (#14) adds on top, and deliberately does **not** exist yet:
 *  - writing to `test/fixtures/recordings/<ceos-4.28.14M|7050tx-64-4.28.13.1M>/<case>.json`,
 *    with the image/target identity recorded beside the capture (DR-043);
 *  - the `--update-fixtures` loader and the assertion that no fixture contains an unredacted
 *    `enable` `input`;
 *  - the cEOS provisioning/readiness guards (DR-034/DR-035/DR-043).
 * So no offline test writes a recording, and nothing here is a live-suite harness.
 *
 * Browser-safe (no `node:*`), because the webui's own component tests may record and replay fixtures.
 */

import type { WireTraceRecord, WireTraceSink } from '../transports/contract'

/** One completed request/response (or request/failure) pair, keyed by the DR-017 request id. */
export interface RecordedExchange {
  readonly requestId: string
  readonly endpoint: string
  /** Request text as sent — already redacted, so this is safe to commit. */
  readonly request: string
  /** Response text, when the round trip completed. */
  readonly response?: string | undefined
  /** Mapped failure text, when it did not (`AuthError: …`, `TlsError: …`). */
  readonly failure?: string | undefined
}

export interface Recorder {
  /** Pass this as the transport's `trace` option. */
  readonly sink: WireTraceSink
  /** Completed exchanges, in arrival order. Pending requests are not included. */
  exchanges(): readonly RecordedExchange[]
  /** JSON text ready to become a fixture file once M12 (#14) chooses the layout and target metadata. */
  dump(): string
  /** Drop everything captured so far, e.g. between cases in one file. */
  clear(): void
}

/**
 * Create an in-memory recorder:
 *
 * ```ts
 * const recorder = createRecorder()
 * const transport = createTransport({ kind: 'https', host: 'sw1.lan', username: 'api', password: pw, trace: recorder.sink })
 * await transport.execute('show version')
 * recorder.dump()
 * ```
 */
export function createRecorder(): Recorder {
  const partial = new Map<string, { endpoint: string; request?: string; response?: string; failure?: string }>()
  const done: RecordedExchange[] = []

  const sink: WireTraceSink = (entry: WireTraceRecord): void => {
    const record = partial.get(entry.requestId) ?? { endpoint: entry.endpoint }
    if (entry.direction === 'request') partial.set(entry.requestId, { ...record, request: entry.body })
    else if (entry.direction === 'response') {
      partial.delete(entry.requestId)
      done.push({ requestId: entry.requestId, endpoint: entry.endpoint, request: record.request ?? '', response: entry.body })
    } else {
      partial.delete(entry.requestId)
      done.push({ requestId: entry.requestId, endpoint: entry.endpoint, request: record.request ?? '', failure: entry.body })
    }
  }

  return {
    sink,
    exchanges(): readonly RecordedExchange[] {
      return done.map((entry) => ({ ...entry }))
    },
    dump(): string {
      return JSON.stringify(
        {
          recorded: done.length,
          // A request with no reply is a live/in-flight or cancelled exchange: recording it half-done
          // would produce a fixture nobody can replay, so it is listed but flagged.
          incomplete: [...partial.keys()],
          exchanges: done,
        },
        null,
        2,
      )
    },
    clear(): void {
      partial.clear()
      done.length = 0
    },
  }
}
