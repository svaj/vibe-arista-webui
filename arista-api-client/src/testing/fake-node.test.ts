/**
 * `createFakeNode` specs (#61). The point is to prove the **seam**, not to re-prove `MockTransport`:
 * that the enable fold matches what a real `Node` actually puts on the wire, that the resource
 * layer parses the scripted answer through production code paths, and that the loud no-script
 * failure survives wiring so a screen test cannot silently pass on an empty device.
 */

import { describe, expect, it } from 'vitest'

import { CommandError, NotSupportedError } from '../errors'
import { createFakeNode } from './fake-node'

/** Verbatim shape from the repo's own running-config fixtures: indent-3 members under `vlan 10`. */
const TRUSTED_CONFIG = 'hostname fake\n!\nvlan 10\n   name TEN\n!\nvlan 20\n   name TWENTY\n!\n'

describe('createFakeNode(): the enable fold is the wire the client actually sends', () => {
  it('a one-command key answers the enable-prefixed batch with the ack slot folded in', async () => {
    const { node, transport } = createFakeNode({
      replies: { 'show running-config all': { output: TRUSTED_CONFIG } },
    })

    const vlans = await node.vlans.getAll()

    expect([...vlans.keys()]).toEqual([10, 20])
    // One request, enable at the front — the exact key the fold wrote.
    expect(transport.sent()).toEqual([['enable', 'show running-config all']])
    // Config TEXT reads go out as format:text (DR-012 keeps format:json for model reads) — another
    // reason this seam is scripted at device answers: the fold must not launder the request shape.
    expect(transport.bodies()[0]?.params.format).toBe('text')
  })

  it('a scripted object reply becomes [enableAck, reply] and parses as a real device answer', async () => {
    const { node, transport } = createFakeNode({
      replies: { 'show version': { modelName: 'DCS-7050TX-64', version: '4.28.13.1M' } },
    })

    const version = await node.show('version')

    expect(version.modelName).toBe('DCS-7050TX-64')
    expect(transport.sent()).toEqual([['enable', 'show version']])
    expect(transport.bodies()[0]?.params.format).toBe('json')
  })

  it('the fold follows the configDefaults flip: the bare running-config spelling gets its own key', async () => {
    const { node, transport } = createFakeNode(
      { replies: { 'show running-config': { output: TRUSTED_CONFIG } } },
      { settings: { configDefaults: false } },
    )

    const vlans = await node.vlans.getAll()

    expect(vlans.get(10)?.name).toBe('TEN')
    // configDefaults:false changes WHICH read goes out, and the one-command fold keys it correctly —
    // the `{}` enable ack is still prepended, so the answer stays positionally honest.
    expect(transport.sent()).toEqual([['enable', 'show running-config']])
  })

  it('rejects a command key containing a newline instead of inventing a doubled enable prefix', async () => {
    const build = (): unknown => createFakeNode({ replies: { 'enable\nshow vlan': { vlan: {} } } })
    expect(build).toThrow(TypeError)
    expect(build).toThrow(/ONE device command/u)
  })
})

describe('createFakeNode(): failures keep the production taxonomy', () => {
  it('an unscripted command is still a loud NotSupportedError, never an implicit {}', async () => {
    const { node } = createFakeNode()
    await expect(node.vlans.getAll()).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('a transport-level reject comes back as CommandError, the way a device refuses a write', async () => {
    const { node, transport } = createFakeNode()
    transport.rejects('enable\nconfigure terminal\nvlan 30', {
      code: 1002,
      message: "CLI command 3 of 3 'vlan 30' failed: invalid command",
    })

    const failure = await node.vlans.create(30).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(CommandError)
    expect((failure as CommandError).failedCommand).toBe('vlan 30')
    expect(transport.sent()).toEqual([['enable', 'configure terminal', 'vlan 30']])
  })
})

describe('createFakeNode(): a full config-session write cycle, end to end', () => {
  it('session → run → diff → commit drives the same batches as config-session.test.ts pins', async () => {
    const { node, transport } = createFakeNode()
    transport
      .replies('enable\nconfigure session ui-fake\ninterface Ethernet1\nswitchport mode access\nswitchport access vlan 20', [
        {}, {}, {}, {}, {},
      ])
      .replies('enable\nconfigure session ui-fake\nshow session-config diffs', [
        {}, {}, { output: '+interface Ethernet1\n+   switchport access vlan 20\n' },
      ])
      .replies('enable\nconfigure session ui-fake\ncommit', [{}, {}, {}])

    const session = await node.configSession({ name: 'ui-fake' })
    await session.run(['interface Ethernet1', 'switchport mode access', 'switchport access vlan 20'])
    const diff = await session.diff()
    expect(diff).toContain('switchport access vlan 20')
    expect(session.hasDiffBeenRead()).toBe(true)
    await session.commit()

    expect(session.state).toBe('committed')
    expect(transport.sent()).toEqual([
      ['enable', 'configure session ui-fake', 'interface Ethernet1', 'switchport mode access', 'switchport access vlan 20'],
      ['enable', 'configure session ui-fake', 'show session-config diffs'],
      ['enable', 'configure session ui-fake', 'commit'],
    ])
  })
})
