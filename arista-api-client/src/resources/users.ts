/**
 * `users` — the W2a wave-2 resource module (#35): local EOS usernames, ported from
 * `pyeapi/api/users.py` (328 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi` range in
 * this file was opened in the pinned clone `/home/svaj/development/arista/pyeapi` @ `6816d9e` on
 * 2026-11-05, and every behavioural claim is what the upstream code **actually does** (probes noted
 * inline), not what its docstrings say. Nothing here cites EOS image internals: unit tests never touch
 * a device, so any EOS-side rule reads "unverified on hardware, M12 (#14) to capture".
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Users(EntityCollection)` (`:77`) | {@link UsersResource} extends `EntityCollection<User, string, UserAttrs>` (`base.ts`'s collection base) |
 * | `get(name)` (`:85-97`), a lookup into `getall()` | {@link UsersResource.get} — the same one-read table (row 15) |
 * | `getall()` (`:99-133`) + `users_re` (`:107-116`, `:124-133` version arms) + `_parse_username` (`:135-149`) | {@link usersFromSections} — a keyword walk of the chunked document's `username …` section keys (divergence 1, §5 row 150; row 151 drops the fabricated `None`s) |
 * | `create(name, nopassword, secret, encryption)` (`:151-176`) | {@link UsersResource.create} — one `attrs` bag (row 77), same routing, same missing-kwargs refusal (row 154, DR-091) |
 * | `create_with_secret` (`:183-208`), `ENCRYPTION_MAP` (`:58`) | {@link UsersResource.createWithSecret} — same map, verbatim command texts |
 * | `create_with_nopassword` (`:210-219`) | {@link UsersResource.createWithNopassword} |
 * | `delete(name)` (`:221-233`) incl. the `admin` `TypeError` (`:230-231`) | {@link UsersResource.delete} — the same refusal, as a `NotSupportedError` (row 154, DR-077) |
 * | `default(name)` (`:235-244`) | {@link UsersResource.setDefault} (`default username X`, `:244`) |
 * | `set_privilege` (`:246-268`), `isprivilege` (`:61-74`), the `value=None ⇒ privilege 1` arm (`:265-267`) | {@link UsersResource.setPrivilege} / {@link UsersResource.unsetPrivilege} / {@link UsersResource.defaultPrivilege} — the invention is dropped, the negation family added (row 153, DR-037/DR-077) |
 * | `set_role` (`:270-288`) | `setRole` / `unsetRole` / `defaultRole` — the `command_builder` trio (`:284-286`) |
 * | `set_sshkey` (`:290-315`): the `{cmd, input}` multiline question from PLAN §4 — **upstream has no multiline arm**; it interpolates the key inline through `command_builder` (`:296-311`), and `test_api_users.py:139-142` pins `username test sshkey newkey` | `setSshKey` / `unsetSshKey` / `defaultSshKey` — inline as well; the invented arm was not ported (row 150's tail) |
 * | version arms `'ssh.key'`/`'sshkey'` selected by the string compare `version_number >= '4.23'` (`:107`/`:124`, `:297`/`:305`) | {@link UsersResource.sshKeyKeyword} — numeric segment compare, refusal when the release cannot be classified (row 155, DR-078); the **reader** takes both spellings from the config text instead of asking the device |
 * | `instance(node)` (`:317-328`) | the `RESOURCE_FACTORIES.users` row plus `Node.users` (DR-006/DR-052) |
 *
 * Upstream's own suite is `pyeapi/test/unit/test_api_users.py` — **22** test methods (the sibling
 * brief's filename `test_users.py` does not exist in the clone; verified by listing `test/unit/` on
 * 2026-11-05). All 22 are ported in `users.test.ts`; where upstream asserted a returned `False` or a
 * `TypeError`, this client asserts the thrown typed refusal (DR-005/DR-077), and upstream's own
 * mislabelled method `test_delete_admin_exception` (`:100-103`) — which actually tests a *normal*
 * delete, while `test_delete` (`:96-98`) tests the admin refusal — is ported with the labels
 * corrected.
 *
 * ## Divergences this file owns — one per MIGRATION.md §5 rows 150-155, cited at each item below
 *
 * 1. **the section scrape is rebuilt on the chunker, not the regex** (§5 row 150). Upstream finds users
 *    with one order-dependent regular expression (`:107-116`): the `privilege <n>` keyword must be
 *    present and immediately after the name, `role` before `nopassword` before `secret`, the ssh-key
 *    line only counts when it is the *next physical line* **and** repeats the same username (the
 *    `(?P=user)` backreference), and the scan is unanchored, so `no username X privilege 1` counts too.
 *    Probe of the pinned clone (2026-11-05): `username bob role network-admin secret sha512 abc` and
 *    `username cy role ops privilege 5` answer **no users at all**; `username dee secret 5 pass word
 *    here` (a multi-token secret) answers no users; `username ann privilege 1 secret sha512 x` followed
 *    by any line other than its own ssh-key line silently loses the key; and a config of *separate*
 *    per-field lines — the shape EOS actually writes when each `username …` command was entered on its
 *    own — reads only the line that happens to carry `privilege`. {@link usersFromSections} instead
 *    walks every top-level section key that begins `username ` and merges per username,
 *    keyword-by-keyword and line-by-line, so order and adjacency stop mattering; the upstream-failing
 *    shapes are pinned in `users.test.ts` as this client's **answers**, and negated `no username …`
 *    keys are not entries.
 * 2. **absence outranks invented fields** (§5 row 151, DR-076's continuation for users).
 *    `_parse_username` (`:135-149`) always returns all six keys: `privilege` as a **string**, and
 *    `None` for whichever of `role`/`format`/`secret`/`sshkey` the line did not carry (and
 *    `test_get`, `test_api_users.py:54-57`, pins exactly that key set). Here `privilege` is a `number`,
 *    and a field the config does not carry is **absent** — `role?`, `secretFormat?`, `sshKey?` — the
 *    same control flow rows 126/DR-076 gave ports. The only kept default is `nopassword: false` itself,
 *    because a boolean flag the line does not carry is honestly `false`, not an invention (the
 *    `vlan … state` default was kept for the same reason in row 94).
 * 3. **the configured secret is never handed back** (§5 row 152, **DR-089**). Upstream returns the
 *    secret text verbatim in every read — the pinned fixture's `$1$…` hashes come straight out of
 *    `get`/`getall` (`:145`, `test/fixtures/running_config.text:357-360`) — and this client's reads back
 *    a **browser**, so a `0`/`cleartext` secret would be shown and re-logged like a credential.
 *    {@link User} carries `secretFormat` (the `0`/`5`/`7`/`sha512` marker, plus `nologin` for the
 *    `secret *` spelling `create(…, {encryption: 'nologin'})` writes) and never the text.
 * 4. **`username X secret *` is a readable state** (§5 row 154's tail). Upstream's read arm accepts
 *    only `secret (0|5|7|sha512)` (`:111`/`:129`), so the very command its own `nologin` write emits
 *    (`:196-199`) reads back as *no secret at all* — probe: the regex's `(?: secret …)?` group fails on
 *    `*` and `.*$` swallows it. Here `*` answers `secretFormat: 'nologin'`, because "the switch has the
 *    user locked out" and "the switch says nothing about a secret" are different statements (DR-076's
 *    vocabulary, inverted against an upstream hole).
 * 5. **no invented default for a missing privilege argument** (§5 row 153). `set_privilege(name)` with
 *    no value sends `username X privilege 1` (`:265-267`, pinned by `test_api_users.py:115-118` as
 *    `test_set_privilege_negate` — it is not a negation), and upstream has no negated form of the verb
 *    at all. Here `setPrivilege` requires a value (`assertPrivilege`, the port of `isprivilege` at
 *    `:61-74`, `0 <= int < 16`, but numeric-typed: probe — `isprivilege('8')` is `True` upstream and
 *    `'8'` interpolates, the same string-coercion row 76/DR-053 inverts for VLAN ids), and
 *    {@link UsersResource.unsetPrivilege}/{@link UsersResource.defaultPrivilege} are base.ts's
 *    `unset<Field>`/`default<Field>` family, which pyeapi never spells.
 * 6. **junk arguments are refusals, not `TypeError`s or half-built commands** (§5 row 154, DR-077).
 *    The three upstream `TypeError`s — missing `nopassword`/`secret` in `create` (`:174-176`), invalid
 *    `encryption` in `create_with_secret` (`:191-195`), deleting `admin` (`:230-231`) — become
 *    `NotSupportedError` refusals naming the rejected value (DR-005/DR-010: no new error classes). Two
 *    further upstream fall-throughs are refused rather than sent: `create(name, {encryption:
 *    'nologin', secret})` **silently drops the caller's secret** (`if secret is not None or encryption
 *    == 'nologin'` then the `nologin` command line omits it, `:169`/`:196-199` — the pairing half of
 *    **DR-091**), and `create_with_secret(name, undefined)` interpolates `None` into the command —
 *    probe of the pinned f-string at `:198`: `username X secret 0 None` (a password literally spelled
 *    `None`); an empty-string cleartext secret would send a trailing space (`'username X secret 0 '`,
 *    which `commandBuilder` would later refuse anyway). Also `create(name, {nopassword: false})` falls
 *    to the same missing-kwargs `TypeError` upstream (`:172` is `is True`) — refused here too, because
 *    answering it with the *other* kind of user would be an invention.
 * 7. **the ssh-key word is picked by numeric release, and unclassifiable releases are refused**
 *    (§5 row 155, DR-078). Upstream compares the version **string** — `'4.9.x' >= '4.23'` is
 *    character-true although 4.9 predates 4.23 by years (`:107`/`:297`) — and reads `version_number`
 *    from `show version` per access (`abstract.py:70-72`). {@link sshKeyKeyword} reuses the reviewed
 *    rule from `interfaces.ts`'s `versionFloorCompare`/`vrfKeyword` (that module's local helper; the
 *    local-copy arrangement follows `system.ts:178`/`vlans.ts`'s `hasControlCharacter` precedent, not
 *    a cross-resource import): the leading `major.minor` segments of `VersionProperties.versionNumber`
 *    compared against `[4, 23]`, and a release with no leading `major.minor` throws instead of guessing
 *    which of `ssh-key`/`sshkey` the box takes. The read side asks nobody: the config text already spells
 *    which form the device wrote (the `vrf`/`vrf forwarding` reader precedent, row 131).
 * 8. **no existence pre-check, no session**: every write is one `configure()` line and the device has
 *    the authority (upstream parity, `:206`/`:218`/`:233`/`:243`/`:267`/`:287`/`:312` send zero reads),
 *    and a rejected write rejects with its `CommandError` including `failedCommand` (DR-005).
 */

import { ConfigParseError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { unquote } from '../config/text'
import { EntityCollection } from './base'
import type { ConfigSections } from '../config/chunk'
import type { ResourceTable } from './types'

/**
 * How {@link UsersResource.createWithSecret} interprets a supplied secret — the port of upstream's
 * `ENCRYPTION_MAP` keys (`users.py:58`, `{'cleartext': 0, 'md5': 5, 'sha512': 'sha512', 'nologin': '*'}`)
 * and of the docstring's accepted values (`:48-49`, `:160-162`). Upstream checks nothing until the dict
 * lookup raises `KeyError` re-raised as `TypeError` (`:191-195`); here the union is also a runtime
 * guard ({@link isUserEncryption}) because a caller arriving from JS can hand any string.
 */
export type UserEncryption = 'cleartext' | 'md5' | 'sha512' | 'nologin'

/** The encodings in upstream's map order, for the runtime guard's message and the entry-point pin. */
export const USER_ENCRYPTIONS: readonly UserEncryption[] = Object.freeze(['cleartext', 'md5', 'sha512', 'nologin'])

/** Is `value` one of the accepted encodings? (The `isSwitchportMode` pattern from `switchports.ts`, DR-079.) */
export function isUserEncryption(value: unknown): value is UserEncryption {
  return USER_ENCRYPTIONS.includes(value as UserEncryption)
}

/** The wire marker each encoding contributes (`users.py:58`; `cleartext` sends the digit `0`). */
const ENCRYPTION_MAP: Readonly<Record<UserEncryption, string>> = Object.freeze({
  cleartext: '0',
  md5: '5',
  sha512: 'sha512',
  nologin: '*',
})

/** Upstream's default when `encryption` is falsy: `DEFAULT_ENCRYPTION = 'cleartext'` (`users.py:57`, `:190`). */
const DEFAULT_ENCRYPTION: UserEncryption = 'cleartext'

/**
 * The secret marker a read reports — the formats the device writes (`users.py:111`/`:129` accept
 * `0|5|7|sha512`) plus `nologin` for the `secret *` spelling this client's own `nologin` create writes
 * (divergence 4; `7` is EOS's hidden/reversible form, present in upstream's read set but not in its
 * write map — an asymmetry ported, not invented).
 */
export type UserSecretFormat = '0' | '5' | '7' | 'sha512' | 'nologin'

/** The formats a read may report, for the guard's message. */
const READ_SECRET_FORMATS: readonly UserSecretFormat[] = ['0', '5', '7', 'sha512']

/**
 * One local user, as this client reads it. `name` repeats the table key (the `Vlan.id` shape,
 * `vlans.ts:147-158`) so an entry printed alone still names itself. pyeapi's inner record instead
 * carries `privilege` (as a string), `role`, `nopassword`, `format`, `secret` and `sshkey`/`ssh-key` —
 * every key **always present**, `None` for absent fields (`users.py:135-149`): divergence 2 drops the
 * `None`s and divergence 3/DR-089 drops the secret text itself.
 */
export interface User {
  /** The username, one token — the `(?P<user>[^\s]+)` the upstream regex keys on (`users.py:107`). */
  readonly name: string
  /** The `privilege <n>` value as a number (upstream's is a string, row 151) — absent when no line names it. */
  readonly privilege?: number
  /** The `role <token>` value — absent when no line names it. */
  readonly role?: string
  /** Whether a line carries `nopassword`. `false` is the honest absence answer for the flag (row 151's tail). */
  readonly nopassword: boolean
  /** The secret's format marker; **absent when no secret line exists**. The text itself is never returned (DR-089). */
  readonly secretFormat?: UserSecretFormat
  /** The `sshkey`/`ssh-key` value, unquoted as written — absent when no line carries either spelling (row 150). */
  readonly sshKey?: string
}

/**
 * The attribute bag {@link UsersResource.create} accepts — pyeapi's kwargs
 * `create(self, name, nopassword=None, secret=None, encryption=None)` (`users.py:151`) become one bag
 * (row 77). A type alias rather than an interface, because `EntityCollection`'s third parameter needs
 * the implicit index signature `ResourceAttrs` gives only to object-literal types (`vlans.ts`'s
 * `VlanAttrs` note, same constraint).
 */
export type UserAttrs = {
  /** Create the user with `username X nopassword`. Only `true` creates anything; `false` is refused (divergence 6). */
  readonly nopassword?: boolean
  /** The secret to assign. Its meaning depends on `encryption`; the pair is refused when `encryption` is `'nologin'` (DR-091). */
  readonly secret?: string
  /** How {@link secret} is encoded — defaulting to `'cleartext'` (pyeapi's `DEFAULT_ENCRYPTION`, `users.py:57`). */
  readonly encryption?: UserEncryption
}

/**
 * A top-level section key that names a username (the chunker keys are whole indent-0 command lines,
 * `rstrip`ped — `client.py:741-747` as cited in `system.ts`). `no username …` and `default username …`
 * keys do not match, which is deliberate: upstream's unanchored findall would read those lines as
 * entries (row 150).
 */
const USERNAME_LINE = /^username (\S+)(?: (.+))?$/u

/** The version floor at which EOS spells the username key `ssh-key` — pyeapi's own `'4.23'` literal (`users.py:107`, `:297`). */
const SSH_KEY_DASHED_FORM_MIN: readonly [number, number] = [4, 23]

/** A rejected argument is named in the message, rendered pyeapi's way — the `refuse` pattern from `validators.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** C0 controls plus DEL, checked code-unit by code-unit — the same test M8's `hasControlCharacter` uses (`system.ts:178-184`), local copy by the same arrangement `vlans.ts` took. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * The numeric reading of pyeapi's version floor — the reviewed rule from `interfaces.ts:819-827`
 * (`versionFloorCompare`) carried here as a local copy, per that helper's arrangement note in
 * divergence 7: upstream's test is a raw string compare on `version_number >= '4.23'`
 * (`users.py:107`/`:297`), and `'4.9' >= '4.23'` is true character-wise while 4.9 predates 4.23 by
 * years. `undefined` means the version cannot be read as `major.minor` at all.
 */
function versionFloorCompare(versionNumber: string, floor: readonly [number, number]): boolean | undefined {
  const parts = /^([0-9]+)\.([0-9]+)/u.exec(versionNumber)
  if (parts === null) return undefined
  const major = Number(parts[1])
  const minor = Number(parts[2])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined
  return major - floor[0] !== 0 ? major > floor[0] : minor >= floor[1]
}

/**
 * Require a username this client can address. Upstream validates nothing anywhere on the name —
 * every verb interpolates it straight into `'username %s …'` (`:206`, `:218`, `:233`, `:243`, `:262`,
 * `:284`, `:308`), so `create('two words', …)` would compose a command whose name is a single token
 * `two` with `words` becoming a stray modifier the read then mis-parses. A name is one token (matching
 * the `(?P<user>[^\s]+)` the reader keys on, `:107`), no control characters, present.
 */
function assertUsername(verb: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse(`${verb} username`, value, 'expected a string username — pyeapi interpolates whatever arrives into `username %s` (users.py:206-311)')
  if (value.trim() === '') refuse(`${verb} username`, value, 'an empty username is refused — the read side keys on `username (?P<user>[^\\s]+)` (users.py:107) and could never name this entry')
  if (/\s/u.test(value)) refuse(`${verb} username`, value, 'expected a single token: a space inside the name would read back as a stray modifier (users.py:107 keeps only non-whitespace)')
  if (hasControlCharacter(value)) refuse(`${verb} username`, value, 'a control character would break the config line this client reads back (the same reason command-builder.ts refuses a value with a line boundary, row 74)')
}

/**
 * Require a privilege level in pyeapi's own range. `isprivilege` (`users.py:61-74`) accepts anything
 * `int()` parses — probe: `isprivilege('8')` is True and `'8'` then interpolates (the row 76 coercion
 * DR-053 inverts) — and bounds the integer to `0 <= value < 16` (`:73`), with the message
 * `'priviledge value must be between 0 and 15'` (`:264`, upstream's spelling kept in {@link
 * assertPrivilege}'s refusal text for grep-ability). Non-numeric input upstream `TypeError`s
 * (`:260-264`); here it is the same `NotSupportedError` family (DR-077).
 */
function assertPrivilege(value: unknown): asserts value is number {
  if (typeof value !== 'number') refuse('privilege', value, 'expected an integer privilege 0..15 — pyeapi int()-coerces strings (users.py:61-74) and this client keeps numbers numeric (row 76/DR-053)')
  if (!Number.isSafeInteger(value)) refuse('privilege', value, 'expected an exact integer privilege 0..15')
  if (value < 0 || value > 15) refuse('privilege', value, 'priviledge value must be between 0 and 15 (pyeapi\'s message, users.py:264; its bound is 0 <= value < 16 at users.py:73) — pyeapi raises TypeError here, and note that calling setPrivilege with NO value is where upstream invents `privilege 1` (users.py:265-267); say unsetPrivilege() to negate (row 153, DR-037)')
}

/** Require a role token. Upstream interpolates any value through `command_builder` unchecked (`users.py:284-286`); the single-token rule is the round-trip contract with the read, which keeps `role ([^\s]+)` (`:109`). */
function assertRole(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('role', value, 'expected a string role — pyeapi checks nothing at users.py:270-288')
  if (value.trim() === '') refuse('role', value, 'an empty role is refused — clear it with unsetRole()/defaultRole() (pyeapi spells those `disable=True`/`default=True`, users.py:284-286)')
  if (/\s/u.test(value)) refuse('role', value, 'expected a single token: the reader keeps `role ([^\\s]+)` (users.py:109) and would not read back a multi-word role')
  if (hasControlCharacter(value)) refuse('role', value, 'a control character would break the config line this client reads back (row 74)')
}

/**
 * Require an ssh-key value. Upstream interpolates it inline unchecked in both version arms
 * (`users.py:296-311`; `test_api_users.py:139-142` pins the inline form, so PLAN §4's `{cmd, input}`
 * multiline question resolves to *no multiline arm upstream* — row 150's tail); internal spaces are
 * allowed because a key line legitimately carries the `comment` token. Empty/whitespace is refused
 * (a trailing-space command reads back as the bare modifier, and `commandBuilder` refuses it anyway,
 * row 74) and so are control characters — the value must come back from the device as the same single
 * line {@link usersFromSections} reads (`sshkey (.+)$`).
 */
function assertSshKeyValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('ssh key', value, 'expected the ssh-key/sshkey text as a string — pyeapi checks nothing at users.py:290-315')
  if (value.trim() === '') refuse('ssh key', value, 'an empty ssh key is refused — clear it with unsetSshKey()/defaultSshKey() instead (DR-037; command-builder.ts refuses an empty value for the same reason)')
  if (hasControlCharacter(value)) refuse('ssh key', value, 'a control character would break the config line this client reads back (row 74 — line boundaries included)')
}

/** Require a non-empty secret string. See divergence 6: upstream would send `secret 0 None` for an absent secret (probe of the f-string at `users.py:198`) and a trailing-space command for `''`. */
function assertSecretText(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('secret', value, 'expected the secret text as a string — pyeapi interpolates whatever arrives (users.py:198)')
  if (value.trim() === '') refuse('secret', value, 'an empty secret is refused — upstream composes a trailing-space command for `secret=\'\'`, and use encryption: "nologin" for a locked-out account (DR-091 refuses the paired nologin+secret instead)')
  if (hasControlCharacter(value)) refuse('secret', value, 'a control character would break the config line the write composes (row 74)')
}

/** One username line's parsed fields before merging (divergence 1). `has*` presence flags distinguish "the line did not carry it" from a value of its own. */
type UsernameFields = {
  privilege?: number
  role?: string
  nopassword?: true
  secretFormat?: UserSecretFormat
  sshKey?: string
}

/** Why a malformed line is reported the way it is: the offending line and token, naming the upstream arm that would have swallowed it. */
function parseError(line: string, because: string): ConfigParseError {
  return new ConfigParseError(
    `users: cannot parse ${pythonRepr(line)} — ${because} (this client reads username modifiers keyword-by-keyword instead of pyeapi's single order-dependent regex, users.py:107-116; MIGRATION.md §5 row 150)`,
    { sectionKey: line },
  )
}

/**
 * Walk one `username …` line's modifier tokens, in any order (divergence 1). An unknown token is
 * skipped one-at-a-time: upstream's `.*$` (`:114`/`:132`) ignores whatever follows the arm it knows,
 * and inventing a meaning — or failing the whole read — for a modifier this model does not have would
 * be worse than the same silence. A **known** token with a missing or malformed value is a parse
 * failure: half-reading `privilege` or `secret` would answer something about the switch the switch
 * did not say (the `vlanStateOf` rule, `vlans.ts:340-354`).
 */
function fieldsOfUsernameLine(line: string, modifiers: string): UsernameFields {
  const fields: UsernameFields = {}
  const tokens: { word: string; start: number }[] = []
  for (const match of modifiers.matchAll(/\S+/gu)) tokens.push({ word: match[0], start: match.index })
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    index += 1
    switch (token.word) {
      case 'privilege': {
        const raw = tokens[index]?.word
        index += 1
        if (raw === undefined || !/^\d+$/u.test(raw)) {
          throw parseError(line, '`privilege` needs an all-digits value right after it')
        }
        fields.privilege = Number(raw)
        continue
      }
      case 'role': {
        const raw = tokens[index]?.word
        index += 1
        if (raw === undefined) throw parseError(line, '`role` needs a value right after it')
        fields.role = raw
        continue
      }
      case 'nopassword': {
        fields.nopassword = true
        continue
      }
      case 'secret': {
        const fmtTok = tokens[index]?.word
        index += 1
        if (fmtTok === undefined) throw parseError(line, '`secret` needs a format marker and a value after it')
        if (fmtTok === '*') {
          fields.secretFormat = 'nologin'
          continue
        }
        if (!READ_SECRET_FORMATS.includes(fmtTok as UserSecretFormat)) {
          throw parseError(line, `the secret format ${pythonRepr(fmtTok)} is not one of ${READ_SECRET_FORMATS.join(' / ')} plus the * (nologin) marker — pyeapi reads only 0|5|7|sha512 (users.py:111/:129) and this client reports an unseen marker instead of guessing`)
        }
        if (index >= tokens.length) {
          throw parseError(line, `the secret format ${pythonRepr(fmtTok)} has no value after it (a secret format without a value is a line this client cannot confirm anything about)`)
        }
        fields.secretFormat = fmtTok as UserSecretFormat
        // The secret TEXT is deliberately dropped here — DR-089. Advance past the
        // whole remainder so its tokens are not re-walked as modifiers.
        index = tokens.length
        continue
      }
      case 'sshkey':
      case 'ssh-key': {
        const rest = modifiers.slice(token.start + token.word.length).trim()
        if (rest === '') throw parseError(line, `\`${token.word}\` has no key after it`)
        fields.sshKey = unquote(rest)
        // The ssh key is the remainder of the line: whatever follows cannot be told apart from
        // key material, and upstream takes `(.+)$` the same way (users.py:115/:133).
        return fields
      }
      default:
        continue
    }
  }
  return fields
}

/** A mutable merge target while walking lines; {@link usersFromSections} freezes the shape out at the end. An optional field is set only by a line that actually carried it (row 151: absence stays absence). */
type MutableUser = {
  name: string
  privilege?: number
  role?: string
  nopassword: boolean
  secretFormat?: UserSecretFormat
  sshKey?: string
}

/**
 * Apply one parsed line to a user's record. Per-field last-line-wins: a username's configuration in
 * EOS is a set of independent `username …` commands, and re-entering one replaces that field — whether
 * the device keeps a *whole-record* order that differs is unverified on hardware, M12 (#14) to
 * capture; the rule here only decides what this client answers over the text it is given (row 150).
 */
function applyLine(user: MutableUser, fields: UsernameFields): void {
  if (fields.privilege !== undefined) user.privilege = fields.privilege
  if (fields.role !== undefined) user.role = fields.role
  if (fields.nopassword === true) user.nopassword = true
  if (fields.secretFormat !== undefined) user.secretFormat = fields.secretFormat
  if (fields.sshKey !== undefined) user.sshKey = fields.sshKey
}

/**
 * Every local user in a chunked running-config, in one pass and **one** device read (DR-030 —
 * upstream pays a `show running-config` per regex access, `users.py:131` reading the whole
 * `self.config` property, row 15).
 *
 * Merge rules (row 150): a user exists when **any** `username <name> …` top-level line mentions it —
 * the privilege keyword is not required, ordering is free, and the ssh-key line may be anywhere (each
 * upstream requirement probed to *no user at all* on 2026-11-05). Keys are kept in **document order**,
 * first appearance winning position — the same device-order contract `vlansFromSections` cites
 * (`vlans.ts:389-418`).
 */
function usersFromSections(sections: ConfigSections): Map<string, User> {
  const merged = new Map<string, MutableUser>()
  for (const key of sections.keys()) {
    const line = USERNAME_LINE.exec(key)
    if (line === null) continue
    const name = line[1]
    if (name === undefined) continue
    const fields = fieldsOfUsernameLine(key, line[2] ?? '')
    let user = merged.get(name)
    if (user === undefined) {
      user = { name, nopassword: false }
      merged.set(name, user)
    }
    applyLine(user, fields)
  }
  const users = new Map<string, User>()
  for (const [name, user] of merged) {
    users.set(name, {
      name,
      nopassword: user.nopassword,
      ...(user.privilege === undefined ? {} : { privilege: user.privilege }),
      ...(user.role === undefined ? {} : { role: user.role }),
      ...(user.secretFormat === undefined ? {} : { secretFormat: user.secretFormat }),
      ...(user.sshKey === undefined ? {} : { sshKey: user.sshKey }),
    })
  }
  return users
}

/**
 * `node.users` — the local usernames configured on one switch.
 *
 * `EntityCollection<User, string, UserAttrs>` (pyeapi's `Users(EntityCollection)`, `users.py:77`): the
 * key is the username string. Upstream's `getall` returns a plain dict of dicts (`:133`); this is the
 * usual `ResourceTable` (row 78), and `get(name)` is a lookup in the same one-read table — exactly
 * upstream's shape (`get` is `self.getall().get(name)`, `:97`), not a second read.
 */
export class UsersResource extends EntityCollection<User, string, UserAttrs> {
  /** Every user, keyed by username — pyeapi's `getall` (`users.py:99-133`) as a table (row 78). */
  override async getAll(): Promise<ResourceTable<string, User>> {
    return usersFromSections(await this.configSections())
  }

  /** One user, or `undefined` — pyeapi's `get` (`users.py:85-97`), whose `None` is DR-027's `undefined`. */
  override async get(name: string): Promise<User | undefined> {
    return (await this.getAll()).get(name)
  }

  /**
   * Create a user: the port of `create(name, nopassword, secret, encryption)` (`users.py:151-176`),
   * same routing — a `secret`, or `encryption: 'nologin'`, goes through {@link createWithSecret};
   * `nopassword: true` through {@link createWithNopassword}; anything else is refused naming the
    * upstream `TypeError` (`:174-176`, `test_api_users.py:88-90`). `nologin` paired with a `secret`
   * is refused rather than silently dropping the secret (DR-091, row 154).
   */
  override async create(name: string, attrs: UserAttrs = {}): Promise<void> {
    assertUsername('create', name)
    const { nopassword, secret, encryption } = attrs
    if (secret !== undefined || encryption === 'nologin') {
      await this.createWithSecret(name, secret, encryption)
      return
    }
    if (nopassword === true) {
      await this.createWithNopassword(name)
      return
    }
    refuse('create attrs', attrs, 'either "nopassword" or "secret" must be specified to create a user (pyeapi raises the same TypeError, users.py:174-176) — `nopassword: false` is not a way to create anything (upstream tests it with `is True` at users.py:172)')
  }

  /**
   * `username X secret <enc> <secret>` — pyeapi's `create_with_secret` (`users.py:183-208`), with the
   * `ENCRYPTION_MAP` markers verbatim (`:58`: `cleartext⇒0`, `md5⇒5`, `sha512⇒sha512`) and
   * `nologin` composed as the **two-token** command `username X secret *` (`:196-199` — upstream the
   * caller's secret is dropped in that arm; here the pairing itself is refused before anything is
   * composed, DR-091, and the *effect* — a locked-out user — is what the read then reports, divergence 4).
   *
   * @throws {NotSupportedError} an `encryption` outside {@link USER_ENCRYPTIONS} (upstream's
    *   `KeyError`-→-`TypeError`, `:191-195`, `test_api_users.py:92-94`); a missing/empty secret for a
   *   format that needs one (upstream composes `secret 0 None` — probe of `:198`, divergence 6).
   */
  async createWithSecret(name: string, secret?: string, encryption?: UserEncryption): Promise<void> {
    assertUsername('createWithSecret', name)
    const enc = encryption ?? DEFAULT_ENCRYPTION
    if (!isUserEncryption(enc)) {
      refuse('encryption', encryption, `encryption must be one of "cleartext", "md5" "nologin" or "sha512" (pyeapi's message, users.py:194-195, raised as TypeError at users.py:193)`)
    }
    if (enc === 'nologin') {
      if (secret !== undefined) {
        refuse('secret', secret, '`encryption: "nologin"` ignores any secret you pass — pyeapi composes `username X secret *` and drops it (users.py:196-199); pass the secret alone (a real hash with `encryption: "sha512"`/`"md5"`) or nothing with nologin — it is the effect that matters, never that input (DR-091)')
      }
      await this.configure(this.commandBuilder(`username ${name} secret`, { value: ENCRYPTION_MAP[enc] }))
      return
    }
    assertSecretText(secret)
    await this.configure(this.commandBuilder(`username ${name} secret`, { value: `${ENCRYPTION_MAP[enc]} ${secret}` }))
  }

  /** `username X nopassword` — pyeapi's `create_with_nopassword` (`users.py:210-219`), pinned verbatim by `test_api_users.py:63-66`. Sent as the literal line upstream composes at `:218` (no `commandBuilder` arm: the command has no value, and fabricating `{ value: true }` for a composed stem would be noise). */
  async createWithNopassword(name: string): Promise<void> {
    assertUsername('createWithNopassword', name)
    await this.configure(`username ${name} nopassword`)
  }

  /**
   * `no username X` — pyeapi's `delete` (`users.py:221-233`). Its guard
   * (`if name == 'admin': raise TypeError('the admin user cannot be deleted.')`, `:230-231`,
   * `test_api_users.py:96-98`) is ported as a refusal naming it (DR-077); upstream's mislabelled
   * `test_delete_admin_exception` (`:100-103`) — the *normal* delete case — is ported under the
   * corrected label.
   */
  override async delete(name: string): Promise<void> {
    assertUsername('delete', name)
    if (name === 'admin') {
      refuse('delete username', name, 'the admin user cannot be deleted (pyeapi raises the same TypeError at users.py:230-231 and this client keeps that guard)')
    }
    await this.configure(this.commandBuilder(`username ${name}`, { mode: 'no' }))
  }

  /** `default username X` — pyeapi's `default` (`users.py:235-244`), pinned by `test_api_users.py:105-107`. */
  override async setDefault(name: string): Promise<void> {
    assertUsername('setDefault', name)
    await this.configure(this.commandBuilder(`username ${name}`, { mode: 'default' }))
  }

  /**
   * `username X privilege V` — pyeapi's `set_privilege` (`users.py:246-268`). Upstream's
   * no-value arm invents `privilege 1` (`:265-267`, `test_api_users.py:115-118`): NOT ported as a
   * default — {@link setPrivilege} always needs a value, and negation is {@link unsetPrivilege}
   * (divergence 5, row 153). Validity is {@link assertPrivilege}, port of `isprivilege` (`:61-74`).
   */
  async setPrivilege(name: string, value: number): Promise<void> {
    assertUsername('setPrivilege', name)
    assertPrivilege(value)
    await this.configure(this.commandBuilder(`username ${name} privilege`, { value }))
  }

  /** `no username X privilege` — the DR-037 unset spelling of a verb upstream can only negate by inventing `privilege 1` (row 153; pyeapi never builds this command). */
  async unsetPrivilege(name: string): Promise<void> {
    assertUsername('unsetPrivilege', name)
    await this.configure(this.commandBuilder(`username ${name} privilege`, { mode: 'no' }))
  }

  /** `default username X privilege` — the DR-037 default family; upstream has no default arm on this verb either. */
  async defaultPrivilege(name: string): Promise<void> {
    assertUsername('defaultPrivilege', name)
    await this.configure(this.commandBuilder(`username ${name} privilege`, { mode: 'default' }))
  }

  /** `username X role V` — pyeapi's `set_role` (`users.py:270-288`), the `command_builder` trio (`:284-286`); `test_api_users.py:124-137` pins all three texts. */
  async setRole(name: string, value: string): Promise<void> {
    assertUsername('setRole', name)
    assertRole(value)
    await this.configure(this.commandBuilder(`username ${name} role`, { value }))
  }

  /** `no username X role` — upstream's `set_role(disable=True)` (`users.py:286`; `test_api_users.py:129-132`). */
  async unsetRole(name: string): Promise<void> {
    assertUsername('unsetRole', name)
    await this.configure(this.commandBuilder(`username ${name} role`, { mode: 'no' }))
  }

  /** `default username X role` — upstream's `set_role(default=True)` (`users.py:279`-arm via `command_builder`; `test_api_users.py:134-137`). */
  async defaultRole(name: string): Promise<void> {
    assertUsername('defaultRole', name)
    await this.configure(this.commandBuilder(`username ${name} role`, { mode: 'default' }))
  }

  /**
   * `username X ssh-key V` (or `… sshkey V`) — pyeapi's `set_sshkey` (`users.py:290-315`), **inline**
   * like upstream: both version arms interpolate through `command_builder` and upstream's own tests
    * pin inline strings (`test_api_users.py:139-152`: `username test sshkey newkey` and friends on the
   * 4.17.1.1 testlib version). PLAN §4's multiline `{cmd, input}` question resolves to
   * *no multiline arm exists upstream* (row 150's tail). Which spelling goes on the wire is version-
   * selected ({@link sshKeyKeyword}, row 155/DR-078); the value's round-trip rules are
   * {@link assertSshKeyValue}.
   */
  async setSshKey(name: string, value: string): Promise<void> {
    assertUsername('setSshKey', name)
    assertSshKeyValue(value)
    const keyword = await this.sshKeyKeyword()
    await this.configure(this.commandBuilder(`username ${name} ${keyword}`, { value }))
  }

  /** `no username X ssh-key` / `no username X sshkey` — upstream's `set_sshkey(disable=True)` (`:305`-arm; `test_api_users.py:144-147`). */
  async unsetSshKey(name: string): Promise<void> {
    assertUsername('unsetSshKey', name)
    const keyword = await this.sshKeyKeyword()
    await this.configure(this.commandBuilder(`username ${name} ${keyword}`, { mode: 'no' }))
  }

  /** `default username X ssh-key` / `default username X sshkey` — upstream's `set_sshkey(default=True)` (`:305`-arm; `test_api_users.py:149-152`). */
  async defaultSshKey(name: string): Promise<void> {
    assertUsername('defaultSshKey', name)
    const keyword = await this.sshKeyKeyword()
    await this.configure(this.commandBuilder(`username ${name} ${keyword}`, { mode: 'default' }))
  }

  /**
   * The version-selected ssh-key keyword — the `interfaces.ts` `vrfKeyword` rule (row 131/DR-078)
   * applied to pyeapi's floor at `users.py:107`/`:297`: `>= 4.23` numerically ⇒ `ssh-key`, below ⇒
   * `sshkey`, and a release with no leading `major.minor` refuses rather than guessing (upstream would
   * string-compare and, probe-confirmed for `'4.9.13.1F'`, take the wrong arm — row 155 pins it).
   * One memoised `show version` per `Node` (DR-026), the same as every other version-gated verb.
   */
  private async sshKeyKeyword(): Promise<'ssh-key' | 'sshkey'> {
    const info = await this.node.getVersion()
    const atLeast = versionFloorCompare(info.versionNumber, SSH_KEY_DASHED_FORM_MIN)
    if (atLeast === undefined) {
      throw new NotSupportedError(
        `cannot pick the username ssh-key command form: this device's version ${pythonRepr(info.version)} (parsed number ${pythonRepr(info.versionNumber)}) has no leading major.minor to compare against ${pythonRepr(SSH_KEY_DASHED_FORM_MIN.join('.'))} — pyeapi would string-compare whatever it was given against '4.23' (users.py:290-315) and this client refuses to guess which spelling a device it cannot name accepts (DR-032/DR-057)`,
      )
    }
    // The read side takes BOTH spellings from the config text regardless (divergence 7); only the
    // write side needs to pick one, and EOS accepts both forms on 4.23+ regardless of which the
    // device writes — that asymmetry is an M12 (#14) capture, not a claim here.
    return atLeast ? 'ssh-key' : 'sshkey'
  }
}
