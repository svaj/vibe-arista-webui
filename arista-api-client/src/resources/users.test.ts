/**
 * `UsersResource` — W2a (#35), the port of `pyeapi/test/unit/test_api_users.py`'s **22** test methods
 * plus the specs the divergences require (MIGRATION.md §5 rows 150-155, DR-089/DR-091).
 *
 * Every read runs over `MockTransport` answering a real config TEXT through the real `Node`
 * (docs/TESTING.md §3); every write is pinned to the exact joined command list —
 * `enable\nconfigure terminal\n<line>` — because an opener-only key never matches (DR-083).
 *
 * Upstream port ledger, method by method (all refs re-opened in `pyeapi` @ `6816d9e` on 2026-11-05;
 * the sibling brief's `test_users.py` does not exist — the real file is `test_api_users.py`, and that
 * is a corrected citation, not a found bug):
 *  - `test_isprivilege_returns_false` (`:50-52`) → ported as the privilege-validity specs below:
 *    upstream tests the predicate directly; here the guard is internal and every refusal is asserted
 *    at the verb boundary (the `validators.test.ts` inversion convention, DR-053).
 *  - `test_get` (`:54-57`) → `get: the fixture user carries exactly the fields its lines state` —
 *    upstream pins the six-key set it INVENTS (`role`/`secret`/`format`/`sshkey` all `None`,
 *    `privilege` a string); ours answers the fields the config actually carries (row 151).
 *  - `test_getall` (`:59-61`) → `getAll: every pinned username line becomes an entry` — upstream only
 *    asserts `isinstance(dict)`; the six fixture users are pinned entry-by-entry instead.
 *  - `test_create_with_nopassword` (`:63-66`), the four `test_create_with_secret_*` (cleartext
 *    `:68-71`, md5 `:73-76`, nologin `:78-81`, sha512 `:83-86`), `test_create_with_missing_kwargs`
 *    (`:88-90`), `test_create_with_invalid_secret_arg` (`:92-94`), `test_delete` = the admin refusal
 *    (`:96-98`), `test_delete_admin_exception` = a NORMAL delete (upstream's mislabel, `:100-103`),
 *    `test_default` (`:105-107`), `test_set_privilege` (`:110-112`), `test_set_privilege_negate`
 *    (`:115-118`), `test_set_privilege_invalid_value` (`:120-122`), `test_set_role` + `_negate` +
 *    `_default` (`:124-137`), `test_set_sshkey` + `_negate` + `_default` (`:139-152`) → each pinned
 *    below at its line-for-line command text, with the two upstream `TypeError` cases ported as
 *    `NotSupportedError` refusals (DR-005/DR-077) and
 *    `test_set_privilege_negate` ported as a REFUSAL of the invented `privilege 1` default (row 153)
 *    plus the real negation this client adds. Line numbers above cite the 156-line file as read on
 *    2026-11-05; the earlier session's probe of this file is superseded by that read.
 *
 * The `USER_FIXTURE` block is `pyeapi/test/fixtures/running_config.text:356-361` copied verbatim
 * (fixture provenance: upstream, re-read 2026-11-05); everything else is hand-authored config text
 * in this repo's established shapes, labelled as such at each use — no new file lands under
 * `test/fixtures/config/`, following the sibling resource suites (the fixture manifest therefore does
 * not change).
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, ConfigParseError, EapiErrorCode, NotSupportedError } from '../errors'
import { mockTransport, type MockReply, type MockTransport } from '../testing/mock-transport'
import { UsersResource } from './users'

/** Join lines into config text so a whitespace-only line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/** The six pinned `username …` lines of upstream's own fixture, byte for byte (`running_config.text:356-361`). */
const USER_FIXTURE = textOf([
  'username admin privilege 1 role network-admin nopassword',
  'username eapi privilege 1 secret 5 $1$eCurfHLe$JCbuUNM7Xwy6i6/zknYha.',
  'username test privilege 10 nopassword',
  'username test1 privilege 1 secret 5 $1$o/po05ru$92uegC/GGu3i4MS7MH9AE0',
  'username test2 privilege 9 role ops secret 5 $1$Kraw0Knu$dfIURYuRCxzDDcyyKnAD1/',
  'username test3 privilege 9 role ops nopassword',
  '!',
  'end',
])

function configTransport(config: string): MockTransport {
  return mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
}

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = configTransport(config)
  return { node: new Node(transport), transport }
}

/** The subject the way a caller reaches it: the `Node`'s static accessor (DR-052). */
function usersFor(config: string): UsersResource {
  return nodeFor(config).node.users
}

/** The one `show version` read behind the ssh-key keyword choice (one memoised call per Node). */
const versionKey = 'enable\nshow version'

/** Script a version answer with BOTH fields `parseVersionProperties` requires — the sibling `interfaces.test.ts` helper, same shape. */
const versionReply = (version: string): MockReply => [{}, { version, modelName: 'DCS-7050TX-64' }]

/** A batch key: `configure()` prepends `enable` + `configure terminal`. */
const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

/** Empty per-command replies for a successful config transaction. */
const okFor = (cmds: readonly string[]): MockReply => Array.from({ length: cmds.length + 2 }, () => ({}))

/** Script a whole config transaction, keyed by the exact command list it must carry. */
function scriptWrite(transport: MockTransport, cmds: readonly string[]): MockTransport {
  return transport.replies(writeKey(cmds), okFor(cmds))
}

/** Every command that reached the wire, as text, request by request. */
function sentAsText(transport: MockTransport): string[][] {
  return transport.sent().map((cmds) => cmds.map((command) => (typeof command === 'string' ? command : command.cmd)))
}

/** Run a verb and report either the resolution or the thrown value, so refusals can be asserted per input. */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

/** Assert a write verb refuses BEFORE the wire: nothing at all was sent. */
async function expectRefusal(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown).toBeInstanceOf(NotSupportedError)
  expect((thrown as Error).message).toMatch(message)
}

// ====================================================================================================
// Reads — pyeapi api/users.py:85-149 (§5 rows 150-152)
// ====================================================================================================

describe('UsersResource reads — pyeapi api/users.py:85-149 (rows 150-152, DR-076/DR-089)', () => {
  it('getAll: every pinned username line becomes an entry, from ONE running-config (upstream pays a read per regex access)', async () => {
    const { node, transport } = nodeFor(USER_FIXTURE)
    const all = await node.users.getAll()
    expect([...all.keys()]).toEqual(['admin', 'eapi', 'test', 'test1', 'test2', 'test3'])
    // Device order is the document order (the `vlansFromSections` contract, `vlans.ts:389-418`).
    expect(all.get('admin')).toEqual({ name: 'admin', privilege: 1, role: 'network-admin', nopassword: true })
    expect(all.get('test2')).toEqual({ name: 'test2', privilege: 9, role: 'ops', nopassword: false, secretFormat: '5' })
    expect(all.get('test3')).toEqual({ name: 'test3', privilege: 9, role: 'ops', nopassword: true })
    expect(transport.bodies()).toHaveLength(1)
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
    // pyeapi's parity port of `test_getall` (`test_api_users.py:59-61`) only asserted the dict type;
    // its own six users come out of the same six lines (the probe of the regex over this exact
    // fixture, logged 2026-11-05 in session notes and re-derived by these assertions).
  })

  it('get: the fixture user carries exactly the fields its lines state (upstream test_get pins the INVENTED six-key set)', async () => {
    // `test_api_users.py:54-57` pins `sorted(['nopassword','privilege','role','secret','format','sshkey'])`
    // for `test` — but that user's config line (`running_config.text:359`) states only privilege and
    // nopassword. `_parse_username` (`users.py:135-149`) fills the rest with `None` and hands
    // `privilege` back as a STRING. Row 151/DR-076: absent is absent, and numbers are numbers.
    const test = await usersFor(USER_FIXTURE).get('test')
    expect(test).toEqual({ name: 'test', privilege: 10, nopassword: true })
    expect(typeof test?.privilege).toBe('number')
    expect(test).not.toHaveProperty('role')
    expect(test).not.toHaveProperty('sshKey')
  })

  it('get on a username the switch does not have answers undefined (pyeapi returns None, users.py:97)', async () => {
    expect(await usersFor(USER_FIXTURE).get('nobody')).toBeUndefined()
  })

  it('the configured secret text is NEVER handed back — only its format marker (DR-089, row 152)', async () => {
    const all = await usersFor(USER_FIXTURE).getAll()
    // Upstream returns the hash verbatim (`users.py:145`; the fixture values at
    // `running_config.text:357/:359/:360`), and this client reads back to a browser.
    expect(all.get('eapi')).toEqual({ name: 'eapi', privilege: 1, nopassword: false, secretFormat: '5' })
    for (const user of all.values()) {
      const json = JSON.stringify(user)
      expect(json).not.toContain('$1$') // neither hashed form from the fixture
      expect(json).not.toContain('eCurfHLe')
      expect(user).not.toHaveProperty('secret')
    }
  })

  it('the readers do not need the device version: both ssh spellings come from the text, quoted or not (row 155 reader arm)', async () => {
    // Hand-authored config: the OLD spelling on one user, the dashed spelling (quoted, comment token
    // included) on another — the chunker keys are what decide the shape, so one read answers both and
    // no `show version` is paid (the `vrf`/`vrf forwarding` reader precedent, row 131).
    const { node, transport } = nodeFor('username olduser sshkey AAAAB3NcSHA-oldform\nusername legacy privilege 1 ssh-key "ssh-ed25519 AAAA3 comment here"\nend')
    const all = await node.users.getAll()
    expect(all.get('olduser')).toEqual({ name: 'olduser', nopassword: false, sshKey: 'AAAAB3NcSHA-oldform' })
    expect(all.get('legacy')).toEqual({ name: 'legacy', privilege: 1, nopassword: false, sshKey: 'ssh-ed25519 AAAA3 comment here' })
    // Only the running-config went out — no `show version` on the read path (the mock would have
    // thrown on an unmatched `enable\nshow version` anyway, DR-083).
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
  })

  it('users upstream\'s regex cannot see are entries here (row 150 probe shapes)', async () => {
    // Hand-authored configs, each one a probe of the pinned clone (2026-11-05) where upstream's
    // `findall` at `users.py:131` answered NO users at all:
    const noPrivilege = await usersFor('username bob role network-admin secret sha512 abc123\nend').getAll()
    expect(noPrivilege.get('bob')).toEqual({ name: 'bob', role: 'network-admin', nopassword: false, secretFormat: 'sha512' })

    const reversedOrder = await usersFor('username cy role ops privilege 5\nend').getAll()
    expect(reversedOrder.get('cy')).toEqual({ name: 'cy', role: 'ops', privilege: 5, nopassword: false })

    const multiTokenSecret = await usersFor('username dee secret 5 pass word here\nend').getAll()
    // The secret text is dropped (DR-089); what matters is that the USER exists with its format,
    // where upstream's `(?: secret (0|5|7|sha512) (.+))?` arm plus `.*$` produced no match at all.
    expect(multiTokenSecret.get('dee')).toEqual({ name: 'dee', nopassword: false, secretFormat: '5' })
  })

  it('separate per-field lines merge into one user (the shape EOS writes when commands are entered one at a time)', async () => {
    // Upstream sees only `eve privilege 3` and the role line not at all (probe: the second line is not
    // a `privilege` arm; hand-authored config, labelled as such upstream-side by its absence from any fixture).
    const eve = await usersFor('username eve privilege 3\nhostname sw\nusername eve role network-operator\nusername eve ssh-key AAAAe key comment\nend').get('eve')
    expect(eve).toEqual({ name: 'eve', privilege: 3, role: 'network-operator', nopassword: false, sshKey: 'AAAAe key comment' })
  })

  it('`no username …` and `default username …` lines are not entries (upstream\'s unanchored scan says they are)', async () => {
    // Probe of the pinned clone 2026-11-05: `users_re` matched inside `no username X privilege 1`,
    // because the pattern starts at the `username` word with no line anchor. The chunker's keys keep
    // the whole command line, so the negation is visible and not a user.
    const all = await usersFor('no username ghost privilege 1\ndefault username former role ops\nusername real privilege 15\nend').getAll()
    expect([...all.keys()]).toEqual(['real'])
  })

  it('the `secret *` (nologin) marker is readable state — upstream\'s own write cannot be read back by it (row 152 tail)', async () => {
    // Probe of `users.py:111`/`:129`: the alternation is `(0|5|7|sha512)`, so the very line
    // `create_with_secret(…, encryption='nologin')` composes (`:196-199`) reads back as NO secret arm at all.
    const kim = await usersFor('username kim privilege 1 secret *\nend').get('kim')
    expect(kim).toEqual({ name: 'kim', privilege: 1, nopassword: false, secretFormat: 'nologin' })
  })

  it('a known keyword with a broken value is a ConfigParseError, never a half-read user (the vlans state rule, applied here)', async () => {
    for (const [line, cause] of [
      ['username mal privilege x\nend', 'all-digits'],
      ['username mal2 privilege\nend', 'all-digits'],
      ['username mal3 role\nend', 'needs a value'],
      ['username mal4 secret\nend', 'format marker'],
      ['username mal5 secret 5\nend', 'has no value'],
      ['username mal6 secret 9 abc\nend', 'is not one of'],
      ['username mal7 sshkey\nend', 'has no key'],
    ] as const) {
      const thrown = await outcome(() => usersFor(line).getAll())
      expect(thrown, line).toBeInstanceOf(ConfigParseError)
      expect((thrown as Error).message, line).toMatch(new RegExp(cause))
      expect((thrown as ConfigParseError).sectionKey, line).toBe(line.split('\n')[0])
    }
  })

  it('UNKNOWN modifiers are skipped, not guessed — and do not swallow the modelled fields behind them', async () => {
    // The token walker steps over unknown tokens one at a time (upstream\'s `.*$` swallows them the
    // same way, `users.py:114`/`:132`). `quarantine` below is hand-authored — not a claimed EOS keyword.
    const lia = await usersFor('username lia quarantine 3 privilege 15\nend').get('lia')
    expect(lia).toEqual({ name: 'lia', privilege: 15, nopassword: false })
  })

  it('a later line replaces an earlier field per field (this client\'s merge rule, row 150\'s stated order rule)', async () => {
    // Whether the device would leave both lines or rewrite one is unverified on hardware, M12 (#14);
    // what is pinned is that this client answers the LAST value seen for each keyword.
    const ann = await usersFor('username ann privilege 1\nusername ann privilege 15 role network-admin\nend').get('ann')
    expect(ann).toEqual({ name: 'ann', privilege: 15, role: 'network-admin', nopassword: false })
  })

  it('two gets plus a getAll cost ONE config read (DR-026/DR-030, unlike pyeapi\'s per-access property)', async () => {
    const { node, transport } = nodeFor(USER_FIXTURE)
    await node.users.get('test')
    await node.users.get('nobody')
    await node.users.getAll()
    expect(transport.bodies()).toHaveLength(1)
  })
})

// ====================================================================================================
// create — pyeapi api/users.py:151-219 (test_api_users.py:63-94; row 154, DR-091)
// ====================================================================================================

describe('UsersResource create family — pyeapi api/users.py:151-219', () => {
  it('create(name, { nopassword: true }) sends `username test nopassword` (:63-66)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['username test nopassword'])
    await new Node(transport).users.create('test', { nopassword: true })
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'username test nopassword']])
  })

  it('create with a cleartext secret sends `username test secret 0 pass` — the ENCRYPTION_MAP marker verbatim (:68-71)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['username test secret 0 pass'])
    await new Node(transport).users.create('test', { secret: 'pass' })
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'username test secret 0 pass']])
  })

  it('create with md5 sends `username test secret 5 pass` (:73-76)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['username test secret 5 pass'])
    await new Node(transport).users.create('test', { secret: 'pass', encryption: 'md5' })
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'username test secret 5 pass']])
  })

  it('create with sha512 sends `username test secret sha512 pass` (:83-86)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['username test secret sha512 pass'])
    await new Node(transport).users.create('test', { secret: 'pass', encryption: 'sha512' })
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'username test secret sha512 pass']])
  })

  it('create with nologin sends the TWO-token `username test secret *` (:78-81)', async () => {
    // Upstream\'s `test_create_with_secret_nologin` passes `secret=\'\'` alongside `encryption=\'nologin\'`;
    // the composed command is the same (`users.py:199` drops the passed secret — divergence 6/DR-091),
    // and this client takes the pairing refusal instead (pinned as a refusal two specs below).
    const transport = configTransport('end')
    scriptWrite(transport, ['username test secret *'])
    await new Node(transport).users.create('test', { encryption: 'nologin' })
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'username test secret *']])
  })

  it('create with neither kwarg is a refusal naming the upstream TypeError (:88-90)', async () => {
    const transport = configTransport('end')
    await expectRefusal(() => new Node(transport).users.create('test'), /either "nopassword" or "secret" must be specified/)
    expect(transport.sent()).toEqual([])
  })

  it('create(name, { nopassword: false }) is the same refusal — `is True` upstream (users.py:172), no invention here', async () => {
    const transport = configTransport('end')
    await expectRefusal(
      () => new Node(transport).users.create('test', { nopassword: false }),
      /either "nopassword" or "secret" must be specified/,
    )
    expect(transport.sent()).toEqual([])
  })

  it('createWithSecret refuses an invalid encryption, naming it — pyeapi raises the same via KeyError (:92-94)', async () => {
    const transport = configTransport('end')
    await expectRefusal(
      () => new Node(transport).users.createWithSecret('test', 'x', 'bcrypt' as never),
      /encryption must be one of "cleartext", "md5" "nologin" or "sha512"/,
    )
    expect(transport.sent()).toEqual([])
  })

  it('DR-091: nologin paired with ANY secret is refused before anything composes (upstream silently drops it, users.py:196-199)', async () => {
    for (const secret of ['hunter2', '']) {
      const transport = configTransport('end')
      await expectRefusal(
        () => new Node(transport).users.createWithSecret('test', secret, 'nologin'),
        /ignores any secret you pass/,
      )
      expect(transport.sent(), secret).toEqual([])
    }
  })

  it('a missing or empty secret for a format that needs one is refused — upstream composes `secret 0 None` (probe of :198)', async () => {
    for (const bad of [undefined, '', '  ']) {
      const transport = configTransport('end')
      await expectRefusal(
        () => new Node(transport).users.createWithSecret('test', bad, 'cleartext'),
        /an empty secret is refused|expected the secret text/,
      )
      expect(transport.sent(), String(bad)).toEqual([])
    }
  })

  it('createWithNopassword / createWithSecret are reachable directly, matching upstream\'s method names (:210/:183)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['username joe nopassword'])
    scriptWrite(transport, ['username joe2 secret sha512 $6$rounds$hash'])
    const users = new Node(transport).users
    await users.createWithNopassword('joe')
    await users.createWithSecret('joe2', '$6$rounds$hash', 'sha512')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'username joe nopassword'],
      ['enable', 'configure terminal', 'username joe2 secret sha512 $6$rounds$hash'],
    ])
  })

  it('a junk username never reaches the wire — tokens, whitespace and controls are refused (upstream interpolates everything)', async () => {
    for (const bad of ['two words', ' pad ', 'tab\tname', '', 'line1\nline2'] as const) {
      const transport = configTransport('end')
      await expectRefusal(() => new Node(transport).users.create(bad, { nopassword: true }), /username/)
      expect(transport.sent(), bad).toEqual([])
    }
  })
})

// ====================================================================================================
// delete / setDefault / setPrivilege — pyeapi api/users.py:221-268 (test_api_users.py:88-122; row 153/154)
// ====================================================================================================

describe('UsersResource presence and privilege verbs — pyeapi api/users.py:221-268', () => {
  it('deleting `admin` is refused with upstream\'s own guard message (:96-98)', async () => {
    const transport = configTransport('end')
    await expectRefusal(
      () => new Node(transport).users.delete('admin'),
      /the admin user cannot be deleted/,
    )
    expect(transport.sent()).toEqual([])
  })

  it('delete of a normal user sends `no username test` (:100-103 — upstream\'s test names are swapped; the guard test is `test_delete` at :96-98)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['no username test'])
    await new Node(transport).users.delete('test')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'no username test']])
  })

  it('setDefault sends `default username test` (:105-107)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['default username test'])
    await new Node(transport).users.setDefault('test')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'default username test']])
  })

  it('setPrivilege sends `username test privilege 8` (:110-112)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['username test privilege 8'])
    await new Node(transport).users.setPrivilege('test', 8)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'username test privilege 8']])
  })

  it('setPrivilege with no value is refused — upstream INVENTS `privilege 1` there (row 153; :115-118 ported as the refusal + the real negation below)', async () => {
    const transport = configTransport('end')
    await expectRefusal(
      () => new Node(transport).users.setPrivilege('test', undefined as unknown as number),
      /expected an integer privilege 0\.\.15/,
    )
    expect(transport.sent()).toEqual([])
  })

  it('unsetPrivilege / defaultPrivilege compose `no`/`default username test privilege` — the DR-037 family pyeapi never spells', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['no username test privilege'])
    scriptWrite(transport, ['default username test privilege'])
    const users = new Node(transport).users
    await users.unsetPrivilege('test')
    await users.defaultPrivilege('test')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'no username test privilege'],
      ['enable', 'configure terminal', 'default username test privilege'],
    ])
  })

  it('an out-of-range privilege is refused with pyeapi\'s message spelling (:120-122; its bound is 0 <= v < 16)', async () => {
    for (const bad of [16, -1, 1.5, '8', Number.NaN] as const) {
      const transport = configTransport('end')
      await expectRefusal(() => new Node(transport).users.setPrivilege('test', bad as never), /priviledge value must be between 0 and 15|expected an (integer|exact integer)/)
      expect(transport.sent(), String(bad)).toEqual([])
    }
    // `'8'` pins the inverted coercion: upstream\'s `isprivilege('8')` is True (probe) and would SEND
    // `username test privilege 8`; this client refuses the string (row 76/DR-053 precedent) — and the
    // same test covers `test_isprivilege_returns_false` upstream\'s predicate tested directly
    // (`isprivilege('test')` → False, `test_api_users.py:50-52`): refuse here says both.
  })

  it('the two in-range edges (0 and 15) do reach the wire', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['username test privilege 0'])
    scriptWrite(transport, ['username test privilege 15'])
    const users = new Node(transport).users
    await users.setPrivilege('test', 0)
    await users.setPrivilege('test', 15)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'username test privilege 0'],
      ['enable', 'configure terminal', 'username test privilege 15'],
    ])
  })
})

// ====================================================================================================
// setRole / setSshKey — pyeapi api/users.py:270-315 (test_api_users.py:124-152; row 155, DR-078)
// ====================================================================================================

describe('UsersResource role and ssh-key verbs — pyeapi api/users.py:270-315', () => {
  it('setRole / unsetRole / defaultRole send the trio upstream pins (:124-137, abstract.py:152-159 arms)', async () => {
    const transport = configTransport('end')
    for (const cmds of [['username test role ops'], ['no username test role'], ['default username test role']]) scriptWrite(transport, cmds)
    const users = new Node(transport).users
    await users.setRole('test', 'ops')
    await users.unsetRole('test')
    await users.defaultRole('test')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'username test role ops'],
      ['enable', 'configure terminal', 'no username test role'],
      ['enable', 'configure terminal', 'default username test role'],
    ])
  })

  it('a multi-word role is refused — the reader keeps one token (users.py:109 `role ([^\\s]+)`)', async () => {
    const transport = configTransport('end')
    await expectRefusal(() => new Node(transport).users.setRole('test', 'network admin'), /single token/)
    expect(transport.sent()).toEqual([])
  })

  it('the ssh-key trio on a pre-4.23 device sends the INLINE `sshkey` texts upstream pins (:139-152; PLAN §4\'s multiline question: upstream has no input arm)', async () => {
    const transport = configTransport('end').replies(versionKey, versionReply('4.17.1.1'))
    for (const cmds of [['username test sshkey newkey'], ['no username test sshkey'], ['default username test sshkey']]) scriptWrite(transport, cmds)
    const users = new Node(transport).users
    await users.setSshKey('test', 'newkey')
    await users.unsetSshKey('test')
    await users.defaultSshKey('test')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show version'],
      ['enable', 'configure terminal', 'username test sshkey newkey'],
      ['enable', 'configure terminal', 'no username test sshkey'],
      ['enable', 'configure terminal', 'default username test sshkey'],
    ])
  })

  it('a 4.23-or-newer device is handed `ssh-key`; the 4.9 release keeps `sshkey` where upstream\'s STRING compare would pick `ssh-key` (row 155, DR-078)', async () => {
    for (const [version, keyword] of [
      ['4.23.1F', 'ssh-key'],
      ['4.28.13.1M', 'ssh-key'],
      ['5.0.1F', 'ssh-key'],
      ['4.22.2F', 'sshkey'],
      ['4.9.13.1F', 'sshkey'],
      ['3.21.1F', 'sshkey'],
    ] as const) {
      const transport = configTransport('end').replies(versionKey, versionReply(version))
      scriptWrite(transport, [`username test ${keyword} KEY`])
      await new Node(transport).users.setSshKey('test', 'KEY')
      expect(sentAsText(transport), version).toEqual([
        ['enable', 'show version'],
        ['enable', 'configure terminal', `username test ${keyword} KEY`],
      ])
    }
    // Upstream\'s compare at `users.py:297` is `version_number >= '4.23'` — lexicographic — so '4.9.13.1F'
    // (4.9 predates 4.23 by years) takes the dashed arm there. The mock identity upstream tests against
    // is pinned at `4.17.1.1` (`test/lib/testlib.py`), which is why its suite never sees the trap —
    // exactly as recorded for VRFs in row 131/DR-078; the same divergence is restated here for the
    // users module rather than silently patched (row 155).
  })

  it('a version this client cannot classify composes no ssh-key command at all (DR-032/DR-057)', async () => {
    for (const version of ['software-version-string', '4', 'v4.23'] as const) {
      const transport = configTransport('end').replies(versionKey, versionReply(version))
      const thrown = await outcome(() => new Node(transport).users.setSshKey('test', 'KEY'))
      expect(thrown, version).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message, version).toMatch(/cannot pick the username ssh-key command form/)
      expect(sentAsText(transport), version).toEqual([['enable', 'show version']])
    }
  })

  it('the version read is the Node\'s memo — three ssh-key writes, one `show version`', async () => {
    const transport = configTransport('end').replies(versionKey, versionReply('4.28.13.1M'))
    for (const cmds of [['username a ssh-key K'], ['no username b ssh-key'], ['default username c ssh-key']]) scriptWrite(transport, cmds)
    const users = new Node(transport).users
    await users.setSshKey('a', 'K')
    await users.unsetSshKey('b')
    await users.defaultSshKey('c')
    expect(transport.bodies().filter((body) => body.params.cmds.some((c) => String(c) === 'show version'))).toHaveLength(1)
  })

  it('an empty or control-bearing ssh key is refused; internal spaces are not (a key may carry a comment token, inline like upstream)', async () => {
    const transport = configTransport('end').replies(versionKey, versionReply('4.28.13.1M'))
    for (const bad of ['', '   ', 'bad\tkey', 'line1\nline2'] as const) {
      await expectRefusal(() => new Node(transport).users.setSshKey('test', bad), /ssh key/)
    }
    expect(transport.sent()).toEqual([])
    scriptWrite(transport, ['username test ssh-key ssh-ed25519 AAAA3 noc@rack'])
    await new Node(transport).users.setSshKey('test', 'ssh-ed25519 AAAA3 noc@rack')
  })

  it('a device refusal on a write arrives as the CommandError with the failed line (DR-005 — upstream would answer False + .error)', async () => {
    const transport = configTransport('end')
    transport.rejects(writeKey(['username test role ops']), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'username test role ops' failed: role does not exist",
    })
    const thrown = await outcome(() => new Node(transport).users.setRole('test', 'ops'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('username test role ops')
    // The failure message's *reason* paraphrases a device answer, not a claim about one (DR-057).
  })
})
