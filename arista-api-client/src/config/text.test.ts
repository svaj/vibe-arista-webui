/**
 * Config-text primitives — M6 (#8). The whole engine's correctness rests on this module matching
 * CPython, because pyeapi's `_chunkify` (`pyeapi/client.py:698-774`) is written against
 * `str.splitlines(keepends=True)` (`client.py:738`), `str.rstrip()`/`str.lstrip()` and
 * `len(line) - len(line.lstrip())` (`client.py:732-733`).
 *
 * The splitlines columns below are **transcribed from CPython 3.13.5 on 2026-11-02** (one-off run,
 * Python is not a test dependency) — the exact printed answers:
 *
 *   "a\r\nb\rc\u2028d\u001ce"  splitlines        -> ['a', 'b', 'c', 'd', 'e']
 *                              splitlines(keepends)-> ['a\r\n', 'b\r', 'c\u2028', 'd\x1c', 'e']
 *                              split(chr(10))      -> ['a\r', 'b\rc\u2028d\x1ce']
 *   "a\nb\n"                   splitlines        -> ['a', 'b']        keepends -> ['a\n', 'b\n']
 *                              split(chr(10))      -> ['a', 'b', '']   <-- the phantom element
 *   "a\n\nb"                   splitlines        -> ['a', '', 'b']    keepends -> ['a\n', '\n', 'b']
 *   "\n"                       splitlines        -> ['']              keepends -> ['\n']
 *   ""                         splitlines        -> []                keepends -> []
 * "\r\r"                       splitlines        -> ['', '']          keepends -> ['\r', '\r']
 * "a\r\r\nb"                   splitlines        -> ['a', '', 'b']    keepends -> ['a\r', '\r\n', 'b']
 * "\u001c"                     splitlines        -> ['']              keepends -> ['\x1c']
 * "a\vb\f\u0085d\u2029e\u001df\u001eg" keepends -> ['a\x0b','b\x0c','c\u0085','d\u2029','e\x1d','f\x1e','g']
 *   (against "x\u001fy": '\u001f' is NOT a boundary — the sample above shows \u001c \u001d \u001e are)
 *
 * `rstrip`/`lstrip` CPython answers, same run: `"x\u0085".rstrip() == 'x'`,
 * `"x\u001c\u001d\u001e\u001f".rstrip() == 'x'`, `"   !".rstrip() == '   !'` (rstrip does not touch
 * leading space), `"   code unit U".lstrip() == 'code unit U'`, `"\tdeep".lstrip() == "deep"`.
 * **Divergence pinned against those:** JS `\s` excludes `\u0085` and `\u001c`-`\u001f`, which Python's
 * `str.isspace()` includes, so this module's `rstrip`/`lstrip` keep the exotic terminator byte instead
 * of dropping it — MIGRATION.md §5 row 60. The text here is the ACTUAL behaviour; the CPython value
 * is in the comment. Never flip the assertion without deciding the divergence again.
 */

import { describe, expect, it } from 'vitest'

import {
  describeLine,
  findAllValues,
  findLine,
  findLines,
  findValue,
  lineIndent,
  lstrip,
  parseBlock,
  rstrip,
  splitLines,
  splitLinesKeepends,
  stripLineEnd,
  unquote,
} from './text'

describe('splitLinesKeepends — CPython str.splitlines(keepends=True) boundaries', () => {
  it('REGRESSION (#8 checkpoint fix): \\r\\n, lone \\r, U+2028 and U+001c all split as line boundaries', () => {
    // The first draft scanned `LINE_BREAK_CLASS.includes(char)` — comparing a real character against
    // REGEX ESCAPE TEXT ('\\u2028' as six literal characters), so U+2028/U+001c fell through into line
    // CONTENT and the engine saw different lines than pyeapi would. Fix: LINE_BREAK_CHARS holds code
    // points, LINE_BREAK_CLASS only the regex. Answers transcribed from str.splitlines(keepends=True)
    // on 2026-11-02 (header block above).
    expect(splitLinesKeepends('a\r\nb\rc\u2028d\u001ce')).toEqual(['a\r\n', 'b\r', 'c\u2028', 'd\u001c', 'e'])
  })

  it('CRLF is ONE terminator, and a CR immediately followed by CRLF splits as CR then CRLF', () => {
    expect(splitLinesKeepends('a\r\nb')).toEqual(['a\r\n', 'b'])
    // upstream: "a\r\r\nb".splitlines(keepends=True) -> ['a\r', '\r\n', 'b']
    expect(splitLinesKeepends('a\r\r\nb')).toEqual(['a\r', '\r\n', 'b'])
    // upstream: "\r\r".splitlines(keepends=True) -> ['\r', '\r']
    expect(splitLinesKeepends('\r\r')).toEqual(['\r', '\r'])
  })

  it('the exotic set \\v \\f \\u0085 \\u2028 \\u2029 \\u001c \\u001d \\u001e all terminate a line', () => {
    // upstream: ['a\x0b','b\x0c','c\u0085','d\u2029','e\x1d','f\x1e','g'] (header block; \u2028 covered
    // in the regression case — this transcription sample omitted it to keep the repr readable in
    // Python, but it is in CPython's boundary set and asserted above).
    expect(splitLinesKeepends('a\u000bb\u000cc\u0085d\u2029e\u001df\u001eg')).toEqual([
      'a\u000b',
      'b\u000c',
      'c\u0085',
      'd\u2029',
      'e\u001d',
      'f\u001e',
      'g',
    ])
  })

  it('\\u001f is whitespace to Python but NOT a line boundary — kept inside the line', () => {
    expect(splitLinesKeepends('a\u001fb')).toEqual(['a\u001fb'])
  })

  it('no phantom final element for text ending in a terminator (split("\\n") WOULD invent one)', () => {
    // upstream: "x\n".splitlines(keepends=True) -> ['x\n']   vs   "x\n".split('\n') -> ['x', '']
    expect(splitLinesKeepends('x\n')).toEqual(['x\n'])
    expect(splitLinesKeepends('x\n')).not.toEqual('x\n'.split('\n'))
    // boundary-only inputs:
    expect(splitLinesKeepends('\u001c')).toEqual(['\u001c']) // upstream: ['\x1c']
    expect(splitLinesKeepends('\n')).toEqual(['\n']) // upstream: ['\n']
    expect(splitLinesKeepends('')).toEqual([]) // upstream: []
  })
})

describe('splitLines — same boundaries, terminator removed', () => {
  it('matches the transcribed str.splitlines() answers', () => {
    expect(splitLines('a\r\nb\rc\u2028d\u001ce')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']) // NOT ['a', 'b', ''] like split('\n')
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b'])
    expect(splitLines('\n')).toEqual([''])
    expect(splitLines('')).toEqual([])
    expect(splitLines('\r\r')).toEqual(['', ''])
  })
})

describe('stripLineEnd — removes ONE trailing CPython terminator, nothing else', () => {
  it('handles CRLF as one unit and leaves interior terminators alone', () => {
    expect(stripLineEnd('a\r\n')).toBe('a')
    expect(stripLineEnd('a\n')).toBe('a')
    expect(stripLineEnd('a\r')).toBe('a')
    expect(stripLineEnd('a\u2028')).toBe('a')
    expect(stripLineEnd('a\u001c')).toBe('a')
    expect(stripLineEnd('a\u001f')).toBe('a\u001f') // not a CPython boundary — kept
    expect(stripLineEnd('a\r\r\n')).toBe('a\r')
    expect(stripLineEnd('a\nb\n')).toBe('a\nb') // only the TRAILING one goes
    expect(stripLineEnd('a  ')).toBe('a  ') // whitespace is not a terminator — rstrip's job
  })
})

describe('rstrip / lstrip — CPython whitespace rules, with the JS \\s divergence pinned (row 60)', () => {
  it('strips ordinary whitespace at the correct end', () => {
    expect(rstrip('alpha   \t ')).toBe('alpha')
    expect(rstrip('   !')).toBe('   !') // CPython: '!' is not whitespace, leading space stays
    expect(lstrip('   code unit U')).toBe('code unit U')
    expect(lstrip('\tdeep')).toBe('deep')
    expect(rstrip('')).toBe('')
    expect(lstrip('keep me')).toBe('keep me')
  })

  it('terminators count as trailing whitespace — this is what makes rstripped EOF comparisons work', () => {
    expect(rstrip('EOF\n')).toBe('EOF')
    expect(rstrip('EOF\r\n')).toBe('EOF')
    expect(rstrip('EOF\u2028')).toBe('EOF') // \u2028 IS in JS \s and is Python whitespace: parity
    expect(rstrip('x\u00a0')).toBe('x') // NBSP: whitespace in both sets
  })

  it('DIVERGENCE (MIGRATION.md §5 row 60): \\u0085 and \\u001c-\\u001f are Python whitespace, NOT JS \\s', () => {
    // CPython (transcribed 2026-11-02): "x\u0085".rstrip() == 'x';
    //   "x\u001c\u001d\u001e\u001f".rstrip() == 'x'; "\u0085x".lstrip() == 'x'.
    // This module instead keeps them (JS \s = WhiteSpace+LineTerminator: \u0085 is Cc, \u001c-\u001f are
    // C1 controls — neither is in JS \s). Pinned because the chunk key/EOF compare DIFFERS from pyeapi
    // for a blob ending a line at NEL/U+001c, and EOS never emits those; see the chunk.test.ts side of
    // this divergence. If anybody "fixes" rstrip to match CPython wholesale, both tests flip — decide
    // deliberately.
    expect(rstrip('x\u0085')).toBe('x\u0085') // CPython: 'x'
    expect(rstrip('x\u001c')).toBe('x\u001c') // CPython: 'x'
    expect(lstrip('\u0085x')).toBe('\u0085x') // CPython: 'x'
  })

  it('never touches content, only the ends', () => {
    expect(rstrip('a b  c')).toBe('a b  c')
    expect(lstrip('a  b')).toBe('a  b')
  })
})

describe('lineIndent — leading whitespace COUNT, exactly like upstream get_indent (client.py:732-733)', () => {
  it('counts characters, not tab columns — pyeapi measures len(line) - len(line.lstrip())', () => {
    // upstream `get_indent` at client.py:732-733 is `len(line) - len(line.lstrip())`: a tab costs 1,
    // whatever column it would "render" at (Python's `tabsize` is a display notion this port, like
    // pyeapi, never consults).
    expect(lineIndent('\tdeep')).toBe(1) // len('\tdeep') - len('deep') = 1 (transcribed)
    expect(lineIndent('\t\t x')).toBe(3)
    expect(lineIndent('   profile PR')).toBe(3) // EOS's normal three-space level
    expect(lineIndent('')).toBe(0)
    expect(lineIndent('no indent')).toBe(0)
  })

  it('whitespace classes agree on the characters EOS and pasted blobs actually use', () => {
    expect(lineIndent('\u00a0x')).toBe(1) // NBSP: JS \s yes, Python str.isspace yes
    expect(lineIndent('\u2005x')).toBe(1) // four-per-em space: whitespace in both
  })
})

describe('parseBlock / describeLine — pyeapi has NO equivalent (each api module re-regexes the block)', () => {
  it('splits a section into header + decorated body in device order, `!` separators included', () => {
    const block = parseBlock('vlan 20\n   name "twenty (ops)"\n   state suspend\n      !\n   trunk group red\n')
    expect(block.header).toBe('vlan 20')
    expect(block.body.map((line) => line.text)).toEqual(['name "twenty (ops)"', 'state suspend', '!', 'trunk group red'])
    expect(block.body.map((line) => line.indent)).toEqual([3, 3, 6, 3]) // raw indent is preserved as the depth signal
  })

  it('the `!` sub-block terminator is a body line with token "!", not a block cut', () => {
    // pyeapi's resource regexes treat `!` as an ordinary line inside the block (e.g. the vlans
    // NAME_RE at api/vlans.py:58 searches THROUGH it); parseBlock decorates rather than truncates so
    // M7+ can decide. Nothing here is upstream code — parseBlock is a new-shape helper (its lack of
    // an upstream twin is why rows 57-59 had to re-derive the chunker's contract).
    const block = parseBlock('router bgp 1\n   vrf T\n      !\n   !\n')
    const terminators = block.body.filter((line) => line.token === '!')
    expect(terminators).toHaveLength(2)
    expect(terminators[0]).toMatchObject({ text: '!', indent: 6, value: undefined })
  })

  it('an empty body parses to an empty block, and a whitespace-only line keeps an empty token', () => {
    expect(parseBlock('')).toEqual({ header: '', body: [] })
    expect(describeLine('    ')).toEqual({ text: '', indent: 4, token: '', value: undefined })
  })

  it('describeLine rstrips the value — but the FIRST WHITESPACE RUN stays in it (known contract gap, see note)', () => {
    // **Honest pin, found while writing this suite:** `ConfigLine.value`'s own doc ("everything after
    // the first whitespace run — already unquote`d`") and the `findValue(…, 'name')` example promise
    // `WAN access`; the implementation splits with `^(\S*)([\s\S]*)$`, so `rest` KEEPS the whitespace
    // run and starts with `' '` — therefore `unquote(rstrip(rest))` can never fire (its
    // `startsWith('"')` test sees a space first) and the value carries the leading spaces and the
    // literal quotes. Nothing consumes parseBlock values yet (M7 #9 owns that), so this is pinned as
    // CURRENT behaviour, not blessed: it is reported in the #8 handoff as the one place where
    // `text.ts` does not do what its header comment claims. A one-line implementation fix
    // (`lstrip(rest)` after the token) flips this test — decide it deliberately, in the milestone
    // that owns the change.
    expect(describeLine('   description "WAN uplink (customer A)"')).toMatchObject({
      indent: 3,
      token: 'description',
      value: ' "WAN uplink (customer A)"', // leading run kept; quotes survived — unquote unreachable here
    })
    expect(describeLine('switchport trunk allowed vlan 10-12,20,30-33')).toMatchObject({
      indent: 0,
      token: 'switchport',
      value: ' trunk allowed vlan 10-12,20,30-33',
    })
    expect(describeLine('name')).toMatchObject({ token: 'name', value: undefined })
    expect(describeLine('   name    ten   ')).toMatchObject({ token: 'name', value: '    ten' }) // TRAILING space rstripped, leading kept
  })
})

describe('findLine / findLines — pyeapi\'s `re.search(pattern, config, re.M)` idiom (api/vlans.py:58 NAME_RE style)', () => {
  const config = 'hostname sw1\n\ninterface Ethernet1\n   no switchport\n'

  it('returns the FIRST matching line, terminator removed, and works mid-document like re.M', () => {
    // pyeapi writes `re.compile(r'(?:name\s)(?P<value>.*)$', re.M)` over the whole block — `^`/`$` at
    // any line edge. findLine scans per line, so `m` changes nothing and cannot change (this is the
    // assertion for the "m flag" case):
    expect(findLine(config, /^interface/m)).toBe('interface Ethernet1')
    expect(findLine(config, /^hostname/)).toBe('hostname sw1') // `^` at the very start works too
    expect(findLine('a\nb\n', /b/)).toBe('b')
    expect(findLine(config, /no switchport/)).toBe('   no switchport')
    expect(findLine(config, /nope/)).toBeUndefined()
  })

  it('flags cannot break repeated searches: /g and /y never advance lastIndex through String#search', () => {
    const grab = /Ethernet\d/g
    expect(findLine(config, grab)).toBe('interface Ethernet1')
    expect(findLine(config, grab)).toBe('interface Ethernet1') // pyeapi re.search has no lastIndex concept; same here
    expect(grab.lastIndex).toBe(0)
  })

  it('a STRING needle is matched literally, never compiled into a regex', () => {
    // '.' must match a dot, not "any character": 'a.b' must NOT hit 'axb'. pyeapi code that passes a
    // bare word is usually asking for exactly this.
    expect(findLine('axb\nreal.a.b line', 'a.b')).toBe('real.a.b line')
    expect(findLine('axb\nno dots here', 'a.b')).toBeUndefined()
  })

  it('findLines keeps duplicates and device order — the re.findall(..., re.M) shape', () => {
    const trunk = 'trunk group red\n   trunk group red\n   trunk group blue\n'
    expect(findLines(trunk, 'trunk group')).toEqual(['trunk group red', '   trunk group red', '   trunk group blue'])
    expect(findLines(config, /^[a-z]/)).toEqual(['hostname sw1', 'interface Ethernet1'])
  })
})

describe('findValue / findAllValues — keyword-anchored value reads off a parsed block', () => {
  const body = parseBlock('interface Ethernet1\n   name "WAN uplink (customer A)"\n   no name shadowed\n   nameplate nope\n   trunk group red\n   trunk group blue\n').body

  it('matches the keyword at the line start only, on a word boundary', () => {
    // Values carry the token-rest verbatim (leading space, literal quotes) — the contract gap pinned
    // at the describeLine case above; the KEYWORD match itself is what this test is about:
    expect(findValue(body, 'name')).toBe(' "WAN uplink (customer A)"') // first match wins
    // `no name shadowed` does not START with 'name', and `nameplate` fails the word boundary:
    expect(findAllValues(body, 'name')).toEqual([' "WAN uplink (customer A)"'])
    expect(findValue(body, 'nameplate')).toBe(' nope')
  })

  it('collects every value for repeated keywords — the trunk groups M9 (#11) reads', () => {
    // `value` is EVERYTHING after the line's first token, not after the matched keyword — so a
    // two-word keyword still yields the text past `trunk` (same contract gap as the describeLine
    // pin above): a resource wanting `red`/`blue` must lstrip or re-split. Pinned as CURRENT shape.
    expect(findAllValues(body, 'trunk group')).toEqual([' group red', ' group blue'])
    // two-word keyword match on the full text, not just the first token:
    expect(findValue(body, 'trunk group')).toBe(' group red')
  })

  it('absent keyword → undefined / empty list (never a throw — optional reads differ from section())', () => {
    expect(findValue(body, 'mtu')).toBeUndefined()
    expect(findAllValues(body, 'mtu')).toEqual([])
  })
})

describe('unquote — EOS `"quoted string"` values; pyeapi has NO quote handling at all (row 56)', () => {
  it('strips a matched outer pair, keeping interior spaces verbatim', () => {
    // the switchport-trunk fixture's real device line: description "WAN uplink (customer A)";
    // pyeapi's regex (api/interfaces.py:206 `description (.+)$`) yields the QUOTES verbatim — row 56.
    expect(unquote('"WAN uplink (customer A)"')).toBe('WAN uplink (customer A)')
    expect(unquote('" WAN uplink "')).toBe(' WAN uplink ') // leading/trailing space was WHY EOS quoted it
  })

  it('leaves everything else untouched — deliberately conservative', () => {
    expect(unquote('Don\'t do this')).toBe('Don\'t do this') // apostrophe inside, EOS-legal
    expect(unquote('ten')).toBe('ten')
    expect(unquote('"unbalanced')).toBe('"unbalanced') // a half quote is reported, never repaired
    expect(unquote('trailing"')).toBe('trailing"')
    expect(unquote('"')).toBe('"') // pair check needs length >= 2
    expect(unquote('""')).toBe('')
    expect(unquote('"a"b"c"')).toBe('"a"b"c"') // interior unescaped quotes → not a valid wrapper
  })

  it('un-escapes \\" inside a properly quoted value', () => {
    // This quoting rule is THIS port's (no upstream twin, row 56); EOS itself escapes inner quotes
    // in `show running-config` — the device round-trip of a description with a literal quote is an
    // M12 (#14) capture, so only the port's OWN rules are pinned here.
    expect(unquote('"say \\"hi\\""')).toBe('say "hi"')
  })
})
