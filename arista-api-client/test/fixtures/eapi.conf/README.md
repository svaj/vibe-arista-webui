# `test/fixtures/eapi.conf/` — the INI corpus for M3 (#5)

Five files are **verbatim copies** of Arista's pyeapi fixtures (`pyeapi/test/fixtures/`,
BSD-3-Clause — DR-001, see `arista-api-client/NOTICE`), so our parser is driven by the same bytes
upstream's `test_client.py` pins, not by paraphrase. The rest are hand-authored here to cover the
quirks a live pyeapi run confirmed but upstream has no fixture for. Naming follows the wire corpus
convention: scenario-named, never test-named. Offline (DR-034): these files are the only thing the
loader reads, and `src/testing/fake-conf-fs.ts` puts them behind the injected `ConfFileSystem` seam.

| File | Provenance | Covers |
| --- | --- | --- |
| `eapi.conf` | upstream | three sections, `enablepwd`, space-padded `tags: tag1, tag2`, `test2` with no `host` key (row 51), `localhost` with no `transport` (row 52) |
| `nohost.conf` | upstream | a section with no keys at all — the `host = <name>` defaulting quirk (`client.py:207-211`) |
| `empty.conf` | upstream | a zero-byte file: exists, parses, yields nothing |
| `env_path.conf` | upstream | the file pyeapi points `$EAPI_CONF` at (`client.py:171-172`) |
| `dut.conf` | upstream | a pyeapi-spelled `transport: http` profile |
| `crlf.conf` | ours | CRLF line endings (upstream is all-LF), inline `#` inside secrets kept verbatim (row 49) |
| `duplicate-section.conf` | ours | repeated `[connection:dup]`: we merge first-value-wins and keep reading; pyeapi raises `DuplicateSectionError` and loses every later section (`client.py:198-203`) (row 49) |
| `malformed.conf` | ours | stray line before any header, orphan continuation, junk line without a separator, BOTH nameless-header flavours (`[]` at the header pass, `[connection:]` at the profile pass), a non-connection section, whole-line `;`/`#` comments (rows 49/51) |
| `defaults.conf` | ours | `[DEFAULT]` fields merged into every connection — configparser's `items()` merge pyeapi inherits (`client.py:207`) (row 50) |
| `tags.conf` | ours | tag trimming, a kept-empty tag (`client.py:230`), and a profile nobody tags (row 53) |
| `percent.conf` | ours | `%` inside a value: configparser interpolation makes pyeapi crash with `InterpolationSyntaxError`; here the value is kept verbatim (row 50) |
