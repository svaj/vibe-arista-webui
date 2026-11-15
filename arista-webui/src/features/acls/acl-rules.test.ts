/**
 * S13 (#83): pins for the mirrored ACL rules.
 *
 * The claim in `./acl-rules.ts` is an equivalence claim: the screen stages command text it composes
 * itself (the client's verbs write immediately and cannot live inside a preview session), so every line
 * here is compared against what the **real** `StandardAclsResource` / `ExtendedAclsResource` put on the
 * wire over the client's own `mockTransport`, using the fixture values from
 * `arista-api-client/src/resources/acl.test.ts`. The line refs in the test names are that file's own
 * `toEqual` pins, and each comparison strips the client's `enable` / `configure terminal` framing so the
 * argv being equalled is exactly what `session.run()` would receive from this screen.
 *
 * The refusals are pinned the same way: the client's guard is expected to throw for the input the screen
 * refuses in-form, so the two never disagree about what is writable.
 *
 * Nothing here contacts a device or a proxy (CAP-TESTING), and no test claims what the DCS-7050TX-64
 * accepts — the fixtures are the client spec's own hand-authored config text.
 */
import { describe, expect, it } from 'vitest'
import { maskToPrefixlen, Node, NotSupportedError, prefixlenToMask } from '@devhax-heavy-industries/arista-eapi'
import { mockTransport } from '@devhax-heavy-industries/arista-eapi/testing'

import {
  ACL_KINDS,
  addEntryLines,
  aclNameRefusal,
  aclStemOf,
  COUNTER_GAP,
  createLines,
  defaultLines,
  deleteLines,
  DESTINATION_MODES,
  duplicateSeqRefusal,
  EMPTY_MATCH,
  EMPTY_RULE,
  matchDisplay,
  matchDraftFromMatch,
  matchRefusal,
  matchText,
  maskReading,
  netmaskForPrefixlen,
  protocolRefusal,
  REFERENCE_GAP,
  removeEntryLines,
  replaceEntryLines,
  ruleBody,
  ruleDraftFromEntry,
  ruleLine,
  ruleReproducibility,
  seqnoRefusal,
  sessionDescription,
  UNTOUCHED_MATCH,
} from './acl-rules'
import type { MatchDraft, RuleDraft } from './acl-rules'
import type { AclEntry, CommandSpec } from '@devhax-heavy-industries/arista-eapi'

// ====================================================================================================
// The client side of the equivalence claim
// ====================================================================================================

/** The client's own write framing: `enable`, `configure terminal`, then the lines under test. */
const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

/**
 * Run one real client verb over `mockTransport` and return the argv it sent, with the `enable` /
 * `configure terminal` framing stripped — i.e. exactly the list this screen hands to `session.run()`.
 */
async function clientArgv(verb: (node: Node) => Promise<unknown>, cmds: readonly string[]): Promise<readonly string[]> {
  const transport = mockTransport().replies(writeKey(cmds), [{}, {}, ...cmds.map(() => ({}))])
  await verb(new Node(transport))
  const sent = transport.sent().at(-1)?.map((entry) => String(entry))
  if (sent === undefined) throw new Error('the client sent nothing')
  return sent.slice(2)
}

/** What this screen would hand `session.run()`, as plain strings. */
const staged = (specs: readonly CommandSpec[]): readonly string[] => specs.map((spec) => String(spec))

/** The message the client's guard throws for a write it refuses, or `undefined` when it sends it. */
async function clientRefusal(verb: (node: Node) => Promise<unknown>): Promise<string | undefined> {
  try {
    await verb(new Node(mockTransport()))
  } catch (thrown: unknown) {
    expect(thrown).toBeInstanceOf(NotSupportedError)
    return (thrown as Error).message
  }
  return undefined
}

const draft = (over: Partial<RuleDraft>): RuleDraft => ({ ...EMPTY_RULE, ...over })
const match = (over: Partial<MatchDraft>): MatchDraft => ({ ...EMPTY_MATCH, ...over })

// ====================================================================================================
// Section verbs
// ====================================================================================================

describe('acl-rules section lines equal the real ACL resources byte for byte', () => {
  it('the two kinds are the two the client knows, and the header differs only by the kind word', () => {
    expect(ACL_KINDS).toEqual(['standard', 'extended'])
    expect(aclStemOf('standard', 'test')).toBe('ip access-list standard test')
    expect(aclStemOf('extended', 'exttest')).toBe('ip access-list exttest')
    expect(sessionDescription('delete')).toBe('webui acl delete')
  })

  it('create: `ip access-list standard test` / `ip access-list exttest` (acl.test.ts:524-525)', async () => {
    const stdPin = ['ip access-list standard test']
    expect(staged(createLines('standard', 'test'))).toEqual(stdPin)
    expect(await clientArgv((node) => node.acls.standard.create('test'), stdPin)).toEqual(stdPin)

    const extPin = ['ip access-list exttest']
    expect(staged(createLines('extended', 'exttest'))).toEqual(extPin)
    expect(await clientArgv((node) => node.acls.extended.create('exttest'), extPin)).toEqual(extPin)
  })

  it('delete: `no ip access-list [standard] <name>` (acl.test.ts:557 / :573)', async () => {
    const stdPin = ['no ip access-list standard test']
    expect(staged(deleteLines('standard', 'test'))).toEqual(stdPin)
    expect(await clientArgv((node) => node.acls.standard.delete('test'), stdPin)).toEqual(stdPin)

    const extPin = ['no ip access-list exttest']
    expect(staged(deleteLines('extended', 'exttest'))).toEqual(extPin)
    expect(await clientArgv((node) => node.acls.extended.delete('exttest'), extPin)).toEqual(extPin)
  })

  it('default: `default ip access-list [standard] <name>` (acl.test.ts:558 / :574)', async () => {
    const stdPin = ['default ip access-list standard test']
    expect(staged(defaultLines('standard', 'test'))).toEqual(stdPin)
    expect(await clientArgv((node) => node.acls.standard.setDefault('test'), stdPin)).toEqual(stdPin)

    const extPin = ['default ip access-list exttest']
    expect(staged(defaultLines('extended', 'exttest'))).toEqual(extPin)
    expect(await clientArgv((node) => node.acls.extended.setDefault('exttest'), extPin)).toEqual(extPin)
  })
})

// ====================================================================================================
// Entry verbs
// ====================================================================================================

describe('acl-rules entry batches equal the real ACL resources byte for byte', () => {
  it('standard addEntry with no sequence number (acl.test.ts:603)', async () => {
    const pin = ['ip access-list standard test', 'permit 0.0.0.0/32 log', 'exit']
    expect(staged(addEntryLines('standard', 'test', 'permit 0.0.0.0/32 log', ''))).toEqual(pin)
    expect(await clientArgv((node) => node.acls.standard.addEntry('test', { action: 'permit', src: { address: '0.0.0.0', prefixlen: 32 }, log: true }), pin)).toEqual(pin)
  })

  it('standard addEntry without log (acl.test.ts:604)', async () => {
    const pin = ['ip access-list standard test', 'permit 0.0.0.0/32', 'exit']
    expect(staged(addEntryLines('standard', 'test', 'permit 0.0.0.0/32', ''))).toEqual(pin)
    expect(await clientArgv((node) => node.acls.standard.addEntry('test', { action: 'permit', src: { address: '0.0.0.0', prefixlen: 32 }, log: false }), pin)).toEqual(pin)
  })

  it('standard addEntry with a sequence number (acl.test.ts:605)', async () => {
    const pin = ['ip access-list standard test', '30 permit 0.0.0.0/32 log', 'exit']
    expect(staged(addEntryLines('standard', 'test', 'permit 0.0.0.0/32 log', '30'))).toEqual(pin)
    expect(await clientArgv((node) => node.acls.standard.addEntry('test', { action: 'permit', src: { address: '0.0.0.0', prefixlen: 32 }, log: true, seqno: 30 }), pin)).toEqual(pin)
  })

  it('standard updateEntry negates the old number first (acl.test.ts:586)', async () => {
    const pin = ['ip access-list standard test', 'no 10', '10 permit 0.0.0.0/32 log', 'exit']
    expect(staged(replaceEntryLines('standard', 'test', '10', 'permit 0.0.0.0/32 log'))).toEqual(pin)
    expect(await clientArgv((node) => node.acls.standard.updateEntry('test', 10, { action: 'permit', src: { address: '0.0.0.0', prefixlen: 32 }, log: true }), pin)).toEqual(pin)
  })

  it('standard removeEntry (acl.test.ts:616)', async () => {
    const pin = ['ip access-list standard test', 'no 10', 'exit']
    expect(staged(removeEntryLines('standard', 'test', '10'))).toEqual(pin)
    expect(await clientArgv((node) => node.acls.standard.removeEntry('test', 10), pin)).toEqual(pin)
  })

  it('extended addEntry with no sequence number (acl.test.ts:644)', async () => {
    const pin = ['ip access-list exttest', 'permit ip 0.0.0.0/32 1.1.1.1/32 log', 'exit']
    expect(staged(addEntryLines('extended', 'exttest', 'permit ip 0.0.0.0/32 1.1.1.1/32 log', ''))).toEqual(pin)
    const entry = { action: 'permit', protocol: 'ip', src: { address: '0.0.0.0', prefixlen: 32 }, dst: { address: '1.1.1.1', prefixlen: 32 }, log: true } as const
    expect(await clientArgv((node) => node.acls.extended.addEntry('exttest', entry), pin)).toEqual(pin)
  })

  it('extended addEntry with a sequence number (acl.test.ts:646)', async () => {
    const pin = ['ip access-list exttest', '30 permit ip 0.0.0.0/32 1.1.1.1/32 log', 'exit']
    expect(staged(addEntryLines('extended', 'exttest', 'permit ip 0.0.0.0/32 1.1.1.1/32 log', '30'))).toEqual(pin)
    const entry = { action: 'permit', protocol: 'ip', src: { address: '0.0.0.0', prefixlen: 32 }, dst: { address: '1.1.1.1', prefixlen: 32 }, log: true, seqno: 30 } as const
    expect(await clientArgv((node) => node.acls.extended.addEntry('exttest', entry), pin)).toEqual(pin)
  })

  it('extended updateEntry (acl.test.ts:627)', async () => {
    const pin = ['ip access-list exttest', 'no 10', '10 permit ip 0.0.0.0/32 1.1.1.1/32 log', 'exit']
    expect(staged(replaceEntryLines('extended', 'exttest', '10', 'permit ip 0.0.0.0/32 1.1.1.1/32 log'))).toEqual(pin)
    const entry = { action: 'permit', protocol: 'ip', src: { address: '0.0.0.0', prefixlen: 32 }, dst: { address: '1.1.1.1', prefixlen: 32 }, log: true } as const
    expect(await clientArgv((node) => node.acls.extended.updateEntry('exttest', 10, entry), pin)).toEqual(pin)
  })

  it('extended removeEntry (acl.test.ts:647)', async () => {
    const pin = ['ip access-list exttest', 'no 10', 'exit']
    expect(staged(removeEntryLines('extended', 'exttest', '10'))).toEqual(pin)
    expect(await clientArgv((node) => node.acls.extended.removeEntry('exttest', 10), pin)).toEqual(pin)
  })
})

// ====================================================================================================
// The four match arms: the composed body equals the composed body the client sends (acl.test.ts:669-673)
// ====================================================================================================

describe('acl-rules composes the four match arms exactly as the client renders them', () => {
  const armCases: readonly { readonly line: string; readonly type: 'standard' | 'extended'; readonly form: RuleDraft; readonly client: (node: Node) => Promise<unknown> }[] = [
    {
      line: 'permit ip any any',
      type: 'extended',
      form: draft({ action: 'permit', protocol: 'ip', source: match({ mode: 'any' }), destination: match({ mode: 'any' }) }),
      client: (node) => node.acls.extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } }),
    },
    {
      line: 'permit tcp host 1.1.1.1 host 2.2.2.2',
      type: 'extended',
      form: draft({ action: 'permit', protocol: 'tcp', source: match({ mode: 'host', address: '1.1.1.1' }), destination: match({ mode: 'host', address: '2.2.2.2' }) }),
      client: (node) => node.acls.extended.addEntry('exttest', { action: 'permit', protocol: 'tcp', src: { host: '1.1.1.1' }, dst: { host: '2.2.2.2' } }),
    },
    {
      line: 'permit tcp 3.3.3.0/24 4.4.4.0/24',
      type: 'extended',
      form: draft({ action: 'permit', protocol: 'tcp', source: match({ mode: 'prefix', address: '3.3.3.0', prefixlen: '24' }), destination: match({ mode: 'prefix', address: '4.4.4.0', prefixlen: '24' }) }),
      client: (node) => node.acls.extended.addEntry('exttest', { action: 'permit', protocol: 'tcp', src: { address: '3.3.3.0', prefixlen: 24 }, dst: { address: '4.4.4.0', prefixlen: 24 } }),
    },
    {
      line: 'permit 10.20.0.0 0.0.255.255',
      type: 'standard',
      form: draft({ action: 'permit', source: match({ mode: 'wildcard', address: '10.20.0.0', mask: '0.0.255.255' }) }),
      client: (node) => node.acls.standard.addEntry('test', { action: 'permit', src: { address: '10.20.0.0', mask: '0.0.255.255' } }),
    },
    {
      line: 'permit host 1.2.3.4 log',
      type: 'standard',
      form: draft({ action: 'permit', source: match({ mode: 'host', address: '1.2.3.4' }), log: true }),
      client: (node) => node.acls.standard.addEntry('test', { action: 'permit', src: { host: '1.2.3.4' }, log: true }),
    },
  ]

  for (const arm of armCases) {
    it(`${arm.line} comes from both sides identically`, async () => {
      const composed = ruleBody(arm.type, arm.form)
      if (!('body' in composed)) throw new Error(`the screen refused a line the client pins: ${composed.refusal}`)
      expect(composed.body).toBe(arm.line)
      const pin = [arm.type === 'standard' ? 'ip access-list standard test' : 'ip access-list exttest', arm.line, 'exit']
      // The client's own verb, driven for real, puts the same rule text on the wire.
      expect(await clientArgv(arm.client, pin)).toEqual(pin)
    })
  }

  it('`permit ip any any` is reachable: choosing `any` on the destination composes the client pin', () => {
    // The pin at acl.test.ts:669 is this exact line, so a screen that could not write it would be wrong
    // about the client — which is why the destination has an explicit `untouched` arm instead of an
    // `any` default that could not be told apart from a form nobody finished.
    expect(UNTOUCHED_MATCH.mode).toBe('untouched')
    expect(DESTINATION_MODES[0]?.value).toBe('untouched')
    expect(EMPTY_RULE.destination).toBe(UNTOUCHED_MATCH)
    const untouched = ruleBody('extended', draft({ action: 'permit', protocol: 'ip' }))
    expect('refusal' in untouched ? untouched.refusal : '').toMatch(/destination is untouched/u)
    expect(matchText(EMPTY_MATCH)).toBe('any')
    expect(() => { matchText(UNTOUCHED_MATCH) }).toThrow(/no line text/u)
  })
})

// ====================================================================================================
// Refusals: the client's guard throws for the same inputs this screen refuses in-form
// ====================================================================================================

describe('acl-rules refusals track the client guards', () => {
  it('an empty or padded ACL name is refused here and by assertAclName; inner whitespace is legal on both', async () => {
    expect(aclNameRefusal('')).toMatch(/empty ACL name/u)
    expect(aclNameRefusal('   ')).toMatch(/empty ACL name/u)
    expect(aclNameRefusal(' spaced ')).toMatch(/leading or trailing whitespace/u)
    expect(aclNameRefusal('bad\u0007name')).toMatch(/control character/u)
    expect(aclNameRefusal('has space')).toBeUndefined()

    expect(await clientRefusal((node) => node.acls.standard.create(''))).toMatch(/empty ACL name/u)
    expect(await clientRefusal((node) => node.acls.standard.create(' spaced '))).toMatch(/leading or trailing whitespace/u)
    // The client both writes and reads back an inner-space name, so the screen must not refuse it.
    const pin = ['ip access-list standard has space']
    expect(await clientArgv((node) => node.acls.standard.create('has space'), pin)).toEqual(pin)
  })

  it('a protocol token is required on the extended side, refused on a standard rule, and never interpolated raw', async () => {
    expect(protocolRefusal('')).toMatch(/needs a protocol token/u)
    expect(protocolRefusal('tcp 80')).toMatch(/single protocol token/u)
    expect(protocolRefusal('47')).toBeUndefined()
    expect(await clientRefusal((node) => node.acls.extended.addEntry('exttest', { action: 'permit', protocol: 'tcp 80', src: { any: true }, dst: { any: true } }))).toMatch(/ACL protocol/u)
    // The screen never composes a standard line with a protocol, which is the refusal the client raises:
    expect(await clientRefusal((node) => node.acls.standard.addEntry('test', { action: 'permit', protocol: 'ip', src: { any: true } }))).toMatch(/has no protocol field/u)
    const std = ruleBody('standard', draft({ action: 'permit', protocol: 'tcp 80', source: match({ mode: 'any' }) }))
    expect('body' in std).toBe(true)
  })

  it('a non-numeric sequence number is refused here and by the read-side grammar the client keys by', async () => {
    expect(seqnoRefusal('')).toBeUndefined()
    expect(seqnoRefusal('10')).toBeUndefined()
    expect(seqnoRefusal('-1')).toMatch(/digits only/u)
    expect(seqnoRefusal('1e3')).toMatch(/digits only/u)
    expect(seqnoRefusal('42949672960000000000000')).toMatch(/more digits/u)
    expect(await clientRefusal((node) => node.acls.standard.removeEntry('test', -1))).toMatch(/sequence number/u)
  })

  it('a duplicate sequence number is refused by this screen alone — the client stages it, its reader then reports it', async () => {
    expect(duplicateSeqRefusal([10, 20], '')).toBeUndefined()
    expect(duplicateSeqRefusal([10, 20], '30')).toBeUndefined()
    expect(duplicateSeqRefusal([10, 20], 'abc')).toBeUndefined()
    expect(duplicateSeqRefusal([10, 20], '20')).toMatch(/already used in this ACL/u)
    // The client offers no such guard: it sends the line, and only its READER refuses the result. That
    // asymmetry is why the refusal is labelled a screen rule rather than a client one.
    const pin = ['ip access-list standard test', '10 permit 1.1.1.1/32', 'exit']
    expect(await clientArgv((node) => node.acls.standard.addEntry('test', { action: 'permit', src: { address: '1.1.1.1', prefixlen: 32 }, seqno: 10 }), pin)).toEqual(pin)
  })

  it('the mask arm is refused on the extended side, exactly where renderMatch refuses it', async () => {
    const refusal = matchRefusal('destination', match({ mode: 'wildcard', address: '1.1.1.0', mask: '0.0.0.255' }), false)
    expect(refusal).toMatch(/standard-ACL spelling/u)
    expect(await clientRefusal((node) => node.acls.extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { address: '1.1.1.0', mask: '0.0.0.255' }, dst: { any: true } }))).toMatch(/standard-ACL spelling/u)
    // and the same arm is legal on a standard source, which is the wildcard the client reads verbatim
    expect(matchRefusal('source', match({ mode: 'wildcard', address: '10.20.0.0', mask: '0.0.255.255' }), true)).toBeUndefined()
  })

  it('a blank or malformed quad, and a prefix length outside 0..32, are refused before a session opens', () => {
    expect(matchRefusal('source', match({ mode: 'host', address: '' }), true)).toMatch(/is empty/u)
    expect(matchRefusal('source', match({ mode: 'host', address: '1.2.3' }), true)).toMatch(/dotted-quad/u)
    expect(matchRefusal('source', match({ mode: 'prefix', address: '1.2.3.0' }), true)).toMatch(/missing its prefix length/u)
    expect(matchRefusal('source', match({ mode: 'prefix', address: '1.2.3.0', prefixlen: '2a' }), true)).toMatch(/integer prefix length/u)
    expect(matchRefusal('source', match({ mode: 'prefix', address: '1.2.3.0', prefixlen: '33' }), true)).toMatch(/outside 0\.\.32/u)
    expect(matchRefusal('source', match({ mode: 'wildcard', address: '1.2.3.0', mask: '256.0.0.0' }), true)).toMatch(/wildcard mask/u)
    expect(matchRefusal('source', match({ mode: 'any' }), true)).toBeUndefined()
  })

  it('the guard order is the client\'s: an empty form hears about the action first', () => {
    // ruleBody mirrors renderEntryBody branch for branch, so the FIRST refusal the screen shows is the
    // first refusal the client would raise.
    const empty = ruleBody('standard', draft({}))
    if ('body' in empty) throw new Error(`an empty form must be refused, got ${empty.body}`)
    expect(empty.refusal).toMatch(/Choose permit or deny/u)
  })
})

// ====================================================================================================
// Read-back rendering and the reproducibility refusal
// ====================================================================================================

describe('acl-rules renders read-back rules as the config wrote them', () => {
  it('matchDisplay keeps every arm distinguishable, including an operator the screen cannot write', () => {
    expect(matchDisplay({ kind: 'any' })).toBe('any')
    expect(matchDisplay({ kind: 'host', address: '1.2.3.4' })).toBe('host 1.2.3.4')
    expect(matchDisplay({ kind: 'address', address: '5.6.7.0', prefixlen: 24 })).toBe('5.6.7.0/24')
    expect(matchDisplay({ kind: 'address', address: '10.20.0.0', mask: '0.0.255.255' })).toBe('10.20.0.0 0.0.255.255')
    expect(matchDisplay({ kind: 'address', address: '1.2.3.4' })).toBe('1.2.3.4')
    expect(matchDisplay({ kind: 'host', address: '1.1.1.1', operator: 'eq 161' })).toBe('host 1.1.1.1 eq 161')
  })

  /** Rule text as the client's own fixture blocks spell it (read model, not re-derived). */
  const wildcardRead: AclEntry = { seqno: 20, action: 'permit', src: { kind: 'address', address: '10.20.0.0', mask: '0.0.255.255' } }
  const logRead: AclEntry = { seqno: 30, action: 'deny', protocol: 'ip', src: { kind: 'any' }, dst: { kind: 'any' }, log: true }
  const optionsRead: AclEntry = { seqno: 40, action: 'deny', protocol: 'ip', src: { kind: 'any' }, dst: { kind: 'any' }, log: true, options: 'urg ttl eq 24 fragments tracked' }
  const hostLogRead: AclEntry = { seqno: 10, action: 'permit', src: { kind: 'host', address: '1.2.3.4' }, log: true }
  const srcOperatorRead: AclEntry = { seqno: 11, action: 'permit', protocol: 'tcp', src: { kind: 'host', address: '1.1.1.1', operator: 'eq 161' }, dst: { kind: 'host', address: '2.2.2.2' } }
  const dstOperatorRead: AclEntry = { seqno: 12, action: 'permit', protocol: 'tcp', src: { kind: 'any' }, dst: { kind: 'host', address: '2.2.2.2', operator: 'range 1024 2048' } }
  const optionsOnlyRead: AclEntry = { seqno: 13, action: 'permit', protocol: 'tcp', src: { kind: 'any' }, dst: { kind: 'any' }, options: 'ttl eq 1 tracked' }
  const prefixRead: AclEntry = { seqno: 50, action: 'deny', protocol: 'ip', src: { kind: 'address', address: '5.6.7.0', prefixlen: 24 }, dst: { kind: 'any' }, log: true }
  const bareQuadRead: AclEntry = { seqno: 60, action: 'permit', src: { kind: 'address', address: '9.9.9.9' } }

  it('ruleLine re-emits the whole line, options tail last, exactly as the block has it', () => {
    expect(ruleLine(wildcardRead)).toBe('20 permit 10.20.0.0 0.0.255.255')
    expect(ruleLine(logRead)).toBe('30 deny ip any any log')
    expect(ruleLine(optionsRead)).toBe('40 deny ip any any log urg ttl eq 24 fragments tracked')
  })

  it('ruleReproducibility refuses exactly the rules carrying text the verbs drop (divergence 9)', () => {
    expect(ruleReproducibility(hostLogRead)).toBeUndefined()
    expect(ruleReproducibility(logRead)).toBeUndefined()
    const srcOp = ruleReproducibility(srcOperatorRead)
    expect(srcOp).toMatch(/source operator "eq 161"/u)
    expect(srcOp).toMatch(/divergence 9/u)
    expect(ruleReproducibility(dstOperatorRead)).toMatch(/destination operator "range 1024 2048"/u)
    expect(ruleReproducibility(optionsOnlyRead)).toMatch(/option tail "ttl eq 1 tracked"/u)
    // The refusal names the way out that this screen CAN take, and does not claim the tail is invalid.
    expect(srcOp).toMatch(/Remove rule/u)
  })

  it('ruleDraftFromEntry prefills a writable rule so a replace round-trips to the same line', () => {
    const prefilled = ruleDraftFromEntry(wildcardRead)
    expect(prefilled.seqno).toBe('20')
    const composed = ruleBody('standard', prefilled)
    expect('body' in composed ? composed.body : '').toBe('permit 10.20.0.0 0.0.255.255')
    // The prefill is faithful: the line the form would write is the line the config has.
    expect(ruleLine(wildcardRead)).toBe(`20 ${'body' in composed ? composed.body : ''}`)
    // A standard entry has no destination, so the form for one never shows that field.
    expect(prefilled.destination).toBe(EMPTY_MATCH)
    expect(prefilled.protocol).toBe('')

    const extDraft = ruleDraftFromEntry(prefixRead)
    expect(extDraft.destination.mode).toBe('any')
    expect(ruleBody('extended', extDraft)).toEqual({ body: 'deny ip 5.6.7.0/24 any log' })

    expect(matchDraftFromMatch({ kind: 'any' })).toEqual(EMPTY_MATCH)
    expect(matchDraftFromMatch({ kind: 'host', address: '1.1.1.1' })).toEqual({ mode: 'host', address: '1.1.1.1', prefixlen: '', mask: '' })
    // A bare quad with neither length nor mask becomes the prefix arm at /32 — the client's own reading
    // of such a line, which is why THAT arm and not another carries it.
    expect(matchDraftFromMatch({ kind: 'address', address: '9.9.9.9' })).toEqual({ mode: 'prefix', address: '9.9.9.9', prefixlen: '32', mask: '' })
    expect(ruleBody('standard', ruleDraftFromEntry(bareQuadRead))).toEqual({ body: 'permit 9.9.9.9/32' })
    // A read that carries an operator never reaches this prefill (the Edit control stays refused), so
    // the operator text is not silently dropped into a writable arm.
    expect(() => { ruleDraftFromEntry(srcOperatorRead) }).not.toThrow()
    expect(ruleDraftFromEntry(srcOperatorRead).source).toEqual({ mode: 'host', address: '1.1.1.1', prefixlen: '', mask: '' })
  })
})

// ====================================================================================================
// The mask helpers the client exports (divergence 2 is the reason the parser never uses them)
// ====================================================================================================

describe('acl-rules mask helpers report what the client computes, and when it is not a prefix length', () => {
  it('netmaskForPrefixlen is the client prefixlen_to_mask (acl.py:68-79)', () => {
    expect(netmaskForPrefixlen(24)).toBe('255.255.255.0')
    expect(netmaskForPrefixlen(0)).toBe('0.0.0.0')
    expect(netmaskForPrefixlen(32)).toBe('255.255.255.255')
    expect(prefixlenToMask(16)).toBe('255.255.0.0')
  })

  it('maskReading answers the netaddr fact and labels the unfaithful ones', () => {
    expect(maskReading('255.255.255.0')).toEqual({ prefixlen: 24, faithful: true })
    expect(maskReading('255.255.0.0')).toEqual({ prefixlen: 16, faithful: true })
    // A standard-ACL wildcard is NOT a netmask: the helper answers 32, which would call the source a
    // single host. This is divergence 2, and why no rule is ever rewritten through these helpers.
    expect(maskReading('0.0.255.255')).toEqual({ prefixlen: 32, faithful: false })
    expect(maskReading('255.0.255.0')).toEqual({ prefixlen: 32, faithful: false })
    expect(maskReading('0.0.0.0')).toEqual({ prefixlen: 0, faithful: true })
    expect(maskToPrefixlen(undefined)).toBe(32)
    expect(maskReading('')).toEqual({ prefixlen: 32, faithful: false })
    expect(() => { maskReading('banana') }).toThrow(NotSupportedError)
  })
})

// ====================================================================================================
// The two gap statements, which the screen renders verbatim
// ====================================================================================================

describe('acl-rules states the two gaps #83 has to be honest about', () => {
  it('the reference gap says the screen cannot see ip access-group and did not check', () => {
    expect(REFERENCE_GAP).toMatch(/no read in this client covers `ip access-group`/u)
    expect(REFERENCE_GAP).toMatch(/does NOT claim it checked/u)
    expect(REFERENCE_GAP).toMatch(/the device `diff\(\)` is the only evidence/u)
  })

  it('the counter gap says no hit numbers are printed, because nothing is captured', () => {
    expect(COUNTER_GAP).toMatch(/`show access-lists` has no capture/u)
    expect(COUNTER_GAP).toMatch(/never prints a hit/u)
  })
})
