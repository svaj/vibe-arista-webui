/**
 * S10 (#80): presentation half of the static-route manager. Pure props (the
 * `SystemSettingsView.tsx`/`AddressingView.tsx` rule): no client type crosses this boundary — the
 * container maps every `StaticRoute` record into {@link StaticRouteRowView} and composes the command
 * text through `./static-route-rules`.
 *
 * What this file is responsible for saying, rather than hiding:
 *
 * - **Config truth, not RIB truth.** The table is parsed `running-config all`; the client has no
 *   `show ip route` static extraction, so no column here claims an installed or working route
 *   (#80 keeps itself to the config CRUD for exactly that reason). The scope note is printed above
 *   the table, and the empty state repeats it, because an empty table from this reader means "none
 *   this client can read" — `ip route vrf …`, `ipv6 route …` and distance-less `ip route` lines are
 *   invisible to it (client divergences 4/6).
 * - **Unread vs empty vs none.** While the read has not answered, the table region says unread; a
 *   failed read is an alert carrying the device's own text, never a blank panel; `rows: []` renders
 *   {@link EmptyState}, not a header-only table.
 * - **The guard states.** A default-route row and a row whose next hop the read table spells as a
 *   default-route next hop carry a visible flag, and the form prints the guard note with its honest
 *   limit ("this screen reads only the static-route table") before any session opens.
 * - Device text is never an HTML sink: staged lines and the device diff are text children, with the
 *   diff in a `<pre>` (`ConfigDiff` owns that element; the screen test pins `tagName === 'PRE'`).
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import type { DeviceIdentity } from '../../shared/identity'
import { READ_SCOPE_NOTE, ROUTE_ACTION_LABELS, ROUTE_ACTIONS } from './static-route-rules'
import type { RouteAction, RouteFields, RouteGuard, RouteRow } from './static-route-rules'

export interface StaticRouteRowView extends RouteRow {
  /** The container-computed `routeKey` of the read row (rules module); also the `<select>` value. */
  readonly routeKey: string
  /** The container-computed `routeLabel` of the same row — one line, built from read segments only. */
  readonly optionLabel: string
  /** Which hard guard this row's removal trips, if any — derived by the container from the read table. */
  readonly guard?: RouteGuard
}

export interface StaticRoutesViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: DeviceIdentity
  readonly rows: readonly StaticRouteRowView[]
  /** False while no read has answered — the table region must say unread, never look empty. */
  readonly tableKnown: boolean
  readonly fields: RouteFields
  readonly onFieldsChange: (fields: RouteFields) => void
  readonly onPreview: (event: FormEvent<HTMLFormElement>) => void
  readonly onReload: () => void
  /** The in-band acknowledgement: required before Preview whenever the selected removal is guarded. */
  readonly ack: boolean
  readonly onAckChange: (value: boolean) => void
  readonly ackRequired: boolean
  /** The guard note for the current selection (removal of a default or shared-gateway route). */
  readonly guardNote?: string
  readonly formError?: string
  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
}

const routeColumns: readonly DataTableColumn<StaticRouteRowView>[] = [
  {
    header: 'Destination',
    cell: (row) => <><code>{row.ipDest}</code>{row.guard?.kind === 'default-route' ? <span className="cell-note">default route</span> : null}</>,
  },
  {
    header: 'Next hop',
    cell: (row) => <><code>{row.nextHop}</code>{row.guard?.kind === 'shared-gateway' ? <span className="cell-note">shares the default route&#39;s next hop</span> : null}</>,
  },
  { header: 'Next-hop address', cell: (row) => row.nextHopIp === undefined ? <span className="cell-note">not in the line</span> : <code>{row.nextHopIp}</code> },
  { header: 'Distance', numeric: true, cell: (row) => String(row.distance) },
  { header: 'Tag', numeric: true, cell: (row) => row.tag === undefined ? <span className="cell-note">none</span> : String(row.tag) },
  { header: 'Name', cell: (row) => row.routeName === undefined ? <span className="cell-note">none</span> : <code>{row.routeName}</code> },
]

export function StaticRoutesView({
  state,
  readError,
  proxyPrompt,
  identity,
  rows,
  tableKnown,
  fields,
  onFieldsChange,
  onPreview,
  onReload,
  ack,
  onAckChange,
  ackRequired,
  guardNote,
  formError,
  busy,
  canAct,
  notice,
  failure,
  connection,
  connectionLabel,
}: StaticRoutesViewProps): ReactElement {
  const needsSelect = fields.action !== 'add-route'
  const usesAddFields = fields.action === 'add-route'
  const usesTagField = fields.action === 'add-route' || fields.action === 'set-tag'
  const usesNameField = fields.action === 'add-route' || fields.action === 'set-name'
  const selectable = rows.length > 0

  return <section className="workspace" aria-labelledby="static-routes-title">
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
        <p className="eyebrow">L3 CONFIG</p>
        <h2 id="static-routes-title">Static routes</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload static routes</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      Every guard here mirrors what <em>this client</em> refuses (<code>staticroute.ts</code>&#39;s own
      guards, <code>assertIpDest</code>/<code>assertNextHop</code>/<code>assertUnsignedSegment</code>/
      <code>assertRouteName</code>) plus the two removal guards issue #80 names; the mirrored reasons are
      labelled refusal-by-refusal in the copy, and anything this screen refuses on its own says so. The
      device keeps the final say: a write the client allowed but the CLI rejects arrives as the
      device&#39;s own <code>CommandError</code>, and a staged line changes running-config only when this
      session commits.
    </p>

    {state === 'loading' && <p className="notice" role="status" aria-busy="true">Reading the running-config (the static-route table is parsed config — there is no show-model for it in this client)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The static-route read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    <section className="panel" aria-labelledby="static-routes-table-title">
      <div className="panel-heading">
        <div><p className="eyebrow">RUNNING-CONFIG</p><h3 id="static-routes-table-title">Static routes this client can read</h3></div>
        <span className="panel-index">{tableKnown ? String(rows.length).padStart(2, '0') : 'unread'}</span>
      </div>
      <p className="current-state">{READ_SCOPE_NOTE}</p>
      {!tableKnown
        ? <p className="notice" role="status">{state === 'failed' ? 'The table is unread — the read failure is above, and nothing below is inferred from it.' : 'No read has answered yet.'}</p>
        : rows.length === 0
          ? <EmptyState heading="The running-config answered no ip route lines this client can read." hint="That is an empty read, not an empty device: ip route vrf …, ipv6 route …, and ip route lines without a distance are invisible to this client's grammar (staticroute.ts divergences 4/6). A route the client cannot read back is also a route it will not write from here." />
          : <DataTable columns={routeColumns} rows={rows} rowKey={(row) => row.routeKey} label="Static routes read from running-config" />}
    </section>

    <section className="panel" aria-labelledby="static-routes-form-title">
      <div className="panel-heading">
        <div><p className="eyebrow">NAMED SESSION</p><h3 id="static-routes-form-title">Stage a static-route change</h3></div>
        <span className="panel-index">01</span>
      </div>
      <p className="field-note">
        One command line per session, always: this screen stages a single <code>ip route</code>/<code>no ip
        route</code> line, so there is never a batched delete whose diff the operator has not enumerated.
        Preview opens the session and reads the device&#39;s own <code>diff()</code>; commit is a separate,
        deliberate action, and abort discards the staged line.
      </p>
      <p className="field-note">
        Forms this screen never stages, with the reason: the client also pins a <code>default ip route
        …</code> line, and upstream&#39;s own docstring calls it &#34;currently equivalent to&#34; the
        negation — an EOS behaviour no capture on either target has confirmed (M12 #14), so only the
        <code>no ip route …</code> form #80 names is offered. There is no tag- or name-clearing verb in
        this client, and no IPv6 grammar anywhere in <code>staticroute.ts</code>, so neither is offered
        here either.
      </p>

      <form onSubmit={onPreview}>
        <label htmlFor="sr-action">Action</label>
        <select
          id="sr-action"
          name="sr-action"
          value={fields.action}
          onChange={(event) => onFieldsChange({ ...fields, action: event.target.value as RouteAction })}
          disabled={!canAct || busy}
        >
          {ROUTE_ACTIONS.map((action) => <option key={action} value={action}>{ROUTE_ACTION_LABELS[action]}</option>)}
        </select>

        {needsSelect && <>
          <label htmlFor="sr-select">Route from the read table</label>
          <select id="sr-select" name="sr-select" value={fields.routeKey} onChange={(event) => onFieldsChange({ ...fields, routeKey: event.target.value })} disabled={!canAct || busy || !selectable}>
            {rows.map((row) => <option key={row.routeKey} value={row.routeKey}>{row.optionLabel}</option>)}
          </select>
          {!selectable && <p className="field-note">The select is empty because the read answered no readable routes (or it failed above) — a removal or a replacement is built from read segments, so nothing here can be typed by hand.</p>}
          {guardNote !== undefined && <>
            <p className="notice notice-warning" role="status"><strong>In-band guard:</strong> {guardNote}</p>
            <p id="sr-ack-help" className="field-note">This removal needs an explicit acknowledgement first: check the box to enable Preview, then review the device diff, then confirm the commit that repeats the exact <code>no ip route …</code> text.</p>
            <label className="field-note" htmlFor="sr-ack">
              <input
                id="sr-ack"
                name="sr-ack"
                type="checkbox"
                checked={ack}
                onChange={(event) => onAckChange(event.target.checked)}
                aria-describedby="sr-ack-help"
                disabled={!canAct || busy}
              />
              {' '}I have read the guard note above and accept that this route may carry the path this UI rides.
            </label>
          </>}
        </>}

        {usesAddFields && <>
          <label htmlFor="sr-prefix">Destination prefix (A.B.C.D/E)</label>
          <input
            id="sr-prefix"
            name="sr-prefix"
            value={fields.prefix}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onFieldsChange({ ...fields, prefix: event.target.value })}
            disabled={!canAct || busy}
          />
          <p className="field-note">The client&#39;s own shape: dotted quad, slash, prefix bits — the first group of the grammar it READs back (staticroute.py:69). Octet/bits bounds past 255/32 are refused here as IPv4 arithmetic (DR-032); an IPv6 or <code>vrf</code> spelling is refused because this client&#39;s <code>staticroute</code> module has no grammar for it at all, and that refusal is the client contract speaking.</p>

          <label htmlFor="sr-hop">Next hop on this switch</label>
          <input
            id="sr-hop"
            name="sr-hop"
            value={fields.nextHop}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onFieldsChange({ ...fields, nextHop: event.target.value })}
            disabled={!canAct || busy}
          />
          <p className="field-note">An interface name or an address, one token (staticroute.py:70). A colon-bearing IPv6 token is refused by this screen: the client&#39;s token guard would let it ride, but no <code>staticroute.ts</code> pin and no committed capture names an IPv6 next hop behind an IPv4 <code>ip route</code> line, and staging one would be guessing at the device contract. This form does not offer the optional next-hop-address segment #80&#39;s write list omits — rows that carry one are still removed and replaced with that segment restated.</p>

          <label htmlFor="sr-distance">Distance (required here)</label>
          <input
            id="sr-distance"
            name="sr-distance"
            value={fields.distance}
            spellCheck={false}
            autoComplete="off"
            inputMode="numeric"
            onChange={(event) => onFieldsChange({ ...fields, distance: event.target.value })}
            disabled={!canAct || busy}
          />
          <p className="field-note">The client&#39;s reader requires the <code>(\d+)</code> distance group, so a line without one can never be read back into this table (divergence 6) — the screen keeps the field required even though the client would compose the bare form. <code>0</code> is a value, and it composes.</p>
        </>}

        {usesTagField && <>
          <label htmlFor="sr-tag">Route tag (optional)</label>
          <input
            id="sr-tag"
            name="sr-tag"
            value={fields.tag}
            spellCheck={false}
            autoComplete="off"
            inputMode="numeric"
            onChange={(event) => onFieldsChange({ ...fields, tag: event.target.value })}
            disabled={!canAct || busy}
          />
          {fields.action === 'set-tag' && <p className="field-note">A replacement line restates every segment this client read (next hop, next-hop address, distance, name) and changes only the tag: the leaf line is replaced whole on the device, and the client&#39;s own <code>set_tag</code> warns that a field it is not given is reset. Refusing to restate would silently erase the name.</p>}
        </>}

        {usesNameField && <>
          <label htmlFor="sr-name">Route name (optional)</label>
          <input
            id="sr-name"
            name="sr-name"
            value={fields.routeName}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onFieldsChange({ ...fields, routeName: event.target.value })}
            disabled={!canAct || busy}
          />
          {fields.action === 'set-name' && <p className="field-note">A replacement line restates the tag this client read and changes only the name — the same whole-line reason as the tag field above. No verb in this client clears a name or a tag, so this screen offers no way to do it either.</p>}
        </>}

        {formError !== undefined && <p className="notice notice-error" role="alert">{formError}</p>}

        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={!canAct || busy || (ackRequired && !ack)}>Add to transaction</button>
        </div>
      </form>

    </section>

    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
  </section>
}
