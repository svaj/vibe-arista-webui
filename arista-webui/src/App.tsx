import { useEffect, useState } from 'react'
import { createAppNode } from './eapi/app-node'
import { fetchRelayStatus } from './eapi/relay'
import type { RelayStatus } from './eapi/relay'
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
import { StpGlobal } from './features/stp/StpGlobal'
import { Vrfs } from './features/vrfs/Vrfs'
import { Acls } from './features/acls/Acls'
import { StaticRoutes } from './features/routes/StaticRoutes'
import { Routing } from './features/routing/Routing'
import { TransactionCenter } from './features/sessions/TransactionCenter'
import { Users } from './features/users/Users'
import { VlanManagement } from './features/vlans/VlanManagement'
import { VlanAssignment } from './features/vlans/VlanAssignment'
import { Connect } from './features/connect/Connect'
import { TransactionProvider, useTransactionSnapshot } from './features/sessions/TransactionContext'
import type { RouteRegistry } from './router'

/** The only route registered so far; empty hashes redirect here and nav/deep links share the path. */
const HOME_PATH = '/vlans'

function App() {
  // #153: the node comes from `createAppNode` so the UI-path deadline (`UI_REQUEST_TIMEOUT_MS`)
  // is set in one pinned place instead of riding the client's 60 s library default unnoticed.
  // #140a: the env-proxy boot flag still creates it synchronously; the RUNTIME relay creates the
  // SAME node after the status probe proves the relay is live — one origin, one path, one deadline.
  const [node, setNode] = useState(() => __EAPI_PROXY_CONFIGURED__ ? createAppNode(window.location.origin) : undefined)
  const [relayStatus, setRelayStatus] = useState<RelayStatus>({ configured: __EAPI_PROXY_CONFIGURED__ ? 'env' : null })

  // Boot probe for the runtime relay (#140a), dev-without-env-vars only: `fetchRelayStatus` never
  // throws, so a static build, a dead endpoint, or a no-plugin server all keep the app in today's
  // honest not-configured state. When a relay IS installed on the dev server, this flips the whole
  // app into the same configured posture the env proxy has.
  useEffect(() => {
    if (__EAPI_PROXY_CONFIGURED__) return
    let active = true
    void fetchRelayStatus().then((status) => {
      if (!active || status.configured !== 'runtime') return
      setRelayStatus(status)
      setNode(createAppNode(window.location.origin))
    })
    return () => {
      active = false
    }
  }, [])

  const configured = __EAPI_PROXY_CONFIGURED__ || node !== undefined

  // The routed screens keep their own `{ node, proxyConfigured }` props byte-identical through the F6
  // split (#68): the registry element closes over the values App already owns, so one route needs no
  // context or render-prop layer — and each screen's fake-node test harness is unchanged by the move.
  // S1 (#71) registers `#/interfaces` first for nav prominence; the empty hash still homes on the VLAN
  // workflow until a later decision changes HOME_PATH.
  const routes: RouteRegistry = {
    '/interfaces': {
      title: 'Interfaces',
      element: <InterfacesDashboard node={node} proxyConfigured={configured} />,
    },
    // S3 (#73) owns `#/switches/manage`: the trunk/switch port editor. #126 wired the reachability
    // half: S1's rows carry `#/switches/manage?port=<name>` anchors and the editor seeds from the
    // parameter (`useHashParam`) — the registry itself still keys on the path alone.
    '/switches/manage': {
      title: 'Switch ports',
      element: <TrunkEditor node={node} proxyConfigured={configured} />,
    },
    // S5 (#75) owns `#/lags`: the Port-Channel / LAG manager. Membership reads the config relation
    // (DR-075); the device-status columns come only from the capture-backed `show port-channel dense`.
    '/lags': {
      title: 'Port-Channels',
      element: <LagManager node={node} proxyConfigured={configured} />,
    },
    // S6 (#76) owns `#/addressing`: routed ports and SVI addresses. Config truth is parsed
    // running-config; the separate device columns ride the JSON `show ip interface brief` captures
    // (#76's "never captured" note went stale — the correction is on the issue and in the screen copy).
    '/addressing': {
      title: 'IP addressing',
      element: <IpAddressing node={node} proxyConfigured={configured} />,
    },
    // S8 (#78) owns `#/system`: hostname, ip routing, EOF-terminated banners. Guards here mirror
    // the client's assert* rules and are labelled as client policy — the device keeps authority.
    '/system': {
      title: 'System settings',
      element: <SystemSettings node={node} proxyConfigured={configured} />,
    },
    // S11 (#81) owns `#/users`: local usernames, privilege, role and SSH keys. The highest
    // self-lockout surface in the wave, so every admin-affecting write is guarded from the parsed
    // read — and no AAA/TACACS+/RADIUS command is reachable from this screen at all.
    '/users': {
      title: 'Users & roles',
      element: <Users node={node} proxyConfigured={configured} />,
    },
    // S12 (#82) owns `#/ntp`: config-backed NTP servers/source, staged the standing named-session way.
    // Command text mirrors the frozen `node.ntp` verbs; the sync-status half stays hidden as
    // "not captured" until show ntp status/associations captures exist (#82's CAPTURES gate).
    '/ntp': {
      title: 'NTP',
      element: <Ntp node={node} proxyConfigured={configured} />,
    },
    // S16 (#90) owns `#/vrfs`: the VRF manager. #90's blocked premise (hardware unknowns) was
    // retired by the run-9 supervised probes — every batch this screen stages is one those captures
    // proved or one the frozen `node.vrfs` verbs compose verbatim (DR-141). Device columns ride the
    // capture-backed `show vrf` contract; membership is the parsed config `vrf` line.
    '/vrfs': {
      title: 'VRF manager',
      element: <Vrfs node={node} proxyConfigured={configured} />,
    },
    // S13 (#83) owns `#/acls`: the access-list viewer/editor over the parsed `ip access-list` sections.
    // Rules are shown as running-config text — no `show access-lists` capture exists, so no counter is
    // printed — and deleting a section is always destructive because no client read covers
    // `ip access-group`, i.e. the screen cannot see whether an interface still applies the ACL.
    '/acls': {
      title: 'ACLs',
      element: <Acls node={node} proxyConfigured={configured} />,
    },
    // S14 (#84) owns `#/mlag`: READ-ONLY MLAG status. The container's own seam is Pick<Node,
    // 'mlag' | 'show'> — it cannot even see a config session — and the screen ships no writes:
    // MLAG configuration needs a paired device (#84 closes editing; the banner says so).
    '/mlag': {
      title: 'MLAG',
      element: <Mlag node={node} proxyConfigured={configured} />,
    },
    // S15 (#85) owns `#/stp`: per-port bpduguard/portfast guard edits staged the named-session way,
    // plus a config-only STP summary and the capture-backed operational panel (#88 step 1). No
    // global-mode control renders here — that lives on `#/stp/global` below (the audit's #88
    // "Do Not Do": never fold global mode mutation into the per-port guard screen).
    '/stp': {
      title: 'Spanning tree',
      element: <Stp node={node} proxyConfigured={configured} />,
    },
    // B3 (#88) step 2 owns `#/stp/global`: the global mode editor (mstp/none/rapid-pvst, the last
    // with its container-only-acceptance disclosure) and the MST region editor DR-149 settled into
    // ONE editor. Stages through the shared transaction; the blast facts ride every confirm.
    '/stp/global': {
      title: 'Spanning-tree global',
      element: <StpGlobal node={node} proxyConfigured={configured} />,
    },
    // S9 (#79) owns `#/sessions`: the transaction center (view/abort/preview half; the durable
    // persistence/rollback half stays out of scope until #89's captures land).
    '/sessions': {
      title: 'Sessions',
      element: <TransactionCenter node={node} proxyConfigured={configured} />,
    },
    // S10 (#80) owns `#/routes/static`: the IPv4 static-route manager. Reads are the config-backed
    // `staticroute` table (no `show ip route` extraction exists in this client), and every write is
    // one staged line in a named session; the guard set is derived only from that same table.
    '/routes/static': {
      title: 'Static routes',
      element: <StaticRoutes node={node} proxyConfigured={configured} />,
    },
    // B2 (#87) owns `#/routing`: READ-ONLY routing status (OSPF / route maps / VRRP). The
    // container's seam is Pick<Node, 'ospf' | 'routemaps' | 'vrrp' | 'show'> — it cannot even see a
    // config session — and the screen ships no writes: #87 keeps every routing editor blocked
    // behind a per-protocol blast-radius review. BGP renders the recorded double negative, not data.
    '/routing': {
      title: 'Routing status',
      element: <Routing node={node} proxyConfigured={configured} />,
    },
    '/vlans/manage': {
      title: 'VLAN management',
      element: <VlanManagement node={node} proxyConfigured={configured} />,
    },
    // S4 (#74) owns `#/console`: the read-only command console. It contacts nothing at mount — the route
    // is registered so the nav can offer it, not so the app can warm anything up.
    '/console': {
      title: 'Command console',
      element: <CommandConsole node={node} proxyConfigured={configured} />,
    },
    // S7 (#77) owns `#/capabilities`: the operator-run capability probe panel. Mounting it opens no
    // config session — `probeTrigger: 'manual'` (#123) makes the confirmed button the only trigger.
    '/capabilities': {
      title: 'Capabilities',
      element: <CapabilityPanel node={node} proxyConfigured={configured} />,
    },
    [HOME_PATH]: {
      title: 'VLAN assignment',
      element: <VlanAssignment node={node} proxyConfigured={configured} />,
    },
    // #140a: the runtime-connect screen exists ONLY when the boot env-proxy is absent — with env
    // vars configured the relay is inert by policy, and a nav item that can only say "inactive"
    // would be exactly the false affordance the screens' honesty rules reject.
    ...(__EAPI_PROXY_CONFIGURED__ ? {} : {
      '/connect': {
        title: 'Connect',
        element: <Connect
          relayStatus={relayStatus}
          envConfigured={__EAPI_PROXY_CONFIGURED__}
          homePath={HOME_PATH}
          onConnected={(status) => { setRelayStatus(status); setNode(createAppNode(window.location.origin)) }}
          onDisconnected={() => { setNode(undefined); setRelayStatus({ configured: null }) }}
        />,
      },
    }),
  }

  // F6 (#68) removed the presentational `status` slot: the connection cluster and the identity chip
  // are the F3 `ConnectionHeader`, fed from the screen's own read state. The shell supplies chrome
  // once — skip link, brand topbar, nav, `#workspace` outlet — and never claims a connection the
  // device reads have not confirmed.
  return <TransactionProvider node={node}><RoutedShell routes={routes} /></TransactionProvider>
}

function RoutedShell({ routes }: { readonly routes: RouteRegistry }) {
  const transaction = useTransactionSnapshot()
  return <AppShell homePath={HOME_PATH} routes={routes} transaction={{ count: transaction.entries.length, status: transaction.status }} />
}

export default App
