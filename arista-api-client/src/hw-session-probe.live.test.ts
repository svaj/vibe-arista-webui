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
 * 4d. A handle is closed the way its STATE allows, and an OPENER refusal retries the batch under a
 *    run-scoped session name (DR-136, same day): the box keeps ONE completed session
 *    (`maxSavedSessions: 1`) and a COMMITTED probe parks its deterministic name there, so re-opening
 *    `hw-probe-<name>` was answered 1000 `could not run command`. Calling `abort()` on the handle the
 *    client model had already marked `lost` throws this client's own DR-023 `SessionError` — uncaught,
 *    it killed run 4 after the device had answered and the refused exchanges were already captured.
 *    `closeHandle()` never aborts a non-live handle and never lets a refused abort kill the loop; the
 *    runbook's console check (§2.5) is the backstop for a genuinely pending session.
 * 4e. §3's `commit timer` question (open item 5) is asked by a batch carrying
 *    `commitWithRevertTimer: "HH:MM:SS"` — the commit goes through this client's own timed-commit verb,
 *    and a REFUSED timed commit is recorded as the answer rather than ending the run. The steps and the
 *    reasons (why no `commit <intf> verify`, why the lane only waits short timers) are on
 *    `hwProbePendingRevertSessions`. Run 5 (2026-11-08) walked all of it and the BOX answered every
 *    step: `commit timer 00:02:00` ACCEPTED → `state: "pendingCommitTimer"` + `commitBy` (uptime clock)
 *    on the plain listing → the second (block-check) session opened normally via eAPI while armed →
 *    no startup-config persistence → the revert fired unattended, and the reverted session then
 *    vanished from BOTH session forms (its name frees DR-136's slot: parking is for plain commits).
 * 5. Each batch is one recording case (`configure-session-<name>--hw-session-probe`), sanitized with
 *    the full hardware scrubber before the write.
 *
 * Not in this file: the STATUS.md §3 session-*boundary* questions (`configure session <name>` max
 * length/charset, `no-commit` acceptance, description quoting depth) — those probe the CLIENT's own
 * guards as much as the device's, and they run as a dedicated follow-up batch family (#14 §3 line 9-10)
 * once this one has produced its first recorded baseline. `commit timer` (open item 5) DOES live here:
 * a revert timer can only be armed by a COMMIT, and a commit is what this lane is allowed to do to the one
 * scratch interface — the batch sets `commitWithRevertTimer`, and the ordered steps (arm → session table →
 * block question → reads → sit out the deadline) are documented on `hwProbePendingRevertSessions`.
 */

import { readFileSync } from 'node:fs'

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { EapiError } from './errors'
import type { ConfigSession } from './config-session'
import { buildRecording, createRecorder } from './testing/recording'
import { writeRecording } from './testing/recorder-node'
import { describeLiveTarget, liveTransportOptions, matchesDeviceIdentity, requireScratchInterface, resolveLiveEnv, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { hwDeviceIdentity, hwProbeCaseName, hwProbePendingRevertSessions, hwProbeRetrySessionName, hwProbeRunTag, hwProbeSessionName, hwProbeTimerWaitMs, hwReadBackOutput, hwScratchReadBackCommand, parseHwProbeSpec, resolveHwScratchToken, sanitizeHwRecording, selectHwProbeBatches, type HwProbeBatch } from './testing/hw-capture'
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

  // The live project's 60 s default cannot hold a batch that deliberately sits out an armed revert timer
  // (`hwProbeTimerWaitMs`: up to 5 min + 15 s of slack per timed batch), and a test killed MID-WAIT would
  // leave a pending-revert session holding the config lock on somebody's switch — the worst outcome this lane
  // knows how to cause. So the run declares its ceiling up front; the reviewed draft's own timer is pinned
  // inside that window by the spec machine-check (`hw-capture.test.ts`), which is what keeps the two numbers
  // honest. Override only for a spec carrying several timed batches.
  const runBudgetMs = Number(process.env['EAPI_HW_PROBE_TEST_TIMEOUT_MS'] ?? 15 * 60_000)

  it('runs each reviewed batch in a named session and records the diff before commit/abort', async () => {
    expect(batches.length).toBeGreaterThan(0)
    const identity = hwDeviceIdentity({ version: reported.version, modelName: reported.modelName }, { topology: `supervised session; scratch=${scratch ?? 'none'}` })
    const scrub = extraSecrets()
    const enablePassword = process.env['EAPI_ENABLE_PASS']
    let committedBatches = 0
    let negatives = 0
    const postReadRefusals: string[] = []
    const openerRefusals: string[] = []
    // One tag for the whole run: retry names stay stable inside a session day and distinguishable across days.
    const runTag = hwProbeRunTag()

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

      // Run 4 (2026-11-08 21:32, PR #112's code and spec rev 3 — see the run numbering in DECISIONS
      // DR-136) died HERE, and it was two separate failures wearing one
      // stack trace (DR-136):
      //  - the DEVICE refused the OPENER line, not a staged command:
      //    `Error [1000] … 'configure session hw-probe-scratch-description description "…"' failed: could
      //    not run command`. The box keeps ONE completed session (`maxSavedSessions: 1`, verified) and
      //    run 2's commit had parked exactly that deterministic name there — so a batch that has ever
      //    committed is unprobeable by name for the life of that slot; and
      //  - the HARNESS then called `abort()` on the handle the client model had marked `lost`, which
      //    throws this client's own DR-023 `SessionError`, and nothing caught it: the batch's refusals
      //    were in the recorder but never reached disk, and every later batch (the restore set again)
      //    was skipped with the switch still carrying that earlier commit's `description`.
      // So a refusal is now kept with its full text, an OPENER refusal is recorded as evidence and the
      // batch retries under a run-scoped session name, and closing a handle always obeys the handle.
      let active: ConfigSession | undefined
      let refusal: string | undefined
      const batchOpenerRefusals: string[] = []
      const handles: ConfigSession[] = []
      for (const attempt of [hwProbeSessionName(batch.name), hwProbeRetrySessionName(batch.name, runTag)]) {
        const session = await node.configSession({ name: attempt, description: batch.question.slice(0, 56) })
        handles.push(session)
        try {
          await session.run(commands)
          active = session
          break
        } catch (rawErr) {
          // DR-134: the device's refusal is the ANSWER, not a crash — record it and reach the next
          // batch (which a throw used to make unreachable; EOS stops the staged batch at the refused
          // line regardless). Anything NOT an EapiError is the harness's/this client's bug: rethrow.
          if (!(rawErr instanceof EapiError)) throw rawErr
          if (session.state === 'lost') {
            batchOpenerRefusals.push(`${attempt}: ${errorText(rawErr)}`)
            continue
          }
          refusal = errorText(rawErr)
          active = session
          break
        }
      }
      if (batchOpenerRefusals.length > 0) {
        openerRefusals.push(...batchOpenerRefusals.map((line) => `${batch.name}: ${line}`))
        console.warn(`hw-session-probe: ${batch.name}: OPENER refused ${String(batchOpenerRefusals.length)}× — recorded as the device's answer${batchOpenerRefusals.length === 1 ? ', batch retried under a run-scoped session name' : ', batch has no live session'}: ${batchOpenerRefusals.join(' || ')}`)
      }

      let diffLines = -1
      let committed = false
      try {
        if (active === undefined) {
          console.warn(`hw-session-probe: ${batch.name}: no live session under either name — recording the refusals and moving on`)
        } else {
          try {
            const diffText = await active.diff()
            diffLines = diffText.split(/\r?\n/u).filter((line) => line.trim() !== '').length
          } catch (rawErr) {
            if (!(rawErr instanceof EapiError)) throw rawErr
            // A refused `show session-config diffs` is itself a §3 answer (open item 8's family).
            refusal = `${refusal ?? 'staged cleanly;'} diff read refused: ${errorText(rawErr)}`
          }
        }
        console.log(`hw-session-probe: ${batch.name}: ${diffLines >= 0 ? `diff captured (${String(diffLines)} line(s))` : 'diff not readable'}${refusal === undefined ? '' : ` — REFUSED recorded as the device's answer: ${refusal}`}`)
        if (batch.allowCommit && refusal === undefined && active !== undefined && active.isOpen) {
          const timer = batch.commitWithRevertTimer
          let commitRefused = false
          try {
            if (timer === undefined) await active.commit()
            else {
              // §3's `commit timer` line, asked of the box through this client's own revert-timer verb
              // (`config-session.ts:856`) — see the numbered flow on `hwProbePendingRevertSessions`.
              await active.commitWithRevertTimer(timer)
              console.log(`hw-session-probe: ${batch.name}: timed commit accepted — revert armed with ${timer}`)
              const listed = await tolerateCall(batch, 'show configuration sessions (after arming)', () => node.listSessions(), postReadRefusals)
              if (listed !== undefined) {
                const seen = hwProbePendingRevertSessions(listed.sessions)
                console.log(`hw-session-probe: ${batch.name}: session table now — ${seen.length === 0 ? 'nothing listed' : seen.map((entry) => `${entry.name}=${entry.state}`).join(', ')}`)
                if (seen.every((entry) => !/pending/iu.test(entry.state))) {
                  // Run 5 (2026-11-08): the armed session read `state: "pendingCommitTimer"` with the
                  // deadline in `commitBy` — this SKU has no label literally spelled `pending-revert`,
                  // so the predicate matches the stem. And run 5 also showed a FIRED revert removes the
                  // entry from both session forms entirely, so "nothing listed" AFTER the deadline is
                  // itself an answer — read the recording, do not hunt for a swallowed refusal.
                  console.warn(`hw-session-probe: ${batch.name}: no entry reported a pending state — run 5's box labels an armed session pendingCommitTimer, and a revert that already fired clears the entry from both listing forms: read the recording`)
                }
              }
              // §3's other half of the same sentence: does a held timer BLOCK a later session? Asked while
              // the timer is armed, which is only possible inside this batch — the answer is either the
              // 1006 refusal (recorded, nothing to clean) or a session this harness opens and aborts
              // immediately, which is the same write class the lane already permits on the scratch port.
              const blockProbe = await tolerateCall(batch, `open a second session while the revert timer is armed`, async () => {
                const probe = await node.configSession({ name: `${hwProbeSessionName(batch.name)}-block-check` })
                try {
                  await probe.run(scratch === undefined ? [] : [`interface ${scratch}`, '   no shutdown'])
                } finally {
                  await closeHandle(probe, batch, postReadRefusals)
                }
                return 'opened and aborted'
              }, postReadRefusals)
              console.log(`hw-session-probe: ${batch.name}: armed-timer block question — ${blockProbe === undefined ? 'the second session was REFUSED (see the refusal list above; that is the 1006-class answer)' : blockProbe}`)
            }
          } catch (rawErr) {
            // DR-134 again, one layer up: a refused COMMIT is the device's answer to §3's timer line
            // ("does this SKU arm a revertable commit?" -- answered NO is still an answer). It must not
            // throw: run 4 died on exactly this class of unhandled typed error and lost its evidence.
            if (!(rawErr instanceof EapiError)) throw rawErr
            refusal = `${refusal ?? 'staged cleanly;'} commit refused: ${errorText(rawErr)}`
            commitRefused = true
            console.warn(`hw-session-probe: ${batch.name}: commit REFUSED and recorded as the answer: ${errorText(rawErr)}`)
          }
          if (!commitRefused) {
            committed = true
            committedBatches += 1
            // Read-backs AFTER a commit are evidence gathering, never control flow (DR-135): the run of
            // 2026-11-08 wrote a committed `description` on the scratch port, then the singular
            // `show running-config interface …` read threw 1002 and killed the loop — the batch's
            // recording was lost and every later batch (the restore set included) never ran, with the
            // mutation already sitting on the switch. Reads go through the verified PLURAL form
            // (`hwScratchReadBackCommand`) and a refusal is logged, not fatal.
            if (scratch !== undefined) {
              const markers = stagedMarkers(commands)
              const [readBack] = await tolerateRead(node, batch, [hwScratchReadBackCommand(scratch)], 'text', postReadRefusals)
              const block = textOf(readBack)
              console.log(`hw-session-probe: ${batch.name}: committed — scratch block ${String(countLines(block))} line(s)${markers.length === 0 ? '' : `; markers still on the port: ${markers.filter((marker) => block.includes(marker)).join(', ') || 'none'}`}`)
              const timer = batch.commitWithRevertTimer
              if (timer !== undefined) {
                // DR-035(c)'s question, asked of the box rather than assumed: did a timed commit persist?
                const [startup] = await tolerateRead(node, batch, ['show startup-config'], 'text', postReadRefusals)
                const startupText = textOf(startup)
                console.log(`hw-session-probe: ${batch.name}: startup-config after the timed commit — ${markers.length === 0 ? 'no marker staged to look for' : markers.map((marker) => `${marker}=${startupText.includes(marker) ? 'PERSISTED' : 'absent'}`).join(' ')}`)
                const waitMs = hwProbeTimerWaitMs(timer)
                if (waitMs === undefined) {
                  console.warn(`hw-session-probe: ${batch.name}: timer ${timer} is outside the waited window — the lane will NOT sit on a switch that long. A pending revert holds the config lock: clear it from the console (§2.5) or wait it out before the next run`)
                } else {
                  console.log(`hw-session-probe: ${batch.name}: sitting out the ${timer} deadline (+15 s) to record whether the revert fires unattended`)
                  await new Promise((resolve) => setTimeout(resolve, waitMs))
                  const [after] = await tolerateRead(node, batch, [hwScratchReadBackCommand(scratch)], 'text', postReadRefusals)
                  const afterBlock = textOf(after)
                  console.log(`hw-session-probe: ${batch.name}: after the deadline — scratch block ${String(countLines(afterBlock))} line(s)${markers.length === 0 ? '' : `; markers still on the port: ${markers.filter((marker) => afterBlock.includes(marker)).join(', ') || 'none (the revert undid them)'}`}`)
                }
              }
            }
          }
        } else {
          if (batch.allowCommit && refusal !== undefined) {
            console.warn(`hw-session-probe: ${batch.name}: allowCommit batch came back with a refusal — commit SKIPPED, session aborted (a half-refused batch never commits, DR-134)`)
          }
          if (refusal !== undefined) negatives += 1
          if (active !== undefined) await closeHandle(active, batch, postReadRefusals)
        }
        // Post-state baseline for the §3 orphan question: what sessions exist after ours closed.
        await tolerateRead(node, batch, ['show configuration sessions', 'show configuration sessions detail'], 'json', postReadRefusals)
      } finally {
        // Safety net only: a handle this client still believes in must never outlive its batch, because a
        // pending session holds the config lock and burns one of the five pending slots. `closeHandle`
        // is a no-op on anything already committed/aborted/lost, so re-visiting the batch's own handle
        // here costs nothing.
        if (!committed) {
          for (const handle of handles) {
            await closeHandle(handle, batch, postReadRefusals)
          }
        }
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
    // Run 5 (2026-11-08 22:43) died in THIS block's first version — after all 17 batches had recorded:
    // the summary interpolated a retry-name EXAMPLE by calling hwProbeRetrySessionName('<batch>', runTag)
    // with the doc placeholder, and the validating builder threw. A summary print must never call a
    // builder it cannot pass; the pattern stays literal text and the refusal lines below already carry
    // the real attempted names.
    if (openerRefusals.length > 0) {
      console.warn(`hw-session-probe: ${String(openerRefusals.length)} batch(es) could not OPEN under the canonical session name (DR-136: the box parks a committed session's name in its ONE completed-session slot, maxSavedSessions=1 — run 5 recorded the reason verbatim: Cannot enter session <name> (already completed)). Each refusal is recorded in that batch's file and the batch was retried as hw-probe-<batch>-${runTag}:\n${openerRefusals.map((line) => `  - ${line}`).join('\n')}`)
    }
    console.log(`hw-session-probe: DONE — ${String(batches.length)} batch(es), ${String(committedBatches)} committed (scratch-scoped only), ${String(negatives)} answered by a device refusal (DR-134), ${String(openerRefusals.length)} opener refusal(s) retried under a run-scoped name (DR-136)`)
  }, runBudgetMs)

  /**
   * The device's answer, kept legible. The first versions cut at 160/200 characters, which amputated the
   * run-4 opener refusal mid-token (`[errors: ['Cannot`) and so hid the reason for the failure — on a
   * switch session the FULL refusal text is the finding, so the cap is generous and a multi-line reply
   * is flattened onto one line instead of truncated at the first one.
   */
  function errorText(error: EapiError): string {
    return error.message.split(/\r?\n/u).filter((line) => line.trim() !== '').join(' | ').slice(0, 500)
  }

  /**
   * Close a handle the way its STATE allows (DR-136): `abort()` only while this client still believes a
   * session exists. On a `lost` handle `abort()` throws the client's own DR-023 `SessionError` — there is
   * is nothing on the switch to abort — and in run 4 that uncaught state error killed the loop one step
   * AFTER the device had answered, throwing away bytes the lane had already captured.
   * A refused abort (1006 lock, or a session another CLI already ended) is recorded, never fatal: the
   * runbook's §2.5 console check (`show configuration sessions`) is the backstop for a real pending one.
   */
  async function closeHandle(session: ConfigSession, batch: HwProbeBatch, refusals: string[]): Promise<void> {
    if (!session.isOpen) return
    try {
      await session.abort()
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      refusals.push(`${batch.name} [abort ${session.name}]: ${errorText(rawErr)}`)
      console.warn(`hw-session-probe: ${batch.name}: abort of ${JSON.stringify(session.name)} refused — check the console (§2.5) before the next batch: ${errorText(rawErr)}`)
    }
  }

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
      refusals.push(`${batch.name} [${commands.join('; ')}]: ${errorText(rawErr)}`)
      console.warn(`hw-session-probe: ${batch.name}: post-batch read refused (kept as evidence, the batch itself already closed): ${errorText(rawErr)}`)
      return []
    }
  }

  /** Same rule as `tolerateRead`, for the typed model accessors (`node.listSessions()`). */
  async function tolerateCall<T>(batch: HwProbeBatch, label: string, call: () => Promise<T>, refusals: string[]): Promise<T | undefined> {
    try {
      return await call()
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      refusals.push(`${batch.name} [${label}]: ${errorText(rawErr)}`)
      console.warn(`hw-session-probe: ${batch.name}: ${label} refused (kept as evidence): ${errorText(rawErr)}`)
      return undefined
    }
  }

  /** The marker texts this batch stages, so a read-back can be checked for them instead of eyeballed. */
  function stagedMarkers(commands: readonly string[]): readonly string[] {
    return commands.map((cmd) => /^\s*description\s+(\S.*?)\s*$/iu.exec(cmd)?.[1]).filter((marker): marker is string => marker !== undefined && marker !== '')
  }

  function textOf(result: unknown): string {
    // Run 5 read `.output` at the exec-item level, got '' for EVERY post-commit read-back (the item is
    // a wrapper, and the composed `enable` gets its own slot), and printed "scratch block 0 line(s);
    // markers … none" over recordings that clearly showed the markers on the port. On a switch day the
    // console line is what the operator trusts first — the lie cost credibility, not just a log.
    return hwReadBackOutput(result)
  }

  function countLines(text: string): number {
    return text.split(/\r?\n/u).filter((line) => line.trim() !== '').length
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
