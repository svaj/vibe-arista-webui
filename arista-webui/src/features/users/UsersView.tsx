/**
 * S11 (#81): the presentation half of the users / SSH-keys / roles screen. Pure props only, mirroring
 * `SystemSettingsView.tsx`: no `User`, `ConfigSession` or client type crosses this boundary, and every
 * string is already what the container decided the operator may see.
 *
 * The security shape this file is responsible for:
 * - **A secret value is never rendered.** The container hands over `loginLabel` (the client's
 *   `secretFormat` marker, never the text — resources/users.ts owns that DR-089 rule on the read side)
 *   and the redacted display copy of the staged batch. `Users.tsx` refuses to mount a draft whose
 *   display copy still mentions the typed secret.
 * - **The standing banner is unconditional.** #81 requires it on the screen, in every state, so it is
 *   not part of a draft panel or an error branch — it is the first thing in the workspace.
 * - **Device text is text.** A configured SSH key is untrusted device output rendered as a `<pre>`
 *   text child (never HTML, never an attribute), the same pin shape as S8's banner bodies and S4's XSS
 *   case. Login/secret markers and usernames are plain text children too.
 * - **"admin" is a read answer, not a guess.** The admin flag comes from the container's parsed
 *   privilege/role; the copy under the table states the under-count limit (a built-in `admin` with no
 *   config line is invisible here) and states that this browser cannot know which account the proxy
 *   signs with, so no row is ever labelled "self".
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import { USER_ACTIONS, USER_ACTION_LABEL, ADMIN_ROLE } from './users-rules'
import type { UserAction } from './users-rules'

export interface UserRowView {
  readonly name: string
  /** Privilege as the read answered it; `undefined` means the config carries no `privilege` line. */
  readonly privilege?: number
  readonly role?: string
  /** The client's read-side answer about the login secret, marker only — never the value (DR-089). */
  readonly loginLabel: string
  /** A configured SSH key, verbatim from the config text. Rendered as `<pre>` text. */
  readonly sshKey?: string
  /** True when the read names this account privilege 15 or the network-admin role. */
  readonly admin: boolean
  /** The account is the client's built-in undeletable `admin`. */
  readonly builtInAdmin: boolean
}

export interface UsersFieldsView {
  readonly action: UserAction
  readonly name: string
  readonly target: string
  readonly encryption: string
  readonly secret: string
  readonly privilege: string
  readonly role: string
  readonly sshKey: string
}

export interface UsersViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }
  readonly rows: readonly UserRowView[]
  /** The admins this read found. `false` = no read has answered, so nothing may be counted or claimed. */
  readonly adminsKnown: boolean
  readonly admins: readonly string[]
  readonly banner: string
  readonly noAaaNote: string
  readonly fields: UsersFieldsView
  /** Per-field refusals raised in-form, before any session is paid for. */
  readonly fieldErrors: Partial<Record<keyof UsersFieldsView, string>>
  readonly onActionChange: (action: UserAction) => void
  readonly onFieldChange: (field: keyof UsersFieldsView, value: string) => void
  readonly targetOptions: readonly string[]
  /** The spelling the ssh-key verbs would stage, decided from the version read; `undefined` = unknown. */
  readonly sshKeyKeyword?: string
  readonly framingNote: string
  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: 'connected' | 'connecting' | 'error'
  readonly connectionLabel: string
  readonly onSubmitPreview: (event: FormEvent<HTMLFormElement>) => void
  readonly onReload: () => void
}

export function UsersView({
  state,
  readError,
  proxyPrompt,
  identity,
  rows,
  adminsKnown,
  admins,
  banner,
  noAaaNote,
  fields,
  fieldErrors,
  onActionChange,
  onFieldChange,
  targetOptions,
  sshKeyKeyword,
  framingNote,
  busy,
  canAct,
  notice,
  failure,
  connection,
  connectionLabel,
  onSubmitPreview,
  onReload,
}: UsersViewProps): ReactElement {
  const columns: readonly DataTableColumn<UserRowView>[] = [
    {
      header: 'Username',
      cell: (row) => <>{row.name}{row.builtInAdmin && <span className="cell-note">the client refuses to delete this name</span>}</>,
    },
    {
      header: 'Privilege',
      cell: (row) => row.privilege === undefined
        ? <span className="cell-note">no privilege line read</span>
        : <span className="numeric-cell">{String(row.privilege)}</span>,
    },
    { header: 'Role', cell: (row) => row.role ?? <span className="cell-note">no role line read</span> },
    { header: 'Login secret', cell: (row) => <>{row.loginLabel}<span className="cell-note">the value itself is never read back here</span></> },
    {
      header: 'SSH key',
      cell: (row) => row.sshKey === undefined
        ? <span className="cell-note">none configured on a line this client reads</span>
        // Untrusted device text: a `<pre>` text child, exactly as S8 renders a banner body.
        : <pre className="diff-output ssh-key-value">{row.sshKey}</pre>,
    },
    {
      header: 'Admin guard',
      cell: (row) => row.admin
        ? <span className="band-flag band-flag-eapi-served">privilege-15 / network-admin</span>
        : <StatePill value="not an admin by this read" />,
    },
  ]

  const secretField = fields.action === 'create-secret'

  return <section className="workspace" aria-labelledby="workspace-title">
    <div className="screen-connection">
      <ConnectionHeader
        state={connection}
        {...(identity === undefined ? {} : { identity })}
        {...(connection === 'connected' ? { connectedLabel: connectionLabel } : {})}
        {...(connection === 'connecting' ? { connectingLabel: connectionLabel } : {})}
        {...(connection === 'error' ? { errorLabel: connectionLabel } : {})}
      />
    </div>

    <div className="workspace-heading">
      <div>
        <p className="eyebrow">LOCAL USERS</p>
        <h2 id="workspace-title">Users &amp; roles</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload device state</button>
    </div>

    {/* #81's standing banner: unconditional, and never softened by a per-account answer. */}
    <p className="notice notice-warning" role="status">{banner}</p>
    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}
    <p className="notice" role="status">{noAaaNote}</p>

    {state === 'loading' && <p className="notice" role="status" aria-busy="true">Reading the running-config for the local user table (a parsed-config read, W2a #35)&#8230;</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The user read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    <div className="inventory-strip" aria-label="User inventory">
      <div><span className="metric-label">Accounts read</span><strong>{adminsKnown ? String(rows.length) : '?'}</strong></div>
      <div><span className="metric-label">Admin accounts in this read</span><strong>{adminsKnown ? String(admins.length) : '?'}</strong></div>
    </div>

    <section className="panel" aria-labelledby="users-table-title">
      <div className="panel-heading">
        <div><p className="eyebrow">RUNNING CONFIG</p><h3 id="users-table-title">Every local user</h3></div>
        <span className="panel-index">{adminsKnown ? rows.length.toString().padStart(2, '0') : '--'}</span>
      </div>
      <p className="field-note">
        This client reads the <code>username &#8230;</code> lines of <code>show running-config all</code> and hands back the
        secret&#39;s <em>format marker only</em> (<code>0</code> cleartext, <code>5</code> md5, <code>7</code> hidden/reversible,
        <code>sha512</code>, <code>*</code> locked out) — the stored value is never returned to a browser (DR-089). The secret a
        create form sends lands in the device&#39;s own <code>show running-config</code> output, which is the only place it is displayed after that.
      </p>
      <p className="field-note">
        {adminsKnown
          ? `Admin accounts in this read: ${admins.length === 0 ? 'none named by a privilege or role line' : admins.join(', ')}. A privilege-15 account or a \`${ADMIN_ROLE}\` role is one that can reach eAPI, and this UI reaches the switch over eAPI; the browser cannot see which account the local proxy signs requests with, so no row here is — or could be — labelled "self". `
          : 'No user read has answered, so no account set is claimed and every write stays locked. '}
        An EOS built-in <code>admin</code> that writes no <code>username admin &#8230;</code> line is invisible to a config read — the count above is a lower bound, not a device promise.
      </p>
      {!adminsKnown
        ? <p className="field-note" role="status">No user read has answered, so this screen lists nothing and claims nothing about the account set.</p>
        : rows.length === 0
          ? <EmptyState heading="The device returned no local username entries." hint="A device whose access is AAA-only, or an unconfigured device — not a read failure. A failed read renders as an error above, and with no local account listed the admin guards refuse every demote or delete." />
          : <DataTable columns={columns} rows={rows} rowKey={(row) => row.name} label="Local user accounts" />}
    </section>

    <section className="panel" aria-labelledby="users-write-title">
      <div className="panel-heading">
        <div><p className="eyebrow">STAGED CHANGE</p><h3 id="users-write-title">Change a local user</h3></div>
        <span className="panel-index">02</span>
      </div>
      <form onSubmit={onSubmitPreview}>
        <label htmlFor="users-action">Action</label>
        <select id="users-action" value={fields.action} disabled={!canAct || busy} onChange={(event) => onActionChange(event.target.value as UserAction)}>
          {USER_ACTIONS.map((action) => <option key={action} value={action}>{USER_ACTION_LABEL[action]}</option>)}
        </select>
        {fieldErrors.action !== undefined && <p className="notice notice-error" role="alert">{fieldErrors.action}</p>}

        {fields.action === 'create-secret' || fields.action === 'create-nologin' || fields.action === 'create-nopassword' ? <>
          <label htmlFor="users-name">New username (one token)</label>
          <input id="users-name" name="users-name" value={fields.name} spellCheck={false} autoComplete="off" disabled={!canAct || busy} onChange={(event) => onFieldChange('name', event.target.value)} />
          {fieldErrors.name !== undefined && <p className="notice notice-error" role="alert">{fieldErrors.name}</p>}
        </> : <>
          <label htmlFor="users-target">Account</label>
          <select id="users-target" value={fields.target} disabled={!canAct || busy || targetOptions.length === 0} onChange={(event) => onFieldChange('target', event.target.value)}>
            {targetOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          {fieldErrors.target !== undefined && <p className="notice notice-error" role="alert">{fieldErrors.target}</p>}
        </>}

        {secretField && <>
          <label htmlFor="users-encryption">Secret encoding to send</label>
          <select id="users-encryption" value={fields.encryption} disabled={!canAct || busy} onChange={(event) => onFieldChange('encryption', event.target.value)}>
            <option value="sha512">sha512 (a hash the device already holds)</option>
            <option value="md5">md5 (5 — legacy)</option>
            <option value="cleartext">cleartext (0 — stored plainly on the device)</option>
          </select>
          {fieldErrors.encryption !== undefined && <p className="notice notice-error" role="alert">{fieldErrors.encryption}</p>}
          <label htmlFor="users-secret">Secret (typed once; this screen never shows it back)</label>
          <input id="users-secret" name="users-secret" type="password" value={fields.secret} spellCheck={false} autoComplete="new-password" disabled={!canAct || busy} onChange={(event) => onFieldChange('secret', event.target.value)} />
          <p className="field-note">
            The preview, the diff and the confirm all show a redaction placeholder instead of this value, while the command the
            transport receives stays exactly what the device needs. Where the value does appear afterwards is the device&#39;s own
            <code>show running-config</code> output — this screen neither stores nor re-reads it.
          </p>
          {fieldErrors.secret !== undefined && <p className="notice notice-error" role="alert">{fieldErrors.secret}</p>}
        </>}

        {(fields.action === 'set-privilege') && <>
          <label htmlFor="users-privilege">Privilege level (0–15)</label>
          <input id="users-privilege" name="users-privilege" value={fields.privilege} inputMode="numeric" spellCheck={false} autoComplete="off" disabled={!canAct || busy} onChange={(event) => onFieldChange('privilege', event.target.value)} />
          <p className="field-note">15 is the top of the ladder (<code>0 &lt;= value &lt; 16</code> is the client&#39;s bound, mirroring pyeapi&#39;s <code>isprivilege</code> at users.py:73). Setting <code>privilege 15</code> or a <code>network-admin</code> role is what can lock an operator in — and out.</p>
          {fieldErrors.privilege !== undefined && <p className="notice notice-error" role="alert">{fieldErrors.privilege}</p>}
        </>}

        {(fields.action === 'create-secret' || fields.action === 'create-nologin' || fields.action === 'create-nopassword') && <>
          <label htmlFor="users-create-privilege">Optional privilege for the new account (0–15, blank for none)</label>
          <input id="users-create-privilege" name="users-create-privilege" value={fields.privilege} inputMode="numeric" spellCheck={false} autoComplete="off" disabled={!canAct || busy} onChange={(event) => onFieldChange('privilege', event.target.value)} />
          <p className="field-note">Blank stages only the <code>username &#8230;</code> line the client&#39;s <code>create</code> composes. A value adds the pinned <code>username &#8230; privilege N</code> line in the same session — and privilege 15 needs another admin to fall back on, which the guard above decides from this read.</p>
          {fieldErrors.privilege !== undefined && <p className="notice notice-error" role="alert">{fieldErrors.privilege}</p>}
        </>}

        {fields.action === 'set-role' && <>
          <label htmlFor="users-role">Role token (one word)</label>
          <input id="users-role" name="users-role" value={fields.role} spellCheck={false} autoComplete="off" disabled={!canAct || busy} onChange={(event) => onFieldChange('role', event.target.value)} />
          <p className="field-note">The role vocabulary is the device&#39;s to answer (<code>network-admin</code> and friends); this client validates a single token only and the CLI rejects a role it does not know with its own <code>CommandError</code>.</p>
          {fieldErrors.role !== undefined && <p className="notice notice-error" role="alert">{fieldErrors.role}</p>}
        </>}

        {fields.action === 'set-ssh-key' && <>
          <label htmlFor="users-ssh-key">Public SSH key (one line)</label>
          <textarea id="users-ssh-key" name="users-ssh-key" className="probe-commands" rows={3} value={fields.sshKey} spellCheck={false} autoComplete="off" disabled={!canAct || busy} onChange={(event) => onFieldChange('sshKey', event.target.value)} />
          <p className="field-note">{framingNote}</p>
          <p className="field-note">Staged spelling: <strong>{sshKeyKeyword ?? 'unknown until the version read answers'}</strong>.</p>
          {fieldErrors.sshKey !== undefined && <p className="notice notice-error" role="alert">{fieldErrors.sshKey}</p>}
        </>}

        <div className="review-actions">
          {/* The name of this control never changes: the in-flight state rides `disabled` plus
              `aria-busy`, and the one-session rule is the container\u2019s refusal (with its own copy), not a
              silently disabled button \u2014 the S8 pattern. */}
          <button className="primary-button" type="submit" disabled={!canAct || busy} aria-busy={busy}>Preview and read the device diff</button>
          {/* No reload control here: the heading already carries the single `Reload device state`
              button, and a second one with the same accessible name would make the name ambiguous. A
              failed read gets its own enabled `Try again` inside the error alert instead. */}
        </div>
      </form>
    </section>

    {notice !== '' && <p className="notice notice-success operation-result" role="status" aria-live="polite">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device refused that.</strong><p>{failure}</p></div>}
  </section>
}
