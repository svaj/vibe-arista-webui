/**
 * S7 (#77): the pure half of the capability probe panel — question-set validation, the operator
 * copy for the seven-verdict taxonomy, and the redacted export builder. No React in this file, so
 * every rule here is testable by calling it (the `command-guard.ts` pattern from S4, #74).
 *
 * ## Where the vocabulary comes from — and where it must not
 *
 * DR-033 (`arista-api-client/docs/DECISIONS.md`, and the header of the client's `capabilities.ts`)
 * forbids this app shipping a "supported on the 7050TX-64" feature table: presence is probed, never
 * looked up. So the question sets start **empty** and every candidate is operator-supplied. That is
 * also what makes this screen's other job real: the export below is deliberately shaped to be
 * pasted into a DECISIONS/open-item note, where an unsourced pre-seeded claim would become the
 * very hard-coding DR-033 refuses.
 *
 * ## What a probe answers, and what it never answers
 *
 * The panel header and the export header both carry the issue's sentence: a probe answers **command
 * presence**, never hardware capacity, platform support, or licensing (epic open item 6). The
 * seven-verdict labels below encode that per verdict: only `unsupported` (the `1002` answer) is
 * allowed to read as unavailable, exactly as DR-062 pins; `1004`/`1005`/`1006`/unmapped answers are
 * labelled as non-claims with the reason stated, and `not-rejected` is called *inconclusive* — an
 * accepting batch that never singled the candidate out is not a green light either.
 *
 * ## The refused candidates are the client's, mirrored for the UI
 *
 * `probeCommands` refuses to probe the verbs in `PROBE_FORBIDDEN_COMMANDS`
 * (`arista-api-client/src/capabilities.ts`, the frozen map above `VERDICT_BY_CODE`'s section —
 * `abort`, `commit`, `configure session`, `configure replace`, `copy running-config startup-config`,
 * `reload`) because each would destroy the probe's own session or write through it. The client
 * still enforces that at probe time; this mirror exists so the refusal happens **before** the
 * operator pays for a confirm click, with copy that explains why — one cause-and-effect sentence
 * per verb rather than a mid-probe throw.
 */
import { isInconclusiveVerdict } from '@devhax-heavy-industries/arista-eapi'
import type { CapabilityVerdict, CommandProbeResult, ProbeCommandsOutcome } from '@devhax-heavy-industries/arista-eapi'
import { scanText } from '../../testing/redaction-guard'
import type { GuardFinding } from '../../testing/redaction-guard'
import type { CapabilitiesView } from '../../shared/use-capabilities'

/** One operator-authored question: a label plus the candidate commands that answer it. */
export interface QuestionSet {
  readonly name: string
  readonly commands: readonly string[]
}

/** Prefix refusals mirroring the client's always-refused probe candidates (see header). Each entry
 *  is `verb → why`; matching is the client's rule — a whole-word prefix over the whole candidate. */
export const FORBIDDEN_CANDIDATES: Readonly<Record<string, string>> = Object.freeze({
  abort: "it ends the probe's own config session before the remaining candidates run, and the candidates staged before it are then probed in a different session",
  commit: 'a probe never writes running-config (DR-050); committing candidates staged earlier in the probe is precisely what the probe\u2019s guaranteed abort prevents',
  'configure session': 'it re-attaches a different named session mid-probe, so the guaranteed abort would end that session instead of the probe',
  'configure replace': 'it replaces running-config wholesale and exits the session it finds — a write wearing a probe costume',
  'copy running-config startup-config': 'saving startup-config is always explicit in this stack (DR-024); a probe cannot trigger durability',
  reload: 'it reboots the switch; nothing on this screen may do that',
})

/** The split-on-newlines form of the editor's textarea value: trimmed, blank lines dropped. */
export function parseCandidates(text: string): readonly string[] {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
}

/** The client's word-boundary prefix match, applied to one candidate (same shape as the client's
 *  `PROBE_FORBIDDEN_PATTERN`, built the same way from these keys). */
function forbiddenHit(candidate: string): readonly [verb: string, why: string] | undefined {
  for (const [verb, why] of Object.entries(FORBIDDEN_CANDIDATES)) {
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    if (new RegExp(`^(?:${escaped})(?:\\s|$)`, 'u').test(candidate)) return [verb, why]
  }
  return undefined
}

/** Control characters and the line-boundary code points a single CLI candidate may not carry. The
 *  textarea split makes embedded newlines unreachable, but `\0`-style payloads survive paste paths —
 *  the same code-point discipline S2 (#72) standardized on for device-bound tokens. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/u

/** Why one question set may not be added, or `undefined` when it may. `existing` supplies the
 *  duplicate-name rule; a refusal here never reaches the device (zero round trips, pinned in tests). */
export function questionSetRefusal(
  name: string,
  commands: readonly string[],
  existing: readonly QuestionSet[],
): string | undefined {
  const label = name.trim()
  if (label === '') return 'A question set needs a name: the name is what the verdict table and the export row are labelled with, and DR-033 means it labels YOUR question — not a feature this app pre-lists.'
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/u.test(label)) return `Question-set name ${JSON.stringify(label)} has to stay one readable token: letters, digits, spaces, dot, dash and underscore only, starting with a letter or digit. The name rides into the export an operator pastes into a DECISIONS note.`
  if (label.length > 64) return 'Question-set name is longer than 64 characters — kept under the client\u2019s own config-session-name cap (MAX_SESSION_NAME_LENGTH, config-session.ts) so both read cleanly in an exported note.'
  if (existing.some((set) => set.name === label)) return `A question set named ${JSON.stringify(label)} is already in the list. Names are the table key, so the probe would fold the two together.`
  if (commands.length === 0) return 'A question set needs at least one candidate command: the device answers per CANDIDATE, and an empty candidate list is a question that cannot be asked.'
  for (const candidate of commands) {
    if (CONTROL_CHARS.test(candidate)) return `A candidate in ${JSON.stringify(label)} carries a control character. A CLI token runs verbatim into the probe batch, so this screen refuses it before any session opens.`
    if (candidate.length > 512) return `A candidate in ${JSON.stringify(label)} is longer than 512 characters: a probe batch is one wire array, and nothing legitimate in this CLI is that long.`
    const hit = forbiddenHit(candidate)
    if (hit !== undefined) {
      return `Candidate ${JSON.stringify(candidate)} starts with \`${hit[0]}\`, which this client refuses to probe: ${hit[1]}. \`probeCommands\` enforces the same rule (its PROBE_FORBIDDEN_COMMANDS map), so the probe would throw mid-list — refusing it here costs zero sessions instead.`
    }
  }
  return undefined
}

/** Operator-facing wording for each of the seven verdicts. The label column is #77's taxonomy; the
 *  meaning column states, per verdict, whether it may be a feature claim at all (DR-062). */
export function verdictFacts(verdict: CapabilityVerdict): { label: string; meaning: string } {
  switch (verdict) {
    case 'supported': return { label: 'available', meaning: 'the device accepted this candidate inside the probe batch — acceptance is the strongest answer this API gives, and it is presence, not capacity.' }
    case 'unsupported': return { label: 'unavailable', meaning: 'the grammar refused this candidate with 1002 COMMAND_INVALID — the one verdict DR-062 allows to read as "not on this device".' }
    case 'not-rejected': return { label: 'inconclusive', meaning: 'the batch failed for another candidate and never named this one — not a feature answer either way, and the client never caches such a run.' }
    case 'incompatible': return { label: 'incompatible', meaning: 'the refusal was 1004 COMMAND_INCOMPATIBLE — an eAPI-context answer, not a statement about the feature. Non-claim.' }
    case 'unauthorized': return { label: 'unauthorized', meaning: 'the answer was 1005 COMMAND_UNAUTHORIZED — AAA command authorization says your ROLE cannot run it; re-authorize as a role that can. It says nothing about the feature. Non-claim.' }
    case 'config-locked': return { label: 'config-locked', meaning: 'the answer was 1006 COMMAND_CONFIG_LOCKED — something holds the config lock and nothing reached the CLI grammar. Fix the pending session (the table below lists them; the transaction center is #79); do not retry blindly. Non-claim.' }
    case 'unknown': return { label: 'unknown', meaning: 'the answer carried a code outside DR-010\u2019s closed set or no per-command detail at all. This client classifies what it can and refuses to guess the rest. Non-claim.' }
  }
}

/** The candidate-level rows under one feature, from the raw outcome — the fold in `features` drops
 *  the command text, the code, and the batch each candidate rode, and #77's verdict table needs all
 *  three (that is why PR #130 passed `lastOutcome` through the hook). */
export function candidateRows(feature: string, outcome: ProbeCommandsOutcome | undefined): readonly {
  command: string; verdict: CapabilityVerdict; label: string; meaning: string; codeText: string; batch: string
}[] {
  if (outcome === undefined) return []
  return outcome.results
    .filter((result: CommandProbeResult) => result.features.includes(feature))
    .map((result) => {
      const facts = verdictFacts(result.verdict)
      const codeText = result.code === undefined
        ? (result.codeName ?? 'no code carried')
        : `${String(result.code)} ${result.codeName ?? 'unmapped'}`
      return { command: result.command, verdict: result.verdict, label: facts.label, meaning: facts.meaning, codeText, batch: `batch ${String(result.batchIndex)}` }
    })
}

/** One candidate per line, one block per feature. Deliberately carries NO device `message` prose and
 *  no endpoint name: device wording is this unit's phrasing (model-general claims must not ride into
 *  a DECISIONS note unlabelled), and the endpoint is switch identity the operator writes by hand
 *  where needed. The F8 scan then runs over the result as a second net, not as the primary defence. */
export function buildExport(view: CapabilitiesView, sets: readonly QuestionSet[]): { text: string; findings: readonly GuardFinding[] } {
  const outcome = view.lastOutcome
  const lines: string[] = [
    '# Capability probe export — command presence only (never a capacity/licensing/platform claim; epic open item 6)',
    `# probedAt ${String(view.probedAt ?? 0)} · source ${view.lastProbeSource ?? 'unknown'} · batches ${String(outcome?.batchCount ?? 0)}`,
  ]
  if (outcome !== undefined) {
    lines.push(`# probe session ${outcome.session.name}: state ${outcome.session.state}, guaranteed abort sent: ${String(outcome.session.aborted)}, no-commit: ${String(outcome.session.noCommit)}`)
  }
  if (view.configLocked) lines.push('# the run reported the config lock (1006): the candidates below never reached the CLI grammar')
  for (const set of sets) {
    const fold = view.features.find((feature) => feature.name === set.name)
    lines.push('', `${set.name}: ${fold?.display ?? 'not probed'}${fold === undefined ? '' : ` — ${fold.reason}`}`)
    for (const row of candidateRows(set.name, outcome)) {
      lines.push(`  ${row.verdict.padEnd(14)} ${row.command}   [code: ${row.codeText}]`)
    }
  }
  const text = `${lines.join('\n')}\n`
  return { text, findings: scanText('capability-export', text) }
}

/** The run-status line the panel prints under the table: client verdict counts, no fold invention. */
export function summarize(outcome: ProbeCommandsOutcome | undefined): string {
  if (outcome === undefined) return 'No probe has answered in this page load.'
  const parts = (Object.keys(outcome.summary) as CapabilityVerdict[])
    .map((verdict) => ({ verdict, count: outcome.summary[verdict] }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${String(entry.count)} ${entry.verdict}`)
  const anyInconclusive = outcome.results.some((result) => isInconclusiveVerdict(result.verdict))
  return `${parts.join(', ')} across ${String(outcome.results.length)} candidate(s) in ${String(outcome.batchCount)} batch(es); inconclusive run: ${String(anyInconclusive)}`
}
