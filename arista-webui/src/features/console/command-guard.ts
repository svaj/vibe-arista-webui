/**
 * S4 (#74): the read-only guard, reply rendering, and error meaning behind the command console.
 *
 * This module is deliberately React-free so the safety rules are testable as data: the console's whole
 * job is to turn an operator's one typed line into (a) exactly one read on the device or (b) a refusal
 * that says which rule stopped it. The client already refuses `configure …` inside `exec()`
 * (`arista-api-client/src/command-layer.ts`, `isConfigModeCommand`, MIGRATION.md §5 row 32) — and
 * **deliberately lets `configure all <intf> <cmd>` through**, because that is an executive-mode command
 * that writes the running-config on each interface. A screen whose promise is "this console is
 * read-only" cannot inherit that exception, so the screen owns a stricter rule: an allow-list.
 *
 * ## Why an allow-list and not the issue's deny-list
 *
 * The exec-mode command surface on 4.28 is registered by dozens of CLI plugins — `bash`, `copy`,
 * `clear`, `test`, `tcpdump`, `reload now`, `dir`, `more`, `verify`, `session`, `debug` — so any list of
 * refused verbs is a list of the ones somebody remembered. Verified in the extracted 4.28.13.1M image:
 *
 * - `bash timeout <1-32000> …` runs `/bin/bash -c` (`CliPlugin/ShellCli.py:60`), and bare `reload` is
 *   refused over eAPI while `reload now` is NOT (`CliPlugin/ReloadCli.py:373`,
 *   `EapiIncompatible(overrideFn=isReloadNow…)`).
 * - The real hazard for a `show`-only console is the **pipe tail**, not the first token: the pipe
 *   grammar accepts `| include|exclude|begin|section|nz|json|no-more` (fixed argv, e.g.
 *   `['grep', '-aEe', PATTERN]`) but also `| redirect|append|tee <url>` and bare `>` / `>>`
 *   (`ShowCommand.py:52-75`, `UrlMatcher(lambda fs: fs.supportsWrite())`) and `| <program> <args>`,
 *   whose adapter sets `['/bin/sh', '-c', progName + ' ' + progArgs]` (`ShowCommand.py:208-214`).
 *   So `show version | grep x && reload now` is a shell string, and `show running-config > flash:x`
 *   is a file write with a perfectly innocent-looking `show` first token.
 *
 * Hence: the first token must be `show` or its declared alternate `sh`, at most one pipe, that pipe must
 * name a built-in filter, and no shell/file metacharacters anywhere.
 *
 * ## Abbreviations are not expanded over eAPI
 *
 * `show` declares `alternates=['sh']` and matches it exactly (`ShowCommand.py:42-46` — the comment says
 * it is there precisely because `shutdown` also starts with `sh`). Everything else (`s`, `sho`, `ver`)
 * only resolves through the parser's completion fallback, which raises `IncompleteTokenError` when
 * `autoComplete` is off — and `runCmds` defaults `autoComplete=False` (`JsonCli.py:335-339`), while
 * `getCommandCompletions` leaves it at its `True` default, which is why the vendor docstring's
 * `'sh int' → ['interfaces']` example is true for completions and false for executed commands
 * (`JsonCli.py:174-192`, `CliApi.py:669`). The console therefore accepts `sh` because it is a declared
 * alternate, sends the line verbatim, and never sets `autoComplete` — silently completing a typo the
 * moment a prefix becomes unique is how a read console would end up running something else.
 *
 * ## The `;` rule
 *
 * A `;` inside one `runCmds` entry is not a separator — the CLI tokenizes on whitespace only. But the
 * **raw-text** request form does split on `[\n\r;]+` (`JsonCli.py:375-390` → `handlePostRawText`), and
 * this app reaches eAPI through a local proxy that could re-form a body. The console sends one command,
 * so a line containing `;` is refused rather than guessed about.
 *
 * ## What a refusal never is
 *
 * A refusal is not an error state: it composes no request, so nothing reaches the device. It is rendered
 * in the same failure slot as a device `CommandError` (one message channel), and its text always names
 * the rule and where it comes from, never a way around it (issue #74: "never offer a path to bypass it").
 */
import { CommandError, eapiErrorName } from '@devhax-heavy-industries/arista-eapi'
import type { CommandCompletion, CommandCompletions, CommandHelp, CommandResult, ExecResult } from '@devhax-heavy-industries/arista-eapi'

import { errorMessage } from '../../shared/load-state'

/** Which rule stopped a line. The console renders `refusal` text; this is for tests and the copy. */
export type ConsoleRefusalReason =
  | 'empty'
  | 'control-character'
  | 'line-separator'
  | 'command-separator'
  | 'shell-metacharacter'
  | 'pipe-count'
  | 'pipe-filter'
  | 'config-mode'
  | 'write-verb'
  | 'not-a-read'

/** The line the console may send, as one string command spec — never `{cmd, input}`. */
export interface ConsoleRead {
  readonly ok: true
  /** The command text to put on the wire: the typed line, trimmed. */
  readonly command: string
}

/** Why the console will not send the line. No request is composed for this verdict. */
export interface ConsoleRefusal {
  readonly ok: false
  readonly reason: ConsoleRefusalReason
  /** The offending token/word, quoted into the message so the operator can see what matched. */
  readonly offender: string
  /** Operator-facing text: the rule, its source, and no bypass. */
  readonly refusal: string
}

export type ConsoleGuard = ConsoleRead | ConsoleRefusal

/**
 * `show` plus the one alternate the vendor grammar declares for it (`ShowCommand.py:42-46`). Not a
 * general abbreviation rule — see the module header for why `s`/`sho` are left to the device.
 */
const READ_TOKENS: readonly string[] = ['show', 'sh']

/**
 * The pipe filters the CLI implements as fixed argv (no shell): `ShowCommand.py:84-86, 133-178`
 * (`include`/`exclude`/`begin`/`section`/`nz` plus `no-more`). Anything else after `|` is either a file
 * redirection (`redirect`/`append`/`tee`/`>`/`>>`) or an arbitrary program run through `/bin/sh -c`.
 */
const BUILTIN_FILTERS: readonly string[] = ['include', 'exclude', 'begin', 'section', 'nz', 'json', 'no-more']

/** Filter words the grammar accepts but that WRITE, so they are named in the refusal rather than allowed. */
const REDIRECT_FILTERS: readonly string[] = ['redirect', 'append', 'tee']

/**
 * Characters the pipe/redirect/shell grammar is made of. `>` and the backtick/`$(` pair are what turn a
 * `show` into a file write or a shell string (`ShowCommand.py:52-75`, `:208-214`); the vendor's own
 * name pattern excludes the same set — `[^\s|>&;` + backtick + `$()\\]+` with the comment "characters
 * that might be troublesome in show commands, where pipe or redirection might be a problem, or where
 * shell substitution would be problematic" (`CliParserCommon.py:854-858`).
 */
const BANNED_SUBSTRINGS: readonly (readonly [string, string])[] = [
  ['`', 'command substitution'],
  ['$(', 'command substitution'],
  ['>', 'output redirection to a file'],
  ['<', 'input redirection'],
  ['&&', 'a shell command list'],
  ['||', 'a shell alternative'],
]

/**
 * First tokens that ENTER configuration (or apply config from exec). Named individually because the
 * message differs per case and because `configure all` is the hole the client intentionally leaves open.
 */
const CONFIG_MODE_WORDS: readonly string[] = [
  'configure', 'config', 'interface', 'vlan', 'router', 'vrf', 'vxlan', 'peer-ip', 'peer-address',
  'class', 'class-map', 'policy-map', 'profile', 'port-group', 'queue-monitor', 'system', 'quantity',
]

/** First tokens that are exec-mode but mutate state. Each reason is a property of the command, not a guess. */
const WRITE_WORDS: ReadonlyMap<string, string> = new Map<string, string>([
  ['copy', 'it writes a file or a config store — `copy … running-config` changes the configuration'],
  ['write', '`write memory` replaces startup-config and `write erase` removes it'],
  ['reload', '`reload now` reboots the switch; bare `reload` is refused over eAPI but the alternate is not (CliPlugin/ReloadCli.py:373)'],
  ['delete', 'it removes a file'],
  ['erase', 'it clears a filesystem'],
  ['mkdir', 'it changes the filesystem'],
  ['rmdir', 'it changes the filesystem'],
  ['rename', 'it changes the filesystem'],
  ['eject', 'it powers/physically ejects a module or removable media'],
  ['clear', 'it resets counters, ARP/MAC tables, or user sessions — a write, not a read'],
  ['test', 'it has side effects: cable tests, SNMP notifications, AAA round trips'],
  ['tcpdump', 'it captures live packets and `-w` writes a capture file'],
  ['bash', 'it runs `/bin/bash -c …` when given a timeout (CliPlugin/ShellCli.py:60)'],
  ['session', 'it is an interactive session command'],
  ['debug', 'it changes switch behaviour at the enable level'],
  ['ztp', 'it runs zero-touch provisioning'],
  ['install', 'it installs software'],
])

/** Reads that are genuine but not `show` — this console's allow-list excludes them, so the message says so. */
const OTHER_READ_WORDS: readonly string[] = ['dir', 'more', 'pwd', 'verify', 'diff', 'show']

/** The single-token form of a line, lower-cased for the word tables above. */
const firstWord = (line: string): string => line.trim().split(/\s+/u)[0] ?? ''

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point <= 0x1f || point === 0x7f
  })

/** NEL / LINE SEPARATOR / PARAGRAPH SEPARATOR: an `\n`-shaped break that a `<input>` does not strip. */
const LINE_SEPARATORS = /[\u0085\u2028\u2029]/u

const refusal = (reason: ConsoleRefusalReason, offender: string, text: string): ConsoleRefusal => ({
  ok: false,
  reason,
  offender,
  refusal: text,
})

/**
 * The character-level rules: is this text ONE command line, and does it carry any of the shell/redirect
 * grammar? Shared by the command guard and by the completion/help queries, which are questions about the
 * CLI rather than commands, but still must not smuggle a second line or a redirect past the console.
 * `undefined` means the shape is acceptable.
 */
export function lineShapeRefusal(input: string): ConsoleRefusal | undefined {
  if (hasControlCharacter(input)) {
    return refusal(
      'control-character',
      'a control character',
      'The line contains a control character. One command per line, and the client refuses control characters in any spliced CLI token for the same reason (`arista-api-client/src/internal/wire.ts`, `assertPreamble` — the device executes such a string as one CLI line).',
    )
  }
  const separator = LINE_SEPARATORS.exec(input)?.[0]
  if (separator !== undefined) {
    return refusal(
      'line-separator',
      `U+${separator.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`,
      'The line contains a Unicode line/paragraph separator. The CLI tokenizes on whitespace, so this reads as a line break to the parser; an HTML input does not strip it, so this console refuses it instead of sending a two-line command.',
    )
  }
  if (input.includes(';')) {
    return refusal(
      'command-separator',
      ';',
      'The line contains `;`. One `runCmds` entry does not split on it (the CLI tokenizes on whitespace), but the raw-text request form splits the body on `[\\n\\r;]+` (`JsonCli.py:375-390` of the 4.28 image) — this console sends exactly one command, so the character is refused rather than passed through.',
    )
  }
  for (const [banned, what] of BANNED_SUBSTRINGS) {
    if (input.includes(banned)) {
      return refusal(
        'shell-metacharacter',
        banned,
        `The line contains \`${banned}\`, which the CLI pipe grammar reads as ${what}. The 4.28 grammar sends a non-built-in filter through \`/bin/sh -c\` and accepts \`>\`/\`>>\`/\`redirect\`/\`append\`/\`tee <url>\` as file writes (\`ShowCommand.py:52-75\`, \`:208-214\`), so a read-only console refuses it.`,
      )
    }
  }

  return undefined
}

/**
 * Decide whether ONE typed line may be sent to the device as a read.
 *
 * Order matters: the character rules run first, because control characters and separators change how
 * many commands a line is; the pipe grammar runs next, because the tail of a pipe can write a file or
 * start a shell no matter what the first token says; the token allow-list runs last, on a line that is
 * known to be exactly one read-shaped command.
 */
export function guardConsoleCommand(input: string): ConsoleGuard {
  if (input.trim() === '') {
    return refusal('empty', '', 'This console runs `show` commands, and the line was empty — type a command first.')
  }
  const shape = lineShapeRefusal(input)
  if (shape !== undefined) return shape

  const parts = input.trim().split('|')
  if (parts.length > 2) {
    return refusal(
      'pipe-count',
      '|',
      `This console allows one pipe filter per line. The grammar can chain filters, and each extra \`|\` widens what the tail can become, so a line with ${String(parts.length - 1)} pipes is refused. Built-in filters here: ${BUILTIN_FILTERS.join(', ')}.`,
    )
  }
  if (parts.length === 2) {
    const filterWord = parts[1].trim().split(/\s+/u)[0] ?? ''
    if (!BUILTIN_FILTERS.includes(filterWord.toLowerCase())) {
      const redirect = REDIRECT_FILTERS.includes(filterWord.toLowerCase())
      return refusal(
        'pipe-filter',
        filterWord === '' ? '|' : filterWord,
        redirect
          ? `\`| ${filterWord} <url>\` writes the output to a file (\`ShowCommand.py:52-75\`), which is not a read. Allowed filters here: ${BUILTIN_FILTERS.join(', ')}.`
          : `The filter word \`${filterWord}\` is not one of the CLI's built-in filters (${BUILTIN_FILTERS.join(', ')}). Anything else after \`|\` is a program the CLI runs through \`/bin/sh -c\` (\`ShowCommand.py:208-214\` — "Filter command by common Linux tools"), so this read-only console refuses it.`,
      )
    }
  }

  const word = firstWord(input)
  const lowered = word.toLowerCase()
  if (READ_TOKENS.includes(lowered)) return { ok: true, command: input.trim() }

  if (CONFIG_MODE_WORDS.includes(lowered)) {
    return refusal(
      'config-mode',
      word,
      `\`${word}\` is a configuration-mode entry (or, for \`configure all <intf> <cmd>\`, an executive-mode command that writes the running-config on each interface — the client lets that one through \`exec()\` on purpose, MIGRATION.md §5 row 32, which is exactly why this screen does not). This console is read-only: it runs \`show\` reads and never a path into configuration.`,
    )
  }
  const why = WRITE_WORDS.get(lowered)
  if (why !== undefined) {
    return refusal('write-verb', word, `\`${word}\` is refused because ${why}. This console is read-only and offers no bypass.`)
  }
  if (OTHER_READ_WORDS.includes(lowered)) {
    return refusal(
      'not-a-read',
      word,
      `Only \`show\` (and its declared alternate \`sh\`) runs here, so \`${word}\` is refused even where it is a filesystem read (\`dir\`, \`more\`, \`pwd\`, \`verify\`, \`diff\`). The allow-list is deliberately the first token: the exec-mode surface on 4.28 is registered by dozens of CLI plugins, so a deny-list would only name the verbs somebody remembered.`,
    )
  }
  return refusal(
    'not-a-read',
    word,
    `\`${word}\` is not \`show\`, and eAPI does not expand abbreviations for an executed command (\`runCmds\` defaults \`autoComplete=False\`, \`JsonCli.py:335-339\`). This console sends one read command: \`show …\` (or \`sh …\`), with at most one built-in pipe filter.`,
  )
}

/**
 * Insert a completion the device offered.
 *
 * The device keys its answer on the LAST typed word only: `_getCompletionsHelper` sets
 * `partialToken = allTokens[-1]` and keeps the rest as the already-typed prefix, and the keys it returns
 * are whole tokens (`'sh' → show|shutdown`, `'sh int' → interfaces`), not suffixes
 * (`CliApi.py:623-641`, `JsonCli.py:174-192`). So the UI replaces the last token — appending would
 * produce `show show`, and trimming the field first would lose the trailing space that makes the
 * completeness answer observable at all (`CliApi.py:631`: `partialToken` is `''` only when the line ends
 * with whitespace).
 */
export function applyCompletion(partial: string, completion: string): string {
  const boundary = Math.max(partial.lastIndexOf(' '), partial.lastIndexOf('\t'))
  if (boundary === -1) return completion
  return partial.slice(boundary + 1) === '' ? `${partial}${completion}` : `${partial.slice(0, boundary + 1)}${completion}`
}

/**
 * `true`/`false` when the device answered the question, `undefined` when it did not — the client keeps
 * that distinction on purpose (`CommandCompletions#complete`, `command-layer.ts:449-455`), and so does this.
 */
export function completionComplete(completions: CommandCompletions): boolean | undefined {
  return completions.complete
}

/**
 * A line typed without a trailing space can never be reported complete by the device, because `<cr>` is
 * only ever offered when `partialToken === ''` (`CliApi.py:631-637`, `JsonCli.py:189`). The hint tells
 * the operator why the panel cannot answer that question for the line as typed.
 */
export function completenessHint(partial: string): string {
  return partial === '' || /\s$/u.test(partial)
    ? 'Type a trailing space after the last complete word and ask again to have the device confirm the line is complete.'
    : 'The line does not end with a space, so the device is completing the last word rather than reporting the line finished — add a trailing space to ask whether the command is complete.'
}

/**
 * Keys `getCommandHelp` answers that `getCommandCompletions` filters out. `EXCLUDED_AUTOCOMPLETES`
 * (`JsonCli.py:35`) is applied only in `getCommandCompletions` (`:190`), while `getCommandHelp`
 * (`:200` → `CliApi.py:442`) returns the whole set — so the help pane has to drop them itself rather
 * than offering a `>` the guard would refuse.
 */
const HELP_STRUCTURAL_TOKENS: readonly string[] = ['<cr>', '|', '>', '>>']

export interface HelpFacts {
  /** Prose help the operator can act on. */
  readonly entries: readonly CommandCompletion[]
  /** Structural keys the help pane hides, named so the panel can say it hid them. */
  readonly hidden: readonly string[]
  /**
   * Tokens whose value was not a string. The CLI assigns a guard CODE to `help` for some commands
   * (`CliApi.py:646-650`, whose own comment calls that a bug), so a non-string here is the device
   * saying "not available for this platform" — the client reports it in `CommandHelp#unparsed`
   * rather than softening it to '' (`command-layer.ts`, `parseCommandHelp`).
   */
  readonly unparsed: readonly string[]
}

export function helpFacts(help: CommandHelp): HelpFacts {
  return {
    entries: help.entries
      .filter((entry) => !HELP_STRUCTURAL_TOKENS.includes(entry.token))
      .map((entry) => ({ name: entry.token, help: entry.help })),
    hidden: help.entries.filter((entry) => HELP_STRUCTURAL_TOKENS.includes(entry.token)).map((entry) => entry.token),
    unparsed: help.unparsed,
  }
}

/** One console reply, already reduced to the text the output pane renders (never HTML — issue #74). */
export interface ConsoleOutput {
  /** Device `output` text verbatim, or the JSON reply re-serialised as text. */
  readonly text: string
  /** The encoding the device actually answered with: `json` or `text`. */
  readonly encoding: string
  /** A `1003 COMMAND_UNCONVERTED` forced the `format:'text'` retry (DR-012). */
  readonly fellBack: boolean
  /** `true` = a JSON model answered; `false` = text, either asked for or fallen back to. */
  readonly modelBacked: boolean
  /** The reply was a JSON model with no `output` block, so it is shown as JSON text. */
  readonly json: boolean
  /** The device answered and the answer rendered to nothing. Empty is a state, not an error. */
  readonly empty: boolean
  /** How many JSON members the answer carried, when it was a JSON model. */
  readonly fields?: number
}

/**
 * Reduce one `exec()` entry to renderable text.
 *
 * `exec()` returns `{command, result, encoding, fellBack}` per command (`ExecResult`,
 * `command-layer.ts:125-137`; §5 rows 1/33 — DR-007 itself only bans pyeapi's duplicate `response` key),
 * and the codec auto-repairs a `1003` with a `format:'text'` re-send (DR-012), which is what `fellBack`
 * reports. The console surfaces that rather than hiding it: "model-backed" vs "text fallback (not
 * model-backed)" are different answers about the device.
 */
export function renderExecEntry(entry: ExecResult): ConsoleOutput {
  const modelBacked = entry.encoding === 'json' && !entry.fellBack
  // `CommandResult` is `Record<string, unknown>` (`src/types/eapi.ts:72`), but the answer is still read
  // defensively: `{output}` may be absent, null, or a non-string, and the JSON branch below is what
  // makes that visible to the operator instead of crashing the pane.
  const reply: CommandResult = entry.result ?? {}
  const output = reply['output']
  if (typeof output === 'string') {
    return {
      text: output,
      encoding: entry.encoding,
      fellBack: entry.fellBack,
      modelBacked,
      json: false,
      empty: output.trim() === '',
    }
  }
  const fields = typeof reply === 'object' && reply !== null ? Object.keys(reply).length : 0
  return {
    text: JSON.stringify(reply ?? null, null, 2),
    encoding: entry.encoding,
    fellBack: entry.fellBack,
    modelBacked,
    json: true,
    empty: fields === 0,
    fields,
  }
}

/** Operator-facing meaning of each device code, per DR-010's closed set and DR-062's wording rule. */
const CODE_MEANING: ReadonlyMap<number, string> = new Map<number, string>([
  [1000, 'the command parsed and the switch refused while running it — the text after the code is the CLI\'s own reason.'],
  [1001, 'the CLI raised an internal error. Note the source mapping has no case for a `requestTimeout` termination, so a timeout is expected to arrive here (uncaptured on this unit): treat it as "the device did not finish", not as "the command is invalid".'],
  [1002, 'the command text did not parse in exec mode. On this unit that covers an unknown or misspelled command, an unsupported abbreviation (eAPI does not complete tokens for an executed read), and a platform/license guard. This is the ONLY code that may be read as "not available here" (DR-062).'],
  [1003, 'the command has no JSON model for the API. This client re-sends it with `format:\'text\'` (DR-012), so the answer above is text — labelled, not presented as structured data.'],
  [1004, 'the command exists but EOS refuses it over eAPI (`CommandIncompatibleError`, and the plugin-level "not permitted via API access" guard). Some have a sanctioned spelling; this console will not guess one.'],
  [1005, 'the switch\'s command authorization refused this command for the authenticated API user (AAA authorization, not a syntax problem). Re-authenticate as a role whose policy permits it — nothing else about the request changes this answer.'],
  [1006, 'the configuration is locked by another session, so the command could not run. Inspect or abort the pending session in the transaction center (#79); a run refused this way says nothing about the command.'],
])

/** What the console shows beside a device or client failure. */
export interface ConsoleFailureFacts {
  /** The client/device message, verbatim (already redacted by the client — DR-011). */
  readonly message: string
  /** Device code, when the failure came from a device `error` envelope. */
  readonly code?: number
  /** `COMMAND_INVALID` etc. (`eapiErrorName`), so an operator can grep the EOS docs for it. */
  readonly codeName?: string
  /** Screen copy for that code; generic text for a failure that never reached the CLI. */
  readonly meaning: string
  /** The JSON-RPC id, so a device log line and this pane match (DR-017). */
  readonly requestId?: string

}

/**
 * Turn a thrown failure into displayable facts. A device `CommandError` carries `code`/`codeName`/
 * `requestId`; a transport or client failure does not, and gets copy that says plainly the request
 * never got a CLI answer.
 */
export function describeFailure(error: unknown): ConsoleFailureFacts {
  const message = errorMessage(error)
  if (error instanceof CommandError) {
    return {
      message,
      code: error.code,
      codeName: eapiErrorName(error.code),
      meaning: CODE_MEANING.get(error.code) ?? 'the code is not one of the EOS 4.28 set (`CliCommon.py:11-33`), so this client cannot claim what it means — the message above is the device\'s text.',
      ...(error.requestId === undefined ? {} : { requestId: String(error.requestId) }),
    }
  }
  return {
    message,
    meaning: 'No device answer: the client or transport refused/failed this request before the CLI ran it. Nothing was executed on the switch.',
  }
}
