/**
 * S4 (#74): the guard table, the completion-insertion arithmetic, the reply renderer and the code
 * meanings — the parts of the console that decide what reaches a switch, offline and without React.
 *
 * The refusal cases are the point of this file. Each one states which rule fired (`reason`), so a later
 * change to the tables cannot silently turn a refusal into a send: the issue's acceptance line is that a
 * non-read is refused with a clear message and **no path to bypass it**, and the module header records why
 * the rule is an allow-list on 4.28 (the exec-mode surface is plugin-registered; and the pipe tail can
 * write a file or reach `/bin/sh -c` regardless of the first token).
 *
 * Source refs below are to the extracted EOS 4.28.13.1M Python (`arista/eos-sqsh-4.28.13.1M/` for the
 * pinned four files, and the `CliPlugin`/`ShowCommand.py` copies re-extracted from `Base.sqsh` for the
 * grammar rows). They are source readings, not wire captures — `arista-api-client/docs/HARDWARE-CAPTURE.md`
 * keeps the completions/help round trips uncaptured, and no test here claims otherwise.
 */
import { describe, expect, it } from 'vitest'
import { CommandError, EapiErrorCode, parseCommandCompletions, parseCommandHelp } from '@devhax-heavy-industries/arista-eapi'
import type { ExecResult } from '@devhax-heavy-industries/arista-eapi'

import {
  applyCompletion,
  completionComplete,
  completenessHint,
  describeFailure,
  guardConsoleCommand,
  helpFacts,
  lineShapeRefusal,
  renderExecEntry,
} from './command-guard'

const verdict = (input: string) => guardConsoleCommand(input)

describe('guardConsoleCommand — the reads it accepts', () => {
  it('accepts a bare show, and `sh` because the vendor grammar declares it as an alternate', () => {
    for (const input of ['show version', 'sh version', 'SHOW vlans', 'sh running-config']) {
      const result = verdict(input)
      expect(result.ok, input).toBe(true)
    }
  })

  it('accepts one built-in pipe filter and trims the command it hands back', () => {
    const result = verdict('   show running-config | section interface Ethernet1   ')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command).toBe('show running-config | section interface Ethernet1')
  })

  it('accepts the whole built-in filter set the CLI implements as fixed argv', () => {
    for (const filter of ['include VLAN', 'exclude Management', 'begin ip route', 'section interface', 'nz', 'json', 'no-more']) {
      const result = verdict(`show running-config | ${filter}`)
      expect(result.ok, filter).toBe(true)
    }
  })
})

describe('guardConsoleCommand — the lines it refuses', () => {
  it('refuses the empty line without claiming anything was sent', () => {
    for (const input of ['', '   ', '\t']) {
      const result = verdict(input)
      expect(result.ok, JSON.stringify(input)).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('empty')
    }
  })

  it('refuses every configuration-mode entry, including the `configure all` spelling exec() allows', () => {
    const cases = [
      'configure',
      'configure terminal',
      'configure session ui-9f2c1a7b',
      'configure replace flash:baseline',
      // The client deliberately lets this through `exec()` (MIGRATION.md §5 row 32) because it is an
      // executive-mode command — and it writes. Hence the screen-level refusal.
      'configure all Ethernet1 description staged-by-console',
      'interface Ethernet1',
      'vlan 100',
      'router ospf 1',
      'vrf context mgmt',
      'system mac address-table learning',
    ] as const
    for (const input of cases) {
      const result = verdict(input)
      expect(result.ok, input).toBe(false)
      if (result.ok) continue
      expect(result.reason, input).toBe('config-mode')
      expect(result.refusal, input).toMatch(/read-only/u)
      expect(result.refusal, input).not.toMatch(/try again|or use|instead send/u)
    }
  })

  it('refuses the mutating exec verbs #74 names, plus the ones only the source shows', () => {
    const expected: Readonly<Record<string, RegExp>> = {
      'copy running-config startup-config': /writes a file or a config store/u,
      'write memory': /startup-config/u,
      // `reload` alone is refused over eAPI, `reload now` is NOT (CliPlugin/ReloadCli.py:373).
      'reload now': /reboots/u,
      'delete flash:overlay.json': /removes a file/u,
      'erase startup-config': /clears a filesystem/u,
      'clear arp': /not a read/u,
      'test aaa group TACACS user op legal yes': /side effects/u,
      // `bash timeout 30 <cmd>` runs /bin/bash -c (CliPlugin/ShellCli.py:60).
      'bash timeout 30 cat /var/log/syslog': /bin\/bash/u,
      'tcpdump -i Ethernet1 -w flash:cap.pcap': /captures live packets/u,
      'ztp run': /zero-touch/u,
    }
    for (const [input, fragment] of Object.entries(expected)) {
      const result = verdict(input)
      expect(result.ok, input).toBe(false)
      if (result.ok) continue
      expect(result.reason, input).toBe('write-verb')
      expect(result.refusal, input).toMatch(fragment)
    }
  })

  it('refuses a non-show first token by rule, and names the filesystem reads the allow-list also excludes', () => {
    for (const input of ['dir', 'more flash:boot-logic', 'pwd', 'verify /md5 flash:test', 'diff flash:a flash:b']) {
      const result = verdict(input)
      expect(result.ok, input).toBe(false)
      if (result.ok) continue
      expect(result.reason, input).toBe('not-a-read')
      expect(result.refusal, input).toMatch(/deny-list would only name/u)
    }
  })

  it('refuses an abbreviation rather than letting the device guess, and says eAPI does not complete tokens', () => {
    for (const input of ['sho version', 's version', 'ver', 'sho vlan sw']) {
      const result = verdict(input)
      expect(result.ok, input).toBe(false)
      if (result.ok) continue
      expect(result.reason, input).toBe('not-a-read')
      expect(result.refusal, input).toMatch(/does not expand abbreviations/u)
      expect(result.refusal, input).toMatch(/JsonCli\.py:335-339/u)
    }
  })

  it('refuses `;` because the raw-text request form splits on it', () => {
    const result = verdict('show vlans; reload now')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('command-separator')
    expect(result.offender).toBe(';')
    expect(result.refusal).toMatch(/JsonCli\.py:375-390/u)
  })

  it('refuses the redirect and shell-substitution grammar a `show` line can otherwise carry', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['show running-config > flash:dump.txt', '>'],
      ['show running-config >> flash:dump.txt', '>'],
      ['show version | include `id`', '`'],
      ['show version | include $(uname)', '$('],
      ['show version && reload now', '&&'],
      ['show version || clear arp', '||'],
      ['show running-config < flash:in.txt', '<'],
    ]
    for (const [input, offender] of cases) {
      const result = verdict(input)
      expect(result.ok, input).toBe(false)
      if (result.ok) continue
      expect(result.reason, input).toBe('shell-metacharacter')
      expect(result.offender, input).toBe(offender)
      expect(result.refusal, input).toMatch(/ShowCommand\.py:52-75/u)
    }
  })

  it('refuses a pipe filter that is not a built-in, naming the /bin/sh -c path it prevents', () => {
    const program = verdict('show version | grep -c Version')
    expect(program.ok).toBe(false)
    if (program.ok) return
    expect(program.reason).toBe('pipe-filter')
    expect(program.offender).toBe('grep')
    expect(program.refusal).toMatch(/bin\/sh/u)

    const redirect = verdict('show running-config | redirect flash:dump.txt')
    expect(redirect.ok).toBe(false)
    if (redirect.ok) return
    expect(redirect.reason).toBe('pipe-filter')
    expect(redirect.offender).toBe('redirect')
    expect(redirect.refusal).toMatch(/writes the output to a file/u)

    const tee = verdict('show startup-config | tee flash:copy.txt')
    expect(tee.ok).toBe(false)
    if (tee.ok) return
    expect(tee.reason).toBe('pipe-filter')
    expect(tee.offender).toBe('tee')
  })

  it('refuses more than one pipe instead of widening the tail', () => {
    const result = verdict('show running-config | include ethernet | exclude Management')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('pipe-count')
    expect(result.refusal).toMatch(/2 pipes/u)
  })

  it('refuses control characters and Unicode line breaks, which an <input> does not strip', () => {
    const bel = verdict('show version\u0007')
    expect(bel.ok).toBe(false)
    if (bel.ok) return
    expect(bel.reason).toBe('control-character')

    const ls = verdict('show version\u{2028}reload now')
    expect(ls.ok).toBe(false)
    if (ls.ok) return
    expect(ls.reason).toBe('line-separator')
    expect(ls.offender).toBe('U+2028')
  })
})

describe('lineShapeRefusal — the query path keeps the character rules only', () => {
  it('allows a mutating word, because completions/help ask the CLI about text rather than running it', () => {
    // `getCommandCompletions`/`getCommandHelp` never execute the line they are given
    // (`JsonCli.py:174-203` → `CliApi.py:623-648`, `:442-462`); this is also why the console does the
    // word guard once, for the command path only.
    expect(lineShapeRefusal('configure')).toBeUndefined()
    expect(lineShapeRefusal('sho ver')).toBeUndefined()
    expect(lineShapeRefusal('conf')).toBeUndefined()
  })

  it('still refuses a smuggled second line', () => {
    expect(lineShapeRefusal('show version\u0000reload now')?.reason).toBe('control-character')
    expect(lineShapeRefusal('show version; reload')?.reason).toBe('command-separator')
    expect(lineShapeRefusal('show run > flash:x')?.reason).toBe('shell-metacharacter')
  })
})

describe('applyCompletion — the device keys on the last word only', () => {
  it('replaces the last token, which is what the device returned it for', () => {
    // `CliApi.py:623-641`: partialToken is the last token (or '' when the line ends with whitespace),
    // and the keys are whole tokens — `JsonCli.py:174-192`'s own examples.
    expect(applyCompletion('sh', 'show')).toBe('show')
    expect(applyCompletion('sh int', 'interfaces')).toBe('sh interfaces')
    expect(applyCompletion('sh ver', 'version')).toBe('sh version')
    expect(applyCompletion('', 'show')).toBe('show')
  })

  it('appends, never doubles, when the last word is already finished — and keeps the trailing space', () => {
    expect(applyCompletion('show ', 'version')).toBe('show version')
    expect(applyCompletion('show version ', 'all')).toBe('show version all')
  })
})

describe('the completeness question', () => {
  it('passes the device answer through without inventing a default', () => {
    expect(completionComplete(parseCommandCompletions({ completions: { show: 'Display details of switch operation' }, complete: true, errors: {} }))).toBe(true)
    expect(completionComplete(parseCommandCompletions({ completions: {}, complete: false, errors: {} }))).toBe(false)
    expect(completionComplete(parseCommandCompletions({ completions: {}, errors: {} }))).toBeUndefined()
  })

  it('tells the operator why it cannot answer for a line with no trailing space', () => {
    expect(completenessHint('sh version')).toMatch(/does not end with a space/u)
    expect(completenessHint('sh version ')).toMatch(/trailing space/u)
    expect(completenessHint('')).toMatch(/trailing space/u)
  })
})

describe('helpFacts — the help reply is un-filtered, the completion reply is not', () => {
  it('hides the structural tokens and reports the non-string help values', () => {
    const help = parseCommandHelp({
      version: 'Software revision info',
      'sh': 'alternate of show',
      '<cr>': '',
      '|': 'Command output pipe filters',
      '>': '',
      '>>': '',
      mtu: 5,
    })
    const facts = helpFacts(help)
    expect(facts.entries.map((entry) => entry.name)).toEqual(['version', 'sh'])
    expect(facts.hidden).toEqual(['<cr>', '|', '>', '>>'])
    expect(facts.unparsed).toEqual(['mtu'])
  })
})

describe('renderExecEntry — what the encoding label claims', () => {
  const entry = (over: Partial<ExecResult>): ExecResult => ({
    command: 'show version',
    result: {},
    encoding: 'json',
    fellBack: false,
    ...over,
  })

  it('reports a `{output}` JSON answer as model-backed text', () => {
    const made = renderExecEntry(entry({ result: { output: 'Hardware:\n  serial number   : 0529KSFC' } }))
    expect(made.text).toMatch(/serial number/u)
    expect(made.modelBacked).toBe(true)
    expect(made.json).toBe(false)
    expect(made.empty).toBe(false)
  })

  it('re-serialises a modelled answer as JSON text and counts its members', () => {
    const made = renderExecEntry(entry({ result: { version: '4.28.13.1M', hostname: 'sw1' } }))
    expect(made.json).toBe(true)
    expect(made.fields).toBe(2)
    expect(JSON.parse(made.text)).toEqual({ version: '4.28.13.1M', hostname: 'sw1' })
  })

  it('names the 1003 → format:text repair, which is the label #74 requires', () => {
    const made = renderExecEntry(entry({ command: 'show session-config diffs', encoding: 'text', fellBack: true, result: { output: '+  vlan 20' } }))
    expect(made.modelBacked).toBe(false)
    expect(made.fellBack).toBe(true)
    expect(made.encoding).toBe('text')
  })

  it('calls an answered-but-nothing-renderable reply empty, not failed', () => {
    expect(renderExecEntry(entry({ result: {} })).empty).toBe(true)
    expect(renderExecEntry(entry({ result: { output: '   ' } })).empty).toBe(true)
    expect(renderExecEntry(entry({ result: { output: '' } })).text).toBe('')
  })

  it('survives a reply whose output is not a string instead of crashing the pane', () => {
    const made = renderExecEntry(entry({ result: { output: null } }))
    expect(made.json).toBe(true)
    expect(made.text).toMatch(/"output": null/u)
  })
})

describe('describeFailure — the code meanings #74 has to render', () => {
  it('maps 1002 to the one verdict allowed to read as unavailable (DR-062)', () => {
    const facts = describeFailure(new CommandError(EapiErrorCode.COMMAND_INVALID, 'Error [1002]: invalid command [% Invalid command (at token 1: sho)]', { requestId: 'webui-7' }))
    expect(facts.code).toBe(1002)
    expect(facts.codeName).toBe('COMMAND_INVALID')
    expect(facts.meaning).toMatch(/ONLY code/u)
    expect(facts.meaning).toMatch(/DR-062/u)
    expect(facts.requestId).toBe('webui-7')
  })

  it('maps 1005 to command authorization, not to a syntax problem', () => {
    const facts = describeFailure(new CommandError(EapiErrorCode.COMMAND_UNAUTHORIZED, 'Error [1005]: permission to run command denied [Authorization denied for command \'show tech-support\']'))
    expect(facts.codeName).toBe('COMMAND_UNAUTHORIZED')
    expect(facts.meaning).toMatch(/authorization/u)
    expect(facts.meaning).toMatch(/re-authenticate/iu)
  })

  it('maps 1006 to the config lock and points at the transaction center', () => {
    const facts = describeFailure(new CommandError(EapiErrorCode.COMMAND_CONFIG_LOCKED, 'Error [1006]: configuration locked [Unable to run this command (configuration is locked by another session)]'))
    expect(facts.codeName).toBe('COMMAND_CONFIG_LOCKED')
    expect(facts.meaning).toMatch(/transaction center/u)
  })

  it('maps 1004 apart from 1002, and refuses to invent a meaning for a code outside the 4.28 set', () => {
    expect(describeFailure(new CommandError(EapiErrorCode.COMMAND_INCOMPATIBLE, 'Error [1004]: incompatible command [Command not permitted via API access.]')).meaning).toMatch(/refuses it over eAPI/u)
    const odd = describeFailure(new CommandError(9999, 'Error [9999]: strange'))
    expect(odd.codeName).toBe('unknown (9999)')
    expect(odd.meaning).toMatch(/cannot claim what it means/u)
    expect(odd.code).toBe(9999)
  })

  it('says plainly when the answer never came from the CLI', () => {
    const facts = describeFailure(new Error('connect ECONNREFUSED 127.0.0.1:8080'))
    expect(facts.code).toBeUndefined()
    expect(facts.message).toMatch(/ECONNREFUSED/u)
    expect(facts.meaning).toMatch(/No device answer/u)
  })
})
