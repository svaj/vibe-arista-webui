/**
 * S11 (#81): the users screen's guard rules, pinned as pure functions — the make-or-break half of the
 * issue. No React, no device, no DOM: these are the decisions the container takes **before** it pays
 * for a config session, so they are tested where they live.
 *
 * The command texts themselves are pinned from the transport side in `Users.test.tsx` (the fake
 * session's `run()` argv, mirroring `arista-api-client/src/resources/users.test.ts`, which pins them
 * against pyeapi's own suite). This file pins the guards, the redaction, and the version-selected
 * ssh-key spelling.
 */
import { describe, expect, it } from 'vitest'
import { USER_ENCRYPTIONS } from '@devhax-heavy-industries/arista-eapi'

import {
  ADMIN_PRIVILEGE,
  ADMIN_ROLE,
  BUILT_IN_ADMIN,
  LOCKOUT_BANNER,
  NO_AAA_NOTE,
  SECRET_PLACEHOLDER,
  SSH_KEY_FRAMING_NOTE,
  USER_ACTIONS,
  USER_ENCRYPTION_MARKER,
  SECRET_FORM_ENCODINGS,
  adminAccounts,
  adminEffect,
  builtInAdminRule,
  encryptionRule,
  findAaaToken,
  isAdminAccount,
  lastAdminRefusal,
  privilegedCreateRule,
  privilegeRule,
  redactSecrets,
  roleRule,
  secretRule,
  sshKeyForm,
  sshKeyRule,
  usesNameField,
  usesPrivilegeField,
  usesRoleField,
  usesSecretField,
  usesSshKeyField,
  usesTargetSelect,
  usernameRule,
  versionNumberFrom,
} from './users-rules'
import type { AccountFacts, SshKeyForm } from './users-rules'

const acct = (over: Partial<AccountFacts> & { name: string }): AccountFacts => ({ ...over, name: over.name })

/** The rules return a value/refusal union, so the specs take the refusal out by narrowing rather than
 *  asserting through a cast (the same shape the container uses at its own call sites). */
const levelRefusal = (outcome: ReturnType<typeof privilegeRule>): string =>
  'refusal' in outcome ? outcome.refusal : ''

const formRefusal = (form: SshKeyForm): string => 'refusal' in form ? form.refusal : ''

describe('the admin vocabulary this screen refuses on', () => {
  it('an admin is privilege 15, the network-admin role, or the built-in admin name', () => {
    expect(isAdminAccount(acct({ name: 'high', privilege: ADMIN_PRIVILEGE }))).toBe(true)
    expect(isAdminAccount(acct({ name: 'roleonly', role: ADMIN_ROLE }))).toBe(true)
    expect(isAdminAccount(acct({ name: BUILT_IN_ADMIN }))).toBe(true)
    expect(isAdminAccount(acct({ name: 'ops', privilege: 5, role: 'ops' }))).toBe(false)
    expect(isAdminAccount(acct({ name: 'bare' }))).toBe(false)
    // Privilege is a number in this client's read (divergence 2, resources/users.ts): a digit string
    // never arrives from the parser, and would silently un-flag an admin if it were honoured here.
    expect(isAdminAccount(acct({ name: 'stringy', privilege: '15' as unknown as number }))).toBe(false)
  })

  it('adminAccounts lists the admins in read order, and an empty read lists nothing', () => {
    const rows: readonly AccountFacts[] = [
      acct({ name: 'eapi', privilege: 1 }),
      acct({ name: 'test15', privilege: 15, role: ADMIN_ROLE }),
      acct({ name: BUILT_IN_ADMIN, privilege: 1, role: ADMIN_ROLE }),
      acct({ name: 'ops', privilege: 5, role: 'ops' }),
    ]
    expect(adminAccounts(rows)).toEqual(['test15', BUILT_IN_ADMIN])
    expect(adminAccounts([])).toEqual([])
  })
})

describe('the last-admin refusal (#81: the guard that cannot know which account the proxy uses)', () => {
  it('names what was refused, says the browser cannot see the proxy credential, and never claims "self"', () => {
    const refusal = lastAdminRefusal('Deleting', 'test15')
    expect(refusal).toContain('Deleting `test15` is refused here')
    expect(refusal).toContain('the only privilege-15')
    expect(refusal).toContain(ADMIN_ROLE)
    expect(refusal).toContain('this read found')
    expect(refusal).toContain('the local proxy signs eAPI requests with')
    expect(refusal).toContain('credentials live server-side')
    // The honesty line the issue asks for, in both directions: no claim about which account is in use.
    expect(refusal).not.toMatch(/\bself\b/u)
    expect(refusal).not.toMatch(/\byour own account\b/u)
  })

  it('states that a config read can under-count admins instead of asserting a device total', () => {
    expect(lastAdminRefusal('Demoting', 'admin')).toContain('invisible to a config read')
  })
})

describe('adminEffect — which intents actually take an account out of the admin set', () => {
  const priv15 = acct({ name: 'test15', privilege: ADMIN_PRIVILEGE })
  const roleOnly = acct({ name: 'radmin', role: ADMIN_ROLE })
  const both = acct({ name: 'locked', privilege: ADMIN_PRIVILEGE, role: ADMIN_ROLE })
  const plain = acct({ name: 'ops', privilege: 5, role: 'ops' })

  it('delete removes, default demotes, and the value-less role/privilege negations are read per account', () => {
    expect(adminEffect('delete-user', priv15)).toBe('remove')
    expect(adminEffect('default-user', roleOnly)).toBe('demote')
    // privilege 15 keeps the account admin-capable even with the role line negated, and vice versa.
    expect(adminEffect('unset-role', both)).toBe('none')
    expect(adminEffect('unset-privilege', both)).toBe('none')
    expect(adminEffect('unset-privilege', priv15)).toBe('demote')
    expect(adminEffect('unset-role', roleOnly)).toBe('demote')
    expect(adminEffect('default-privilege', priv15)).toBe('demote')
    expect(adminEffect('default-role', roleOnly)).toBe('demote')
  })

  it('writing the top level or the admin role is not a demotion; any other value is', () => {
    expect(adminEffect('set-privilege', priv15, { privilege: ADMIN_PRIVILEGE })).toBe('none')
    expect(adminEffect('set-privilege', priv15, { privilege: 3 })).toBe('demote')
    expect(adminEffect('set-role', roleOnly, { role: ADMIN_ROLE })).toBe('none')
    expect(adminEffect('set-role', roleOnly, { role: 'network-operator' })).toBe('demote')
    expect(adminEffect('set-role', roleOnly, { privilege: 15 })).toBe('demote')
  })

  it('an account the read says is not an admin is never guarded as one, and the keys/secret verbs never demote', () => {
    expect(adminEffect('delete-user', plain)).toBe('none')
    expect(adminEffect('default-user', plain)).toBe('none')
    expect(adminEffect('set-privilege', plain, { privilege: ADMIN_PRIVILEGE })).toBe('none')
    for (const kind of ['set-ssh-key', 'unset-ssh-key', 'default-ssh-key', 'create-secret'] as const) {
      expect(adminEffect(kind, priv15)).toBe('none')
    }
  })
})

describe('the built-in admin guard (mirrors UsersResource.delete, users.py:230-231)', () => {
  it('refuses to delete or clip the built-in admin, in words that name the client rule', () => {
    const refusal = builtInAdminRule('delete-user', acct({ name: BUILT_IN_ADMIN, privilege: 1, role: ADMIN_ROLE }))
    expect(refusal).toContain('built-in')
    expect(refusal).toContain('users.py:230-231')
    expect(builtInAdminRule('default-user', acct({ name: BUILT_IN_ADMIN }))).toBeDefined()
    expect(builtInAdminRule('set-privilege', acct({ name: BUILT_IN_ADMIN }))).toBeDefined()
    expect(builtInAdminRule('set-role', acct({ name: BUILT_IN_ADMIN }))).toBeDefined()
    // A key write takes no admin line away, so neither guard fires on it.
    expect(builtInAdminRule('set-ssh-key', acct({ name: BUILT_IN_ADMIN }))).toBeUndefined()
    expect(builtInAdminRule('delete-user', acct({ name: 'someone', privilege: ADMIN_PRIVILEGE }))).toBeUndefined()
  })
})

describe('the field rules (mirrors of the client\'s module-local assert* guards)', () => {
  it('username must be one present token with no control character', () => {
    expect(usernameRule('eapi')).toBeUndefined()
    expect(usernameRule('')).toMatch(/needs a value/u)
    expect(usernameRule('two words')).toMatch(/one token/u)
    // A tab is whitespace, so the reader contract refuses it as a token problem; a non-printing
    // control code is the branch that names the config line itself.
    expect(usernameRule('tab\there')).toMatch(/one token/u)
    expect(usernameRule('bell\u0007name')).toMatch(/control character/u)
  })

  it('privilege is an exact integer 0..15, never a digit string and never a defaulted value', () => {
    expect(privilegeRule('0')).toEqual({ value: 0 })
    expect(privilegeRule(' 15 ')).toEqual({ value: ADMIN_PRIVILEGE })
    expect(levelRefusal(privilegeRule('16'))).toContain('is outside 0..15')
    expect(levelRefusal(privilegeRule('8x'))).toContain('is not a whole number')
    expect(levelRefusal(privilegeRule(''))).toContain('A privilege level needs a value')
    expect(levelRefusal(privilegeRule('-1'))).toContain('is not a whole number')
  })

  it('role and ssh key are validated for the round trip, and the role vocabulary is left to the device', () => {
    expect(roleRule('network-operator')).toBeUndefined()
    expect(roleRule('')).toMatch(/needs a value/u)
    expect(roleRule('network admin')).toMatch(/one token/u)
    expect(roleRule(ADMIN_ROLE)).toBeUndefined()
    // A key may legitimately carry a comment token (the pin at users.test.ts:533 does), but never a
    // line boundary — the write is one inline command line.
    expect(sshKeyRule('ssh-ed25519 AAAA3 noc@rack')).toBeUndefined()
    expect(sshKeyRule('')).toMatch(/needs a value/u)
    expect(sshKeyRule('   ')).toMatch(/needs a value/u)
    expect(sshKeyRule('ssh-rsa AAAA\nssh-rsa BBBB')).toMatch(/one line/u)
    expect(secretRule('   ')).toMatch(/empty secret is refused/u)
    expect(sshKeyRule('bad\tkey')).toMatch(/control character/u)
    expect(secretRule('hunter2')).toBeUndefined()
    expect(secretRule('')).toMatch(/empty secret is refused/u)
    expect(secretRule(' a ')).toBeUndefined()
    expect(secretRule('a b')).toBeUndefined()
    expect(secretRule('line1\nline2')).toMatch(/one config line/u)
  })

  it('the offered secret encodings are the client\u2019s list minus the nologin marker, and anything else is refused', () => {
    expect(SECRET_FORM_ENCODINGS).toEqual(USER_ENCRYPTIONS.filter((kind) => kind !== 'nologin'))
    expect(encryptionRule('sha512')).toBeUndefined()
    expect(encryptionRule('cleartext')).toBeUndefined()
    expect(encryptionRule('md5')).toBeUndefined()
    // DR-091: pyeapi drops a secret paired with `nologin`, so the pairing is a refusal, not a command.
    expect(encryptionRule('nologin')).toMatch(/nologin marker is the separate locked-out action/u)
    expect(encryptionRule('smoke-test')).toMatch(/outside the encodings this screen composes/u)
  })
})

describe('the ssh-key spelling is version-selected, never guessed (DR-078)', () => {
  it('4.23 and newer spells the dashed form; older releases spell it inline without the dash', () => {
    for (const version of ['4.23.1F', '4.28.13.1M', '5.0.1F'] as const) {
      expect(sshKeyForm(versionNumberFrom(version)), version).toEqual({ keyword: 'ssh-key', numericFloor: true })
    }
    for (const version of ['4.22.2F', '4.9.13.1F', '3.21.1F'] as const) {
      expect(sshKeyForm(versionNumberFrom(version)), version).toEqual({ keyword: 'sshkey', numericFloor: true })
    }
  })

  it('an unclassifiable or missing version refuses rather than picking a spelling', () => {
    expect(formRefusal(sshKeyForm(undefined))).toContain('version read has not answered')
    expect(formRefusal(sshKeyForm('software-version-string'))).toContain('no leading major.minor')
    expect(formRefusal(sshKeyForm('software-version-string'))).toContain('DR-078')
    expect('keyword' in sshKeyForm('4.28.13.1M')).toBe(true)
  })

  it('versionNumberFrom takes the leading digits-and-dots run, the client\'s own shape', () => {
    expect(versionNumberFrom('4.28.13.1M')).toBe('4.28.13.1')
    expect(versionNumberFrom('4.17.1.1F-3512479.41711F (engineering build)')).toBe('4.17.1.1')
    expect(versionNumberFrom('software-version-string')).toBe('software-version-string')
    expect(versionNumberFrom(undefined)).toBeUndefined()
  })

  it('the W2 framing note states the verified answer in the copy the operator reads', () => {
    expect(SSH_KEY_FRAMING_NOTE).toContain('INLINE command')
    expect(SSH_KEY_FRAMING_NOTE).toContain('not a `{cmd, input}` pair')
    expect(SSH_KEY_FRAMING_NOTE).toContain('one command line')
  })
})

describe('no AAA, TACACS+ or RADIUS vocabulary is reachable from this screen', () => {
  it('refuses the AAA command the issue names, and any staged line naming tacacs or radius as a token', () => {
    expect(findAaaToken(['aaa authentication login default group radius local'])).toBe('aaa authentication login default group radius local')
    expect(findAaaToken(['username test role tacacs+'])).toBe('username test role tacacs+')
    expect(findAaaToken(['username radius nopassword'])).toBe('username radius nopassword')
    expect(findAaaToken(['username test15 privilege 15', 'no username ops role'])).toBeUndefined()
    expect(findAaaToken(['username test1 secret sha512 $6$rounds$hash'])).toBeUndefined()
    // A word that merely contains the shape is not the keyword: `staaac` / `pre-radius` stay writable.
    expect(findAaaToken(['username staaac privilege 3'])).toBeUndefined()
    expect(findAaaToken(['username test15 role pre-radius-view'])).toBeUndefined()
    expect(findAaaToken([])).toBeUndefined()
  })

  it('the standing notice says what this screen does not do, and names the lockout reason', () => {
    expect(NO_AAA_NOTE).toContain('local users only')
    expect(NO_AAA_NOTE).toContain('aaa authentication')
    expect(NO_AAA_NOTE).toContain('TACACS+')
    expect(NO_AAA_NOTE).toContain('RADIUS')
    expect(NO_AAA_NOTE).toContain('lockout')
    expect(LOCKOUT_BANNER).toBe('Locking yourself out of a privilege-15 account can sever eAPI access; verify another admin exists first.')
  })
})

describe('privileged-create guard', () => {
  it('refuses a new privilege-15 account when the read shows no other admin to fall back on', () => {
    const refusal = privilegedCreateRule({ privilege: ADMIN_PRIVILEGE, name: 'newbie' }, [])
    expect(refusal).toContain('refused here')
    expect(refusal).toContain('no other privilege-15')
    expect(refusal).toContain('local proxy')
  })

  it('allows it once another admin exists, and never guards a lower level', () => {
    expect(privilegedCreateRule({ privilege: ADMIN_PRIVILEGE, name: 'newbie' }, [BUILT_IN_ADMIN])).toBeUndefined()
    expect(privilegedCreateRule({ privilege: 14, name: 'newbie' }, [])).toBeUndefined()
    // The account being created cannot be its own fallback.
    expect(privilegedCreateRule({ privilege: ADMIN_PRIVILEGE, name: 'test15' }, ['test15'])).toBeDefined()
  })
})

describe('secret redaction (#81: the transport stays honest, the UI never shows the value)', () => {
  it('replaces the secret tail of every secret-bearing line, in commands and in device diff text', () => {
    expect(redactSecrets('username test1 secret 0 hunter2')).toBe(`username test1 secret 0 ${SECRET_PLACEHOLDER}`)
    expect(redactSecrets('username test1 secret sha512 $6$rounds$9KQvZ0hZ0m2n')).toBe(`username test1 secret sha512 ${SECRET_PLACEHOLDER}`)
    expect(redactSecrets('username test1 secret 5 $1$eCurfHLe$JCbuUNM7Xwy6i6/zknYha.')).toBe(`username test1 secret 5 ${SECRET_PLACEHOLDER}`)
    const diff = ['hostname sw1', '+username test1 secret sha512 $6$rounds$abcdef', '+   privilege 15']
    const redacted = redactSecrets(diff.join('\n')).split('\n')
    expect(redacted[1]).toBe(`+username test1 secret sha512 ${SECRET_PLACEHOLDER}`)
    expect(redacted[2]).toBe('+   privilege 15')
    expect(redactSecrets('')).toBe('')
  })

  it('leaves the two-token locked-out form and the non-secret verbs untouched', () => {
    expect(redactSecrets('username test1 secret *')).toBe('username test1 secret *')
    expect(redactSecrets('username test1 nopassword')).toBe('username test1 nopassword')
    expect(redactSecrets('no username test1')).toBe('no username test1')
    expect(redactSecrets('username test1 privilege 15')).toBe('username test1 privilege 15')
    expect(redactSecrets('username test1 role network-admin')).toBe(`username test1 role ${ADMIN_ROLE}`)
  })

  it("the marker per encoding matches the client's ENCRYPTION_MAP (users.py:58)", () => {
    expect(USER_ENCRYPTION_MARKER).toEqual({ cleartext: '0', md5: '5', sha512: 'sha512', nologin: '*' })
  })
})

describe('the action vocabulary itself', () => {
  it('the action list is the closed set the view renders: 14 forms, no AAA verb among them', () => {
    expect(USER_ACTIONS).toHaveLength(14)
    expect(USER_ACTIONS.filter((kind) => findAaaToken([`username x ${kind}`]) !== undefined)).toEqual([])
    expect(USER_ACTIONS.filter((kind) => /aaa|tacacs|radius/u.test(kind))).toEqual([])
  })

  it('exactly one field family is live per action, and create actions never need a selected target', () => {
    for (const kind of USER_ACTIONS) {
      const fields = [usesSecretField(kind), usesPrivilegeField(kind), usesRoleField(kind), usesSshKeyField(kind)]
      expect(fields.filter((live) => live).length, kind).toBeLessThanOrEqual(1)
      expect(usesNameField(kind), kind).not.toBe(usesTargetSelect(kind))
    }
    expect(USER_ACTIONS.filter(usesNameField)).toEqual(['create-secret', 'create-nologin', 'create-nopassword'])
    expect(usesSecretField('create-secret')).toBe(true)
    expect(usesPrivilegeField('set-privilege')).toBe(true)
  })
})
