# `test/fixtures/recordings/` — captured eAPI round trips (M12, #14)

One directory per **target identity**, one file per command scenario:

```
test/fixtures/recordings/
├── ceos-4.28.14M/                     # disposable cEOS-lab captures (docs/CEOS.md:143)
│   └── show-version--lab-identity.json
└── 7050tx-64-4.28.13.1M/              # physical-switch captures — empty until a sweep runs
    └── (no files: nothing has been captured from the 7050TX-64)
```

The directory name is the slug `src/testing/recording.ts` derives from the device's own
`modelName` + `version` (`cEOS…` + `4.28.14M` → `ceos-4.28.14M`;
`DCS-7050TX-64` + `4.28.13.1M` → `7050tx-64-4.28.13.1M`), and the same pair is written into the
file's `identity` envelope. `src/testing/recorder-node.ts`'s `loadRecording`/`readRecording` (and
`parseRecording` for text) re-derive the slug from the envelope and refuse when it disagrees with the
directory, so a lab capture cannot overwrite a hardware one (DR-043, docs/CEOS.md:143-145,
docs/TESTING.md:130-131). File names are `<command>--<scenario>.json` (docs/TESTING.md:113-114) and
contain no timestamp, so a refresh that changes nothing shows an empty diff.

## Envelope

```json
{ "format": "arista-eapi-recording/v1",
  "identity": { "targetSlug", "targetClass", "modelName", "aristaVersion", "versionNumber",
                "provenance", "endpoint"?, "image"?, "topology"?, "capturedAt"? },
  "captures": [ { "requestId", "commands", "format"?, "result"? | "error"? | "raw"? | "failure" } ],
  "incomplete": [ "request ids that never got a reply" ] }
```

`captures[].commands` is the post-`buildRequest` command list, which is what a replay keys on
(`MockTransport` matches a whole batch by its `"\n"`-joined text — `src/testing/mock-transport.ts:79-88`).
The recorded envelope deliberately drops `jsonrpc`/`id`: replay re-ids the answer through the mock's own
DR-017 policy, which is what keeps `src/transports/base.ts:89` + `transports/correlate.ts` from rejecting
a good fixture over a cosmetic id.

## Redaction (read this before committing a capture)

Every body is redacted **on capture** (`src/transports/base.ts:85-94` → `redactWireText`) and again **on
write** and on load (`src/testing/recording.ts`). The hard rule: `enable` is the only command whose
`input` is a password (`src/internal/redact.ts:50`), so an entry named `enable` must carry exactly
`"<redacted>"`; `username … secret|password …` values are replaced the same way
(`src/internal/redact.ts:46`). A fixture that still spells a real value is refused — by
`buildRecording`/`recordingText` on the way out and by `parseRecording` on the way in — so a
hand-edit that pastes a password back in fails a test rather than a review (DR-011,
docs/TESTING.md:112). The suite in `src/testing/recorder-node.test.ts` runs that guard over **this whole
directory** on every `npm test`.

Identifying data is redacted too, as far as a fixture can be: the slug has no hostname/serial/MAC, and
`endpoint` is a lab origin (`https://localhost:8443/command-api`), never a switch name
(docs/TESTING.md:131, docs/CEOS.md:145).

## Provenance, and what the committed example is not

`identity.provenance` is `"captured"` (a real round trip) or `"hand-authored-example"`. The one file
committed so far is a **hand-authored example of the layout**: no container was booted and no switch was
contacted while writing it (`npm test` stays offline, DR-034). Its `identity.modelName` is the family
placeholder `cEOS`, **not** a device-reported string, and its reply body is minimal (`version`,
`modelName`, `hostname`) rather than real `show version` output. Per docs/TESTING.md:117-118 that marker
lives in the envelope and here, because a JSON fixture has no comment syntax.

Device-captured fixtures arrive with the cEOS harness: `npm run fixtures:refresh` (explicit, opt-in;
it invokes the planned `scripts/ceos-lab.mjs` lab harness and is never part of `npm test`). Nothing in
this directory is evidence about the 7050TX-64 until a hardware sweep runs it (DR-043).
