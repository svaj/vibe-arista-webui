/**
 * S11 (#81): the pure rules behind the users/SSH-keys/roles screen. No React, and the only client
 * import is a **type-only** one (the encryption vocabulary), so this file holds exactly the
 * decisions #81 grades as make-or-break:
 *
 * - **which accounts are admins** (`isAdminAccount`): a `privilege 15` line or a
 *   `role network-admin` line in the parsed running-config, plus the built-in name `admin`, which
 *   the client itself refuses to delete (`UsersResource.delete`, resources/users.ts citing
 *   users.py:230-231). An EOS `admin` with no `username admin …` line is invisible to a config
 *   read, so the read can under-count admins — every refusal below says that instead of asserting
 *   a total.
 * - **the last-admin refusal** (`lastAdminRefusal`): with one admin account on the table, deleting
 *   or demoting it is refused outright, because this UI reaches the switch over eAPI and the
 *   browser cannot see which account the local proxy authenticates as (credentials are server-side,
 *   `src/testing/redaction-guard.ts` header / vite proxy). The copy never claims to know "self".
 * - **the high-privilege create guard** (`privilegedCreateRule`): a fresh `privilege 15` account is
 *   refused when the read shows no *other* admin — the issue names this asymmetry on purpose, and
 *   the refusal explains how to read it.
 * - **no AAA vocabulary** (`findAaaToken`): the screen composes local-user commands only, and every
 *   staged batch is scanned for the `aaa` / `tacacs` / `radius` keywords before a session opens
 *   (#81: enabling AAA without a local fallback is the classic eAPI lockout, so it is out of scope
 *   here, not merely discouraged).
 * - **the secret never renders** (`redactSecrets`): the transport keeps the honest
 *   `username X secret <fmt> <value>` line the client composes (users.py:198, `ENCRYPTION_MAP`
 *   :58), while every string the view could print — staged display copy, the device `diff()`, both
 *   confirm bodies — has the value replaced by the placeholder.
 * - **the ssh-key spelling** (`sshKeyForm`): the client picks `ssh-key` vs `sshkey` by a *numeric*
 *   compare of the parsed version against pyeapi's `4.23` floor (users.ts:222-237 / users.py:107,
 *   :297) and refuses to guess on an unclassifiable release (DR-078/DR-032). This screen does the
 *   same arithmetic on the identity read it already performs — a probe would cost an always-aborted
 *   config session for a question `show version` already answers (DR-063).
 *
 * The validation rules (`usernameRule` / `privilegeRule` / `roleRule` / `sshKeyRule` /
 * `secretRule`) mirror the client's module-local `assert*` guards (assertUsername, assertPrivilege
 * ← `isprivilege` users.py:61-74, assertRole, assertSshKeyValue, assertSecretText) and each message
 * names the rule it mirrors: those are **client policy**, unverified on hardware (M12 #14), and the
 * device keeps authority — a write the client allowed but the CLI rejects answers with its own
 * `CommandError`.
 */
import type { UserEncryption } from '@devhax-heavy-industries/arista-eapi'

/** The actions this screen can stage. One entry per pinned command form in the client's spec. */
export const USER_ACTIONS = [
  'create-secret',
  'create-nologin',
  'create-nopassword',
  'set-privilege',
  'unset-privilege',
  'default-privilege',
  'set-role',
  'unset-role',
  'default-role',
  'set-ssh-key',
  'unset-ssh-key',
  'default-ssh-key',
  'delete-user',
  'default-user',
] as const

export type UserAction = (typeof USER_ACTIONS)[number]

/** The select's vocabulary, in the order the screen lists it. */
export const USER_ACTION_LABEL: Readonly<Record<UserAction, string>> = {
  'create-secret': 'Create / re-key with a secret (username … secret …)',
  'create-nologin': 'Create locked out (username … secret *)',
  'create-nopassword': 'Create with no login secret (username … nopassword)',
  'set-privilege': 'Set privilege (username … privilege N)',
  'unset-privilege': 'Clear privilege (no username … privilege)',
  'default-privilege': 'Default privilege (default username … privilege)',
  'set-role': 'Set role (username … role NAME)',
  'unset-role': 'Clear role (no username … role)',
  'default-role': 'Default role (default username … role)',
  'set-ssh-key': 'Set SSH key (username … ssh-key KEY)',
  'unset-ssh-key': 'Clear SSH key (no username … ssh-key)',
  'default-ssh-key': 'Default SSH key (default username … ssh-key)',
  'delete-user': 'Delete (no username …)',
  'default-user': 'Default the whole account (default username …)',
}

/** What each action needs from the form. `name` = a username typed from scratch, `target` = a row
 *  chosen from the read table; `secret` pairs with `create-secret` only. */
export function usesNameField(action: UserAction): boolean {
  return action === 'create-secret' || action === 'create-nologin' || action === 'create-nopassword'
}

export function usesTargetSelect(action: UserAction): boolean {
  return !usesNameField(action)
}

export function usesSecretField(action: UserAction): boolean {
  return action === 'create-secret'
}

export function usesPrivilegeField(action: UserAction): boolean {
  return action === 'set-privilege'
}

export function usesRoleField(action: UserAction): boolean {
  return action === 'set-role'
}

export function usesSshKeyField(action: UserAction): boolean {
  return action === 'set-ssh-key'
}

/** #81's standing banner, verbatim from the issue body. The view renders it on every state. */
export const LOCKOUT_BANNER = 'Locking yourself out of a privilege-15 account can sever eAPI access; verify another admin exists first.'

/** #81's scope line: this screen is local users only, and says so. */
export const NO_AAA_NOTE = 'This screen configures local users only. It never composes an `aaa authentication` / `aaa authorization` line, and never touches TACACS+ or RADIUS: enabling AAA without a local fallback is the classic eAPI lockout, and answering it is not this screen\u2019s job.'

/** The privilege level EOS treats as the top of the ladder — the client's own bound is
 *  `0 <= value < 16` (`isprivilege`, users.py:73), and 15 is the level that can reach eAPI. */
export const ADMIN_PRIVILEGE = 15

/** The role token that carries full administration on EOS. It is also the token the client's read
 *  side reports, never one this screen invents (`role network-admin` appears in the client fixture
 *  at users.test.ts:52). */
export const ADMIN_ROLE = 'network-admin'

/** The username the client refuses to delete outright (`UsersResource.delete`, users.py:230-231). */
export const BUILT_IN_ADMIN = 'admin'

/** What the view shows wherever a secret value would have been printed. */
export const SECRET_PLACEHOLDER = '[secret redacted by this UI]'

/** The minimum fields the guards need about one account. The client's `User` record satisfies it
 *  (resources/users.ts), and absence stays absence (row 151) rather than a coerced default. */
export interface AccountFacts {
  readonly name: string
  readonly privilege?: number
  readonly role?: string
}

/** Is this one of "the accounts that keep eAPI reachable"? See the header for the under-count note. */
export function isAdminAccount(account: AccountFacts): boolean {
  return account.name === BUILT_IN_ADMIN || account.privilege === ADMIN_PRIVILEGE || account.role === ADMIN_ROLE
}

/** Every admin in the parsed config, in read order. */
export function adminAccounts(accounts: Iterable<AccountFacts>): string[] {
  return [...accounts].filter(isAdminAccount).map((account) => account.name)
}

/** The refusal copy shared by the last-admin guards: what was refused, why the browser cannot
 *  answer the real question, and what to do instead. */
export function lastAdminRefusal(what: string, account: string): string {
  return `${what} \`${account}\` is refused here: it is the only privilege-15 / ${ADMIN_ROLE} account this read found, and this browser cannot tell which account the local proxy signs eAPI requests with \u2014 the credentials live server-side (vite proxy), so the UI never knows whether the account it is about to clip is the one it is riding. Verify another admin exists on the device itself (console, or the account list after a change you know is safe), then come back. Note that an EOS built-in \`admin\` writing no \`username admin \u2026\` line is invisible to a config read, so "the only admin here" is a lower bound, not a device promise.`
}

/** How an action touches an admin account: nothing, a demotion, or removal of the account itself.
 *  `default-user`/`default-privilege`/`default-role` count as demotions, because EOS answers a
 *  `default` by dropping the line that made the account an admin. */
export type AdminEffect = 'none' | 'demote' | 'remove'

export interface IntentValues {
  readonly privilege?: number
  readonly role?: string
}

/** Does this staged intent take an admin account out of the admin set? */
export function adminEffect(action: UserAction, target: AccountFacts, values: IntentValues = {}): AdminEffect {
  if (!isAdminAccount(target)) return 'none'
  if (action === 'delete-user') return 'remove'
  if (action === 'default-user') return 'demote'
  if (action === 'set-privilege') return values.privilege === ADMIN_PRIVILEGE ? 'none' : 'demote'
  if (action === 'unset-privilege' || action === 'default-privilege') return target.role === ADMIN_ROLE ? 'none' : 'demote'
  if (action === 'set-role') return values.role === ADMIN_ROLE ? 'none' : 'demote'
  if (action === 'unset-role' || action === 'default-role') return target.privilege === ADMIN_PRIVILEGE ? 'none' : 'demote'
  return 'none'
}

/** The `no username X` / `default username X` / write-side refusal for the built-in admin, naming
 *  the client guard it mirrors. The client raises `NotSupportedError` for `delete('admin')`
 *  (pyeapi raises `TypeError` at users.py:230-231); mirroring it in-form means no session is paid
 *  for one the client would refuse anyway. */
export function builtInAdminRule(action: UserAction, target: AccountFacts): string | undefined {
  if (target.name !== BUILT_IN_ADMIN) return undefined
  if (isAdminAccount(target) && (action === 'delete-user' || action === 'default-user' || adminEffect(action, target) !== 'none')) {
    return `This client refuses to delete the built-in \`${BUILT_IN_ADMIN}\` account (UsersResource.delete mirrors pyeapi\u2019s TypeError, users.py:230-231), and clipping its privilege or role is the same lockout risk \u2014 so nothing is staged here. Change a different account, or use the console if you really mean the built-in one.`
  }
  return undefined
}

/** The C0-plus-DEL control-character test the client uses module-locally (`hasControlCharacter`,
 *  resources/users.ts, same shape as system.ts:178). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Mirrors `assertUsername` (resources/users.ts, the round-trip contract with the reader's
 *  `username (?P<user>[^\s]+)`, users.py:107). */
export function usernameRule(value: string): string | undefined {
  if (value.trim() === '') return 'A username needs a value \u2014 this client refuses an empty one (assertUsername; the reader keys on `username (?P<user>[^\\s]+)`, users.py:107).'
  if (/\s/u.test(value)) return 'A username must be one token: a space inside it would read back as a stray modifier (assertUsername, mirroring the reader at users.py:107).'
  if (hasControlCharacter(value)) return 'A username cannot contain a control character \u2014 it would break the config line this client reads back (assertUsername, row 74).'
  return undefined
}

/** Mirrors `assertPrivilege`, the port of pyeapi's `isprivilege` (users.py:61-74): an exact integer
 *  0..15. Numeric only \u2014 upstream `int()`-coerces the string `'8'` (row 76/DR-053); this client
 *  keeps numbers numeric, and so does this form. */
export function privilegeRule(text: string): { readonly value: number } | { readonly refusal: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { refusal: 'A privilege level needs a value: 0 to 15. Negating the verb is a different action \u2014 Clear/Default privilege (mirrors assertPrivilege, users.py:61-74; pyeapi\u2019s no-value arm invents `privilege 1`, users.py:265-267, and this client refuses to port it).' }
  if (!/^\d+$/u.test(trimmed)) return { refusal: `Privilege ${JSON.stringify(trimmed)} is not a whole number \u2014 assertPrivilege refuses anything but an exact integer 0..15 (pyeapi int()-coerces strings at users.py:61-74; this client keeps numbers numeric).` }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < 0 || value > ADMIN_PRIVILEGE) return { refusal: `Privilege ${String(value)} is outside 0..${String(ADMIN_PRIVILEGE)} \u2014 pyeapi\u2019s bound is 0 <= value < 16 (users.py:73) and its message is "priviledge value must be between 0 and 15" (users.py:264). Whether EOS accepts a level this far out is unverified on hardware (M12 #14); the device's own answer is the referee.` }
  return { value }
}

/** Mirrors `assertRole` (resources/users.ts): a present single token, no control characters. The
 *  role *vocabulary* is a device question (network-admin / network-operator / …) and is never
 *  enumerated here (DR-032) \u2014 a role the CLI does not know rejects with its own `CommandError`. */
export function roleRule(value: string): string | undefined {
  if (value.trim() === '') return 'A role needs a value \u2014 clear a role with the Clear/Default role action instead (assertRole; pyeapi checks nothing at users.py:270-288).'
  if (/\s/u.test(value)) return 'A role must be one token: the reader keeps `role ([^\\s]+)` (users.py:109) and would not read a multi-word role back (assertRole).'
  if (hasControlCharacter(value)) return 'A role cannot contain a control character \u2014 it would break the config line this client reads back (assertRole, row 74).'
  return undefined
}

/** Mirrors `assertSshKeyValue`: present, and no control characters **including line boundaries** —
 *  the write is one inline line (see {@link SSH_KEY_FRAMING_NOTE}), and the reader takes `(.+)$` to end
 *  of line (users.py:115/:133). Internal spaces are legal, since a key line carries its comment token
 *  (pinned at users.test.ts:533). */
export function sshKeyRule(value: string): string | undefined {
  if (value.trim() === '') return 'An SSH key needs a value \u2014 clear a key with the Clear/Default SSH key action instead (assertSshKeyValue, resources/users.ts).'
  if (hasControlCharacter(value)) return 'An SSH key is one line: a control character (a newline included) would break the config line this client reads back (assertSshKeyValue / command-builder\u2019s one-line rule, row 74).'
  return undefined
}

/** Mirrors `assertSecretText`: a present secret with no control characters. The secret is the one
 *  value this screen never displays again after it is typed (\u00a7DR-089 in the client read side). */
export function secretRule(value: string): string | undefined {
  if (value.trim() === '') return 'An empty secret is refused \u2014 upstream composes a trailing-space command for it (probe of users.py:198), and a locked-out account is the `secret *` action instead (DR-091).'
  if (hasControlCharacter(value)) return 'A secret cannot contain a control character \u2014 the write is one config line (assertSecretText, row 74).'
  return undefined
}

/** The encodings a create-with-secret form may compose. `nologin` is deliberately excluded: it is the
 *  separate two-token `username X secret *` action, and pyeapi silently drops a secret paired with it
 *  (`if secret is not None or encryption == 'nologin'` then the `nologin` line omits it — users.py:169
 *  and :196-199, the pairing half of DR-091). */
export const SECRET_FORM_ENCODINGS: readonly UserEncryption[] = ['cleartext', 'md5', 'sha512']

/** Why a create-with-secret encoding is refused, or `undefined`. Mirrors the client's runtime guard on
 *  pyeapi's `ENCRYPTION_MAP` lookup (users.py:191-195, where an unknown key becomes a `TypeError`): the
 *  browser-side form could in principle post anything, so the check is re-made here rather than trusted
 *  to the select's own option list. */
export function encryptionRule(kind: string): string | undefined {
  if ((SECRET_FORM_ENCODINGS as readonly string[]).includes(kind)) return undefined
  return `Secret encoding ${JSON.stringify(kind)} is outside the encodings this screen composes (${SECRET_FORM_ENCODINGS.join(' / ')}). The client refuses an unknown encryption the way pyeapi does (users.py:191-195), and the nologin marker is the separate locked-out action — never a secret plus a marker, because pyeapi drops the paired secret silently (DR-091, users.py:169/:196-199).`
}

/** The `{cmd, input}` question #81's W2 note asks about, answered from the client source: upstream
 *  has **no** multiline arm for a username key (users.py:290-315 interpolates inline, and
 *  `test_api_users.py:139-152` pins the inline texts), so there is nothing to frame — the write is
 *  one plain command line, and the client's own `commandBuilder` refuses a value carrying a line
 *  boundary. The screen therefore offers the control, and this is the copy that says why. */
export const SSH_KEY_FRAMING_NOTE = 'Framing, verified against the client before this control was offered: a username SSH key is an INLINE command, not a `{cmd, input}` pair (resources/users.ts setSshKey composes one plain line; pyeapi has no multiline arm at users.py:290-315 and its suite pins the inline texts). So this screen sends one command line and `commandBuilder` refuses a value with a line boundary (DR-015/row 74), rather than inventing a framing the device was never shown to need.'

/** ssh-key spellings the two device generations answer, and the pyeapi floor between them
 *  (users.py:107/:297 use the literal `'4.23'`). */
export type SshKeyKeyword = 'ssh-key' | 'sshkey'

export type SshKeyForm = { readonly keyword: SshKeyKeyword; readonly numericFloor: true } | { readonly refusal: string }

/** The client's numeric compare (users.ts:222-237 / interfaces.ts:1137) applied to the version this
 *  screen already reads for the header chip. Upstream's compare is a raw STRING compare, so
 *  `'4.9.x' >= '4.23'` is character-true although 4.9 predates 4.23 (row 155, DR-078); an
 *  unclassifiable release must not be guessed at either (DR-032). */
export function sshKeyForm(versionNumber: string | undefined): SshKeyForm {
  if (versionNumber === undefined || versionNumber.trim() === '') {
    return { refusal: 'The SSH-key action needs the device\u2019s version, and the version read has not answered, so this screen cannot pick `ssh-key` from `sshkey` \u2014 the client refuses to guess which spelling a device it cannot name accepts (DR-078/DR-032, sshKeyKeyword at users.ts:620-628). Reload the read, or use the console if you know the spelling.' }
  }
  const parts = /^([0-9]+)\.([0-9]+)/u.exec(versionNumber)
  if (parts === null) {
    return { refusal: `The version read answered ${JSON.stringify(versionNumber)}, which has no leading major.minor to compare against the 4.23 floor (users.py:297) \u2014 this client refuses to guess the ssh-key spelling rather than repeat pyeapi\u2019s raw string compare (row 155/DR-078). Nothing is staged.` }
  }
  const major = Number(parts[1])
  const minor = Number(parts[2])
  return { keyword: major > 4 || (major === 4 && minor >= 23) ? 'ssh-key' : 'sshkey', numericFloor: true }
}

/** pyeapi's leading digits-and-dots run (`client.py:563`, kept by the client as
 *  `VersionProperties.versionNumber`, command-layer.ts:299). The identity chip's `version` string is
 *  the verbatim device answer, so the same slice is taken here. */
export function versionNumberFrom(version: string | undefined): string | undefined {
  if (version === undefined) return undefined
  return /^[\d.]+/u.exec(version)?.[0] ?? version
}

/** The AAA/TACACS+/RADIUS keywords #81 keeps out of this screen, matched only as standalone words: a
 *  role named \`pre-radius-view\` or a username containing \`staaac\` is not the keyword, while
 *  \`tacacs+\` (the form EOS itself spells) is. The command the issue names — \`aaa authentication
 *  login …\` — can therefore never be staged from here. */
const AAA_TOKEN = /(?<![\w-])(?:aaa|tacacs|radius)(?![\w-])/iu

/** Why a staged batch is refused before any session opens, or `undefined` when the batch is made of
 *  local-user commands only. Both halves of the guard are mechanical: what this screen composes
 *  cannot spell an AAA line, and anything that somehow does never reaches the device. */
export function findAaaToken(commands: readonly string[]): string | undefined {
  for (const command of commands) {
    if (AAA_TOKEN.test(command)) return command
  }
  return undefined
}

/** The display form of a staged batch: every `secret <fmt> <value>` tail becomes the placeholder.
 *  The transport keeps the real line (\u00a7the honest split), the view never sees the value. */
export function redactSecrets(text: string): string {
  return text.replace(/(\bsecret\s+(?:0|5|7|sha512))\s[^\n]*/gu, `$1 ${SECRET_PLACEHOLDER}`)
}

/** The marker each encoding contributes to the command line — the client's `ENCRYPTION_MAP`
 *  (`{ cleartext: '0', md5: '5', sha512: 'sha512', nologin: '*' }`, users.py:58). The union of
 *  accepted encodings itself comes from the client (`USER_ENCRYPTIONS`), so nothing here invents a
 *  fourth kind. */
export const USER_ENCRYPTION_MARKER: Readonly<Record<UserEncryption, string>> = {
  cleartext: '0',
  md5: '5',
  sha512: 'sha512',
  nologin: '*',
}

/** The form the *other* admin needs to be able to fix a mistake: a console-visible note rather than
 *  silence, used in the privileged-create refusal. */
export function privilegedCreateRule(values: { readonly privilege: number; readonly name: string }, admins: readonly string[]): string | undefined {
  if (values.privilege !== ADMIN_PRIVILEGE) return undefined
  const others = admins.filter((admin) => admin !== values.name)
  if (others.length > 0) return undefined
  return `Creating \`${values.name}\` at privilege ${String(ADMIN_PRIVILEGE)} is refused here: this read shows no other privilege-15 / ${ADMIN_ROLE} account to fall back on, and the browser cannot see which account the local proxy signs eAPI with (credentials are server-side), so it cannot promise you are adding a second admin rather than betting the whole eAPI path on the account being created. An EOS built-in \`admin\` that writes no \`username admin \u2026\` line would also be invisible to this read. Establish a fallback admin by a path that does not depend on this screen, then create the account.`
}
