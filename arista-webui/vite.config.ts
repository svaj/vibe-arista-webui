import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { Buffer } from 'node:buffer'
import { defineConfig, loadEnv } from 'vite'
import { eapiRelayPlugin } from './eapi-relay.js'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const server = command === 'serve'
  const proxy = server ? createEapiProxy(env) : undefined

  return {
    define: { __EAPI_PROXY_CONFIGURED__: JSON.stringify(proxy !== undefined) },
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      // #140a: runtime connect relay — always mounted in dev; inert (status `'env'`, no setup)
      // whenever the boot-time env proxy above is configured, so existing lanes are untouched.
      ...(server ? [eapiRelayPlugin({ envProxyConfigured: proxy !== undefined })] : []),
    ],
    ...(server ? {
      server: {
        host: '127.0.0.1',
        ...(proxy === undefined ? {} : { proxy: { '/command-api': proxy } }),
      },
    } : {}),
  }
})

function createEapiProxy(env: Record<string, string>): {
  target: string
  changeOrigin: true
  secure: false
  headers: { authorization: string }
} | undefined {
  const host = env['EAPI_HOST']
  const username = env['EAPI_USER']
  const password = env['EAPI_PASS']
  if (host === undefined && username === undefined && password === undefined) return undefined
  if (host === undefined || host.trim() === '' || username === undefined || username === '' || password === undefined || password === '') {
    throw new Error('Vite dev proxy needs EAPI_HOST, EAPI_USER, and EAPI_PASS together; no switch target is selected by default.')
  }

  const targetUrl = new URL(host.startsWith('https://') ? host : `https://${host}`)
  if (targetUrl.protocol !== 'https:' || targetUrl.username !== '' || targetUrl.password !== '' || targetUrl.pathname !== '/' || targetUrl.search !== '' || targetUrl.hash !== '') {
    throw new Error('EAPI_HOST must be an HTTPS host[:port] without credentials, path, query, or fragment.')
  }

  return {
    target: targetUrl.origin,
    changeOrigin: true,
    secure: false,
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` },
  }
}
