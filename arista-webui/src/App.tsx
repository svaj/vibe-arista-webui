import { useState } from 'react'
import { createNode } from '@devhax-heavy-industries/arista-eapi'
import './App.css'
import { AppShell } from './components/AppShell'
import { InterfacesDashboard } from './features/interfaces/InterfacesDashboard'
import { TrunkEditor } from './features/interfaces/TrunkEditor'
import { CommandConsole } from './features/console/CommandConsole'
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
    // S3 (#73) owns `#/switches/manage`: the trunk/switch port editor. The per-port link from S1's
    // table that #73 also lists is NOT wired yet — see the WIP note in the branches and issue #73.
    '/switches/manage': {
      title: 'Switch ports',
      element: <TrunkEditor node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
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
