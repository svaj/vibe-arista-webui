/**
 * M13 (#15) typed show contracts for the screens this webui needs
 * (`arista-api-client/docs/PLAN.md` M13: `show version`, `show interfaces status`, `show vlan`,
 * `show mlag`, `show lag`).
 *
 * The client deliberately ships an **empty** {@link ShowContracts} map (ARCHITECTURE.md §9.1:
 * consumers widen it by declaration merging "so app code gets typed `show` output without waiting
 * for upstream releases"), and `Node#show` keys the map on the command literal **without** its
 * `show ` prefix (`command-layer.ts`'s `showCommand`, pinning MIGRATION.md §2 / USAGE.md §4:
 * `node.show('vlan 20')`, contract key `'lag counters'`). So these five keys are `version`,
 * `'interfaces status'`, `vlan`, `mlag`, and `lag`.
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
 * **`lag` is deliberately NOT augmented yet**: no capture of `show lag` exists in either fixture
 * corpus, cEOS-lab never ran it, and `show lag resources` is an open 7050TX-64 hardware-sweep
 * item (STATUS.md §3), so publishing a field list for it would be invented shape — the very
 * failure mode DR-011/DR-043's evidence discipline refuses. Until the sweep captures it,
 * `node.show('lag')` stays `unknown` and a LAG screen must narrow honestly or read the
 * `port-channel` captures instead; the capture path is `scripts/ceos-lab.mjs` (cEOS) plus the
 * STATUS §3 batch (hardware).
 */
declare module '@devhax-heavy-industries/arista-eapi' {
  interface ShowContracts {
    version: ShowVersionReply
    'interfaces status': ShowInterfacesStatusReply
    vlan: ShowVlanReply
    mlag: ShowMlagReply
  }
}
