import { useState } from 'react'
import { createNode } from '@devhax-heavy-industries/arista-eapi'
import './App.css'
import { AppShell } from './components/AppShell'
import { InterfacesDashboard } from './features/interfaces/InterfacesDashboard'
import { TrunkEditor } from './features/interfaces/TrunkEditor'
import { CommandConsole } from './features/console/CommandConsole'
import { LagManager } from './features/lags/LagManager'
import { IpAddressing } from './features/addressing/IpAddressing'
import { CapabilityPanel } from './features/capabilities/CapabilityPanel'
import { Mlag } from './features/mlag/Mlag'
import { SystemSettings } from './features/system/SystemSettings'
import { Ntp } from './features/ntp/Ntp'
import { Stp } from './features/stp/Stp'
import { Vrfs } from './features/vrfs/Vrfs'
import { Acls } from './features/acls/Acls'
import { StaticRoutes } from './features/routes/StaticRoutes'
import { TransactionCenter } from './features/sessions/TransactionCenter'
import { Users } from './features/users/Users'
import { VlanManagement } from './features/vlans/VlanManagement'
import { VlanAssignment } from './features/vlans/VlanAssignment'
import type { RouteRegistry } from './router'

/** The only route registered so far; empty hashes redirect here and nav/deep links share the path. */
const HOME_PATH = '/vlans'

function App() {
  const [node] = useState(() => __EAPI_PROXY_CONFIGURED__ ? createNode({
    kind: 'http',
    baseUrl: window.location.origin,
    path: '/command-api',
  }) : undefined)

  // The routed screens keep their own `{ node, proxyConfigured }` props byte-identical through the F6
  // split (#68): the registry element closes over the values App already owns, so one route needs no
  // context or render-prop layer — and each screen's fake-node test harness is unchanged by the move.
  // S1 (#71) registers `#/interfaces` first for nav prominence; the empty hash still homes on the VLAN
  // workflow until a later decision changes HOME_PATH.
  const routes: RouteRegistry = {
    '/interfaces': {
      title: 'Interfaces',
      element: <InterfacesDashboard node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S3 (#73) owns `#/switches/manage`: the trunk/switch port editor. #126 wired the reachability
    // half: S1's rows carry `#/switches/manage?port=<name>` anchors and the editor seeds from the
    // parameter (`useHashParam`) — the registry itself still keys on the path alone.
    '/switches/manage': {
      title: 'Switch ports',
      element: <TrunkEditor node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S5 (#75) owns `#/lags`: the Port-Channel / LAG manager. Membership reads the config relation
    // (DR-075); the device-status columns come only from the capture-backed `show port-channel dense`.
    '/lags': {
      title: 'Port-Channels',
      element: <LagManager node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S6 (#76) owns `#/addressing`: routed ports and SVI addresses. Config truth is parsed
    // running-config; the separate device columns ride the JSON `show ip interface brief` captures
    // (#76's "never captured" note went stale — the correction is on the issue and in the screen copy).
    '/addressing': {
      title: 'IP addressing',
      element: <IpAddressing node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S8 (#78) owns `#/system`: hostname, ip routing, EOF-terminated banners. Guards here mirror
    // the client's assert* rules and are labelled as client policy — the device keeps authority.
    '/system': {
      title: 'System settings',
      element: <SystemSettings node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S11 (#81) owns `#/users`: local usernames, privilege, role and SSH keys. The highest
    // self-lockout surface in the wave, so every admin-affecting write is guarded from the parsed
    // read — and no AAA/TACACS+/RADIUS command is reachable from this screen at all.
    '/users': {
      title: 'Users & roles',
      element: <Users node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S12 (#82) owns `#/ntp`: config-backed NTP servers/source, staged the standing named-session way.
    // Command text mirrors the frozen `node.ntp` verbs; the sync-status half stays hidden as
    // "not captured" until show ntp status/associations captures exist (#82's CAPTURES gate).
    '/ntp': {
      title: 'NTP',
      element: <Ntp node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S16 (#90) owns `#/vrfs`: the VRF manager. #90's blocked premise (hardware unknowns) was
    // retired by the run-9 supervised probes — every batch this screen stages is one those captures
    // proved or one the frozen `node.vrfs` verbs compose verbatim (DR-141). Device columns ride the
    // capture-backed `show vrf` contract; membership is the parsed config `vrf` line.
    '/vrfs': {
      title: 'VRF manager',
      element: <Vrfs node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S13 (#83) owns `#/acls`: the access-list viewer/editor over the parsed `ip access-list` sections.
    // Rules are shown as running-config text — no `show access-lists` capture exists, so no counter is
    // printed — and deleting a section is always destructive because no client read covers
    // `ip access-group`, i.e. the screen cannot see whether an interface still applies the ACL.
    '/acls': {
      title: 'ACLs',
      element: <Acls node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S14 (#84) owns `#/mlag`: READ-ONLY MLAG status. The container's own seam is Pick<Node,
    // 'mlag' | 'show'> — it cannot even see a config session — and the screen ships no writes:
    // MLAG configuration needs a paired device (#84 closes editing; the banner says so).
    '/mlag': {
      title: 'MLAG',
      element: <Mlag node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S15 (#85) owns `#/stp`: per-port bpduguard/portfast guard edits staged the named-session way,
    // plus a config-only STP summary. `show spanning-tree` is uncaptured (operational state is
    // "not yet observable"), and no global-mode control renders — mode changes are blocked B3 (#88).
    '/stp': {
      title: 'Spanning tree',
      element: <Stp node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S9 (#79) owns `#/sessions`: the transaction center (view/abort/preview half; the durable
    // persistence/rollback half stays out of scope until #89's captures land).
    '/sessions': {
      title: 'Sessions',
      element: <TransactionCenter node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S10 (#80) owns `#/routes/static`: the IPv4 static-route manager. Reads are the config-backed
    // `staticroute` table (no `show ip route` extraction exists in this client), and every write is
    // one staged line in a named session; the guard set is derived only from that same table.
    '/routes/static': {
      title: 'Static routes',
      element: <StaticRoutes node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    '/vlans/manage': {
      title: 'VLAN management',
      element: <VlanManagement node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S4 (#74) owns `#/console`: the read-only command console. It contacts nothing at mount — the route
    // is registered so the nav can offer it, not so the app can warm anything up.
    '/console': {
      title: 'Command console',
      element: <CommandConsole node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    // S7 (#77) owns `#/capabilities`: the operator-run capability probe panel. Mounting it opens no
    // config session — `probeTrigger: 'manual'` (#123) makes the confirmed button the only trigger.
    '/capabilities': {
      title: 'Capabilities',
      element: <CapabilityPanel node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
    [HOME_PATH]: {
      title: 'VLAN assignment',
      element: <VlanAssignment node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
  }

  // F6 (#68) removed the presentational `status` slot: the connection cluster and the identity chip
  // are the F3 `ConnectionHeader`, fed from the screen's own read state. The shell supplies chrome
  // once — skip link, brand topbar, nav, `#workspace` outlet — and never claims a connection the
  // device reads have not confirmed.
  return <AppShell homePath={HOME_PATH} routes={routes} />
}

export default App
