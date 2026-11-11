/**
 * S11 (#81): the local-users screen — usernames, privilege, role, login secret and SSH keys, staged
 * the way the rest of the screen wave writes: named session → device `diff()` → confirm → commit,
 * running-config only (DR-024), abort always offered.
 *
 * ```
 * create-secret      ['username X secret sha512 <value>']   (+ `username X privilege N` when supplied)
 * create-nologin     ['username X secret *']                 the two-token locked-out form
 * create-nopassword  ['username X nopassword']
 * privilege          ['username X privilege 5'] / ['no username X privilege'] / ['default username X privilege']
 * role               ['username X role ops']    / ['no username X role']      / ['default username X role']
 * ssh key            ['username X ssh-key KEY'] / ['no username X ssh-key']   / ['default username X ssh-key']
 * delete-user        ['no username X']
 * default-user       ['default username X']
 * ```
 *
 * Every text is the client's own, composed through the package's exported `commandBuilder` and pinned
 * character-for-character against `arista-api-client/src/resources/users.test.ts` (which pins those
 * texts against pyeapi's suite). The resource verbs write immediately (`configure()` — the arms at
 * users.ts:505-616), so this screen composes the same lines into a named session instead of calling
 * them, exactly as S1–S6 do.
 *
 * ## Framing, verified before the SSH-key control was offered (#81's W2 note)
 *
 * There is **no `{cmd, input}` arm** for a username SSH key: pyeapi interpolates it inline
 * (`users.py:290-315`) and its own suite pins the inline texts (`test_api_users.py:139-152`), so this
 * client composes one plain command line (`UsersResource.setSshKey`, divergence 1's tail) and
 * `commandBuilder` refuses a value carrying a line boundary (DR-015 / row 74). Which spelling —
 * `ssh-key` or `sshkey` — goes on the wire is version-selected by the client's numeric floor compare
 * against `4.23` (DR-078); {@link sshKeyForm} mirrors that arithmetic from the `show version` read the
 * identity chip already performs, and refuses to guess when the release cannot be classified. An
 * always-aborted probe session would cost the config lock to answer a question `show version` already
 * answers (DR-063) — which is why this screen has no `useCapabilities` (the same stated absence as
 * S6 #76 and S8 #78).
 *
 * ## The secrets rule (DR-089's UI half)
 *
 * A secret is typed once into a `type="password"` field and never rendered again: the staged review
 * copy, the device `diff()` and both confirm bodies go through {@link redactSecrets}, and
 * {@link preview} drops a draft whose display copy still contains the typed value. The transport keeps
 * the honest line — `session.run(['username bob secret sha512 hunter2'])` is what the device needs —
 * and the screen copy says plainly that the value's afterlife is the device's own
 * `show running-config` output, not anything this page keeps.
 *
 * ## The lockout guards (#81's make-or-break section)
 *
 * The browser cannot know which account the proxy authenticates as (credentials are server-side —
 * see {@link AAA_GUARD}'s source note in `src/testing/redaction-guard.ts`), so nothing here claims a
 * "self" account. What it can do is refuse on the shape that matters, every decision taken from the
 * parsed read (all of it pure logic in ./users-rules.ts, unit-tested there):
 * - deleting or demoting a `privilege 15` / `role network-admin` / built-in `admin` account is refused
 *   outright when it is the only admin this read found ({@link lastAdminRefusal});
 * - with another admin present, that same write needs the destructive confirm **twice**, the second one
 *   naming the account ({@link commitDraft});
 * - creating a new account at `privilege 15` is refused unless another admin already exists
 *   ({@link privilegedCreateRule});
 * - `no username admin` is refused in-form, mirroring the client's own guard (`UsersResource.delete`,
 *   users.py:230-231);
 * - every staged batch is scanned for the words `aaa` / `tacacs` / `radius` before a session opens
 *   ({@link findAaaToken}) — this screen configures local users only, and says so in a standing notice
 *   under #81's standing lockout banner.
 *
 * Client-side guards are mirrors, labelled as such (DR-057): each refusal names the `assert*` rule it
 * restates, and a write this client allowed but the CLI rejects answers with the device's own
 * `CommandError` in the failure slot.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { commandBuilder } from '@devhax-heavy-industries/arista-eapi'
import type { ConfigSession, Node, User, UserEncryption } from '@devhax-heavy-industries/arista-eapi'

import { softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { UsersView } from './UsersView'
import type { UserRowView, UsersDraftView, UsersFieldsView } from './UsersView'
import {
  ADMIN_ROLE,
  BUILT_IN_ADMIN,
  LOCKOUT_BANNER,
  NO_AAA_NOTE,
  SECRET_FORM_ENCODINGS,
  SECRET_PLACEHOLDER,
  SSH_KEY_FRAMING_NOTE,
  USER_ENCRYPTION_MARKER,
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
import type { AccountFacts, IntentValues, SshKeyKeyword, UserAction } from './users-rules'

// The typed `show('version')` overload (the F-tier extension mechanism) — same import S6/S8 use.
import '../../eapi/show-contracts'

export type UsersClient = Pick<Node, 'users' | 'show' | 'configSession'>

export interface UsersProps {
  readonly node: UsersClient | undefined
  readonly proxyConfigured?: boolean
}

type Session = Pick<ConfigSession, 'name' | 'state' | 'run' | 'diff' | 'hasDiffBeenRead' | 'commit' | 'abort'>

interface Draft {
  readonly session: Session
  /** What the transport receives — honest command text, secret included. Never rendered. */
  readonly transport: readonly string[]
  /** What the operator reads, with every secret tail replaced by {@link SECRET_PLACEHOLDER}. */
  readonly display: readonly string[]
  readonly effectLabel: string
  readonly risks: readonly string[]
  /** Set when an admin-guarded write needs a second, named confirm at commit time. */
  readonly adminAccount?: string
  readonly diff?: string
  readonly commitAttempted: boolean
}

interface Data {
  readonly users: readonly User[]
  readonly admins: readonly string[]
  readonly versionNumber?: string
  readonly identity?: DeviceIdentity
}

type Planned = Plan | { readonly refusal: string }
interface Plan {
  readonly specs: readonly string[]
  readonly risks: readonly string[]
  readonly effectLabel: string
  readonly adminAccount?: string
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY = 'Commit was attempted; refresh device state before taking another action.'
const NO_TARGET = 'No account is selected, and this action needs one the read answered. Reload, or pick a create action.'
const ONE_SESSION = 'A staged session is already open on this screen; commit or abort it before staging another change.'
const NO_READ = 'The user read has not answered, so no account can be named or guarded. Staging blind is refused.'
const SSH_VERBS: readonly UserAction[] = ['set-ssh-key', 'unset-ssh-key', 'default-ssh-key']

/** The encodings the create-secret form offers — the rules module\u2019s list, which is the client's
 *  `USER_ENCRYPTIONS` minus `nologin` (pinned equivalent in `users-rules.test.ts`). `nologin` is its own
 *  action because pyeapi silently drops a secret paired with it (DR-091, users.py:169 and :196-199), and
 *  offering both in one bag is how that upstream hole stays open. */
export const SECRET_ENCODINGS: readonly UserEncryption[] = SECRET_FORM_ENCODINGS

const INITIAL_FIELDS: UsersFieldsView = {
  action: 'create-secret',
  name: '',
  target: '',
  encryption: 'sha512',
  secret: '',
  privilege: '',
  role: '',
  sshKey: '',
}

export function Users(props: UsersProps) {
  return <ConfirmProvider><UsersWorkspace {...props} /></ConfirmProvider>
}

function UsersWorkspace({ node, proxyConfigured = true }: UsersProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const canAct = proxyConfigured && node !== undefined

  const [fields, setFields] = useState<UsersFieldsView>(INITIAL_FIELDS)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof UsersFieldsView, string>>>({})
  const [draft, setDraft] = useState<Draft | undefined>(undefined)

  const read = useDeviceRead<Data>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      const users = await node.users.getAll()
      // The version read is SOFT and SILENT, exactly as S8's identity chip: a failed `show version`
      // removes the chip and un-arms the SSH-key spelling, it never blanks the user table the
      // running-config read did answer.
      const versionRead = await softRead(node.show('version'), { silent: true })
      const version = softValue(versionRead)
      const list = [...users.values()]
      return {
        users: list,
        admins: adminAccounts(list),
        ...(version === undefined ? {} : { versionNumber: versionNumberFrom(version.version), identity: identityFrom(version) }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )

  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const rows = data === undefined ? [] : data.users
  const admins = data === undefined ? [] : data.admins
  // The selected account is resolved the way S3 resolves a port: whatever the read named first until
  // the operator picks otherwise, so the controlled `<select>` never displays one row while its state
  // says another (and a stale name from a re-read falls back rather than refusing).
  const targetName = rows.some((user) => user.name === fields.target) ? fields.target : (rows[0]?.name ?? '')
  const fieldsView: UsersFieldsView = { ...fields, target: targetName }
  const selected: AccountFacts | undefined = rows.find((user) => user.name === targetName)
  const keywordForm = sshKeyForm(data?.versionNumber)
  const action = fields.action

  function changeField(field: keyof UsersFieldsView, value: string): void {
    setFields((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
  }

  function refuse(field: keyof UsersFieldsView, message: string): void {
    setFieldErrors((current) => ({ ...current, [field]: message }))
  }

  /** The client's `createWithSecret` form, composed with the package's own `commandBuilder` so the
   *  composer's refusals (an empty value, a value with a line boundary) arrive as the client's text. */
  function secretSpec(name: string, encryption: UserEncryption, secret: string): string {
    return commandBuilder(`username ${name} secret`, { value: `${USER_ENCRYPTION_MARKER[encryption]} ${secret}` })
  }

  /** The optional create-time privilege, appended to the create line in the same session with the
   *  client's pinned `setPrivilege` text. `null` = the field was refused in-form. */
  function appendCreatePrivilege(base: string, name: string): readonly string[] | null {
    if (fields.privilege.trim() === '') return [base]
    const checked = privilegeRule(fields.privilege)
    if ('refusal' in checked) { refuse('privilege', checked.refusal); return null }
    const guard = privilegedCreateRule({ privilege: checked.value, name }, admins)
    if (guard !== undefined) { refuse('privilege', guard); return null }
    return [base, commandBuilder(`username ${name} privilege`, { value: checked.value })]
  }

  /** The value-less verbs, in the client's `unset*`/`default*` mode arms. pyeapi spells only
   *  `disable=True`/`default=True` (users.py:284-286), and its no-value `set_privilege` arm invents
   *  `privilege 1` (users.py:265-267) — the negation family here is DR-037's, never that invention. */
  function plainSpec(kind: UserAction, name: string): string {
    switch (kind) {
      case 'unset-privilege': return commandBuilder(`username ${name} privilege`, { mode: 'no' })
      case 'default-privilege': return commandBuilder(`username ${name} privilege`, { mode: 'default' })
      case 'unset-role': return commandBuilder(`username ${name} role`, { mode: 'no' })
      case 'default-role': return commandBuilder(`username ${name} role`, { mode: 'default' })
      case 'delete-user': return commandBuilder(`username ${name}`, { mode: 'no' })
      case 'default-user': return commandBuilder(`username ${name}`, { mode: 'default' })
      default: throw new Error(`this action is not a value-less verb: ${kind}`)
    }
  }

  /** The ssh-key family: the inline form the client composes (no `{cmd, input}` arm exists — see the
   *  header), spelled by the version-selected keyword. */
  function sshKeySpec(kind: UserAction, name: string, keyword: SshKeyKeyword): string {
    if (kind === 'set-ssh-key') return commandBuilder(`username ${name} ${keyword}`, { value: fields.sshKey.trim() })
    return commandBuilder(`username ${name} ${keyword}`, { mode: kind === 'unset-ssh-key' ? 'no' : 'default' })
  }

  /** The create-family intents: one username typed from scratch, plus the optional privilege line. */
  function planCreate(name: string): Planned {
    const problem = usernameRule(name)
    if (problem !== undefined) {
      refuse('name', problem)
      return { refusal: 'The username was refused in-form; no config session was opened.' }
    }
    if (action === 'create-secret') {
      const encodingProblem = encryptionRule(fields.encryption)
      if (encodingProblem !== undefined) {
        refuse('encryption', encodingProblem)
        return { refusal: 'The secret encoding was refused in-form; no config session was opened.' }
      }
      const secretProblem = secretRule(fields.secret)
      if (secretProblem !== undefined) {
        refuse('secret', secretProblem)
        return { refusal: 'The secret was refused in-form; no config session was opened.' }
      }
      const specs = appendCreatePrivilege(secretSpec(name, fields.encryption as UserEncryption, fields.secret), name)
      if (specs === null) return { refusal: 'The privilege level was refused in-form; no config session was opened.' }
      const exists = rows.some((user) => user.name === name)
      return {
        specs,
        effectLabel: `username ${name} secret <set>`,
        risks: [
          'The secret value is redacted everywhere on this page (' + SECRET_PLACEHOLDER + '); the transport still carries the real command line, and the device writes that value into its own running-config — the device\u2019s own `show running-config` output is the only place it is displayed after this commit.',
          exists
            ? `${name} already exists in this read: this replaces its login form. Whether EOS accepts a re-key is the device's answer (unverified on hardware, M12 #14).`
            : `${name} is new to this read. An account with no privilege or role line reads back as no such line at all (divergence 2 in resources/users.ts) — what the device then lets it do is a device answer, not a claim made here.`,
          fields.encryption === 'cleartext'
            ? 'cleartext (`secret 0`) stores the password plainly on the device. Pick sha512 unless you have a specific reason — and DR-089 is why this screen can never show you what it wrote.'
            : 'This client never reads a secret back (DR-089), so a re-read after commit proves the account changed, not what the value was.',
        ],
      }
    }
    const bare = action === 'create-nologin' ? `username ${name} secret *` : `username ${name} nopassword`
    const specs = appendCreatePrivilege(bare, name)
    if (specs === null) return { refusal: 'The privilege level was refused in-form; no config session was opened.' }
    return {
      specs,
      effectLabel: action === 'create-nologin' ? `username ${name} secret * (locked out)` : `username ${name} nopassword`,
      risks: action === 'create-nologin'
        ? ['`username X secret *` is the two-token form this client reads back as `nologin` (divergence 4): the account exists and cannot log in. Creating it takes no admin line away, which is why this write carries no named second confirm — but it can lock the account itself out.']
        : ['`nopassword` creates a user with no login secret. What that means for console or SSH login is the device\u2019s answer (unverified on hardware, M12 #14); an empty value or a control character was refused above for the round-trip reason.'],
    }
  }

  /** Everything that operates on an account this read answered. Field values are validated first (so a
   *  malformed value never reaches the guard arithmetic), then the admin guards run on the parsed
   *  table — all of it before any session is paid for. */
  function planAccount(target: AccountFacts): Planned {
    const blocked = builtInAdminRule(action, target)
    if (blocked !== undefined) {
      refuse('target', blocked)
      return { refusal: 'The built-in `admin` guard refused this in-form; no config session was opened.' }
    }

    let specs: readonly string[]
    let values: IntentValues = {}
    if (usesPrivilegeField(action)) {
      const checked = privilegeRule(fields.privilege)
      if ('refusal' in checked) { refuse('privilege', checked.refusal); return { refusal: 'The privilege level was refused in-form; no config session was opened.' } }
      values = { privilege: checked.value }
      specs = [commandBuilder(`username ${target.name} privilege`, { value: checked.value })]
    } else if (usesRoleField(action)) {
      const problem = roleRule(fields.role)
      if (problem !== undefined) { refuse('role', problem); return { refusal: 'The role was refused in-form; no config session was opened.' } }
      values = { role: fields.role.trim() }
      specs = [commandBuilder(`username ${target.name} role`, { value: fields.role.trim() })]
    } else if (SSH_VERBS.includes(action)) {
      if (usesSshKeyField(action)) {
        const problem = sshKeyRule(fields.sshKey)
        if (problem !== undefined) { refuse('sshKey', problem); return { refusal: 'The SSH key was refused in-form; no config session was opened.' } }
      }
      if (!('keyword' in keywordForm)) { refuse('action', keywordForm.refusal); return { refusal: 'The SSH-key spelling could not be decided from the version read; no config session was opened.' } }
      specs = [sshKeySpec(action, target.name, keywordForm.keyword)]
    } else {
      specs = [plainSpec(action, target.name)]
    }

    const effect = adminEffect(action, target, values)
    if (effect !== 'none' && admins.length <= 1) {
      refuse('target', lastAdminRefusal(effect === 'remove' ? 'Deleting' : 'Demoting', target.name))
      return { refusal: 'The last-admin guard refused this in-form; no config session was opened.' }
    }

    const adminWrite = effect !== 'none'
    const risks: string[] = [
      'A privilege or role line the config does not carry reads back as absent, never as an assumed default (divergence 2 in resources/users.ts), so the re-read after commit is the proof of what the device accepted.',
      adminWrite
        ? `${target.name} is a privilege-15 / ${ADMIN_ROLE} account. ${LOCKOUT_BANNER} This read does show another admin (${admins.filter((name) => name !== target.name).join(', ')}), and this screen still cannot say which account the proxy signs with — the named second confirm is the honest guard it can offer.`
        : `${target.name} is not an admin by this read, so this write cannot be the one that severs the eAPI path. It is still a write: the device diff decides, and the under-count limit (an EOS built-in \`admin\` writing no config line) is restated under the table.`,
    ]
    if (action === 'set-ssh-key') risks.unshift(SSH_KEY_FRAMING_NOTE)
    if (action === 'delete-user') risks.unshift('`no username X` removes the account outright. If X is the account the operator logs in with, nothing on this page can tell you so — settle that by a path that does not ride eAPI first.')
    if (action === 'default-user') risks.unshift('`default username X` resets the whole account to the device default rather than removing one line; what EOS leaves behind is a device answer (unverified on hardware, M12 #14), which is why the diff above, not this copy, is the evidence.')
    return {
      specs,
      effectLabel: `${action} ${target.name}`,
      risks,
      ...(adminWrite ? { adminAccount: target.name } : {}),
    }
  }

  function plan(): Planned {
    if (usesNameField(action)) return planCreate(fields.name.trim())
    if (selected === undefined) { refuse('target', NO_TARGET); return { refusal: NO_TARGET } }
    return planAccount(selected)
  }

  async function preview(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy || !canAct || node === undefined) return
    setFieldErrors({})
    if (draft !== undefined) {
      operation.run(async () => { throw new Error(ONE_SESSION) }).catch(() => undefined)
      return
    }
    if (data === undefined) {
      operation.run(async () => { throw new Error(NO_READ) }).catch(() => undefined)
      return
    }
    if (usesTargetSelect(action) && targetName === '') {
      refuse('target', NO_TARGET)
      return
    }
    const staged = plan()
    if ('refusal' in staged) {
      operation.run(async () => { throw new Error(staged.refusal) }).catch(() => undefined)
      return
    }
    const offender = findAaaToken(staged.specs)
    if (offender !== undefined) {
      operation.run(async () => { throw new Error(`Refused before any session opened: this screen composes local-user commands only, so the command ${JSON.stringify(offender)} is never staged. ${NO_AAA_NOTE}`) }).catch(() => undefined)
      return
    }
    const display = staged.specs.map(redactSecrets)
    if (usesSecretField(action) && display.some((line) => line.includes(fields.secret))) {
      // Defensive and loud: had redaction ever missed the typed value, this draft is dropped rather
      // than displayed, and no commit can follow because no draft exists.
      operation.run(async () => { throw new Error('Redaction did not strip the secret from the review copy, so this staged draft was dropped instead of shown. Reload device state before trying again.') }).catch(() => undefined)
      return
    }
    await operation.run(async () => {
      const session = await node.configSession({ description: `webui users ${action}` })
      const handle: Session = session
      setDraft({
        session: handle,
        transport: staged.specs,
        display,
        effectLabel: staged.effectLabel,
        risks: staged.risks,
        commitAttempted: false,
        ...(staged.adminAccount === undefined ? {} : { adminAccount: staged.adminAccount }),
      })
      await handle.run(staged.specs)
      const diffText = await handle.diff()
      setDraft((current) => current === undefined ? current : { ...current, diff: redactSecrets(diffText) })
      return diffText
    }, {
      progress: 'Staging the change and reading the device diff\u2026',
      success: 'Review the device diff before committing. The staged copy above is redacted; the transport kept the real command line.',
    })
  }

  async function commitDraft(): Promise<void> {
    if (busy || draft === undefined || draft.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted) return
    const named = draft.adminAccount
    if (!await confirm({
      title: named === undefined ? 'Commit to running-config' : `Confirm: ${named} is an admin account`,
      body: [
        `Commit session ${draft.session.name}, which stages ${draft.display.join(' \u00b7 ')}? This changes running-config only; startup-config is never written by this screen (DR-024).`,
        ...(draft.risks.length === 0 ? [] : [`Risks named for this write:\n${draft.risks.map((risk) => `  \u00b7 ${risk}`).join('\n')}`]),
        'If this session is lost mid-commit, the change may still have applied — reconnect and refresh before any further action.',
      ].join(' '),
      confirmLabel: named === undefined ? 'Commit to running-config' : `Commit despite ${named} being an admin`,
      destructive: true,
      subject: `${draft.session.name} \u00b7 ${draft.effectLabel}`,
    })) return
    // The second, named destructive confirm (#81: deleting or demoting an admin account needs a double
    // destructive confirm). Declining either prompt means `commit()` is never called at all.
    if (named !== undefined && !await confirm({
      title: `Second confirm: ${named}`,
      body: `${LOCKOUT_BANNER} This session stages ${draft.display.join(' \u00b7 ')}, and that changes the admin status of ${named}. This browser cannot see which account the local proxy signs eAPI requests with, so it cannot tell you whether ${named} is the account you are riding. Confirm once more only if another admin has been verified by a path that does not depend on this page.`,
      confirmLabel: `I verified another admin: commit for ${named}`,
      destructive: true,
      subject: `${draft.session.name} \u00b7 ${named}`,
    })) return
    setDraft({ ...draft, commitAttempted: true })
    const committed = await operation.run(() => draft.session.commit(), {
      progress: 'Committing the reviewed change to running-config\u2026',
      success: 'Changes committed to running-config. Startup-config was not changed.',
      failureSuffix: COMMIT_RECOVERY,
    })
    if (committed.ok) {
      setDraft(undefined)
      setFields((current) => ({ ...current, name: '', secret: '', sshKey: '', role: '', privilege: '' }))
      read.reload()
    }
  }

  async function abortDraft(): Promise<void> {
    if (busy || draft === undefined || (draft.session.state !== 'open' && draft.session.state !== 'diffed')) return
    if (!await confirm({ title: 'Abort staged changes', body: `Abort staged changes in session ${draft.session.name}? Its staged ${draft.display.join(' \u00b7 ')} will be discarded and nothing will be written to the device.`, confirmLabel: 'Abort staged changes', destructive: true, subject: draft.session.name })) return
    const aborted = await operation.run(async () => {
      await draft.session.abort()
      setDraft(undefined)
      return draft.session.name
    }, { success: `Session ${draft.session.name} was aborted; nothing was written to the device.` })
    if (aborted.ok) read.reload()
  }

  const draftView: UsersDraftView | undefined = draft === undefined ? undefined : {
    sessionName: draft.session.name,
    sessionState: draft.session.state,
    effectLabel: draft.effectLabel,
    batch: draft.display,
    risks: draft.risks,
    ...(draft.diff === undefined ? {} : { diff: draft.diff }),
    canCommit: draft.diff !== undefined && draft.session.hasDiffBeenRead() && !draft.commitAttempted,
    commitAttempted: draft.commitAttempted,
    ...(draft.adminAccount === undefined ? {} : { adminAccount: draft.adminAccount }),
  }

  const viewRows: readonly UserRowView[] = rows.map((user) => ({
    name: user.name,
    ...(user.privilege === undefined ? {} : { privilege: user.privilege }),
    ...(user.role === undefined ? {} : { role: user.role }),
    loginLabel: loginLabelFor(user),
    ...(user.sshKey === undefined ? {} : { sshKey: user.sshKey }),
    admin: isAdminAccount(user),
    builtInAdmin: user.name === BUILT_IN_ADMIN,
  }))

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  return <UsersView
    state={state}
    {...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {})}
    {...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT })}
    {...(data?.identity === undefined ? {} : { identity: data.identity })}
    rows={viewRows}
    adminsKnown={data !== undefined}
    admins={admins}
    banner={LOCKOUT_BANNER}
    noAaaNote={NO_AAA_NOTE}
    fields={fieldsView}
    fieldErrors={fieldErrors}
    onActionChange={(next) => { changeField('action', next) }}
    onFieldChange={changeField}
    targetOptions={rows.map((user) => user.name)}
    {...('keyword' in keywordForm ? { sshKeyKeyword: keywordForm.keyword } : {})}
    framingNote={SSH_KEY_FRAMING_NOTE}
    {...(draftView === undefined ? {} : { draft: draftView })}
    busy={busy}
    canAct={canAct && state === 'ready'}
    notice={notice}
    failure={failure}
    connection={!canAct || state === 'failed' ? 'error' : state === 'loading' || busy ? 'connecting' : 'connected'}
    connectionLabel={!canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading the running-config\u2026'
        : state === 'failed'
          ? 'The user read did not come back'
          : 'Local users read from the parsed running-config'}
    onSubmitPreview={(event) => { void preview(event) }}
    onCommitDraft={() => void commitDraft()}
    onAbortDraft={() => void abortDraft()}
    onReload={() => { setFieldErrors({}); operation.clear(); read.reload() }}
  />
}

/** The login secret, marker only — the value itself is never returned by the client either (DR-089).
 *  `secret *` is checked before `nopassword` because the lock-out is the stronger statement the
 *  config made (divergence 4: upstream reads that line as no secret at all). */
export function loginLabelFor(user: User): string {
  if (user.secretFormat === 'nologin') return 'secret * (locked out — nologin)'
  if (user.nopassword) return 'nopassword (no login secret configured)'
  if (user.secretFormat === undefined) return 'no secret line read'
  if (user.secretFormat === '0') return 'secret 0 (cleartext stored on the device)'
  if (user.secretFormat === '5') return 'secret 5 (md5 hash)'
  if (user.secretFormat === '7') return 'secret 7 (hidden/reversible form)'
  return `secret ${user.secretFormat} (hash form)`
}
