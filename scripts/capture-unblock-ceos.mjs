#!/usr/bin/env node
// @ts-check
/**
 * `capture-unblock-ceos.mjs` — record the DEVICE ANSWERS for the #89 (B4) persistence / rollback
 * verbs, on the DISPOSABLE cEOS-lab container. Run under the harness so it owns up→child→teardown:
 *
 *   npm run lab:run -- --quiet --no-fixtures -- node scripts/capture-unblock-ceos.mjs
 *
 * WHY cEOS and not the 7050TX-64: on the physical switch these verbs are mechanically refused by
 * the hardware probe lane (`HW_PROBE_FORBIDDEN`: `rollback` / `configure replace`; and
 * `assertNoPersistenceCommand`: `copy run start`, DR-035(c)). Even under the 2026-11-15 write
 * authorization, overwriting startup-config or replacing running-config is NOT a
 * "default-traffic-unaffected" change, so it does not belong on the live unit. A throwaway
 * container answers the *same* open-item-8 question — does 4.28 answer `1000`/`1002`/`1004` for these
 * verbs, or accept them — with zero blast radius. Container results are NOT a 7050TX verdict (DR-043):
 * the file lands as a review artifact, never as a committed `test/fixtures` recording, and the 7050TX
 * half of #89 stays an operator call.
 *
 * Trust model mirrors scripts/ceos-lab-eapi-child.mjs: it MUST be a `lab` target over loopback, it
 * pins the container cert fingerprint, and it never disables certificate validation. Exit codes:
 * 0 recorded (even if some verbs refused) · 2 bad env · 3 target-class/addressing refusal ·
 * 4 TLS pin mismatch · 5 transport failure.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
/** @param {string} k */
const env = (k) => process.env[k]
/** @returns {never} */
function die(code, msg) {
  process.stderr.write(`capture-unblock-ceos: ${msg}\n`)
  process.exitCode = code
  throw new Error(msg)
}

if (env('EAPI_LIVE') !== '1') die(2, 'EAPI_LIVE!=1 — this child only runs under `npm run lab:run` (DR-034: live lanes are explicit opt-in)')
if (env('EAPI_TARGET_CLASS') !== 'lab') die(3, `EAPI_TARGET_CLASS=${JSON.stringify(env('EAPI_TARGET_CLASS'))} — persistence verbs run ONLY on the disposable lab class, never a device`)
const host = String(env('EAPI_HOST') ?? '')
if (!LOOPBACK.has(host)) die(3, `EAPI_HOST=${JSON.stringify(host)} is not loopback — the persistence child must never be pointed at a pre-existing switch`)
for (const key of ['EAPI_PORT', 'EAPI_USER', 'EAPI_PASS', 'EAPI_LAB_CERT', 'EAPI_LAB_CERT_FINGERPRINT']) {
  if (!env(key)) die(2, `missing harness env ${key} (only set under lab:run)`)
}

const port = Number(env('EAPI_PORT'))
const user = String(env('EAPI_USER'))
const secret = String(env('EAPI_PASS'))
const ca = (() => {
  const raw = String(env('EAPI_LAB_CERT'))
  // The harness exports the leaf either as an inline PEM or a path; accept both.
  return raw.includes('-----BEGIN') ? raw : fs.readFileSync(raw, 'utf8')
})()
const expectFp = String(env('EAPI_LAB_CERT_FINGERPRINT')).toUpperCase().replace(/:/g, '')

const OUT = env('EAPI_UNBLOCK_OUT')
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'arista-api-client', 'docs', 'evidence', 'unblock-persistence.ceos.json')

/** One `runCmds` JSON-RPC turn over TLS, cert-pinned. Returns {ok, result} or {ok:false, error}. */
function runCmds(cmds, fmt = 'json') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', params: { version: 1, cmds, format: fmt }, id: 'unblock' })
    const req = https.request({
      host,
      port,
      path: '/command-api',
      method: 'POST',
      ca,
      rejectUnauthorized: true, // CA chain is always validated
      // loopback IP with a self-signed CN=self.signed cert: skip the hostname name-check but pin the
      // fingerprint ourselves (same triple the hardware lane resolves with EAPI_SERVER_NAME).
      checkServerIdentity: () => undefined,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`,
      },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        // Keep the RAW body (truncated) on every turn: the 2026-11-15 first artifact proved an
        // HTTP-200 answer that is neither a result array nor a JSON-RPC error ARRAY is possible on
        // EOS, and dropping the body in that case recorded `ok:true` next to zero evidence. raw is
        // the tie-breaker a human reads; parsed fields stay for machine diffing.
        const raw = data.slice(0, 900)
        let parsed = null
        try { parsed = JSON.parse(data) } catch { /* non-JSON: raw is the whole answer */ }
        const errObj = parsed?.error
        const errorText = Array.isArray(errObj)
          ? errObj?.[1] ?? errObj
          : errObj && typeof errObj === 'object'
            ? errObj.message ?? errObj
            : undefined
        resolve({
          ok: res.statusCode === 200 && errObj === undefined && parsed?.result !== undefined,
          status: res.statusCode,
          ...(parsed?.result === undefined ? {} : { result: parsed.result }),
          ...(errorText === undefined ? {} : { error: errorText }),
          raw,
        })
      })
    })
    // Pin: compare the peer cert sha256 to the fingerprint the harness read from the container.
    req.on('socket', (sock) => {
      sock.on('secureConnect', () => {
        const cert = sock.getPeerCertificate?.()
        const fp = cert?.raw
          ? crypto.createHash('sha256').update(Buffer.from(cert.raw)).digest('hex').toUpperCase()
          : String(cert?.fingerprint256 ?? '').toUpperCase().replace(/:/g, '')
        if (fp !== expectFp) {
          req.destroy(new Error(`TLS fingerprint mismatch: peer ${fp} != expected ${expectFp}`))
        }
      })
    })
    req.on('error', (e) => reject(e))
    req.write(body)
    req.end()
  })
}

/**
 * The verbs #89 needs, each in its OWN `enable`-framed turn so one refusal cannot mask the others.
 * `configure replace` points at a NON-EXISTENT file: a file-not-found error PROVES the verb exists
 * while guaranteeing no running-config is replaced; an unknown-command error is the opposite answer.
 */
const VERBS = [
  { verb: 'copy running-config startup-config', question: 'does 4.28 accept a save to startup-config and with what reply', cmds: ['enable', 'copy running-config startup-config'] },
  { verb: 'configure replace', question: 'command presence (file-not-found vs unknown-command), pointing at a deliberately absent file so nothing is replaced', cmds: ['enable', 'configure replace flash:/__unblock_absent__.cfg'] },
  { verb: 'rollback clean-config', question: 'answer for rollback clean-config (open item 8, DR-042 class)', cmds: ['enable', 'rollback clean-config'] },
]

/**
 * Reads the CAPTURE_CATALOG pass DROPS when cEOS refuses them (the fixture policy records negatives
 * only in the console, never a file) -- 2026-11-15 run: show-bgp / show-vxlan-interface /
 * show-vxlan-tunnel produced no fixture, so their error lines existed only in scrollback. Capturing
 * them here pins WHICH refusal each command gets, as text, in a committed-able artifact.
 */
const REFUSAL_READS = [
  // 2026-11-16 A-run pinned the semantics: bare `show bgp` = 1002 INCOMPLETE (token 1); the
  // sub-keyed spellings are GRAMMAR-FINE and answer 1000 "could not run command" with no BGP
  // instance/agent running. Pin both classes so the artifact never loses the distinction.
  { verb: 'show bgp summary (cEOS read)', cmds: ['enable', 'show bgp summary'], fmt: 'json' },
  { verb: 'show bgp neighbors (cEOS read)', cmds: ['enable', 'show bgp neighbors'], fmt: 'json' },
  { verb: 'show vxlan interface (cEOS read)', cmds: ['enable', 'show vxlan interface'], fmt: 'text' },
  { verb: 'show vxlan tunnel (cEOS read)', cmds: ['enable', 'show vxlan tunnel'], fmt: 'text' },
]

/**
 * Self-redaction. The recorder pipeline scrubs lab secrets for fixture writes; this child writes
 * its own artifact and BYPASSES it -- the 2026-11-16 `show startup-config (after)` capture rendered
 * the run user's full `secret sha512 $6$…` line. Same categories as the lab lane's rules:
 * secret material, PEM armour, and the ephemeral run username wherever it appears.
 */
function redactSecrets(text) {
  return String(text)
    .replace(/\bsecret\s+(?:sha512|md5)\s+\S+/giu, 'secret <redacted-lab-secret>')
    .replace(/-----BEGIN[A-Z ]*-----[\s\S]*?-----END[A-Z ]*-----/giu, '<redacted-lab-pem>')
    .replaceAll(user, '<lab-run-user>')
}

async function main() {
  const captures = []
  // A startup-config baseline before/after the copy is the persistence signal. Must be TEXT: this
  // image answers `show startup-config` over JSON with 1003 "set format=text" (captured 2026-11-16),
  // and on a never-saved container the text form answers "No such file" (1000, the DR-035(c) state) --
  // after a successful copy it must show the saved bytes. That flip is the persistence proof.
  const before = await runCmds(['enable', 'show startup-config'], 'text').catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  captures.push({ verb: 'show startup-config (before, text)', question: 'baseline in TEXT encoding (JSON gets 1003): expect "No such file" on a never-saved container', response: before })
  for (const v of VERBS) {
    const response = await runCmds(v.cmds).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
    captures.push({ verb: v.verb, question: v.question, response })
  }
  for (const v of REFUSAL_READS) {
    const response = await runCmds(v.cmds, v.fmt).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
    captures.push({ verb: v.verb, question: 'pin the exact cEOS refusal/answer (fixture policy drops refused reads; this artifact keeps the line)', response })
  }
  const after = await runCmds(['enable', 'show startup-config'], 'text').catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  captures.push({ verb: 'show startup-config (after, text)', question: 'after the copy: if the save landed, the text now renders saved bytes instead of the 1000', response: after })

  const identity = await runCmds(['enable', 'show version']).catch(() => ({ ok: false }))
  const doc = {
    kind: 'unblock-persistence-ceos-review-artifact',
    warning: 'CONTAINER EVIDENCE ONLY — cEOS-lab 4.28.14M. NOT a 7050TX-64 / 4.28.13.1M verdict (DR-043). Not committed under test/fixtures; move the answers into DECISIONS STATUS §3 by hand.',
    generatedAt: new Date().toISOString(),
    containerIdentity: identity?.ok ? { version: identity.result?.[1]?.version, modelName: identity.result?.[1]?.modelName } : identity,
    captures,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, redactSecrets(`${JSON.stringify(doc, null, 2)}\n`), 'utf8')
  for (const cap of captures) {
    const r = cap.response ?? {}
    const line = r.ok
      ? `ACCEPTED ${JSON.stringify(r.result?.slice?.(-1)?.[0] ?? r.result ?? null).slice(0, 160)}`
      : `NOT ACCEPTED (HTTP ${String(r.status)}) ${JSON.stringify(r.error ?? r.raw ?? r).slice(0, 220)}`
    console.log(redactSecrets(`[unblock-ceos] ${cap.verb}: ${line}`))
  }
  console.log(`[unblock-ceos] wrote ${OUT} (review, then transcribe the answers into DECISIONS/STATUS §3 — this is container evidence only)`)
  process.exitCode = 0
}

main().catch((e) => die(5, `transport failure: ${String(e?.message ?? e)}`))
