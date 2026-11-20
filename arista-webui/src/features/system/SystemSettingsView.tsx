/**
 * S8 (#78): the presentation half of the system-settings screen. Pure props (matching
 * `CommandConsoleView.tsx`/`TrunkEditorView.tsx`); all device strings arrive as plain values.
 *
 * - Banner bodies render as `<pre>` text children — never HTML, never dangerouslySet
 *   (#78's "the banner body is never sent raw through an HTML sink" acceptance line; the same pin
 *   shape as S4's XSS case).
 * - IP routing reads as a `StatePill` token (text + colour, never colour alone).
 * - The draft panel mirrors the S2/S3/S6 review contract: staged batch, device `diff()`,
 *   commit gated on `canCommit`, abort always offered while the session is open.
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { StatePill } from '../../components/ui/StatePill'
import type { BannerKind } from './system-rules'

export interface BannerRowView {
  readonly kind: BannerKind
  readonly label: string
  /** False = the running-config has no `banner <kind>` block for this reader at all. */
  readonly present: boolean
  /** Present-and-empty is a real third state (divergence §5 row 87): `present: true, body: ''`. */
  readonly body?: string
  /** The operator's in-form text for this kind (`''` = untouched). */
  readonly draft: string
  readonly draftError?: string
  /** What the CURRENT config says, so the overwrite confirm can name the previous body. */
  readonly currentLabel: string
  onDraftChange: (value: string) => void
  onSet: (kind: BannerKind) => void
  onRemove: (kind: BannerKind) => void
}

export interface SystemSettingsViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }
  readonly hostname: string
  /** False while no system read has answered — the screen must not DISPLAY `''` as "unset". */
  readonly hostnameKnown: boolean
  readonly hostnameDraft: string
  readonly hostnameError?: string
  readonly onHostnameDraftChange: (value: string) => void
  readonly onSetHostname: (event: FormEvent<HTMLFormElement>) => void
  readonly onRemoveHostname: () => void
  readonly ipRouting: boolean
  /** False = the routing pill must say *unknown*, never a default claim (DR-032 style). */
  readonly routingKnown: boolean
  readonly onRouting: (enable: boolean) => void
  readonly banners: readonly BannerRowView[]
  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly onReload: () => void
}

export function SystemSettingsView({
  state,
  readError,
  proxyPrompt,
  identity,
  hostname,
  hostnameKnown,
  hostnameDraft,
  hostnameError,
  onHostnameDraftChange,
  onSetHostname,
  onRemoveHostname,
  ipRouting,
  routingKnown,
  onRouting,
  banners,
  busy,
  canAct,
  notice,
  failure,
  connection,
  connectionLabel,
  onReload,
}: SystemSettingsViewProps): ReactElement {
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
        <p className="eyebrow">GLOBAL CONFIG</p>
        <h2 id="workspace-title">System settings</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload device state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      Every guard on this screen mirrors what <em>this client</em> refuses (DR-057, §5 rows 83-90):
      those rules are client policy, <strong>unverified on hardware</strong>. The device keeps the
      final say — a write the client allowed but the CLI refuses comes back as the device&#39;s own
      <code>CommandError</code>, and a hostname this screen stages is only proven by the re-read
      after commit.
    </p>

    {state === 'loading' && <p className="notice" role="status">Reading the running-config (system settings come from parsed config, M8)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The system read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    {/* The panels always render — the states ride the KNOWN/UNKNOWN props (DR-032 honesty: an
        un-read field never displays as a value), and every control is gated on `canAct`, which is
        false for no-proxy, failed-read, and mid-busy alike. */}
    <>
      <section className="panel" aria-labelledby="system-hostname-title">
        <div className="panel-heading">
          <div><p className="eyebrow">IDENTITY</p><h3 id="system-hostname-title">Hostname</h3></div>
          <span className="panel-index">{!hostnameKnown ? 'unread' : hostname === '' ? 'unset' : 'set'}</span>
        </div>
        <p className="field-note">Current running-config hostname: <strong>{!hostnameKnown ? '(no system read has answered yet)' : hostname === '' ? '(none — the device section is absent, which this client reads as unset rather than pyeapi&#39;s invented &#39;localhost&#39;)' : hostname}</strong>. Changing it is not destructive, but it changes the identity chip in the header — the screen re-reads both after a commit.</p>
        <form onSubmit={onSetHostname}>
          <label htmlFor="system-hostname">New hostname (one token)</label>
          <input
            id="system-hostname"
            name="system-hostname"
            value={hostnameDraft}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onHostnameDraftChange(event.target.value)}
            disabled={!canAct || busy}
          />
          <div className="review-actions">
            <button className="primary-button" type="submit" disabled={!canAct || busy || hostnameDraft.trim() === ''}>Update hostname</button>
            <button className="danger-button" type="button" onClick={onRemoveHostname} disabled={!canAct || busy}>Remove hostname</button>
          </div>
        </form>
        {hostnameError !== undefined && <p className="notice notice-error" role="alert">{hostnameError}</p>}
      </section>

      <section className="panel" aria-labelledby="system-routing-title">
        <div className="panel-heading">
          <div><p className="eyebrow">FORWARDING</p><h3 id="system-routing-title">IP routing</h3></div>
          <span className="panel-index">{routingKnown ? <StatePill value={ipRouting ? 'enabled' : 'disabled'} /> : <StatePill value="unknown" />}</span>
        </div>
        <p className="field-note">
          <code>ip routing</code> is assumed ON when the parsed config carries neither the line nor
          its negation (upstream&#39;s default, kept per parity). Turning it OFF can drop routed reachability —
          and if the eAPI path rides a routed interface, the path this UI is riding with it. That
          write takes a hard confirm. What the <em>device</em> does around the toggle is uncaptured
          on this unit (M12 #14) — only its <code>diff()</code> is evidence here.
        </p>
        <div className="review-actions">
          <button className="primary-button" type="button" onClick={() => onRouting(true)} disabled={!canAct || busy}>Enable ip routing</button>
          <button className="danger-button" type="button" onClick={() => onRouting(false)} disabled={!canAct || busy}>Disable ip routing</button>
        </div>
      </section>

      {banners.map((banner) => <section key={banner.kind} className="panel" aria-labelledby={`system-banner-${banner.kind}-title`}>
        <div className="panel-heading">
          <div><p className="eyebrow">BANNER {banner.kind.toUpperCase()}</p><h3 id={`system-banner-${banner.kind}-title`}>{banner.label}</h3></div>
          <span className="panel-index">{banner.present ? (banner.body === '' ? 'empty' : 'set') : 'none'}</span>
        </div>
        <p className="field-note">Currently: {banner.currentLabel}</p>
        {banner.body !== undefined && <pre className="diff-output banner-body">{banner.body}</pre>}
        <label htmlFor={`system-banner-${banner.kind}`}>New {banner.kind} banner body (lines; never HTML)</label>
        <textarea
          id={`system-banner-${banner.kind}`}
          name={`system-banner-${banner.kind}`}
          className="probe-commands"
          rows={4}
          value={banner.draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => banner.onDraftChange(event.target.value)}
          disabled={!canAct || busy}
        />
        <p className="field-note">
          The client owns the terminator: the stored block is the body plus the <code>EOF</code>
          line (DR-015). A body line reading <code>EOF</code>, a carriage return, or an empty body
          is refused here before any session opens — mirroring <code>assertBannerBody</code>.
        </p>
        {banner.draftError !== undefined && <p className="notice notice-error" role="alert">{banner.draftError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="button" onClick={() => banner.onSet(banner.kind)} disabled={!canAct || busy || banner.draft.trim() === ''}>Set {banner.kind} banner</button>
          <button className="danger-button" type="button" onClick={() => banner.onRemove(banner.kind)} disabled={!canAct || busy || !banner.present}>Remove {banner.kind} banner</button>
        </div>
      </section>)}
    </>

    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
  </section>
}
