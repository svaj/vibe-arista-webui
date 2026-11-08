import { useState } from 'react'
import { createNode } from '@devhax-heavy-industries/arista-eapi'
import './App.css'
import { AppShell } from './components/AppShell'
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

  // The routed screen keeps its own `{ node, proxyConfigured }` props byte-identical through the F6
  // split (#68): the registry element closes over the values App already owns, so one route needs no
  // context or render-prop layer — and the screen's fake-node test harness is unchanged by the move.
  const routes: RouteRegistry = {
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
