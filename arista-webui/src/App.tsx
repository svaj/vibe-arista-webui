import { useState } from 'react'
import { createNode } from '@devhax-heavy-industries/arista-eapi'
import './App.css'
import { SwitchManager } from './features/SwitchManager'

function App() {
  const [node] = useState(() => __EAPI_PROXY_CONFIGURED__ ? createNode({
    kind: 'http',
    baseUrl: window.location.origin,
    path: '/command-api',
  }) : undefined)

  return <SwitchManager node={node} proxyConfigured={__EAPI_PROXY_CONFIGURED__} />
}

export default App
