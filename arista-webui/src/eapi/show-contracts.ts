/**
 * M13 (#15) typed show contracts for the screens this webui needs
 * (`arista-api-client/docs/PLAN.md` M13: `show version`, `show interfaces status`, `show vlan`,
 * `show mlag`, `show lag`).
 *
 * The client deliberately ships an **empty** {@link ShowContracts} map (ARCHITECTURE.md §9.1:
 * consumers widen it by declaration merging "so app code gets typed `show` output without waiting
 * for upstream releases"), and `Node#show` keys the map on the command literal **without** its
 * `show ` prefix (`command-layer.ts`'s `showCommand`, pinning MIGRATION.md §2 / USAGE.md §4:
 * `node.show('vlan 20')`, contract key `'lag counters'`). So the M13 keys are `version`,
 * `'interfaces status'`, `vlan`, `mlag`, and `lag` — and S1 (#71) adds
 * `'management api http-commands'`, also capture-backed on both targets.
 *
 * **Evidence rule, identical to the client's capture discipline (DR-043):** every field below was
 * read out of a recorded reply, not out of documentation prose. A key present with the same type
 * in every capture of that command is required; a key seen in only one capture is optional; a key
 * no capture carries is not modelled at all. Value *sets* stay the device's — these are `string`,
 * never invented enums (DR-032/DR-057). "Absent" on a screen means "this model does not promise
 * it", not "the device cannot send it": EOS models answer more fields than any single capture, so
 * narrowing here is a floor, and the screens below only ever read modelled keys.
 *
 * This augmentation is in the app's own compilation (imported for its side effect by
 * `src/features/vlans/VlanAssignment.tsx` since F6/#68),
 * so `node.show('version')` types end-to-end; `src/eapi/show-contracts.test.ts` pins each shape
 * against verbatim capture payloads, and `src/eapi-show-contracts.test.ts` proves the consumer
 * spelling still merges through the package's published types.
 */

/**
 * `show version`. Two recorded replies:
 * - DCS-7050TX-64 / EOS **4.28.13.1M** (the target hardware):
 *   `arista-api-client/test/fixtures/show/show-version--4.28.13.1M-dcs-7050tx-64.json`
 * - cEOS-lab **4.28.14M** (`hardwareEvidence: "none"`, DR-043):
 *   `arista-api-client/test/fixtures/live/ceos-4.28.14M/show-version.json`
 *
 * The required keys are exactly the intersection of those two captures. The two optional groups
 * name which single capture each came from — cEOS-lab carries container-only facts
 * (`cEosToolsVersion`, `kernelVersion`, …) and the switch carries image/hardware facts
 * (`hostname`, `versionInfo`, `mem`, …) the container answer omits, so no screen may treat either
 * group as always present.
 */
export interface ShowVersionReply {
  // --- required: present with the same name and type in BOTH captures -----------------------------
  /** e.g. `"4.28.13.1M"`; the cEOS capture's is an engineering-build string — pin the base, not the build. */
  readonly version: string
  /** MAC-shaped; zeroed by capture redaction in both files (the shape, not the value, is pinned). */
  readonly systemMacAddress: string
  /** `"DCS-7050TX-64"` on the switch, `"cEOSLab"` in the container. */
  readonly modelName: string
  /** Empty string on the cEOS-lab image (kept verbatim) — never assume a readable serial. */
  readonly serialNumber: string
  /** Full build string, e.g. `"4.28.14M-50015774.42814M"`. */
  readonly internalVersion: string
  /** `"x86_64"` on the 7050TX capture, `"i686"` on this WSL-hosted container capture. */
  readonly architecture: string
  /** Seconds since epoch; the 7050TX capture is a redacted `0`. */
  readonly bootupTimestamp: number
  /** Seconds up; the 7050TX capture is a redacted `0`. */
  readonly uptime: number

  // --- seen only in the 7050TX-64 hardware capture ------------------------------------------------
  readonly hostname?: string
  /** Free+used memory in KiB on the switch spelling. The container spell it `memFree`/`memTotal` instead. */
  readonly mem?: number
  readonly uptimeString?: string
  /** The switch capture spells this `"short"`; the container answer carries no `versionFormat` key. */
  readonly versionFormat?: string
  readonly internalArch?: string
  readonly aristaHardwareModel?: string
  readonly aristaHardwareVersion?: string
  /** Per-image entries; one entry object observed (`version`/`imageType`/`email`/`timestamp`), entry shape not pinned further — no screen reads it. */
  readonly versionInfo?: readonly unknown[]

  // --- seen only in the cEOS-lab 4.28.14M capture --------------------------------------------------
  /** Container-only identity fields; a 7050TX reply is not promised to carry them (and the reverse holds too). */
  readonly mfgName?: string
  readonly hwMacAddress?: string
  readonly configMacAddress?: string
  readonly hardwareRevision?: string
  readonly kernelVersion?: string
  readonly memFree?: number
  readonly memTotal?: number
  readonly isIntlVersion?: boolean
  readonly imageFormatVersion?: string
  readonly imageOptimization?: string
  readonly internalBuildId?: string
  readonly cEosToolsVersion?: string
}

/**
 * One `show interfaces status` row. Key set from the **only recorded reply of this command**
 * (`…/show-interfaces-status.json`, cEOS-lab 4.28.14M) as captured at M10a time: its `Ethernet1`
 * row is pinned verbatim in `arista-api-client/src/resources/interfaces.test.ts`
 * (`LAB_ROW_ETHERNET1`) and copied here. The 2026-11-06 M12c re-capture of the same command
 * answered an **empty** `interfaceStatuses` map, so no row key is required: a row proves its keys
 * only when the device writes them.
 *
 * `autoNegotigateActive` is not a typo on our side — the captured row carries both spellings,
 * and the mis-cased key is device data (see the client's note on `LAB_ROW_ETHERNET1`).
 */
export interface ShowInterfaceStatusRow {
  /** The operational column this command's recorded spelling uses (`"connected"`). */
  readonly linkStatus?: string
  /** The sibling `show interfaces` capture's spelling of the same column — read as a fallback by the client (divergence 12). */
  readonly interfaceStatus?: string
  /** `"up"` in both spellings; still optional because the current capture of this command has zero rows. */
  readonly lineProtocolStatus?: string
  /** Verbatim, quotes and all; `""` when the port has an empty description. */
  readonly description?: string
  /** Interface bandwidth in bits/s as captured (`1000000000`). */
  readonly bandwidth?: number
  /** Device vocabulary (`"duplexFull"` in the capture). */
  readonly duplex?: string
  /** PHY name from the capture (`"EbraTestPhyPort"`) — deliberately NOT the sibling's `hardware` class. */
  readonly interfaceType?: string
  readonly autoNegotiateActive?: boolean
  /** Captured duplicate of the key above under the device's mis-cased spelling. */
  readonly autoNegotigateActive?: boolean
  readonly mtu?: number
  /** Sibling-capture port class (`ethernet`, `loopback`, …); the recorded row for *this* command has no such key. */
  readonly hardware?: string
  readonly vlanInformation?: {
    readonly interfaceMode?: string
    readonly vlanId?: number
    readonly interfaceForwardingModel?: string
  }
}

/**
 * `show interfaces status`. The recorded cEOS-lab answer models only the map wrapper, and the map
 * itself was `{}` in the 2026-11-06 capture (its `Ethernet1` row above comes from the earlier
 * capture, pinned in the client suite). The client's reader also accepts the sibling command's
 * `interfaces` spelling for the same table ({@link ShowInterfaceStatusRow}, capture-order first),
 * so both maps are modelled and a screen must not assume a JSON `show interfaces status` answer
 * cannot also carry `output` — a unit without the model answers the text fallback after the
 * client's 1003 retry (DR-012), which is exactly why `interfaces.getStatus()` exists as the
 * failure-reporting verb in this app.
 */
export interface ShowInterfacesStatusReply {
  /** Recorded spelling of *this* command's table, keyed by interface name. */
  readonly interfaceStatuses?: Readonly<Record<string, ShowInterfaceStatusRow>>
  /** Sibling `show interfaces` spelling, accepted by the reader as the labelled fallback. */
  readonly interfaces?: Readonly<Record<string, ShowInterfaceStatusRow>>
  /** The `format:'text'` fallback envelope (DR-012 1003 retry) — present means "no JSON model here". */
  readonly output?: string
}

/**
 * One entry of `show vlan`'s map, from the cEOS-lab 4.28.14M capture
 * (`…/show-vlan.json`): `{"status":"active","name":"default","interfaces":{},"dynamic":false}`.
 * The VLAN screen's member map is not settled by the capture (`interfaces` is `{}` there), so its
 * values stay `unknown` until a configured-port capture lands; the VLAN *table* this screen
 * renders comes from the client's `vlans` resource, not from this contract.
 */
export interface ShowVlanEntry {
  /** Device vocabulary (`"active"` captured); absent does not mean "down". */
  readonly status: string
  readonly name: string
  /** Member map keyed by interface name; the only capture carries an empty map, so members are `unknown`. */
  readonly interfaces: Readonly<Record<string, unknown>>
  readonly dynamic: boolean
}

/**
 * `show vlan` — cEOS-lab 4.28.14M capture. Map keys are decimal VLAN ids as **strings**
 * (`"1"`), exactly as EOS writes JSON object keys.
 */
export interface ShowVlanReply {
  /** Captured as `""`; prose from the CLI footer area — never parsed. */
  readonly sourceDetail: string
  readonly vlans: Readonly<Record<string, ShowVlanEntry>>
}

/**
 * `show mlag` — cEOS-lab 4.28.14M capture (`state: "disabled"`, empty `peerLink`/`localInterface`,
 * `mlagPorts` keyed by state-label with integer counts). Every key in the capture is required
 * here because the capture is the only evidence — the whole model came back, MLAG merely off.
 * Statuses stay raw device strings (DR-032); the MLAG panel narrows them for display.
 */
export interface ShowMlagReply {
  /** Captured `"disabled"`; the enabled vocabularies need a real-MLAG capture before an screen branches on them. */
  readonly state: string
  /** MLAG local interface; `""` while disabled. */
  readonly localInterface: string
  /** Peer-link interface; `""` while disabled. */
  readonly peerLink: string
  /** Captured 300 (seconds). */
  readonly reloadDelay: number
  /** Captured 300 (seconds). */
  readonly reloadDelayNonMlag: number
  /** Captured key set while disabled — the labels are the device's count buckets, not ours. */
  readonly mlagPorts: Readonly<Record<string, number>>
  readonly portsErrdisabled: boolean
  readonly dualPrimaryDetectionState: string
  readonly dualPrimaryPortsErrdisabled: boolean
}

/**
 * The five literals M13 names, augmented onto the client's map (consumer spelling, USAGE.md §4).
 * **`lag` stays deliberately NOT augmented — permanently, as a recorded refusal**: the #14 §3
 * hardware sweep is DONE 2026-11-09 (probe runs 1-6) with the cEOS catalog regenerated the same day
 * (`lab-1637825-9bbb4b`), and both targets answered the `show lag` family with negatives: cEOS-lab
 * `% Incomplete` (probe-note transcripts, never files) and the 7050TX-64 `invalid command` for
 * `show lag resources` and `show port-channel detail` (committed *negative captures*
 * `show-lag-resources--hw-inventory.json`, `show-port-channel-detail--hw-inventory.json`). No
 * positive reply exists on either target, so publishing a field list would be exactly the invented
 * shape DR-011/DR-043's evidence discipline refuses — `node.show('lag')` stays `unknown` by design,
 * and the LAG screen (#75) reads the real evidence instead: `show port-channel dense` is a
 * committed positive on cEOS (`show-port-channel-dense.json`) and answered on the box
 * (`show-port-channel-dense--hw-inventory.json`), with the channel-group relation as the config-side
 * source (the Port-Channel field group in `resources/interfaces.ts`, M10c/DR-075). This is closed
 * territory, not a pending capture.
 */
/**
 * `show management api http-commands` — added for S1 (#71), because the shutdown guard asks a question
 * no config read can answer: **which interface is eAPI actually being served on?** The device answers
 * that about itself, in `urls[]`, so this is the strongest readable in-band signal the repo has.
 *
 * Two captures, both positive:
 * - DCS-7050TX-64 / **4.28.13.1M**:
 *   `arista-api-client/test/fixtures/recordings/7050tx-64-r-4.28.13.1M/show-management-api-http-commands--hw-inventory.json`
 *   → `urls: ["Management1 : https://<hw-redacted>:443"]` (the host is redacted by the capture lane),
 *   `vrf: "default"`, `httpsServer.running: true`.
 * - cEOS-lab **4.28.14M** (`hardwareEvidence: "none"`, DR-043):
 *   `arista-api-client/test/fixtures/live/ceos-4.28.14M/show-management-api-http-commands.json`
 *   → `urls: ["Vlan100     : https://10.0.100.1:443"]` — same key, and the interface token is padded
 *   with spaces before the colon, so a parser must not assume single spacing.
 *
 * Every key below is required because both captures carry it with the same type; the one optional key
 * names which capture it came from. `users` stays `Readonly<Record<string, unknown>>` on purpose: the
 * hardware capture's entries are per-username counters (`requestCount`/`bytesOut`/`lastHitTime` under a
 * login name), which is exactly the operator-identifying data F8 (#70) contract (d) scrubs from
 * artifacts — and no screen reads it. `urls` is the only member S1 consumes.
 */
export interface ShowManagementApiHttpCommandsReply {
  /** One entry per serving endpoint, `"<interface> : <scheme>://<host>:<port>"` — device-padded. */
  readonly urls: readonly string[]
  /** The VRF the API is bound to (`"default"` in both captures). */
  readonly vrf: string
  readonly vrfs: readonly string[]
  readonly enabled: boolean
  readonly httpsServer: { readonly running: boolean; readonly configured: boolean; readonly port: number }
  readonly httpServer: { readonly running: boolean; readonly configured: boolean; readonly port: number }
  readonly localHttpServer: { readonly running: boolean; readonly configured: boolean; readonly port: number }
  readonly unixSocketServer: { readonly running: boolean; readonly configured: boolean }
  readonly tlsProtocol: readonly string[]
  /** Per-username usage counters — deliberately not modelled further (F8 contract d). */
  readonly users: Readonly<Record<string, unknown>>
  readonly corsOrigins: readonly unknown[]
  readonly iframeAncestors: readonly unknown[]
  readonly logLevel: string
  readonly dscpValue: number
  readonly fipsEnabled: boolean
  readonly bytesIn: number
  readonly bytesOut: number
  readonly commandCount: number
  readonly executionTime: number
  readonly hitCount: number
  readonly requestCount: number
  /** Hardware capture only (the cEOS answer carries no `lastHitTime` key). */
  readonly lastHitTime?: number
}

/**
 * `show port-channel dense` — added for S5 (#75). `arista-api-client/docs/STATUS.md:143` routes the
 * LAG screens here specifically (and keeps `show lag` a permanent recorded refusal — this file's
 * `lag` note above). Two positive captures, both committed:
 * - DCS-7050TX-64 / **4.28.13.1M** (inside the hw-inventory sweep envelope, `captures[]` entry with
 *   commands `["enable","show port-channel dense"]`):
 *   `arista-api-client/test/fixtures/recordings/7050tx-64-r-4.28.13.1M/show-port-channel-dense--hw-inventory.json`
 *   → one aggregator `Port-Channel10`, members `Ethernet4`/`Ethernet5` with `lagMember: true`,
 *   `lacpMisconfig.status: "bundled"`, `numberOfChannelsInUse: 1`.
 * - cEOS-lab **4.28.14M** (CLI-format capture, `hardwareEvidence: "none"`, DR-043):
 *   `arista-api-client/test/fixtures/live/ceos-4.28.14M/show-port-channel-dense.json`
 *   → `Port-Channel1` with `linkState: "down"`, `Ethernet2` `lagMember: false`,
 *   `lacpMisconfig.status: "noAgg"`, counts both `0`.
 *
 * Every key below appears with the same type in BOTH captures, so all are required; the value sets
 * (`protocol`/`lacpMode`/`linkState`/`lacpMisconfig.status`) stay `string` — device vocabulary, never
 * an app enum (DR-032). The two count members are rendered ONLY as device answers to this command —
 * issue #75's capacity rule forbids the screen pairing them with any invented platform limit
 * (DECISIONS open item 6: the 16-ports/64-members prose is wrong-SKU matrix text).
 */
export interface ShowPortChannelDenseLacpState {
  readonly collecting: boolean
  readonly distributing: boolean
  readonly synchronization: boolean
  readonly defaulted: boolean
  readonly timeout: boolean
  readonly activity: boolean
  readonly expired: boolean
  readonly aggregation: boolean
}

export interface ShowPortChannelDenseLacpMisconfig {
  /** Captured values `"bundled"` and `"noAgg"`; the vocabulary is the device's. */
  readonly status: string
}

export interface ShowPortChannelDensePort {
  readonly staticLag: boolean
  readonly lacpState: ShowPortChannelDenseLacpState
  /** The physical port name as the device spells it in this reply. */
  readonly intf: string
  readonly suspended: boolean
  /** The bundling answer this screen shows per member — this is "bundled?" as data, not inference. */
  readonly lagMember: boolean
  readonly lacpMisconfig: ShowPortChannelDenseLacpMisconfig
  readonly exceedsMaxWeight: boolean
  readonly linkDown: boolean
}

export interface ShowPortChannelDenseAggregator {
  readonly inactive: boolean
  /** Captured `"lacp"` in both; other spellings are possible device answers. */
  readonly protocol: string
  /** Captured `"active"` in both. */
  readonly lacpMode: string
  /** Captured `"up"` (hardware) and `"down"` (cEOS). */
  readonly linkState: string
  readonly ports: Readonly<Record<string, ShowPortChannelDensePort>>
}

export interface ShowPortChannelDenseReply {
  readonly numberOfAggregators: number
  readonly portChannels: Readonly<Record<string, ShowPortChannelDenseAggregator>>
  readonly numberOfChannelsInUse: number
}

declare module '@devhax-heavy-industries/arista-eapi' {
  interface ShowContracts {
    version: ShowVersionReply
    'interfaces status': ShowInterfacesStatusReply
    vlan: ShowVlanReply
    mlag: ShowMlagReply
    // S1 (#71): the in-band/management-path read. Positive captures on BOTH targets, so this is a
    // modelled command, not a `lag`-style recorded refusal.
    'management api http-commands': ShowManagementApiHttpCommandsReply
    // S5 (#75): the LAG status read — positive on both targets (hw sweep + cEOS CLI capture), same
    // evidence standing as the line above. `lag`/`lag resources` stay unmodelled recorded refusals.
    'port-channel dense': ShowPortChannelDenseReply
  }
}
