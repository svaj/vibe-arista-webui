/**
 * `hw-session-probe.live.test.ts` — reviewed config-session probes against the physical 7050TX-64
 * (#14 §3, the "abort-only + ONE designated scratch interface" half of the locked switch-evidence
 * decision). The commands themselves live in a JSON spec file the operator reviews **before** the
 * switch session (`parseHwProbeSpec` + `hw-capture.test.ts` enforce the fence mechanically;
 * `docs/hw-session-probes.draft.json` is the reviewed draft). This file only executes.
 *
 * ## Guarantees, in the order they fire
 * 1. Target gates first (identical to `hw-inventory`): full hardware `resolveLiveEnv` profile +
 *    `EAPI_HW_SESSION_PROBE=1`; lab-class or half-configured envs skip loudly, they never probe.
 * 2. The device must self-report the pinned identity (`matchesDeviceIdentity`) before a session opens.
 * 3. Every spec batch was already shape-validated at parse time; at RUN time each batch additionally
 *   must survive: `{{SCRATCH}}` resolution through `requireScratchInterface` (guard-accepted
 *    `Ethernet…` name only), and for `allowCommit` batches the scratch port must not be carrying
 *    traffic (`linkStatus connected/errdisabled` ⇒ refuse: "unused" is the operator's declaration,
 *    connected is the device's contradiction of it).
 * 4. Each batch runs in a NAMED `configure session` (`hw-probe-<name>` — DR-035's auditability rule,
 *    made physical): stage → record `session.diff()` + `show configuration sessions detail` →
 *    either `abort()` (the default) or `commit()` (only `allowCommit` batches; never `{persist:true}`,
 *    DR-024/DR-035(c)). A `finally` aborts anything still open — a dead session on somebody's switch
 *    holds the config lock (`1006` blast radius), the same reasoning as on a container.
 * 4b. A DEVICE REFUSAL (1002/1004) inside staging or inside the diff read is **recorded as the
 *    batch's answer and the loop continues** (DR-134 — the rule `hw-inventory` already ships: which
 *    commands the SKU accepts IS §3 evidence). It must also continue mechanically: EOS stops a
 *    staged batch at the refused line, so a throwing harness silently made every later batch
 *    unreachable (found live 2026-11-08: `switchport trunk allowed vlan only 10,20` → 1002 killed
 *    the run before batches 3-9 could answer anything). On an `allowCommit` batch a refusal
 *    **skips the commit** — the batch aborts and records. Only typed `EapiError`s are tolerated;
 *    transport or state-machine failures still kill the run (half-captured switch evidence is
 *    worse than none).
 * 4c. A read that happens AFTER a batch has closed (scratch read-back, `show configuration sessions`
 *    post-state) can never control the loop and never cancels a committed batch's recording (DR-135,
 *    found live 2026-11-08): the harness read `show running-config interface <scratch>` — singular —
 *    and the SKU answered 1002 `% Incomplete token (at token 2: 'interface')`, which killed the loop
 *    one statement after a SUCCESSFUL commit, losing that batch's recording and skipping the whole
 *    restore set while the mutation sat on the switch. The read spelling now comes from
 *    `hwScratchReadBackCommand` (plural `interfaces`, as Arista's own system suite writes it),
 *    refusals are logged as answers, and `EAPI_HW_PROBE_ONLY` (see `selectHwProbeBatches`) lets a
 *    stopped day resume with only the batches still owed.
 * 5. Each batch is one recording case (`configure-session-<name>--hw-session-probe`), sanitized with
 *    the full hardware scrubber before the write.
 *
 * Not in this file: the STATUS.md §3 session-*boundary* questions (`configure session <name>` max
 * length/charset, `no-commit` acceptance, `commit timer`) — those probe the CLIENT's own guards as
 * much as the device's, and they run as a dedicated follow-up batch family (#14 §3 line 9-10) once
 * this one has produced its first recorded baseline.
 */

import { readFileSync } from 'node:fs'

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { EapiError } from './errors'
import { buildRecording, createRecorder } from './testing/recording'
import { writeRecording } from './testing/recorder-node'
import { describeLiveTarget, liveTransportOptions, matchesDeviceIdentity, requireScratchInterface, resolveLiveEnv, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { hwDeviceIdentity, hwProbeCaseName, hwScratchReadBackCommand, parseHwProbeSpec, resolveHwScratchToken, sanitizeHwRecording, selectHwProbeBatches, type HwProbeBatch } from './testing/hw-capture'
import type { VersionProperties } from './command-layer'

const resolution = resolveLiveEnv(process.env)
if (!resolution.ok) {
  console.warn(`hw-session-probe: SKIPPED (DR-034) — ${resolution.reason}`)
}
const hardwareTarget = resolution.ok && resolution.targetClass === 'hardware'
const probeOn = process.env['EAPI_HW_SESSION_PROBE'] === '1'
if (hardwareTarget && !probeOn) {
  console.warn('hw-session-probe: SKIPPED — hardware target accepted, but config-session probes need EAPI_HW_SESSION_PROBE=1 plus a reviewed EAPI_HW_PROBE_SPEC file')
}
if (probeOn && !hardwareTarget) {
  console.warn('hw-session-probe: SKIPPED — probes exist only for the hardware class; the container lane probes through scripts/ceos-lab.mjs provisioning instead')
}
const runnable = resolution.ok && hardwareTarget && probeOn

function extraSecrets(): string[] {
  const raw = process.env['EAPI_HW_SCRUB']
  if (raw === undefined || raw.trim() === '') return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

describe.skipIf(!runnable)('hardware session probes: named config sessions on the 7050TX-64 (#14 §3)', () => {
  let target: LiveTarget
  let reported: VersionProperties
  let scratch: string | undefined
  let batches: readonly HwProbeBatch[] = []

  beforeAll(async () => {
    target = unwrapLiveTarget(resolution)
    console.log(`hw-session-probe: target = ${describeLiveTarget(target)}`)
    const specPath = process.env['EAPI_HW_PROBE_SPEC']
    if (specPath === undefined || specPath.trim() === '') {
      throw new Error('hw-session-probe: EAPI_HW_PROBE_SPEC must name the reviewed spec file (default review draft: arista-api-client/docs/hw-session-probes.draft.json — copying it there does NOT mean it is approved for THIS switch day; the operator re-reads it live)')
    }
    const spec = parseHwProbeSpec(readFileSync(specPath.trim(), 'utf8'))
    // A switch day can stop halfway (a crash, a console interruption, an operator pause). Every batch
    // BEFORE the stop may already have committed, so replaying the whole spec is not automatically
    // safe — EAPI_HW_PROBE_ONLY names the batches still owed. Unknown names refuse instead of no-op.
    batches = selectHwProbeBatches(spec.batches, process.env['EAPI_HW_PROBE_ONLY'])
    if (resolution.ok && resolution.targetClass === 'hardware') {
      const needScratch = batches.some((batch) => batch.commands.some((cmd) => cmd.includes('{{SCRATCH}}')))
      if (needScratch) {
        // The ONLY exempt call site of the DR-132 hardware write fence: this lane's mutations are fenced
        // by their own chain (EAPI_HW_SESSION_PROBE=1 above, a spec mechanically reviewed by
        // parseHwProbeSpec, and assertScratchStillUnused before any commit batch).
        const scratchGate = requireScratchInterface(target, { hardwareSessionProbe: true })
        if (!('name' in scratchGate)) throw new Error(`hw-session-probe: the spec names {{SCRATCH}} but the guard refuses the declared interface — ${scratchGate.reason}`)
        scratch = scratchGate.name
      }
    }
    const probeNode = createNode(liveTransportOptions(target))
    reported = await probeNode.getVersion()
    const identityMismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    if (identityMismatch !== undefined) throw new Error(`hw-session-probe: refusing to write anywhere — ${identityMismatch.reason}`)
  })

  it('runs each reviewed batch in a named session and records the diff before commit/abort', async () => {
    expect(batches.length).toBeGreaterThan(0)
    const identity = hwDeviceIdentity({ version: reported.version, modelName: reported.modelName }, { topology: `supervised session; scratch=${scratch ?? 'none'}` })
    const scrub = extraSecrets()
    const enablePassword = process.env['EAPI_ENABLE_PASS']
    let committedBatches = 0
    let negatives = 0
    const postReadRefusals: string[] = []

    for (const batch of batches) {
      const commands = resolveHwScratchTokenFor(batch)
      const recorder = createRecorder()
      const node = createNode({
        ...liveTransportOptions(target),
        ...(enablePassword === undefined || enablePassword === '' ? {} : { enablePassword }),
        trace: recorder.sink,
      })

      if (batch.allowCommit) {
        await assertScratchStillUnused(node)
      }

      const session = await node.configSession({
        name: `hw-probe-${batch.name}`,
        description: batch.question.slice(0, 56),
      })
      let committed = false
      let refusal: string | undefined
      try {
        try {
          await session.run(commands)
        } catch (rawErr) {
          // DR-134: the device's refusal is the ANSWER, not a crash — record it and reach the next
          // batch (which a throw used to make unreachable; EOS stops the staged batch at the refused
          // line regardless). Anything NOT an EapiError is the harness's/this client's bug: rethrow.
          if (!(rawErr instanceof EapiError)) throw rawErr
          refusal = rawErr.message.split(/\r?\n/u)[0]?.slice(0, 200) ?? String(rawErr)
        }
        let diffLines = -1
        try {
          const diffText = await session.diff()
          diffLines = diffText.split(/\r?\n/u).filter((line) => line.trim() !== '').length
        } catch (rawErr) {
          if (!(rawErr instanceof EapiError)) throw rawErr
          // A refused `show session-config diffs` is itself a §3 answer (open item 8's family).
          refusal = `${refusal ?? 'staged cleanly;'} diff read refused: ${rawErr.message.split(/\r?\n/u)[0]?.slice(0, 160) ?? ''}`
        }
        console.log(`hw-session-probe: ${batch.name}: ${diffLines >= 0 ? `diff captured (${String(diffLines)} line(s))` : 'diff not readable'}${refusal === undefined ? '' : ` — REFUSED recorded as the device's answer: ${refusal}`}`)
        if (batch.allowCommit && refusal === undefined) {
          await session.commit()
          committed = true
          committedBatches += 1
          // Read-backs AFTER a commit are evidence gathering, never control flow (DR-135): the run of
          // 2026-11-08 wrote a committed `description` on the scratch port, then the singular
          // `show running-config interface …` read threw 1002 and killed the loop — the batch's
          // recording was lost and every later batch (the restore set included) never ran, with the
          // mutation already sitting on the switch. Reads now go through the verified PLURAL form
          // (hwScratchReadBackCommand) and a refusal is logged, not fatal.
          if (scratch !== undefined) {
            const [readBack] = await tolerateRead(node, batch, [hwScratchReadBackCommand(scratch)], 'text', postReadRefusals)
            const echoed = ((readBack as { output?: string } | undefined)?.output ?? '').split(/\r?\n/u).filter((line) => line.trim() !== '').length
            console.log(`hw-session-probe: ${batch.name}: committed — scratch read-back ${String(echoed)} line(s)`)
          }
        } else {
          if (batch.allowCommit) {
            console.warn(`hw-session-probe: ${batch.name}: allowCommit batch came back with a refusal — commit SKIPPED, session aborted (a half-refused batch never commits, DR-134)`)
          }
          if (refusal !== undefined) negatives += 1
          await session.abort()
        }
        // Post-state baseline for the §3 orphan question: what sessions exist after ours closed.
        await tolerateRead(node, batch, ['show configuration sessions', 'show configuration sessions detail'], 'json', postReadRefusals)
      } finally {
        if (!committed && session.isOpen) await session.abort()
      }
      if (recorder.incomplete().length > 0) throw new Error(`hw-session-probe: incomplete exchanges in batch ${JSON.stringify(batch.name)} — refusing to write a half-recorded probe`)
      const built = buildRecording(recorder, identity)
      const sanitized = sanitizeHwRecording(built, { extraSecrets: scrub })
      let out: { created: boolean; bytes: number }
      try {
        out = writeRecording(sanitized.fixture, { caseName: hwProbeCaseName(batch.name), overwrite: true })
      } catch (rawErr) {
        // DR-135: after a commit the switch has ALREADY changed, so a lost write is an operational
        // problem, not just a test failure — name the outstanding restore batch in the loudest place.
        if (committed) {
          console.error(`hw-session-probe: ${batch.name}: COMMITTED on ${scratch ?? '<scratch>'} but the recording could not be written — restore before anything else: EAPI_HW_PROBE_ONLY=<spec's restore batch> (cause: ${(rawErr as Error).message})`)
        }
        throw rawErr
      }
      console.log(`hw-session-probe: ${hwProbeCaseName(batch.name)}: ${out.created ? 'created' : 'refreshed'} (${String(out.bytes)} B, ${String(sanitized.log.length)} scrub(s), ${refusal !== undefined ? 'negative recorded' : committed ? 'committed' : 'aborted'})`)
    }
    if (postReadRefusals.length > 0) {
      console.warn(`hw-session-probe: ${String(postReadRefusals.length)} evidence READ(s) refused after their batch closed (recorded as answers, they never changed control flow):\n${postReadRefusals.map((line) => `  - ${line}`).join('\n')}`)
    }
    console.log(`hw-session-probe: DONE — ${String(batches.length)} batch(es), ${String(committedBatches)} committed (scratch-scoped only), ${String(negatives)} answered by a device refusal (DR-134)`)
  })

  /**
   * A post-batch read only REPORTS switch state; it must never decide whether the loop continues or
   * whether a committed batch gets its recording. Typed `EapiError`s are appended to `refusals` and
   * swallowed; anything else is a harness bug and still kills the run (DR-134's rule).
   */
  async function tolerateRead(node: ReturnType<typeof createNode>, batch: HwProbeBatch, commands: readonly string[], format: 'json' | 'text', refusals: string[]): Promise<readonly unknown[]> {
    if (commands.length === 0) return []
    try {
      return await node.exec([...commands], { format })
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      const first = rawErr.message.split(/\r?\n/u)[0]?.slice(0, 200) ?? String(rawErr)
      refusals.push(`${batch.name} [${commands.join('; ')}]: ${first}`)
      console.warn(`hw-session-probe: ${batch.name}: post-batch read refused (kept as evidence, the batch itself already closed): ${first}`)
      return []
    }
  }

  function resolveHwScratchTokenFor(batch: HwProbeBatch): readonly string[] {
    if (!batch.commands.some((cmd) => cmd.includes('{{SCRATCH}}'))) return batch.commands
    if (scratch === undefined) {
      // parseHwProbeSpec already gated allowCommit batches on the token; abort-only batches may still
      // use it for clarity. Either way the NAME must have passed the guard — never a free-text port.
      throw new Error('hw-session-probe: batch uses {{SCRATCH}} but the declared EAPI_SCRATCH_INTERFACE did not clear requireScratchInterface')
    }
    return resolveHwScratchToken(batch.commands, scratch)
  }

  /**
   * "One designated UNUSED scratch interface" is the operator's declaration; `linkStatus:
   * connected` is the switch contradicting it — so a commit batch refuses BEFORE staging. The check
   * is advisory in one direction only: it cannot prove "unused" (a quiet LACP peer looks down), which
   * is why the commit fence also needs the spec to be scratch-only by construction (parseHwProbeSpec).
   */
  async function assertScratchStillUnused(node: ReturnType<typeof createNode>): Promise<void> {
    if (scratch === undefined) throw new Error('hw-session-probe: allowCommit batch reached the check with no scratch interface — parser/gate bug')
    const [status] = await node.exec([`show interfaces ${scratch} status`], { format: 'json' })
    const statuses = (status?.result as { interfaceStatuses?: Record<string, { linkStatus?: string }> } | undefined)?.interfaceStatuses
    const link = statuses?.[scratch]?.linkStatus
    console.log(`hw-session-probe: scratch ${scratch} linkStatus=${link ?? '<unread>'} before commit batch`)
    if (link === 'connected' || link === 'errdisabled') {
      throw new Error(`hw-session-probe: refusing commit probes against ${JSON.stringify(scratch)} — linkStatus=${link} contradicts the "unused scratch" declaration (re-declare the port or run abort-only batches)`)
    }
  }
})
