/**
 * B3 (#88) step 2: the pure rules behind `#/stp/global`. Every composed line is pinned
 * byte-for-byte to its capture (the header of ./stp-global-rules.ts cites which), the validators
 * accept the hardware capture's own sample values, and the risk/confirm copy is pinned to carry
 * the measured blast numbers + the DR-043 scoping sentence (DR-149: facts, not adjectives).
 */
import { describe, expect, it } from 'vitest'

import {
  STP_FAR_END_NOTE,
  STP_GLOBAL_MODES,
  STP_MODE_BLAST_FACTS,
  STP_MODE_NONE_FACTS,
  STP_REGION_IDENTITY_RISK,
  STP_REGION_INSTANCE_RISK,
  STP_REGION_REMOVAL_FACT,
  isStpGlobalModeChoice,
  parseStpRegionSection,
  stpModeConfirmation,
  stpModeLine,
  stpModeRisks,
  stpRapidPvstDisclosure,
  stpRegionChildLines,
  stpRegionDraftIsEmpty,
  stpRegionIdentityConfirmation,
  stpRegionNoInstanceLine,
  stpRegionRisks,
  validateStpInstanceId,
  validateStpRegionName,
  validateStpRegionRevision,
  validateStpVlanRanges,
} from './stp-global-rules'

describe('the mode line (capture-pinned spelling)', () => {
  it('offers exactly the three owner-approved values, nothing else', () => {
    expect(STP_GLOBAL_MODES).toEqual(['mstp', 'none', 'rapid-pvst'])
    expect(isStpGlobalModeChoice('mstp')).toBe(true)
    expect(isStpGlobalModeChoice('rapid-pvst')).toBe(true)
    // The camelCase device token belongs to `show` JSON, never to the config line (DR-148).
    expect(isStpGlobalModeChoice('rapidPvst')).toBe(false)
    expect(isStpGlobalModeChoice('rstp')).toBe(false)
    expect(isStpGlobalModeChoice('pvst')).toBe(false)
  })

  it('composes the hyphenated config-line spelling the captures sent', () => {
    expect(stpModeLine('mstp')).toBe('spanning-tree mode mstp')
    expect(stpModeLine('none')).toBe('spanning-tree mode none')
    expect(stpModeLine('rapid-pvst')).toBe('spanning-tree mode rapid-pvst')
  })

  it('never composes a no/default mode arm (DR-096 stays the only unset story)', () => {
    const all = STP_GLOBAL_MODES.map(stpModeLine)
    for (const line of all) {
      expect(line).toMatch(/^spanning-tree mode (mstp|none|rapid-pvst)$/u)
    }
  })
})

describe('the MST region block (hardware batch unblock-stp-mst-region-grammar)', () => {
  it('composes the capture sample byte-for-byte: name / revision / instance', () => {
    const lines = stpRegionChildLines({ name: 'LAB-UNBLOCK', revision: '1', instances: [{ id: '1', vlans: '100,110' }] })
    expect(lines).toEqual(['name LAB-UNBLOCK', 'revision 1', 'instance 1 vlan 100,110'])
  })

  it('stages ONLY what the operator changed — untouched fields emit no line', () => {
    expect(stpRegionChildLines({ instances: [{ id: '2', vlans: '200-210' }] })).toEqual(['instance 2 vlan 200-210'])
    expect(stpRegionChildLines({ revision: '7', instances: [] })).toEqual(['revision 7'])
    expect(stpRegionChildLines({ name: 'R1', instances: [] })).toEqual(['name R1'])
  })

  it('an empty draft is empty (the container refuses it at zero sessions)', () => {
    expect(stpRegionDraftIsEmpty({ instances: [] })).toBe(true)
    expect(stpRegionDraftIsEmpty({ name: '', instances: [] })).toBe(true)
    expect(stpRegionDraftIsEmpty({ instances: [{ id: '1', vlans: '10' }] })).toBe(false)
  })

  it('a draft with no removals composes no `no …` line at all', () => {
    const lines = stpRegionChildLines({ name: 'X', revision: '2', instances: [{ id: '3', vlans: '30' }] })
    for (const line of lines) expect(line).not.toMatch(/^no\s/u)
  })

  it('removals compose the capture-backed BARE `no instance <id>` (rea-q2, unblock-grammar-ceos.json), after the adds', () => {
    expect(stpRegionNoInstanceLine('3')).toBe('no instance 3')
    const lines = stpRegionChildLines({ instances: [{ id: '4', vlans: '40' }], removeInstances: [{ id: '1' }, { id: '2' }] })
    expect(lines).toEqual(['instance 4 vlan 40', 'no instance 1', 'no instance 2'])
  })

  it('a removal-only draft is NOT empty (the container must not refuse it)', () => {
    expect(stpRegionDraftIsEmpty({ instances: [], removeInstances: [{ id: '1' }] })).toBe(false)
    expect(stpRegionDraftIsEmpty({ instances: [], removeInstances: [] })).toBe(true)
  })
})

describe('parseStpRegionSection (the region read model)', () => {
  const section = [
    'spanning-tree mst configuration',
    '   name LAB-UNBLOCK',
    '   revision 1',
    '   instance 1 vlan 100,110',
    '   instance 2 vlan 200-210',
  ].join('\n')

  it('folds the capture-shaped block into name/revision/instances, device tokens verbatim', () => {
    const view = parseStpRegionSection(section)
    expect(view.name).toBe('LAB-UNBLOCK')
    expect(view.revision).toBe('1')
    expect(view.instances).toEqual([
      { id: '1', vlans: '100,110' },
      { id: '2', vlans: '200-210' },
    ])
    expect(view.unmodelledLines).toBe(0)
  })

  it('a header-only section answers "no fields, no instances" — never a crash', () => {
    const view = parseStpRegionSection('spanning-tree mst configuration\n')
    expect(view.name).toBeUndefined()
    expect(view.revision).toBeUndefined()
    expect(view.instances).toEqual([])
    expect(view.unmodelledLines).toBe(0)
  })

  it('an unrecognised line is COUNTED, not silently dropped (the editor never re-states it)', () => {
    const view = parseStpRegionSection('spanning-tree mst configuration\n   name R\n   some-future-kernel line\n')
    expect(view.name).toBe('R')
    expect(view.unmodelledLines).toBe(1)
  })

  it('reads the device\'s OWN double-space spelling (`instance 1 vlan  100,110`, both diffs)', () => {
    // The device normalizes the stored line to `vlan  100,110` (hardware batch diff AND
    // unblock-grammar-ceos.json rea-q0) — a single-space-only reader would count it unmodelled.
    const view = parseStpRegionSection('spanning-tree mst configuration\n   instance 1 vlan  100,110\n')
    expect(view.instances).toEqual([{ id: '1', vlans: '100,110' }])
    expect(view.unmodelledLines).toBe(0)
  })
})

describe('in-form validators (client grammar — the device keeps the say, DR-057)', () => {
  it('name: blank passes (untouched), the capture sample passes, shapes refuse', () => {
    expect(validateStpRegionName('')).toBeUndefined()
    expect(validateStpRegionName('LAB-UNBLOCK')).toBeUndefined()
    expect(validateStpRegionName('has space')).toMatch(/1-32 printable/u)
    expect(validateStpRegionName('x'.repeat(33))).toMatch(/1-32 printable/u)
  })

  it('revision: 1 and 65535 pass; 0, 65536, and non-numbers refuse', () => {
    expect(validateStpRegionRevision('')).toBeUndefined()
    expect(validateStpRegionRevision('1')).toBeUndefined()
    expect(validateStpRegionRevision('65535')).toBeUndefined()
    expect(validateStpRegionRevision('0')).toMatch(/1 to 65535/u)
    expect(validateStpRegionRevision('65536')).toMatch(/1 to 65535/u)
    expect(validateStpRegionRevision('1.5')).toMatch(/1 to 65535/u)
  })

  it('instance id: 0 and 64 pass; 65 and junk refuse', () => {
    expect(validateStpInstanceId('0')).toBeUndefined()
    expect(validateStpInstanceId('64')).toBeUndefined()
    expect(validateStpInstanceId('65')).toMatch(/0 to 64/u)
    expect(validateStpInstanceId('abc')).toMatch(/0 to 64/u)
  })

  it('vlan ranges: the capture sample, a span, and a mixed list pass; junk/out-of-range/descending refuse', () => {
    expect(validateStpVlanRanges('100,110')).toBeUndefined()
    expect(validateStpVlanRanges('100-200')).toBeUndefined()
    expect(validateStpVlanRanges('1,10-20,4094')).toBeUndefined()
    expect(validateStpVlanRanges('')).toMatch(/required/u)
    expect(validateStpVlanRanges('100;110')).toMatch(/not a VLAN number/u)
    expect(validateStpVlanRanges('0')).toMatch(/out of shape/u)
    expect(validateStpVlanRanges('4095')).toMatch(/out of shape/u)
    expect(validateStpVlanRanges('200-100')).toMatch(/must not descend/u)
  })
})

describe('risk + confirm copy (DR-149: the confirm carries the CAPTURED facts)', () => {
  it('the mode blast sentence carries the measured numbers AND the DR-043 scoping line', () => {
    expect(STP_MODE_BLAST_FACTS).toMatch(/~67 ms/u)
    expect(STP_MODE_BLAST_FACTS).toMatch(/MST0 was replaced by per-VLAN instances/u)
    expect(STP_MODE_BLAST_FACTS).toMatch(/brief forwarding interruption on every VLAN/u)
    expect(STP_MODE_BLAST_FACTS).toMatch(/not measured on this 7050TX-64-R \(DR-043\)/u)
  })

  it('mode → none states what it removes and claims no measurement', () => {
    expect(STP_MODE_NONE_FACTS).toMatch(/Disables spanning-tree on every port/u)
    expect(STP_MODE_NONE_FACTS).toMatch(/Not measured on any target/u)
  })

  it('rapid-pvst carries its stage-accepted/committed-split disclosure in risks AND in the second confirm', () => {
    const risks = stpModeRisks('rapid-pvst', ['spanning-tree mode rapid-pvst'])
    expect(risks.some((risk) => risk.includes('STAGE-ACCEPTED on this 7050TX-64-R'))).toBe(true)
    expect(risks.some((risk) => risk.includes('cEOS-lab 4.28.14M only'))).toBe(true)
    expect(stpModeRisks('mstp', ['spanning-tree mode mstp']).some((risk) => risk.includes('STAGE-ACCEPTED on this 7050TX-64-R'))).toBe(false)
    const confirmation = stpModeConfirmation('rapid-pvst')
    expect(confirmation.body).toMatch(/STAGE-ACCEPTED on this 7050TX-64-R/u)
    expect(confirmation.body).toMatch(/measured on cEOS-lab 4.28.14M only/u)
    expect(confirmation.title).toMatch(/rapid-pvst/u)
  })

  it('every mode risk list opens with the staged-line restatement and closes with the far-end NOTE', () => {
    const risks = stpModeRisks('none', ['spanning-tree mode none'])
    expect(risks[0]).toMatch(/The staged lines: `spanning-tree mode none`/u)
    expect(risks.at(-1)).toBe(STP_FAR_END_NOTE)
    expect(STP_FAR_END_NOTE).toMatch(/informational note/u)
    expect(STP_FAR_END_NOTE).toMatch(/no port-hygiene gate/u)
  })

  it('a removal draft carries the STP_REGION_REMOVAL_FACT line with its hardware (DR-159) scoping', () => {
    const risks = stpRegionRisks({ instances: [], removeInstances: [{ id: '1' }] }, ['spanning-tree mst configuration', 'no instance 1'])
    expect(risks).toContain(STP_REGION_REMOVAL_FACT)
    expect(STP_REGION_REMOVAL_FACT).toMatch(/netted the line out of the block/u)
    expect(STP_REGION_REMOVAL_FACT).toMatch(/staged on this 7050TX-64-R on 2026-11-22/u)
    expect(STP_REGION_REMOVAL_FACT).toMatch(/fallback is not measured on any target/u)
  })

  it('region risks: identity edit gets the reconvergence sentence, a pure remap only the instance one', () => {
    const identity = stpRegionRisks({ name: 'R', instances: [] }, ['spanning-tree mst configuration', 'name R'])
    expect(identity).toContain(STP_REGION_IDENTITY_RISK)
    expect(identity).not.toContain(STP_REGION_INSTANCE_RISK)
    const remap = stpRegionRisks({ instances: [{ id: '1', vlans: '10' }] }, ['spanning-tree mst configuration', 'instance 1 vlan 10'])
    expect(remap).toContain(STP_REGION_INSTANCE_RISK)
    expect(remap).not.toContain(STP_REGION_IDENTITY_RISK)
    // A pure remap ships NO second confirm (only identity edits force the extra dialog); the
    // container decides that, and pins it in StpGlobal.test.tsx.
    expect(remap.at(-1)).toBe(STP_FAR_END_NOTE)
  })

  it('the identity confirmation names what changed in its subject', () => {
    const confirmation = stpRegionIdentityConfirmation('name LAB, revision 2')
    expect(confirmation.subject).toBe('MST region name LAB, revision 2')
    expect(confirmation.body).toBe(STP_REGION_IDENTITY_RISK)
  })

  it('the disclosure sentence exists standalone for the in-form copy', () => {
    expect(stpRapidPvstDisclosure()).toMatch(/STAGE-ACCEPTED on this 7050TX-64-R/u)
    expect(stpRapidPvstDisclosure()).toMatch(/DR-159/u)
  })
})
