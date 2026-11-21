/**
 * `capture-unblock-grammar-ceos.mjs` — record the DEVICE ANSWERS for two grammar questions that
 * currently keep a shipped feature smaller than it needs to be, both answerable on the disposable
 * cEOS-lab container (single node, no blast):
 *
 *   1. #88 / `#/stp/global`: the MST region REMOVAL spelling. The add form is hardware-pinned
 *      (batch `unblock-stp-mst-region-grammar`), but `no instance …` was never captured, so the
 *      editor deliberately offers no mapping removal (docs/SPEC-stp-global-editor.md). Questions:
 *      the exact-spacing `no instance 1 vlan 100,110`, the bare `no instance 1`, `no name`, and
 *      `no revision` — each in its OWN named session, staged + diffed, then ABORTED (net-zero).
 *   2. #87 / `#/routing/ospf`: OSPF client divergence 10 — does the bare `no redistribute <proto>`
 *      the client always sends clear a route-map-QUALIFIED line? Plus divergence 4's underlying
 *      device fact: does the box normalize a bare `area 0` to the dotted-quad the reader can see?
 *      The redistribute half commits (then restores to net-zero); the area half is abort-only.
 *
 * Run through the harness (never against a device — the guards below refuse anything but the lab):
 *   npm run lab:run -- --quiet --no-fixtures -- node scripts/capture-unblock-grammar-ceos.mjs
 * (or scripts/capture-unblock-grammar-ceos.sh, which also steers the mgmt band and backstops teardown)
 *
 * Container evidence ONLY (DR-043): a cEOS answer is never a 7050TX-64 / 4.28.13.1M verdict.
 * Modeled on scripts/capture-unblock-ceos.mjs (same guards, cert-pinned runCmds, redaction).
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
  process.stderr.write(`capture-unblock-grammar: ${msg}\n`)
  process.exitCode = code
  throw new Error(msg)
}

if (env('EAPI_LIVE') !== '1') die(2, 'EAPI_LIVE!=1 — this child only runs under `npm run lab:run` (DR-034: live lanes are explicit opt-in)')
if (env('EAPI_TARGET_CLASS') !== 'lab') die(3, `EAPI_TARGET_CLASS=${JSON.stringify(env('EAPI_TARGET_CLASS'))} — grammar verbs run ONLY on the disposable lab class, never a device`)
const host = String(env('EAPI_HOST') ?? '')
if (!LOOPBACK.has(host)) die(3, `EAPI_HOST=${JSON.stringify(host)} is not loopback — the grammar child must never be pointed at a pre-existing switch`)
for (const key of ['EAPI_PORT', 'EAPI_USER', 'EAPI_PASS', 'EAPI_LAB_CERT', 'EAPI_LAB_CERT_FINGERPRINT']) {
  if (!env(key)) die(2, `missing harness env ${key} (only set under lab:run)`)
}

const port = Number(env('EAPI_PORT'))
const user = String(env('EAPI_USER'))
const secret = String(env('EAPI_PASS'))
const ca = (() => {
  const raw = String(env('EAPI_LAB_CERT'))
  return raw.includes('-----BEGIN') ? raw : fs.readFileSync(raw, 'utf8')
})()
const expectFp = String(env('EAPI_LAB_CERT_FINGERPRINT')).toUpperCase().replace(/:/g, '')

const OUT =
  env('EAPI_GRAMMAR_OUT') ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'evidence', 'unblock-grammar-ceos.json')

/** One `runCmds` JSON-RPC turn over TLS, cert-pinned. Returns {ok, result} or {ok:false, error, raw}. */
function runCmdsOnce(cmds, fmt = 'json') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', params: { version: 1, cmds, format: fmt }, id: 'unblock-grammar' })
    const req = https.request(
      {
        host,
        port,
        path: '/command-api',
        method: 'POST',
        ca,
        rejectUnauthorized: true,
        // loopback IP with a self-signed CN=self.signed cert: skip the hostname name-check but pin
        // the fingerprint ourselves (same triple capture-unblock-ceos.mjs uses).
        checkServerIdentity: () => undefined,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`,
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => {
          const raw = data.slice(0, 900)
          let parsed = null
          try {
            parsed = JSON.parse(data)
          } catch {
            /* non-JSON: raw is the whole answer */
          }
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
      },
    )
    req.on('socket', (sock) => {
      sock.on('secureConnect', () => {
        const cert = sock.getPeerCertificate?.()
        const fp = cert?.raw
          ? crypto.createHash('sha256').update(Buffer.from(cert.raw)).digest('hex').toUpperCase()
          : String(cert?.fingerprint256 ?? '')
              .toUpperCase()
              .replace(/:/g, '')
        if (fp !== expectFp) {
          req.destroy(new Error(`TLS fingerprint mismatch: peer ${fp} != expected ${expectFp}`))
        }
      })
    })
    // A stalled turn must surface as a failed capture, never hang the lane (run 3: the forwarder
    // flapped `close-before-client-got-bytes` and a request sat open until the harness SIGINTs).
    req.setTimeout(25_000, () => req.destroy(new Error('runCmds timeout after 25s')))
    req.on('error', (e) => reject(e))
    req.write(body)
    req.end()
  })
}

/** One turn, retried once on transport failure (the forwarder occasionally drops a connection). */
async function runCmds(cmds, fmt = 'json') {
  try {
    return await runCmdsOnce(cmds, fmt)
  } catch (e) {
    console.log(`[grammar] transport retry: ${String(e?.message ?? e)}`)
    return runCmdsOnce(cmds, fmt)
  }
}

/** Refuse-and-log wrapper: a failed read is recorded, never thrown (lane rule: reads are evidence). */
async function ask(question, cmds, fmt = 'json') {
  console.log(`[grammar] ask: ${question.slice(0, 90)}`)
  const response = await runCmds(cmds, fmt).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  const capture = { question, cmds, response }
  captures.push(capture)
  return response
}

/**
 * One named session: open, stage `staged`, read the session diff (TEXT — the diff is the answer),
 * then `commit` or `abort`. Every line above the question is a spelling the harness or a prior
 * capture already proved on this image; ONE new question per session, so a refusal cannot mask
 * the questions behind it (lane rule). Returns the diff text ('' when the read failed).
 */
async function session(question, name, staged, outcome) {
  console.log(`[grammar] session ${name}: ${question.slice(0, 90)} (${outcome})`)
  // The description rides the CLI line: keep it to plain words (the question text carries
  // backticks for our own reading; the device never needs to see them).
  const plain = question.replace(/[^\w ,.()/-]+/gu, '').slice(0, 60)
  const opener = ['enable', `configure session ${name} description "rea grammar: ${plain}"`]
  const open = await runCmds([...opener, ...staged]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  captures.push({ question: `${question} — staging turn`, cmds: [...opener, ...staged], response: open })
  const diff = await runCmds([...opener, 'show session-config diffs'], 'text').catch(() => ({ ok: false }))
  const diffText = diff?.ok ? String(diff.result?.at(-1)?.output ?? '') : ''
  captures.push({ question: `${question} — session diff`, cmds: ['show session-config diffs'], response: diff, diffText })
  const close = await runCmds([...opener, outcome]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  captures.push({ question: `${question} — ${outcome}`, cmds: [outcome], response: close })
  return { stagedOk: open.ok === true, openError: open.error, diffText, closeOk: close.ok === true }
}

function redactSecrets(text) {
  return String(text)
    .replace(/\bsecret\s+(?:sha512|md5)\s+\S+/giu, 'secret <redacted-lab-secret>')
    // DR-150: a running-config diff/scan is a credential surface wider than passwords — the whole
    // ssh-key line (including the key COMMENT, an operator identity) goes.
    .replace(/\busername\b[^\n]*\bssh-key\b[^\n]*/giu, 'username <redacted-ssh-key-line>')
    .replace(/-----BEGIN[A-Z ]*-----[\s\S]*?-----END[A-Z ]*-----/giu, '<redacted-lab-pem>')
    .replaceAll(user, '<lab-run-user>')
}

const captures = []
/** Verdict lines the console prints AND the artifact carries, so a claim is always re-derivable. */
const findings = []

// The provisioned single-node container (scripts/ceos-lab.mjs provisionStaging): vlans 10/100/110,
// `router ospf 1` with `network 10.0.100.0/24 area 0` + `network 10.0.110.0/24 area 0` (the device
// composed `area 0.0.0.0` per the 2026-11-18 note), `route-map RM-LAB-IMPORT permit 10`,
// spanning-tree mode mstp with NO region stanza. Baselines below re-prove that from the box itself.
async function main() {
  const identity = await runCmds(['enable', 'show version']).catch(() => ({ ok: false }))
  if (!identity?.ok) die(5, 'cannot read show version — refusing to run grammar questions blind')

  // Full running-config TEXT reads, sections derived locally — the `section <name>` filter with a
  // space in the name is not a spelling this repo has captured, and a malformed question is a
  // defect, not a device answer (lane rule).
  const ospfBaseline = await ask('baseline: full running-config (OSPF + spanning-tree derived locally)', ['enable', 'show running-config'], 'text')
  const ospfBaselineText = ospfBaseline?.ok ? String(ospfBaseline.result?.at(-1)?.output ?? '') : ''
  // Whatever spelling provisioning left (`area 0` or `area 0.0.0.0`) is what the negation line
  // must quote — derive it, never assume it.
  const provisionedArea = /network 10\.0\.110\.0\/24 area (\S+)/u.exec(ospfBaselineText)?.[1] ?? '0.0.0.0'
  findings.push({
    id: 'baseline-spanning-tree-region',
    hasRegionStanza: /spanning-tree mst configuration/u.test(ospfBaselineText),
    note: 'Expect false on the provisioned container — the MST sessions below then prove add+remove in-session, independent of running-config state.',
  })

  // ---- #88 MST region grammar (all ABORTED — the running-config never changes) ----
  const mstAdd = await session(
    'MST region add (hardware-pinned spelling, re-proved on cEOS as the diff baseline)',
    'rea-q0-mst-add',
    ['spanning-tree mst configuration', '   name LAB-UNBLOCK', '   revision 1', '   instance 1 vlan 100,110'],
    'abort',
  )
  const mstNoInstanceExact = await session(
    'MST region removal: `no instance 1 vlan 100,110` (exact spacing of the add line in the hardware diff)',
    'rea-q1-mst-noinst-quad',
    ['spanning-tree mst configuration', '   name LAB-UNBLOCK', '   revision 1', '   instance 1 vlan 100,110', '   no instance 1 vlan 100,110'],
    'abort',
  )
  const mstNoInstanceBare = await session(
    'MST region removal: bare `no instance 1`',
    'rea-q2-mst-noinst-bare',
    ['spanning-tree mst configuration', '   name LAB-UNBLOCK', '   revision 1', '   instance 1 vlan 100,110', '   no instance 1'],
    'abort',
  )
  const mstNoName = await session(
    'MST region field removal: `no name`',
    'rea-q3-mst-noname',
    ['spanning-tree mst configuration', '   name LAB-UNBLOCK', '   revision 1', '   no name'],
    'abort',
  )
  const mstNoRevision = await session(
    'MST region field removal: `no revision`',
    'rea-q4-mst-norevision',
    ['spanning-tree mst configuration', '   name LAB-UNBLOCK', '   revision 1', '   no revision'],
    'abort',
  )
  findings.push({
    id: 'mst-region-removal',
    addStaged: mstAdd.stagedOk,
    addDiffShowsInstanceLine: /\+ {3}instance 1 vlan\s+100,110/u.test(mstAdd.diffText),
    noInstanceQuadStaged: mstNoInstanceExact.stagedOk,
    noInstanceQuadDiff: mstNoInstanceExact.diffText,
    noInstanceBareStaged: mstNoInstanceBare.stagedOk,
    noInstanceBareDiff: mstNoInstanceBare.diffText,
    noNameStaged: mstNoName.stagedOk,
    noNameDiff: mstNoName.diffText,
    noRevisionStaged: mstNoRevision.stagedOk,
    noRevisionDiff: mstNoRevision.diffText,
    note: 'All sessions ABORTED. A diff that nets the instance line OUT (or shows add+remove cancelling to an empty diff) proves the removal spelling stages; the exact device-normalized spelling is the diff of the ADD session.',
  })

  // ---- #87 OSPF divergence 10: bare negation vs a qualified line (COMMIT + restore, net-zero) ----
  const rmName = 'RM-LAB-IMPORT'
  const add = await session(
    `OSPF: stage \`redistribute connected route-map ${rmName}\` on the provisioned process`,
    'rea-q5-ospf-redist-add',
    ['router ospf 1', `   redistribute connected route-map ${rmName}`],
    'commit',
  )
  const afterAdd = await ask(
    `running-config after the add commit (expect a redistribute connected route-map ${rmName} line)`,
    ['enable', 'show running-config'],
    'text',
  )
  const qualifiedCommitted = afterAdd?.ok && String(afterAdd.result?.at(-1)?.output ?? '').includes(`redistribute connected route-map ${rmName}`)
  const bareNegation = await session(
    'OSPF divergence 10: bare `no redistribute connected` over the committed qualified line — does the diff remove the QUALIFIED line?',
    'rea-q6-ospf-bare-negate',
    ['router ospf 1', '   no redistribute connected'],
    'commit',
  )
  const afterBare = await ask(
    'running-config after the bare negation (no redistribute connected line at all = the bare form DID clear the qualified line)',
    ['enable', 'show running-config'],
    'text',
  )
  const bareClearedQualified = afterBare?.ok && !String(afterBare.result?.at(-1)?.output ?? '').includes('redistribute connected')
  if (qualifiedCommitted && !bareClearedQualified) {
    // Net-zero was supposed to come from the bare negation; it did not. Remove the qualified line
    // explicitly so the container is left as provisioned, and record that the bare form left it.
    await session(
      'OSPF net-zero repair: explicit `no redistribute connected route-map RM-LAB-IMPORT`',
      'rea-q7-ospf-explicit-negate',
      ['router ospf 1', `   no redistribute connected route-map ${rmName}`],
      'commit',
    )
  }
  const finalOspf = await ask('final running-config (net-zero check: expect NO redistribute line)', ['enable', 'show running-config'], 'text')
  findings.push({
    id: 'ospf-divergence-10-bare-negation',
    addCommitted: add.stagedOk && add.closeOk,
    qualifiedLineCommitted: qualifiedCommitted,
    bareNegationStaged: bareNegation.stagedOk,
    bareNegationDiff: bareNegation.diffText,
    bareFormClearedQualifiedLine: bareClearedQualified,
    netZero: finalOspf?.ok && !String(finalOspf.result?.at(-1)?.output ?? '').includes('redistribute connected'),
    note: 'Divergence 10 (resources/ospf.ts): the client ALWAYS sends bare `no redistribute <proto>`. bareFormClearedQualifiedLine=true means the bare form clears a route-map-qualified line on this container; false means the qualified line SURVIVES the bare negation.',
  })

  // ---- #87 OSPF divergence 4: does the device normalize a bare `area 0`? (ABORTED) ----
  const areaZero = await session(
    `OSPF divergence 4: stage network 10.0.110.0/24 area 0 (provisioned as area ${provisionedArea}) — does the diff show a bare area 0 or the dotted-quad?`,
    'rea-q8-ospf-area-zero',
    ['router ospf 1', `   no network 10.0.110.0/24 area ${provisionedArea}`, '   network 10.0.110.0/24 area 0'],
    'abort',
  )
  findings.push({
    id: 'ospf-divergence-4-area-normalization',
    staged: areaZero.stagedOk,
    stageError: areaZero.openError,
    diff: areaZero.diffText,
    note: 'The provisioned section was composed by the device from `area 0` (see the ceos-lab.mjs note). This session removes the dotted-quad line and re-adds with a BARE `area 0` in one session: a diff netting to nothing means the device normalized bare 0 to 0.0.0.0 at stage time; a diff showing `area 0` means the two spellings are distinct config text — which is what makes the dotted-quad-only reader (divergence 4) visible. ABORTED either way.',
  })

  const doc = {
    kind: 'unblock-grammar-ceos-review-artifact',
    warning:
      'CONTAINER EVIDENCE ONLY — cEOS-lab 4.28.14M. NOT a 7050TX-64 / 4.28.13.1M verdict (DR-043). MST sessions all aborted; OSPF redistribute commits restored to net-zero (see findings.netZero).',
    generatedAt: new Date().toISOString(),
    containerIdentity: identity?.ok ? { version: identity.result?.[1]?.version, modelName: identity.result?.[1]?.modelName } : identity,
    findings,
    captures,
  }
  const rendered = redactSecrets(`${JSON.stringify(doc, null, 2)}\n`)
  // Pre-write scan (DR-150, the persistence-lane pattern): refuse to write an artifact that still
  // carries credential shapes — a full running-config was captured, so the surface is wide.
  const scan = /\$6\$|ssh-key|ssh-(?:ed25519|rsa)|AAAA[0-9A-Za-z+/]{40,}/u.exec(rendered)
  if (scan) {
    die(6, `artifact scan rejected a credential shape (${JSON.stringify(scan[0].slice(0, 12))}…) — refusing to write ${OUT}`)
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, rendered, 'utf8')

  for (const f of findings) {
    console.log(redactSecrets(`[grammar] ${f.id}: ${JSON.stringify(f, (k, v) => (k === 'note' ? undefined : v)).slice(0, 400)}`))
  }
  const sessionsLeft = await runCmds(['enable', 'show configuration sessions']).catch(() => undefined)
  const open = Object.entries(sessionsLeft?.result?.[1]?.sessions ?? {}).filter(([, s]) => /pending|active/iu.test(String(s?.state ?? '')))
  console.log(redactSecrets(`[grammar] open/pending sessions left: ${JSON.stringify(open.map(([n]) => n))}`))
  console.log(`[grammar] wrote ${OUT} (review, then transcribe the answers — container evidence only, DR-043)`)
  process.exitCode = 0
}

main().catch((e) => die(5, `transport failure: ${String(e?.message ?? e)}`))
