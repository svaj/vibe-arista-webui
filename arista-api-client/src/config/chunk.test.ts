/**
 * `chunkConfig` unit tests — M6 (#8).
 *
 * Every expected value here was produced by **upstream pyeapi** running `_chunkify` on the same input
 * (the same call path as `scripts/config-chunkify-oracle.py`: `Node._chunkify.__wrapped__`, pyeapi
 * 1.0.4-rc0 at `develop` 6816d9e, CPython 3.13) and then transcribed. That is deliberate: PLAN.md's M6
 * exit gate is "the same text pyeapi would return", so the assertions are pinned to pyeapi's answers,
 * not to what a reviewer might expect a chunker to do. Where upstream's answer is surprising — the
 * `''` key, the single `'!'` key, the `code unit` swallow — the test says so out loud and the
 * MIGRATION.md §5 row records it.
 *
 * The device-facing fixtures live in `test/fixtures/config/` (hand-authored, see that README) and are
 * asserted by `chunk.fixture.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import { ConfigParseError } from '../errors'
import { chunkConfig } from './chunk'

/** Map iteration order is the contract (DR-027's "first matching key"), so entries are compared as lists. */
function entries(config: string): [string, string][] {
  return [...chunkConfig(config).entries()]
}

describe('chunkConfig — top-level sections (pyeapi client.py:698-774)', () => {
  it('returns nothing for empty config text', () => {
    expect(entries('')).toEqual([])
    expect(chunkConfig('').size).toBe(0)
  })

  it('maps each unindented line to itself, terminator included', () => {
    expect(entries('a\nb\n')).toEqual([
      ['a', 'a\n'],
      ['b', 'b\n'],
    ])
  })

  it('keys on the rstripped line but keeps the raw text in the value', () => {
    // upstream: `trailing-space-line` — the body line's trailing spaces survive in the value,
    // and a header with trailing space would key without them.
    expect(entries('router x\n   alpha   \n')).toEqual([['router x', 'router x\n   alpha   \n']])
  })

  it('treats a blank line as a section whose key is the empty string', () => {
    // pyeapi quirk, not a bug we introduced: every blank line in a running-config overwrites that one
    // `''` entry, because the key is the rstripped line. Recorded so M7 (#9) never iterates keys
    // blindly.
    expect(entries('\n')).toEqual([['', '\n']])
  })

  it('collapses the repeated `!` marker EOS writes into a single key holding the last one', () => {
    // `!` is a section key like any other in pyeapi's model, and dict semantics keep the last write.
    // This is why a resource must never ask for `section('!')`.
    expect(entries('!\n!\n')).toEqual([['!', '!\n']])
  })

  it('accepts a tab as indentation, measuring width by characters not columns', () => {
    expect(entries('a\n\tdeep\n')).toEqual([['a', 'a\n\tdeep\n']])
  })
})

describe('chunkConfig — line boundaries follow CPython splitlines, not JS split', () => {
  it('keeps CRLF as one terminator', () => {
    expect(entries('a\r\nb\r\n')).toEqual([
      ['a', 'a\r\n'],
      ['b', 'b\r\n'],
    ])
  })

  it('splits on U+2028 the way Python does, so a pasted config cannot parse differently here than under pyeapi', () => {
    expect(entries('a\u2028b\u2028')).toEqual([
      ['a', 'a\u2028'],
      ['b', 'b\u2028'],
    ])
  })
})

describe('chunkConfig — nested sub-sections', () => {
  const nested = 'mac security\n   profile PR\n      cipher aes256-gcm\n   profile QR\n      cipher aes128-gcm\n!\n'
  /**
   * Upstream's parent value is **not** the whole input: the indent-0 `!` that closes the block is a
   * sibling section, so it is excluded from `mac security`'s text. Transcribed from the real
   * `_chunkify` output (and mirrored by the `mac-security-profile.conf` oracle entry) rather than
   * assumed — a parent key that swallowed its own terminator would make `getBlock` re-emit it.
   */
  const MAC_SECURITY_TEXT =
    'mac security\n   profile PR\n      cipher aes256-gcm\n   profile QR\n      cipher aes128-gcm\n'

  it('keys the sub-sections with their own indentation, and the parent without', () => {
    // This is the docstring example at client.py:705-714, verified against upstream output:
    // '   profile PR' (three spaces IN the key) is a key, 'mac security' is a key.
    expect(entries(nested)).toEqual([
      ['   profile PR', '   profile PR\n      cipher aes256-gcm\n'],
      ['   profile QR', '   profile QR\n      cipher aes128-gcm\n'],
      ['mac security', MAC_SECURITY_TEXT],
      ['!', '!\n'],
    ])
  })

  it('puts sub-section keys BEFORE the parent key, because that is what the recursive merge does', () => {
    // client.py:770-771 is `parsed.update(sections); sections = parsed`, so the inner (deeper) keys are
    // first in iteration order. `section()` takes the first match, so ordering is load-bearing: an
    // unanchored pattern reaches the deepest level first.
    const keys = [...chunkConfig(nested).keys()]
    expect(keys.indexOf('   profile PR')).toBeLessThan(keys.indexOf('mac security'))
  })

  it('gives a parent section the full nested text, so getBlock + parseBlock needs no second lookup', () => {
    // Everything except the closing `!`, which upstream keeps as its own section.
    expect(chunkConfig(nested).get('mac security')).toBe(MAC_SECURITY_TEXT)
    expect(chunkConfig(nested).get('!')).toBe('!\n')
  })

  it('handles three nesting levels (router bgp → vrf → address-family)', () => {
    const three = 'router bgp 1\n   vrf T\n      address-family ipv4\n         neighbor 1.1.1.1 activate\n      !\n   !\n!\n'
    // Note what is NOT a key: the 9-indent `neighbor` line. The indent-6 pass opens a key only when a
    // line is no deeper than 6, so a single deeper line stays inside `address-family ipv4`. Transcribed
    // from upstream — this is the shape M10 (#12) reads interface bodies through.
    expect(entries(three)).toEqual([
      ['      address-family ipv4', '      address-family ipv4\n         neighbor 1.1.1.1 activate\n'],
      ['      !', '      !\n'],
      ['   vrf T', '   vrf T\n      address-family ipv4\n         neighbor 1.1.1.1 activate\n      !\n'],
      ['   !', '   !\n'],
      ['router bgp 1', 'router bgp 1\n   vrf T\n      address-family ipv4\n         neighbor 1.1.1.1 activate\n      !\n   !\n'],
      ['!', '!\n'],
    ])
  })
})

describe('chunkConfig — EOF-terminated blocks', () => {
  it('keeps a banner block as one section, terminator line included', () => {
    expect(entries('banner motd\nhello\nEOF\nhostname x\n')).toEqual([
      ['banner motd', 'banner motd\nhello\nEOF\n'],
      ['hostname x', 'hostname x\n'],
    ])
  })

  it('swallows an unclosed banner to the end of the config rather than inventing a close', () => {
    // Same as upstream. A truncated capture is reported as a truncated section, and M12's (#14)
    // fixture recorder should treat that as a red flag.
    expect(entries('banner motd\nhello\n')).toEqual([['banner motd', 'banner motd\nhello\n']])
  })

  it('does not apply the banner rule to an indented line that reads "banner "', () => {
    // client.py:747 tests the RAW line with startswith('banner '), gated on indent 0.
    expect(entries('router general\n   banner inner\n      text\n   EOF\n!\n')).toEqual([
      ['   banner inner', '   banner inner\n      text\n'],
      ['   EOF', '   EOF\n'],
      ['router general', 'router general\n   banner inner\n      text\n   EOF\n'],
      ['!', '!\n'],
    ])
  })

  it('terminates on EOF only at column 0, matching upstream — and that is a live hazard for code units', () => {
    // The terminator is compared after rstrip ONLY (client.py:744), so `      EOF` never ends the block
    // at indent 0. pyeapi's own code-unit fixture hides the consequence by putting the block last;
    // here an `interface` section after it is consumed. Preserved for parity (MIGRATION.md §5 row 41)
    // and flagged in docs/STATUS.md §3 for the config-text capture to settle.
    const config = 'router general\n   control-functions\n      code unit U\n         body()\n      EOF\ninterface Ethernet1\n   no shutdown\n!\n'
    expect(entries(config)).toEqual([['router general', config]])
    expect(chunkConfig(config).has('interface Ethernet1')).toBe(false)
  })
})

describe('chunkConfig — code unit continuation lines', () => {
  it('starts a section on a leading `code unit` line and absorbs to EOF', () => {
    expect(entries('code unit X\nfoo\nEOF\n')).toEqual([['code unit X', 'code unit X\nfoo\nEOF\n']])
  })

  it('appends a `code unit` line to the section already open instead of opening a new one', () => {
    // client.py:752-759: when `key` is set, the marker line is appended to the open section and that
    // section becomes the multiline target — the marker never becomes its own key at indent 0.
    // Upstream then dies in the short-line check for THIS shape (a continuation line at column 0 puts a
    // 3-char `EOF` inside a body whose indent is 3), so the transcribed expectation is the error.
    // A `code unit` whose body is not deeply indented is unsupported by both implementations.
    const config = 'router general\n   code unit U\nbody\nEOF\n!\n'
    expect(() => chunkConfig(config)).toThrow(ConfigParseError)
    expect(() => chunkConfig(config)).toThrow(
      "Unable to parse section 'router general' at indent 3 due to short line 'EOF'; " +
        'likely unhandled multiline literal block (EOF-terminated)',
    )
  })
})

describe('chunkConfig — the recursion invariant is structural, not a comment', () => {
  it('exposes exactly one parameter, so no caller can pass indent=0 or indent=3 by mistake', () => {
    // pyeapi documents "it's imperative that the most outer call is made with indent=0"
    // (client.py:716-720) on a method any caller can invoke with any indent.
    expect(chunkConfig).toHaveLength(1)
  })

  it('is idempotent per input: chunking the same text twice yields equal, ordered output', () => {
    const config = 'vlan 20\n   name x\n!\nhostname sw1\n'
    expect([...chunkConfig(config)]).toEqual([...chunkConfig(config)])
  })
})

describe('chunkConfig — explicit failure modes', () => {
  it('raises ConfigParseError with pyeapi\'s wording when a body line is shorter than the block indent', () => {
    // Byte-identical to upstream `client.py:723-730` (`{section_key!r}`, `{line!r}` via pythonRepr):
    // a device log and this message can be diffed. Only the class differs (row 33).
    const config = 'router unsupported-literal\n      free-form body at indent six\n   !\n!\n'
    const expected =
      "Unable to parse section 'router unsupported-literal' at indent 6 due to short line '   !'; " +
      'likely unhandled multiline literal block (EOF-terminated)'
    expect(() => chunkConfig(config)).toThrow(ConfigParseError)
    expect(() => chunkConfig(config)).toThrow(expected)
    try {
      chunkConfig(config)
      expect.unreachable('the short line must raise, not answer')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigParseError)
      const parseError = error as ConfigParseError
      expect(parseError.sectionKey).toBe('router unsupported-literal')
      expect(parseError.indent).toBe(6)
      expect(parseError.shortLine).toBe('   !')
      expect(parseError.toJSON()).toMatchObject({ name: 'ConfigParseError', indent: 6, shortLine: '   !' })
    }
  })

  it('raises the same way when a blank line inside a block leaves an under-length sibling', () => {
    const config = 'router x\n   a\n      deep\n\n      END\n   !\n!\n'
    expect(() => chunkConfig(config)).toThrow(
      "Unable to parse section '' at indent 6 due to short line '   !'; " +
        'likely unhandled multiline literal block (EOF-terminated)',
    )
  })

  it('names the line when a config begins with an indented line, where pyeapi raises KeyError: None', () => {
    // client.py:763 assumes "key is always expected to be set by now"; for a config whose first line is
    // indented it is not, and Python dies with `KeyError: None` — no line, no section, no explanation.
    // row 32.
    expect(() => chunkConfig('   orphan\nsecond\n')).toThrow(ConfigParseError)
    try {
      chunkConfig('   orphan\nsecond\n')
      expect.unreachable('an orphaned indented line must raise')
    } catch (error) {
      const parseError = error as ConfigParseError
      expect(parseError.line).toBe(1)
      expect(parseError.message).toBe('Unable to parse config: line 1 \'   orphan\' is indented but no section header precedes it')
    }
  })

  it('does NOT raise for a shallow-but-long line, which is what the check is really about', () => {
    // `len(line) <= indent` is a length test, not an indentation test: a 17-character line under a
    // 6-indent body is "short" to a text editor and fine to pyeapi. Pinned so nobody "fixes" the check
    // into an under-indentation error without a device citation.
    expect(() => chunkConfig('router x\n      deep\n   not short at all\n!\n')).not.toThrow()
  })
})
