import { useState } from 'react'
import { createNode } from '@devhax-heavy-industries/arista-eapi'
import './App.css'
import { AppShell } from './components/AppShell'
import type { ConnectionStatus } from './components/AppShell'
import { SwitchManager } from './features/SwitchManager'
import type { RouteRegistry } from './router'

/** The only route registered so far; empty hashes redirect here and nav/deep links share the path. */
const HOME_PATH = '/vlans'

function App() {
  const [node] = useState(() => __EAPI_PROXY_CONFIGURED__ ? createNode({
    kind: 'http',
    baseUrl: window.location.origin,
    path: '/command-api',
  }) : undefined)

  // The routed screen keeps its own `{ node, proxyConfigured }` props byte-identical: the registry
  // element closes over the values App already owns, so one route needs no context or render-prop layer.
  const routes: RouteRegistry = {
    [HOME_PATH]: {
      title: 'VLAN assignment',
      element: <SwitchManager node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />,
    },
  }

  // Presentational only — AppShell must not contact the device. Issue #64 owns the live connection state.
  const status: ConnectionStatus = __EAPI_PROXY_CONFIGURED__
    ? { label: 'Reading through the local proxy', detail: '/command-api', tone: 'ok' }
    : { label: 'Local proxy is not configured', detail: 'Set EAPI_HOST and restart Vite.', tone: 'error' }

  return <AppShell homePath={HOME_PATH} routes={routes} status={status} />
}

export default App
