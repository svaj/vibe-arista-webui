/**
 * `capture-session-grammar-ceos.mjs` — record the DEVICE ANSWERS for the DR-147 session-grammar
 * families that the hardware lane refuses to ask BY DESIGN (#89 item 7/8, DECISIONS open items 7/8,
 * STATUS §3): on the 7050TX-64 the one-scratch-port licence never covers an adversarially-named or
 * adversarially-described COMMIT, and the hardware probe lane refuses a raw config opener — so the
 * name-length boundary, the name-charset boundary, the description quote-depth family, and `no-commit`
 * acceptance have never been asked of any target. The disposable cEOS-lab container is exactly the
 * target DR-147's two skipped discovery stubs named ("a transport-level opener under operator consent
 * on a cleared host — the harness container is one"), and this lane IS that transport-level opener:
 * it speaks raw `runCmds` lines, bypassing this client's own `assertSessionName`/`quoteDescription`
 * bounds on purpose, because the whole question is where the DEVICE's bounds sit, not ours.
 *
 * Families (one question per named session; NOTHING commits — every session aborts, so
 * running-config is net-zero by construction and no completed-session name slot is ever parked):
 *   A. name-length boundary: raw `configure session <name>` at a length ladder past the client's 64,
 *      then a bisection between the last accepted and first refused length. Each accepted opener is
 *      aborted in the same probe (maxOpenSessions is 5 — never leave more than one probe session open).
 *   B. name-charset boundary: for each byte the client refuses (space, `"`, `'`, `\`, backtick, `#`,
 *      `;`, tab, newline), a raw opener with the byte at the END of the name — injection-shaped bytes
 *      sit last so a parser that terminates the command there can only open the truncated prefix,
 *      which the end-of-run sweep (abort every `sg-*` session) still owns.
 *   C. description quote depth: the hardware run-2 answer covered plain free text; the embedded `"`,
 *      escaped `\"`, `#`, `;`, backslash, backtick, and `'` depths stay uncaptured on both targets.
 *      Each rides its OWN session opener as raw CLI text (NOT this client's quoteDescription — the
 *      device's own parser is the question), read back from `show configuration sessions detail`.
 *   D. `no-commit`: the client's hidden-node opener (`ConfigSessionOptions.noCommit`) assumes the
 *      device disallows committing such a session (SessionCli.py:295-311 image note, never captured).
 *      Ask: does the opener ACCEPT, does the session list, does an in-session `commit` refuse, and
 *      with what message. ABORTED either way.
 *   E. bare `show session-config` (no `diffs`): the STATUS §3 "still missing" read shape, asked
 *      inside one ordinary named session.
 *
 * Run through the harness (never against a device — the guards below refuse anything but the lab):
 *   npm run lab:run -- --quiet --no-fixtures -- node scripts/capture-session-grammar-ceos.mjs
 * (or scripts/capture-session-grammar-ceos.sh, which also steers the mgmt band and backstops teardown)
 *
 * Container evidence ONLY (DR-043): a cEOS answer is never a 7050TX-64 / 4.28.13.1M verdict — the
 * hardware halves of every family here stay open device questions after this run.
 * Modeled on scripts/capture-unblock-grammar-ceos.mjs (same guards, cert-pinned runCmds, DR-150
 * redaction + pre-write scan).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
/** @param {string} k */
const env = (k) => process.env[k]
/** @returns {never} */
function die(code, msg) {
  process.stderr.write(`capture-session-grammar: ${msg}\n`)
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
  env('EAPI_SESSION_GRAMMAR_OUT') ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'evidence', 'session-grammar.ceos.json')

/** One `runCmds` JSON-RPC turn over TLS, cert-pinned. Returns {ok, result} or {ok:false, error, raw}. */
function runCmdsOnce(cmds, fmt = 'json') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', params: { version: 1, cmds, format: fmt }, id: 'session-grammar' })
    const req = https.request(
      {
        host,
        port,
        path: '/command-api',
        method: 'POST',
        ca,
        rejectUnauthorized: true,
        // loopback IP with a self-signed CN=self.signed cert: skip the hostname name-check but pin
        // the fingerprint ourselves (same triple capture-unblock-grammar-ceos.mjs uses).
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
    // A stalled turn must surface as a failed capture, never hang the lane (the forwarder occasionally
    // flaps; the grammar lane's 25s bound is proven).
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
    console.log(`[sess-grammar] transport retry: ${String(e?.message ?? e)}`)
    return runCmdsOnce(cmds, fmt)
  }
}

const captures = []
/** Verdict lines the console prints AND the artifact carries, so a claim is always re-derivable. */
const findings = []

/** Refuse-and-log wrapper: a failed read is recorded, never thrown (lane rule: reads are evidence). */
async function ask(question, cmds, fmt = 'json') {
  console.log(`[sess-grammar] ask: ${question.slice(0, 90)}`)
  const response = await runCmds(cmds, fmt).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  captures.push({ question, cmds, response })
  return response
}

const errorText = (r) => (r?.error === undefined ? undefined : typeof r.error === 'string' ? r.error.slice(0, 300) : JSON.stringify(r.error).slice(0, 300))

/**
 * Family A/B primitive: fire a RAW `configure session <name>` opener (no client validation — that is
 * the point), record accept/refuse verbatim, and abort the session if it opened. The name is echoed
 * by length + JSON form only in findings (a charset probe name can carry control bytes; the artifact
 * keeps the JSON-escaped form, never a raw newline).
 */
async function probeOpener(question, name, extra = '') {
  const line = `configure session ${name}${extra}`
  const open = await runCmds(['enable', line]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  captures.push({ question, cmds: ['enable', line], response: open })
  let aborted = null
  if (open.ok) {
    // The opener succeeded, so a pending session now exists under SOME name (a charset byte may have
    // truncated it — the end-of-run sweep is the backstop). Abort by the name we asked for.
    aborted = await runCmds(['enable', `configure session ${name} abort`]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
    captures.push({ question: `${question} — abort`, cmds: ['enable', `configure session ${name} abort`], response: aborted })
  }
  // errorRaw carries the JSON-RPC error head verbatim: run 1 showed the wrapper text ("could not run
  // command") is generic and the device's own refusal class sits one level deeper in the reply.
  return {
    accepted: open.ok === true,
    error: errorText(open),
    errorRaw: open.raw === undefined ? undefined : String(open.raw).slice(0, 400),
    abortRecorded: aborted !== null && aborted.ok === true,
  }
}

/**
 * Deep-walk a capture/findings tree and redact every string BEFORE JSON.stringify. Run 1 of this
 * lane proved why post-render redaction is unsafe here: the family-E bare `show session-config`
 * dump carries the lab `username … secret sha512 …` line, and a post-render `\S+` redaction ate the
 * string's closing `\"` escape and produced invalid JSON. Redacting the JS strings first means
 * JSON.stringify owns all escaping and a redaction can never corrupt the document; the post-render
 * pass stays as a scan-only backstop (findings/captures are built from device replies, so the
 * surface is wide — DR-150).
 */
function deepRedact(node) {
  if (typeof node === 'string') return redactSecrets(node)
  if (Array.isArray(node)) return node.map(deepRedact)
  if (node !== null && typeof node === 'object') {
    const out = {}
    // KEYS are redacted too: the family-E `show session-config` reply is JSON whose `cmds` map keys
    // each line by its whole command text — the lab `username … secret sha512 $6$…` line is a KEY
    // there, not a value (the fixtures' redactionApplied note, observed 2026-11-06). Run 3 of this
    // lane proved the pre-write scan catches it; this makes the redactor catch it first.
    for (const [k, v] of Object.entries(node)) out[redactSecrets(k)] = deepRedact(v)
    return out
  }
  return node
}

function redactSecrets(text) {
  return String(text)
    .replace(/\bsecret\s+(?:sha512|md5)\s+\S+/giu, 'secret <redacted-lab-secret>')
    // DR-150: a config/session dump is a credential surface wider than passwords — the whole
    // ssh-key line (including the key COMMENT, an operator identity) goes.
    .replace(/\busername\b[^\n]*\bssh-key\b[^\n]*/giu, 'username <redacted-ssh-key-line>')
    .replace(/-----BEGIN[A-Z ]*-----[\s\S]*?-----END[A-Z ]*-----/giu, '<redacted-lab-pem>')
    .replaceAll(user, '<lab-run-user>')
}

// The provisioned single-node container (scripts/ceos-lab.mjs provisionStaging). This lane never
// touches the provisioned config: every session it opens is aborted, so running-config is net-zero
// by construction and the completed-session slot (maxSavedSessions: 1) is never parked.
async function main() {
  const identity = await runCmds(['enable', 'show version']).catch(() => ({ ok: false }))
  if (!identity?.ok) die(5, 'cannot read show version — refusing to run grammar questions blind')

  const sessionsJson = async (question) => {
    const r = await ask(question, ['enable', 'show configuration sessions detail'])
    // runCmds replies are ARRAY-parallel to cmds (the `enable` gets its own item) — run 1 read
    // result.sessions and saw nothing, which silently voided every listing read in that run.
    return r?.ok ? (r.result?.[1]?.sessions ?? {}) : {}
  }
  const before = await sessionsJson('baseline: sessions before the run (expect lab-pending-capture + lab-provision)')
  findings.push({ id: 'sessions-before', names: Object.keys(before) })

  // ---- Family A: name-length boundary (raw openers, every accepted one aborted in-probe) ----
  // The client's own cap is 64 (MAX_SESSION_NAME_LENGTH); the device limit is the question. Names are
  // `sg-len-<len>-<pad x>` so every candidate is unique, safe-charset, and sweep-ownable.
  // 2026-11-21 run 1: the container accepted every name through 2048, so the ladder now reaches 8192 —
  // "no boundary found up to N" is itself the recorded answer.
  const ladder = [64, 65, 96, 128, 256, 512, 1024, 2048, 4096, 8192]
  const nameLen = []
  for (const len of ladder) {
    const stem = `sg-len-${String(len)}-`
    const name = `${stem}${'x'.repeat(Math.max(0, len - stem.length))}`.slice(0, len)
    const r = await probeOpener(`A: raw opener, name length ${String(len)}`, name)
    nameLen.push({ len, accepted: r.accepted, error: r.error, errorRaw: r.errorRaw, abortRecorded: r.abortRecorded })
    console.log(`[sess-grammar] A len=${String(len)} accepted=${String(r.accepted)}${r.error ? ` err=${r.error.slice(0, 90)}` : ''}`)
    if (!r.accepted) break // no point asking longer names once one refused; the bisection refines below.
  }
  // Bisection between the longest accepted and the first refused (only if the ladder found a boundary).
  let bisected = []
  const refusedAt = nameLen.find((x) => !x.accepted)
  const acceptedLens = nameLen.filter((x) => x.accepted).map((x) => x.len)
  if (refusedAt !== undefined && acceptedLens.length > 0) {
    let lo = Math.max(...acceptedLens)
    let hi = refusedAt.len
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      const stem = `sg-bis-${String(mid)}-`
      const name = `${stem}${'y'.repeat(Math.max(0, mid - stem.length))}`.slice(0, mid)
      const r = await probeOpener(`A: bisection opener, length ${String(mid)}`, name)
      bisected.push({ len: mid, accepted: r.accepted, error: r.error })
      if (r.accepted) lo = mid
      else hi = mid
    }
  }
  const longestAccepted = Math.max(...acceptedLens, ...bisected.filter((x) => x.accepted).map((x) => x.len), 0)
  findings.push({
    id: 'name-length-boundary',
    clientMax: 64,
    ladder: nameLen,
    bisection: bisected,
    deviceMaxAccepted:
      acceptedLens.length === 0
        ? 'unknown — even the 64-char ladder entry refused'
        : refusedAt === undefined
          ? `>= ${String(ladder.at(-1))} (ladder never refused)`
          : String(longestAccepted),
    note: 'Raw `configure session <name>` openers, aborted in-probe, nothing committed. deviceMaxAccepted is the LONGEST name this container opened; the client bound (64) is this port\'s, not the device\'s.',
  })

  // ---- Family B: name-charset boundary (byte at the END of the name; sweep is the backstop) ----
  const charsetProbes = [
    { id: 'space', char: ' ', note: 'whitespace splits the CLI token — expect a parse answer, not a charset one' },
    { id: 'dquote', char: '"', note: 'quote: can open a quoted token after the name' },
    { id: 'squote', char: "'", note: 'single quote' },
    { id: 'backslash', char: '\\', note: 'escape byte' },
    { id: 'backtick', char: '`', note: 'shell-history byte at the CLI layer' },
    { id: 'hash', char: '#', note: 'comment byte: may swallow the rest of the line' },
    { id: 'semicolon', char: ';', note: 'command terminator: may open the TRUNCATED prefix name — sweep owns it' },
    { id: 'tab', char: '\t', note: 'control byte (whitespace class)' },
    { id: 'newline', char: '\n', note: 'control byte: would end the command line — nothing is placed after it' },
  ]
  const charset = []
  for (const p of charsetProbes) {
    const name = `sg-c-${p.id}${p.char}`
    const r = await probeOpener(`B: raw opener, charset byte ${p.id}`, name)
    charset.push({ id: p.id, charJson: JSON.stringify(p.char), note: p.note, accepted: r.accepted, error: r.error, errorRaw: r.errorRaw, abortRecorded: r.abortRecorded })
    console.log(`[sess-grammar] B ${p.id} accepted=${String(r.accepted)}${r.error ? ` err=${r.error.slice(0, 90)}` : ''}`)
  }
  findings.push({
    id: 'name-charset-boundary',
    probes: charset,
    note: 'Each byte sits at the END of an otherwise-safe name so an injection-capable parser can only ever open the truncated `sg-c-<id>` prefix (never a crafted second command). The end-of-run sweep aborts every sg-* session, so a truncated open is still owned by this run. Compare against UNSAFE_SESSION_NAME in src/config-session.ts (this port\'s refusals).',
  })

  // ---- Family C: description quote depth (raw CLI text, NOT quoteDescription) ----
  // Hardware run 2 round-tripped plain free text; the embedded depths below are the open family.
  // Each description rides its own session opener; the stored value is read back from
  // `show configuration sessions detail` BEFORE the abort (pending entries carry `description`).
  const descProbes = [
    { id: 'c0-plain', raw: '"plain round-trip baseline"', note: 'the hardware run-2 class, re-asked on the container as the comparison arm' },
    { id: 'c1-embedded', raw: '"embedded "quoted" words"', note: 'bare embedded double quotes mid-string' },
    { id: 'c2-escaped', raw: '"escaped \\"quote\\" inner"', note: 'backslash-escaped quotes — the shape this client\'s quoteDescription() emits' },
    { id: 'c3-hash', raw: '"hash # comment byte"', note: 'comment byte inside a quoted token' },
    { id: 'c4-semi', raw: '"semi ; terminator byte"', note: 'command-terminator byte inside a quoted token' },
    { id: 'c5-backslash', raw: '"back \\\\ slash pair"', note: 'escaped backslash pair' },
    { id: 'c6-backtick', raw: '"backtick ` byte"', note: 'backtick inside a quoted token' },
    { id: 'c7-squote', raw: '"apostrophe \' single"', note: 'single quote inside a double-quoted token' },
  ]
  const descs = []
  for (const p of descProbes) {
    const name = `sg-${p.id}`
    const line = `configure session ${name} description ${p.raw}`
    const open = await runCmds(['enable', line]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
    captures.push({ question: `C: description probe ${p.id}`, cmds: ['enable', line], response: open })
    let stored
    let storedFrom
    if (open.ok) {
      const listing = await sessionsJson(`C: sessions detail while ${p.id} is open`)
      const entry = listing[name]
      if (entry !== undefined) {
        stored = entry.description
        storedFrom = 'detail'
      } else {
        // Fall back to the plain form (the fixtures show `description` on both listing forms).
        const plain = await ask(`C: plain sessions listing fallback for ${p.id}`, ['enable', 'show configuration sessions'])
        const pe = plain?.ok ? (plain.result?.[1]?.sessions ?? {})[name] : undefined
        if (pe !== undefined) {
          stored = pe.description
          storedFrom = 'plain'
        }
      }
      const ab = await runCmds(['enable', `configure session ${name} abort`]).catch(() => ({ ok: false }))
      captures.push({ question: `C: abort ${p.id}`, cmds: ['enable', `configure session ${name} abort`], response: ab })
    }
    descs.push({ id: p.id, rawCliText: p.raw, note: p.note, openerAccepted: open.ok === true, error: errorText(open), storedDescription: stored, storedFrom })
    console.log(`[sess-grammar] C ${p.id} accepted=${String(open.ok)} stored=${stored === undefined ? '<none>' : JSON.stringify(stored).slice(0, 80)}`)
  }
  findings.push({
    id: 'description-quote-depth',
    probes: descs,
    note: 'Raw CLI description text (the device parser is the question, not this client\'s quoteDescription). storedDescription is what the device kept, read from the session listing while the session was still pending. Compare against quoteDescription()/assertDescriptionText in src/config-session.ts.',
  })

  // ---- Family D: `no-commit` (client's hidden-node opener; commit attempt is the question) ----
  const ncName = 'sg-nocommit-1'
  const ncOpen = await runCmds(['enable', `configure session ${ncName} no-commit description "sg no-commit probe"`]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  captures.push({ question: 'D: no-commit opener', cmds: ['enable', `configure session ${ncName} no-commit description "sg no-commit probe"`], response: ncOpen })
  let ncListing
  let ncDiff = ''
  let ncCommit = { accepted: null, error: 'opener refused — commit never asked' }
  if (ncOpen.ok) {
    const listing = await sessionsJson('D: sessions detail while no-commit session is open')
    ncListing = listing[ncName]
    const diff = await runCmds(['enable', `configure session ${ncName}`, 'vlan 150', '   name LAB-SG-NC', 'show session-config diffs'], 'text').catch(() => ({ ok: false }))
    captures.push({ question: 'D: stage + diff inside no-commit session', cmds: ['enable', `configure session ${ncName}`, 'vlan 150', '   name LAB-SG-NC', 'show session-config diffs'], response: diff })
    ncDiff = diff?.ok ? String(diff.result?.at(-1)?.output ?? '') : ''
    ncCommit = await runCmds(['enable', `configure session ${ncName}`, 'commit'])
      .then((r) => ({ accepted: r.ok === true, error: errorText(r), errorRaw: r.raw === undefined ? undefined : String(r.raw).slice(0, 400) }))
      .catch((e) => ({ accepted: false, error: String(e?.message ?? e) }))
    captures.push({ question: 'D: in-session commit attempt on no-commit session', cmds: ['enable', `configure session ${ncName}`, 'commit'], response: ncCommit })
    // Cleanup: if the commit somehow ACCEPTED, the name parked in the completed slot and there is a
    // vlan 150 to remove; if it refused (the expected answer), abort discards the staged vlan.
    if (ncCommit.accepted) {
      const undo = await runCmds(['enable', 'configure session sg-nocommit-undo', 'no vlan 150', 'commit']).catch(() => ({ ok: false }))
      captures.push({ question: 'D: net-zero undo after an ACCEPTED no-commit commit', cmds: ['enable', 'configure session sg-nocommit-undo', 'no vlan 150', 'commit'], response: undo })
    }
    const ab = await runCmds(['enable', `configure session ${ncName} abort`]).catch(() => ({ ok: false }))
    captures.push({ question: `D: abort ${ncName}`, cmds: ['enable', `configure session ${ncName} abort`], response: ab })
  }
  findings.push({
    id: 'no-commit-opener',
    openerAccepted: ncOpen.ok === true,
    openerError: errorText(ncOpen),
    listedState: ncListing?.state,
    listedDescription: ncListing?.description,
    stagedDiffText: ncDiff,
    commitAttempt: ncCommit,
    note: 'The client (ConfigSessionOptions.noCommit, config-session.ts) refuses commit() LOCALLY for a no-commit session on the strength of the SessionCli.py:295-311 image note. commitAttempt.error is the DEVICE answer that note predicts. If the commit was accepted, the staged vlan 150 was removed by a follow-up session (net-zero undo recorded in captures).',
  })

  // ---- Family E: bare `show session-config` (no `diffs`) inside an ordinary named session ----
  const bareName = 'sg-bare-read-1'
  const bare = await runCmds(['enable', `configure session ${bareName}`, 'vlan 151', '   name LAB-SG-BARE', 'show session-config']).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  captures.push({ question: 'E: bare show session-config inside a named session', cmds: ['enable', `configure session ${bareName}`, 'vlan 151', '   name LAB-SG-BARE', 'show session-config'], response: bare })
  const bareAbort = await runCmds(['enable', `configure session ${bareName} abort`]).catch(() => ({ ok: false }))
  captures.push({ question: `E: abort ${bareName}`, cmds: ['enable', `configure session ${bareName} abort`], response: bareAbort })
  findings.push({
    id: 'bare-show-session-config',
    accepted: bare.ok === true,
    error: errorText(bare),
    resultShape: bare.ok ? Object.keys(bare.result?.at?.(-1) ?? bare.result ?? {}) : undefined,
    outputHead: bare.ok ? String(bare.result?.at(-1)?.output ?? JSON.stringify(bare.result?.at(-1) ?? bare.result)).slice(0, 400) : undefined,
    aborted: bareAbort?.ok === true,
    note: 'STATUS §3: the bare form (without `diffs`) is the read shape still missing on both targets. Staged vlan 151 was ABORTED with the session — net-zero.',
  })

  // ---- Sweep: own every session this run could have opened (truncated charset names included) ----
  const after = await sessionsJson('post-run: sessions detail before the sweep')
  // Every session this run could have opened (truncated charset names included) carries the sg- prefix,
  // so the listing itself — not a local name registry — decides what the sweep owns.
  const ours = Object.keys(after).filter((n) => n.startsWith('sg-'))
  const swept = []
  for (const n of ours) {
    const r = await runCmds(['enable', `configure session ${n} abort`]).catch(() => ({ ok: false }))
    swept.push({ name: n, abortedOk: r?.ok === true, error: errorText(r) })
  }
  const final = await sessionsJson('post-run: sessions detail after the sweep')
  findings.push({
    id: 'sweep-and-net-zero',
    sessionsBefore: Object.keys(before),
    sessionsAfterSweep: Object.keys(final),
    swept,
    netZero: Object.keys(final).every((n) => !n.startsWith('sg-')),
    note: 'Nothing in this lane commits (the only possible commit is Family D, which undoes itself if accepted), so running-config is net-zero by construction; this sweep proves no sg-* session residue and that the pre-existing lab sessions are untouched.',
  })

  const doc = {
    kind: 'session-grammar-ceos-review-artifact',
    warning:
      'CONTAINER EVIDENCE ONLY — cEOS-lab 4.28.14M. NOT a 7050TX-64 / 4.28.13.1M verdict (DR-043). Every session aborted; nothing committed (see findings["sweep-and-net-zero"]). The hardware halves of all four families stay open device questions.',
    generatedAt: new Date().toISOString(),
    containerIdentity: identity?.ok ? { version: identity.result?.[1]?.version, modelName: identity.result?.[1]?.modelName } : identity,
    findings: deepRedact(findings),
    captures: deepRedact(captures),
  }
  const rendered = `${JSON.stringify(doc, null, 2)}\n`
  // Pre-write scan (DR-150, the persistence-lane pattern): refuse to write an artifact that still
  // carries credential shapes.
  const scan = /\$6\$|ssh-key|ssh-(?:ed25519|rsa)|AAAA[0-9A-Za-z+/]{40,}/u.exec(rendered)
  if (scan) {
    die(6, `artifact scan rejected a credential shape (${JSON.stringify(scan[0].slice(0, 12))}…) — refusing to write ${OUT}`)
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, rendered, 'utf8')

  for (const f of findings) {
    console.log(redactSecrets(`[sess-grammar] ${f.id}: ${JSON.stringify(f, (k, v) => (k === 'note' ? undefined : v)).slice(0, 400)}`))
  }
  console.log(`[sess-grammar] wrote ${OUT} (review, then transcribe the answers — container evidence only, DR-043)`)
  process.exitCode = 0
}

main().catch((e) => die(5, `transport failure: ${String(e?.message ?? e)}`))
