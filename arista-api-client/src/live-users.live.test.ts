/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_users.py` @ `6816d9e` — the first **D2 full-write**
 * suite (#14, DR-126): users have no scratch-port shape, so upstream's whole file is a global write and it
 * runs only under `EAPI_LAB_FULL_WRITE=1` against the throwaway cEOS container, through
 * `buildFullWriteNode` so the self-lockout fence sits on the transport seam.
 *
 * ## Gate (DR-034 / DR-126)
 * `liveFullWriteReadiness(process.env)` composes the env gate, the `lab` target-class rule and the consent
 * flag (arista-api-client/src/testing/live-full-write.ts, `live-guard.ts:654`). With the env unset or the
 * consent missing, this file prints the refusal and collects zero executed cases — it never reaches a
 * device, and ordinary `npm test` (the `unit` project) never loads it.
 *
 * ## Which username each case owns
 * Upstream drives one fixed name, `test`, from every method (`:52`, `:74`, `:80`, `:88`, …), so the 13
 * methods overlap on one device entry and the file only stays green because each case re-normalises it.
 * Here every case owns **its own** name, which (a) removes the inter-case coupling, (b) keeps idempotence
 * cheap (`no username X` at case start), and (c) makes the cleanup assertion per case meaningful. None of
 * them is `admin`/`netadmin` or this run's `EAPI_USER`: those three lines are refused **before the wire**
 * by `live-session-policy.ts:159-166`, and `beforeAll` re-checks the plan against the resolved username so
 * a leftover env cannot silently aim a write at the account it logs in as.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:50`) | ✅ | stages `no username test` + `username test nopassword` + the ssh-key line (`:52-57`, the `ssh-key` arm at `:53-54` — the same floor this client picks numerically, row 155) then `get('test')` (`:59`). Upstream's `values` dict (`:60-66`) demands all six keys always, `privilege` as the **string** `'1'`, and `secret`/`role`/`format` as `''` for a field the config never carried; `assertEqual` at `:70`. Here the same staging, then the typed record: `nopassword` true, `role`/`secretFormat` **absent** and `privilege` a **number or absent** (row 151), the secret text never returned (DR-089), and the ssh key compared to what we wrote when the device accepted it |
 * | `test_getall` (`:72`) | ✅ | staging `:74`, `assertIsInstance(result, dict)` `:76`, `assertIn('test', result)` `:77`. Ours: `getAll()` is a `Map`, every entry self-names, and the membership half is claimed for the user **this case created** |
 * | `test_create` (`:79`) | ✅ | `api.create('test', nopassword=True)` `:83` → `assertTrue` `:84`, then `assertIn('username test privilege 1', api.config)` `:85`. There is no `True` here (DR-005: the call resolves or throws), and the `privilege 1` half is exactly a device default claim — so the write is asserted, the token is **printed** (absent is legal per row 151, and `show running-config all` is the source, `command-layer.ts:771-781`) |
 * | `test_delete` (`:87`) | ✅ | precondition `username test privilege 1 nopassword` in config `:90`, `delete` `:91`, `assertNotIn` `:93`. Ours reads the record before and after (DR-027's `undefined` for pyeapi's absence) and additionally proves the DR-126 fence fires through the facade on `netadmin` — not an upstream case, but the one live behaviour every `test/system` port shares |
 * | `test_default` (`:96`) | ✅ (negative read reported) | `api.default('test')` `:100` then `assertNotIn('username test nopassword')` `:102`. Same staging here; the negative half is *reported* when the target still answers a record, following the `live-switchports.live.test.ts` `test_get_returns_none` precedent (§5 row 188) rather than forcing pyeapi's None-equality through a widening this client has not decided |
 * | `test_set_privilege_with_value` (`:105`) | ✅ (default widened to a capture) | staging `:107`, the `# EOS defaults to privilege 1` precondition `:110`, `set_privilege('test', 8)` `:111`, post-assert `:113`. The `8` round trip is asserted; the **pre**-write privilege is printed, because whether this image spells `privilege 1` in running-config is a device answer (row 151/DR-027), not a client rule |
 * | `test_set_privilege_with_no_value` (`:115`) | ✅ as the refusal + real negation | upstream stages `username test privilege 8 nopassword` (`:117-118`), calls `set_privilege('test')` (`:121`) — which **invents** `username X privilege 1` (`users.py:265-267`, §5 row 153) — and asserts `privilege 1` at `:123`. That invention is not ported (`users.ts:70-77`): the value-less call rejects `NotSupportedError`, and the negation the case is circling is `unsetPrivilege` (`users.ts:551-554`, a command pyeapi never spells) |
 * | `test_set_role_with_value` (`:125`) | ✅ | precondition `:128`, `set_role('test','network-admin')` `:129`, post-assert `:131` on the one-line joined form. Our reader is keyword-by-keyword (row 150) so the round trip is asserted on `role`, and the joined-line shape is not demanded of the device |
 * | `test_set_role_with_no_value` (`:134`) | ✅ | staging `username test role network-admin nopassword` `:136-137`, `set_role('test')` `:140` (upstream's value-less arm negates), `assertNotIn` `:142`. Here `unsetRole` says the negation out loud (DR-037) and the read asserts `role` absent |
 * | `test_set_sshkey_with_value` (`:144`) | ✅ (tolerant arm) | pre-absence check `:148-151`, `set_sshkey('test', TEST_SSH_KEY)` `:152`, post-assert `:154-157` with the version arm. Ours writes whichever arm `sshKeyKeyword` picks (row 155) and reads back the exact key (row 150's `sshkey (.+)$`). Whether 4.28 validates the key blob is the device's call: a refusal arrives as the package's typed error and is printed, and the read-back half is then reported as unexercised instead of claimed |
 * | `test_set_sshkey_with_empty_string` (`:160`) | ✅ as a refusal | upstream calls `set_sshkey('test', '')` (`:169`), asserts `True`, then asserts the key is absent (`:171-177`) — i.e. it relies on EOS ignoring a trailing-space command. Here the identical input is refused before anything is composed (`assertSshKeyValue`, `users.ts:276-283`; §5 row 154/DR-005), so the case asserts the throw and then that nothing was applied |
 * | `test_set_sshkey_with_None` (`:178`) | ✅ as a refusal | upstream `set_sshkey('test', None)` at `:187` (and `command_builder`'s falsy fall-through). At the TS boundary the parameter is `string`; a runtime non-string is refused the same way (DR-077), asserted, and the record is re-read to show nothing landed |
 * | `test_set_sshkey_with_no_value` (`:196`) | ✅ | staging `:198-199`, precondition `:200`, `set_sshkey('test', disable=True)` `:202`, post-assert `:204-210`. Maps to `unsetSshKey` (`users.ts:599-604`), which is exactly upstream's `no` arm |
 *
 * `TEST_SSH_KEY` below is upstream's constant (`test_api_users.py:40-46`, BSD-3-Clause test data — an inert
 * key blob, not a credential) so the byte-for-byte round trip is the same string upstream pinned.
 *
 * **Write vocabulary (§5 rows 151-155, DR-005/DR-077/DR-089/DR-091):** upstream's `configure` returns
 * `True`/`False` and its guards raise `TypeError`; every one of those states is a **throw** here
 * (`CommandError` when the device refuses, `NotSupportedError` when this client refuses) — so
 * `assertTrue(result)` becomes "the awaited verb resolves", and `assertFalse`/`assertRaises` become
 * `.rejects`. Reads never return `None`s: pyeapi's `secret: ''`/`role: ''` become absent fields, and the
 * secret text is never handed to a browser at all (DR-089) — this file therefore prints `secretFormat`,
 * never a secret, and every user it creates is `nopassword` (no credential text crosses the wire in either
 * direction, which also keeps the artifact-redaction rules of `docs/CEOS.md` trivially satisfied).
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, NotSupportedError, ProtocolError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Node } from './command-layer'

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`live-users: SKIPPED (DR-034/DR-126) — ${gate.skipReason ?? 'reason unavailable'}`)
}

/** Upstream's `TEST_SSH_KEY`, `test_api_users.py:40-46` — inert test key material, ported for the byte-exact read-back. */
const TEST_SSH_KEY =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDKL1UtBALa4CvFUsHUipNym' +
  'A04qCXuAtTwNcMj84bTUzUI+q7mdzRCTLkllXeVxKuBnaTm2PW7W67K5CVpl0' +
  'EVCm6IY7FS7kc4nlnD/tFvTvShy/fzYQRAdM7ZfVtegW8sMSFJzBR/T/Y/sxI' +
  '16Y/dQb8fC3la9T25XOrzsFrQiKRZmJGwg8d+0RLxpfMg0s/9ATwQKp6tPoLE' +
  '4f3dKlAgSk5eENyVLA3RsypWADHpenHPcB7sa8D38e1TS+n+EUyAdb3Yov+5E' +
  'SAbgLIJLd52Xv+FyYi0c2L49ByBjcRrupp4zfXn4DNRnEG4K6GcmswHuMEGZv' +
  '5vjJ9OYaaaaaaa'

/**
 * One case-scoped scratch username per upstream method, so no two cases share a device entry (upstream's
 * fixed `test` name, e.g. `:52`/`:74`/`:80`, is what forces its re-normalising setup). Names are ≤ 8 chars,
 * single tokens, and deliberately unlike the built-ins.
 */
const USERS = {
  get: 'd2u_get',
  getall: 'd2u_all',
  create: 'd2u_new',
  delete: 'd2u_del',
  dflt: 'd2u_dflt',
  privilege: 'd2u_priv',
  role: 'd2u_role',
  sshkey: 'd2u_sshkey',
} as const

/** The three accounts a full-write lab run must never aim a `username …` line at (`live-session-policy.ts:159-166`). */
const BLOCKED_USERS: readonly string[] = ['admin', 'netadmin']

/** The device refusal vocabulary of this suite, printed once per tolerated arm (mirrors live-switchports). */
function describeRefusal(rawErr: unknown): string {
  if (rawErr instanceof EapiError) {
    const code = rawErr instanceof CommandError ? String(rawErr.code) : rawErr instanceof ProtocolError ? `protocol ${String(rawErr.code)}` : 'no code'
    return `${rawErr.constructor.name} ${code}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}`
  }
  return rawErr instanceof Error ? `${rawErr.constructor.name}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}` : String(rawErr)
}

/**
 * Stage a `nopassword` user out of band — the guarded-session twin of upstream's `dut.config([...])` lines,
 * and deliberately **not** the verb under test. `no username X` first makes the case idempotent against a
 * target that still holds the entry from an earlier run (a `create` would otherwise collide with the
 * device's own state rather than with this client's).
 */
async function stageUser(node: Node, name: string, lines: readonly string[] = [`username ${name} nopassword`]): Promise<void> {
  await runGuardedLiveWriteSession(node, {
    name: `d2-users-stage-${name}`,
    commands: [`no username ${name}`, ...lines],
  })
}

/** Remove a user this case created. Never asserted: a missing entry is the success state, and the case that owns the name already reported its own result. */
async function dropUser(node: Node, name: string): Promise<void> {
  try {
    await runGuardedLiveWriteSession(node, { name: `d2-users-drop-${name}`, commands: [`no username ${name}`] })
  } catch (rawErr) {
    console.warn(`live-users: cleanup \`no username ${name}\` was refused (${describeRefusal(rawErr)}) — the entry may survive into the next case; reported, not hidden`)
  }
}

describe.skipIf(!gate.runnable)('live full-write: pyeapi test_api_users.py (all 13 methods, :50-:196)', () => {
  let node: Node

  beforeAll(async () => {
    const target: LiveTarget = unwrapLiveTarget(gate.resolution)
    console.log(`live-users: target = ${describeLiveTarget(target)}`)
    // The fence travels with the Node (`buildFullWriteNode`), so a `username admin …` line from any facade
    // is refused before a byte leaves the process — no case in this file has to remember the policy.
    node = buildFullWriteNode(target)
    const planned = Object.values(USERS)
    const blocked = [...BLOCKED_USERS, target.username]
    const offender = planned.find((name) => blocked.includes(name))
    if (offender !== undefined) {
      throw new Error(`live-users readiness: the planned username ${JSON.stringify(offender)} is one this lane must never write (admin/netadmin or EAPI_USER=${JSON.stringify(target.username)}) — pick a different account or refuse the run`)
    }
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    // Tolerate only the suffix-driven EAPI_VERSION_MISMATCH (the cEOS `version` carries an engineering-build
    // suffix the base pin cannot match); model, train and TLS identity stay enforced by the probe (DR-066).
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') {
      throw new Error(`live-users readiness: ${mismatch.reason}`)
    }
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
      console.warn(`live-users: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
    }
  })

  it('users.get() answers the typed record — not pyeapi\'s always-six-key dict (test_get, :50)', async () => {
    const name = USERS.get
    await stageUser(node, name)
    try {
      // Upstream stages the key with the version-selected word (`:53-54`/`:56-57`); here the client picks the
      // arm (row 155), so the ssh-key half rides the facade and a device refusal is reported, not fatal.
      let keyApplied = false
      try {
        await node.users.setSshKey(name, TEST_SSH_KEY)
        keyApplied = true
      } catch (rawErr) {
        expect(rawErr).toBeInstanceOf(EapiError)
        console.warn(`live-users: this target refused \`username ${name} ssh-key …\` (${describeRefusal(rawErr)}) — the key half of :60-66 is NOT exercised here`)
      }
      const user = await node.users.get(name)
      expect(user).toBeDefined()
      if (user === undefined) return
      expect(user.name).toBe(name)
      expect(user.nopassword).toBe(true)
      // row 151: a field the config does not carry is absent, where pyeapi answers `''`/None (`:60-66`).
      expect(user.role).toBeUndefined()
      // DR-089: this client reports the secret's *format*, never its text — and a nopassword user has neither.
      expect(user.secretFormat).toBeUndefined()
      if (user.privilege === undefined) {
        console.warn(`live-users: privilege reads ABSENT for ${name} — upstream's values dict demands '1' (:61/:65), which is a device-default claim this container did not spell out (${JSON.stringify(user).slice(0, 200)})`)
      } else {
        expect(Number.isSafeInteger(user.privilege) && user.privilege >= 0 && user.privilege <= 15).toBe(true)
        console.log(`live-users: privilege = ${String(user.privilege)} for ${name} (upstream pins '1' at :61/:65)`)
      }
      if (keyApplied) {
        expect(user.sshKey).toBe(TEST_SSH_KEY)
      } else if (user.sshKey !== undefined) {
        console.warn(`live-users: ${name} carries an sshKey this case never wrote (${user.sshKey.slice(0, 40)}…) — leftover state from an earlier run, reported`)
      }
    } finally {
      await dropUser(node, name)
    }
  })

  it('users.getAll() is a keyed table that contains the user this run created (test_getall, :72 — the assertIn half at :77)', async () => {
    const name = USERS.getall
    await stageUser(node, name)
    try {
      const all = await node.users.getAll()
      expect(typeof all.has).toBe('function')
      for (const [key, entry] of all) {
        expect(typeof key).toBe('string')
        expect(entry.name).toBe(key)
        expect(typeof entry.nopassword).toBe('boolean')
        if (entry.privilege !== undefined) expect(Number.isSafeInteger(entry.privilege)).toBe(true)
        if (entry.role !== undefined) expect(typeof entry.role).toBe('string')
      }
      expect(all.size).toBeGreaterThan(0)
      expect(all.has(name)).toBe(true)
      expect(all.get(name)?.nopassword).toBe(true)
    } finally {
      await dropUser(node, name)
    }
  })

  it('users.create(name, {nopassword:true}) applies and reads back; the device\'s privilege default is printed, not assumed (test_create, :79)', async () => {
    const name = USERS.create
    // Idempotence: the upstream `no username test` normalisation (`:81`) is the same delete-if-exists move.
    await dropUser(node, name)
    try {
      // pyeapi answers `True` (`:83-84`); there is no return value here — a write that did not happen throws.
      await node.users.create(name, { nopassword: true })
      const created = await node.users.get(name)
      expect(created).toBeDefined()
      expect(created?.nopassword).toBe(true)
      // Upstream's post-assert (`:85`) demands `username test privilege 1` in the config text. This client
      // answers that default as a number when the device spells it and as absent when it does not (row 151).
      console.log(`live-users: after create(), the record is ${JSON.stringify(created)} — the privilege-1 half of :85 reads ${created?.privilege === undefined ? 'ABSENT' : String(created?.privilege)}`)
    } finally {
      await dropUser(node, name)
    }
  })

  it('users.delete(name) removes the entry (test_delete, :87 — precondition :90, post-assert :93) and the fence refuses netadmin before the wire', async () => {
    const name = USERS.delete
    await stageUser(node, name)
    try {
      expect(await node.users.get(name)).toBeDefined()
      await node.users.delete(name)
      expect(await node.users.get(name)).toBeUndefined()
    } finally {
      await dropUser(node, name)
    }
    // Not an upstream case: the one live-lane invariant every `test/system` port shares. `users.delete`
    // composes `no username netadmin`, and the seam must reject it without a request (DR-126) — the built-in
    // accounts stay intact even when a suite asks politely.
    await expect(node.users.delete('netadmin')).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('users.setDefault(name) is the whole-record default (test_default, :96 — the post-assert half at :102 reported, cf. §5 row 188)', async () => {
    const name = USERS.dflt
    await stageUser(node, name)
    try {
      await node.users.setDefault(name)
      const after = await node.users.get(name)
      if (after === undefined) {
        expect(after).toBeUndefined()
        console.log(`live-users: default username ${name} removed the entry (upstream's assertNotIn at :102)`)
      } else {
        // `show running-config all` can keep a section this client reads as an entry; the negative half is
        // then the device's answer to print, not a claim to force (live-switchports' §5 row 188 precedent).
        console.warn(`live-users: get(${JSON.stringify(name)}) still answers a record after \`default username\` (${JSON.stringify(after).slice(0, 200)}) — the :102 negative half is reported for this target, not asserted`)
      }
    } finally {
      await dropUser(node, name)
    }
  })

  it('setPrivilege(8) round-trips through the typed record (test_set_privilege_with_value, :105 — :111/:113; the :110 device default captured)', async () => {
    const name = USERS.privilege
    await stageUser(node, name)
    try {
      // Upstream asserts the EOS default here (`:110`, `# EOS defaults to privilege 1`). That is a device
      // statement, so this lane captures it and lets the write assertions stand on their own.
      const before = await node.users.get(name)
      console.log(`live-users: privilege before setPrivilege = ${JSON.stringify(before?.privilege)} — upstream claims 1 at :110 (${String(before?.privilege === undefined)})`)
      await node.users.setPrivilege(name, 8)
      const after = await node.users.get(name)
      expect(after).toBeDefined()
      expect(after?.privilege).toBe(8)
    } finally {
      await dropUser(node, name)
    }
  })

  it('the value-less privilege arm upstream invents is a refusal here, and the negation is its own verb (test_set_privilege_with_no_value, :115 — staging :117-118, the invention at users.py:265-267, row 153)', async () => {
    const name = USERS.privilege
    // Upstream's staging (`:117-118`) is the joined line, so that is the shape pushed here too.
    await stageUser(node, name, [`username ${name} privilege 8 nopassword`])
    try {
      const staged = await node.users.get(name)
      expect(staged).toBeDefined()
      expect(staged?.privilege).toBe(8)
      // Upstream's value-less call (`:121`) answers True and writes `privilege 1` (`:123`). Calling here with no
      // value is a type error at the boundary and a runtime refusal (users.ts:70-77/256) — never an invented 1.
      await expect(node.users.setPrivilege(name, undefined as unknown as number)).rejects.toBeInstanceOf(NotSupportedError)
      const untouched = await node.users.get(name)
      expect(untouched?.privilege).toBe(8)
      // The negation the upstream case was reaching for, spelled (row 153, DR-037).
      await node.users.unsetPrivilege(name)
      const unset = await node.users.get(name)
      if (unset === undefined) {
        // If the negation took the whole entry, that is the device's answer to the command **this** client
        // spells (pyeapi's value-less arm at `:121` can never do that — it always writes `privilege 1`, `:123`).
        // Reported rather than turned into a pass or a forced equivalence (row 153's live half).
        console.warn(`live-users: unsetPrivilege left no record for ${name} — reported, not asserted: the upstream arm at :121/:123 always leaves an entry behind`)
      } else if (unset.privilege === undefined) {
        expect(unset.privilege).toBeUndefined()
      } else if (unset.privilege !== 8) {
        console.warn(`live-users: unsetPrivilege left privilege=${String(unset.privilege)} on ${name} — the device's own default, reported (no \`privilege 8\` line survives)`)
      } else {
        throw new Error(`live-users: unsetPrivilege left the staged privilege 8 in place on ${JSON.stringify(unset)} — the line the case negated is still there, so \`no username ${name} privilege\` did not take effect (row 153's live half)`)
      }
    } finally {
      await dropUser(node, name)
    }
  })

  it('setRole("network-admin") reads back off the keyword walk (test_set_role_with_value, :125 — :129/:131)', async () => {
    const name = USERS.role
    await stageUser(node, name)
    try {
      await node.users.setRole(name, 'network-admin')
      const user = await node.users.get(name)
      expect(user).toBeDefined()
      // pyeapi's joined post-assert (`:131`, `username test privilege 1 role network-admin nopassword`) depends
      // on the device emitting one line; this client's reader merges per-field lines (row 150), so `role` is
      // what is asserted and the record is printed for the line-shape question.
      console.log(`live-users: record after setRole = ${JSON.stringify(user)}`)
      expect(user?.role).toBe('network-admin')
    } finally {
      await node.users.unsetRole(name).catch(() => undefined)
      await dropUser(node, name)
    }
  })

  it('the role negation is a named verb, not an omitted argument (test_set_role_with_no_value, :134 — staging :136-137, :140, post :142)', async () => {
    const name = USERS.role
    // Upstream's staging at `:136-137` is the same joined form its `:131` post-assert expects.
    await stageUser(node, name, [`username ${name} role network-admin nopassword`])
    try {
      expect((await node.users.get(name))?.role).toBe('network-admin')
      await node.users.unsetRole(name)
      const after = await node.users.get(name)
      expect(after).toBeDefined()
      expect(after?.role).toBeUndefined()
    } finally {
      await dropUser(node, name)
    }
  })

  it('setSshKey writes the arm this client\'s floor picked and the record reads it verbatim (test_set_sshkey_with_value, :144 — pre-absence :148-151, :152, post :154-157)', async () => {
    const name = USERS.sshkey
    await stageUser(node, name)
    try {
      expect((await node.users.get(name))?.sshKey).toBeUndefined()
      try {
        await node.users.setSshKey(name, TEST_SSH_KEY)
      } catch (rawErr) {
        expect(rawErr).toBeInstanceOf(EapiError)
        console.warn(`live-users: \`username ${name} <ssh-key arm>\` was refused by this target (${describeRefusal(rawErr)}) — the :154-157 read-back half is NOT exercised here (which arm this client writes is a DR-078 floor question; validating the blob is the device's call)`)
        return
      }
      const withKey = await node.users.get(name)
      expect(withKey?.sshKey).toBe(TEST_SSH_KEY)
    } finally {
      await dropUser(node, name)
    }
  })

  it('an empty ssh key is refused before the wire instead of relying on EOS to ignore a trailing space (test_set_sshkey_with_empty_string, :160 — upstream\'s call at :169, asserts :171-177)', async () => {
    const name = USERS.sshkey
    await stageUser(node, name)
    try {
      // Upstream sends `username test sshkey `+`''`, asserts True, then asserts the key is absent — i.e. it
      // tests the device's tolerance of its own malformed line. This client refuses to compose it (row 154).
      await expect(node.users.setSshKey(name, '')).rejects.toBeInstanceOf(NotSupportedError)
      const after = await node.users.get(name)
      expect(after).toBeDefined()
      expect(after?.sshKey).toBeUndefined()
    } finally {
      await dropUser(node, name)
    }
  })

  it('a non-string ssh key is a refusal, not pyeapi\'s None interpolation (test_set_sshkey_with_None, :178 — upstream\'s call at :187)', async () => {
    const name = USERS.sshkey
    await stageUser(node, name)
    try {
      await expect(node.users.setSshKey(name, undefined as unknown as string)).rejects.toBeInstanceOf(NotSupportedError)
      expect((await node.users.get(name))?.sshKey).toBeUndefined()
    } finally {
      await dropUser(node, name)
    }
  })

  it('unsetSshKey is the negation arm (test_set_sshkey_with_no_value, :196 — staging :198-199, precondition :200, :202, post :204-210)', async () => {
    const name = USERS.sshkey
    await stageUser(node, name)
    try {
      try {
        await node.users.setSshKey(name, TEST_SSH_KEY)
        expect((await node.users.get(name))?.sshKey).toBe(TEST_SSH_KEY)
      } catch (rawErr) {
        expect(rawErr).toBeInstanceOf(EapiError)
        console.warn(`live-users: cannot test the negation because the key write itself was refused (${describeRefusal(rawErr)}) — :202-210 reported as unexercised`)
        return
      }
      await node.users.unsetSshKey(name)
      const after = await node.users.get(name)
      expect(after?.sshKey).toBeUndefined()
    } finally {
      await dropUser(node, name)
    }
  })
})
