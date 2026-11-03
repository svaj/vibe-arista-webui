# `test/fixtures/show/` — per-command `show` reply objects (M4, #6)

Hand-authored **per-command reply** objects (`CommandResult`, i.e. one member of a `runCmds`
`result[]`), not full envelopes — `test/fixtures/wire/` owns the envelope samples, and
`MockTransport` wraps these into one so `parseResponse` stays the only validator (docs/TESTING.md §3).

**These are SYNTHETIC.** No device has been captured by this milestone; `npm test` stays offline
(DR-034), and cEOS provisioning plus the 7050TX-64 sweep are M12 (#14) / STATUS.md §3. Treat the
field **names** the parser reads (`version`, `modelName`, `output`) as the contract to defend, and the
values as illustrative — in particular `version` is the *expected* 4.28.13.1M answer, and DECISIONS.md
open item 1 exists precisely to confirm it (as does the `modelName` spelling: `DCS-7050TX-64` came from
the product MIB, not from a capture). Identifying data (serial, MAC) is placeholder zeros.

When M12 records real captures they go to `test/fixtures/recordings/<host-class>/<case>.json`
(TESTING.md §4) and must never overwrite these.

Naming: `<command>--<scenario>.json`, per TESTING.md §4 — never named after a test.

| File | Covers |
| --- | --- |
| `show-version--4.28.13.1M-dcs-7050tx-64.json` | the target device's `show version` answer as `parseVersionProperties` sees it: `versionNumber` `4.28.13.1`, `model` `7050`, full `modelName` kept |
| `show-running-config--minimal.json` | the `format: "text"` `{output: …}` shape `getConfig`/`showText` unwraps, in the 4.28 section style (trailing `end`) |
| `show-configuration-sessions--pending-orphans.json` | M5 (#7) `listSessions()`/`recoverOrphans()`. **Field names are image-grounded** (`Base.sqsh:/usr/lib/python2.7/site-packages/CliPlugin/ConfigSessionModel.py:15-41`: `sessions{}` keyed by name, `state`, `description`, `completedTime`, `commitBy`, `commitUser`, `instances{pid:{user,terminal,currentTerminal}}`, `maxSavedSessions`, `maxOpenSessions`); **the values are synthetic**, and so is every `state` spelling except `pending` — which is the one confirmed in the image (`CliPlugin/SessionCli.py:67`). The enum's other members come from `Tac.Type('Cli::Session::SessionState')`, so the sample deliberately contains an unrecognised state to pin that recovery reports rather than aborts unknown sessions. Timestamps are illustrative epoch seconds. |
