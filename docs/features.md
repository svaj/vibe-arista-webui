# Supported Features — Arista 7050X

Feature checklist for what this Web UI project plans to support, derived from the
[Arista supported-features matrix](https://www.arista.com/en/support/product-documentation/supported-features)
for the **7050X** series, and what's in EOS 4.28.13M.

> - Only features marked **Yes** in the source matrix are listed; unsupported features are intentionally omitted.
> - Check an item off once the UI covers it.
> - *(FlexProfile)* / *(FlexProfile Lite)* = the source matrix ties the feature to a programmable
>   forwarding-profile partition (FLX / FLX-Lite). Other footnote tags from the source (E, Z, V2) are dropped.
> - **Tick audit 2026-11-15:** a checked box means a shipped UI screen covers the row's core, with the
>   screen/issue key in the note. Rows the UI covers only partly are left **unchecked** and carry an
>   inline *partial* note so the covered half is still findable. Title still says **7050X** — re-derive
>   is DECISIONS open item 6, not done here.

### Note
Since this was pulled from a feature list, this needs to be turned into relevant terminology for our project.  (E.g "IEEE 1588 PTP — two-step transparent clock" might just be "IEE 1588 PTP configuration")

## Management & System Services

- [ ] (Medium priority) Allow command execution / a shell to EOS *(partial: S4 #74 console executes operator-typed reads behind an allow-list — no shell, no config writes)*
- [ ] SSH v2 (with SSH host keys) config
- [ ] Telnet config
- [ ] Management VRF
- [ ] Management port isolation
- [ ] Management to IPv6 addresses on VLAN and management interfaces
- [ ] (Low priority) DNS client
- [x] NTP / NTPv6 *(S12 #82: server add/prefer/remove + source/local-interface staged via named session; NTPv6 address forms unproven on this target)*
- [ ] NTP extensions for DHCP in ZTP
- [ ] IEEE 1588 PTP — two-step boundary clock
- [ ] IEEE 1588 PTP — two-step transparent clock
- [ ] IEEE 1588 PTP — one-step transparent clock
- [ ] IEEE 802.1AB LLDP
- [ ] (Medium priority) View Syslog
- [ ] File download via FTP, TFTP, HTTP, HTTPS
- [x] Login and MOTD banners *(S8 #78: motd/login/exec banners, EOF-framed, plus hostname and the ip-routing toggle)*
- [ ] Interface range support *(the interface-name grammar refuses range forms — DECISIONS open item 7)*
- [ ] Show reload cause
- [ ] VMs on EOS / VMTracer
- [ ] Locator LED control
- [ ] Digital Optical Monitoring (DOM)
- [ ] Zero Touch Provisioning (ZTP)
- [ ] CLI Scheduler
- [ ] Event Manager / Event Monitor
- [ ] Tcpdump sessions
- [ ] Smart System Upgrade (SSU) — leaf, and spine in maintenance mode
- [ ] Configure replace *(no UI; the hardware probe lane fences the verb — see docs/CAPTURE-UNBLOCK.md; #89)*
- [x] Config sessions (incl. merge on commit) *(S9 #79 transaction center; #141 adds one app-wide in-memory session shared across screens, ordered multi-change staging, combined device diff, and central commit/abort; save/rollback half parked at #89)*
- [ ] Config versions
- [ ] Bug Alerts

## Security & Access Control

- [ ] (Medium-high priority) Ingress and egress IPv6 ACLs
- [ ] Control-Plane ACLs (CP-ACL)
- [ ] ACL counters
- [ ] ACL deny logging
- [ ] Discontiguous masks for IPv6 ACLs
- [x] Layer 3 ACLs *(S13 #83: IPv4 standard + extended viewer/editor over the parsed `ip access-list` sections; IPv6 ACLs and interface attachment out of scope)*
- [ ] TACACS+ authentication & authorization (PAP)
- [ ] TACACS+ accounting
- [ ] RADIUS authentication, authorization, and accounting
- [ ] RADIUS hitless key rotation
- [ ] Proactive probing for RADIUS servers
- [ ] RFC 6614 RadSec support for RADIUS
- [ ] Role-Based Access Control (RADIUS / TACACS+)
- [ ] Password complexity requirements
- [ ] TLSv1.3 in SSL profiles
- [ ] User-configurable hardware control-plane policing (CoPP)

## Observability, Mirroring & Automation

- [x] (High priority) EOS API (eAPI) Typescript client *(packaged `@devhax-heavy-industries/arista-eapi`: resource modules, named config sessions, recording/live lanes, docs — consumed by the proxy this UI rides)*
- [ ] OpenConfig models over gRPC / RESTCONF / NETCONF
- [ ] OpenConfig support for CPU state
- [ ] GNSI (gRPC Network Security Interface)
- [ ] LANZ (Latency Analyzer)
- [ ] Path Tracer
- [ ] MapReduce Tracer with YARN support
- [ ] Mirror to EOS
- [ ] Mirroring to GRE tunnel
- [ ] Sampled Flow Tracking with IPFIX export
- [ ] Connectivity Monitor (IPv4 / IPv6)
- [ ] DirectFlow

## Layer 2

- [x] (High priority) VLAN-based port segmentation *(S2 #72 VLAN create/rename/delete/state + S1 #71 / S3 #73 per-port access/trunk assignment)*
- [ ] Tagged native VLAN mode
- [ ] IEEE 802.1D bridging
- [x] IEEE 802.1Q trunking *(S3 #73 trunk editor — mode/native-VLAN/allowed-lists through a named session; S1 #71 → S3 per-port deep link from #126; trunk-group writes probe-gated)*
- [ ] IEEE 802.1Q-in-Q and selective Q-in-Q
- [ ] VLAN translation / dual-tag VLAN manipulation
- [ ] PVLAN
- [ ] IEEE 802.1w RSTP
- [ ] IEEE 802.1s MSTP
- [ ] Rapid Per-VLAN Spanning Tree (Rapid-PVSTP)
- [ ] MST–PVST interop
- [x] BPDU guard / BPDU filtering *(S15 #85 per-port `spanning-tree bpduguard` + `portfast`/edge/auto writes through a named session; BPDU filtering is not in the ported pyeapi stp verbs, so that half stays open)*
- [ ] Root guard / loop guard / loop protection
- [ ] Bridge assurance
- [ ] Disable STP on a VLAN (routed ports)
- [ ] Backup interface
- [x] (High priority) Link Aggregation Groups — up to 16 ports per LAG, 64 member interfaces total *(S5 #75 LAG manager — create/edit/resolve members via the config relation, DR-075; the 16/64 limits themselves are retired wrong-SKU prose per open item 6)*
- [x] (High priority) IEEE 802.3ad LACP (incl. minimum links) *(S5 #75: member `channel-group <id> mode <x>` writes; `port-channel min-links` / `lacp fallback [timeout]` read as config fields, with presence F5-probed)*
- [ ] LAG hash on L2 & L3 header fields
- [ ] Multi-chassis LAG (MLAG), incl. peer gateway *(view-only: S14 #84 read-only status screen; config + validation need a second physical device — DECISIONS' MLAG note)*
- [ ] IGMP snooping + MLAG
- [ ] VARP for MLAG / VARP + proxy-ARP
- [ ] Port mirroring (port-channel source supported)
- [ ] VLAN mirroring (ingress)
- [ ] Layer 2 access lists
- [ ] Interface rate counters
- [ ] MAC address table configuration
- [ ] Static MAC multicast
- [ ] Auto-negotiation with 1000BASE-X; auto MDI/MDI-X on Base-T
- [ ] IEEE 802.3x PAUSE frames (RX and TX)
- [ ] Priority Flow Control watchdog
- [x] Jumbo frames up to 9214 bytes *(S1 #71 per-interface mtu writes; the 9214 ceiling is device-side, the UI sends whatever the client's mtu guard admits)*
- [ ] sFlow
- [ ] Storm control
- [ ] Control-Plane Protection (CoPP)
- [ ] Permit traffic during ACL reprogram
- [ ] IEEE 802.1X port-based network access control (PNAC) + accounting
- [ ] IEEE 802.1X dynamic VLAN assignment
- [ ] 802.1X MAC-based authentication (MAB)
- [ ] L2 protocol forwarding profiles

## QoS

- [ ] Interface QoS trust
- [ ] Egress port shaping
- [ ] Egress queue scheduling and shaping
- [ ] DSCP marking on ingress
- [ ] DSCP rewrite for bridged traffic
- [ ] L3 ACL-based DSCP rewrite
- [ ] DSCP for CPU-generated traffic
- [ ] Weighted Round Robin scheduling
- [ ] ACL policing
- [ ] QoS profiles
- [ ] Per-port, per-VLAN QoS
- [ ] SVI egress policy
- [ ] Explicit Congestion Notification (ECN)
- [ ] IEEE 802.1Qbb PFC (Priority-based Flow Control)
- [ ] IEEE 802.1Qaz DCBX

## VXLAN & EVPN

> Device note (2026-11-15, DECIDED 2026-11-17): the 7050TX-64 capture set answers
> `show license features` = `{"active":[],"missing":[]}`; the stage-then-abort probes ran (runs 7/9)
> and found the VTEP config grammar stages (`interface Vxlan1`, `vxlan vlan <id> vni <n>`,
> `vxlan source-interface`) while every VXLAN read stays suppressed/empty — **feature-absent**.
> **DECISION: the VXLAN/EVPN UI does not ship on this deployment (#86 closed won't-ship, DR-142).**
> Nothing below is tickable; the rows stay as 7050X datasheet content, and DR-142's disposition
> never edits them. Reopen is evidence-gated: one populated `show vxlan …` read from this hardware.

### Bridging & Routing

- [ ] VXLAN bridging (with MLAG)
- [ ] VXLAN routing; IPv6 VXLAN routing
- [ ] VXLAN routing with overlay VRFs
- [ ] L2 overlay ECMP
- [ ] VTEP encapsulation/decapsulation counters
- [ ] VXLAN multicast decapsulation
- [ ] VXLAN hardware head-end replication (HER)
- [ ] EVPN config sanity

### EVPN

- [ ] BGP L2 EVPN (Type-2, MAC only) *(FlexProfile Lite)*
- [ ] BGP L2 EVPN IRB support, incl. IPv6 *(FlexProfile Lite)*
- [ ] BGP L3 EVPN (Type-5) for IPv4 and IPv6 *(FlexProfile Lite)*
- [ ] EVPN Type-5 interface-full
- [ ] ARP relay for EVPN DCI *(FlexProfile Lite)*
- [ ] DHCP relay in VXLAN EVPN *(FlexProfile Lite)*
- [ ] IPv4 multicast routing with VXLAN using underlay tree *(FlexProfile Lite)*

## Layer 3

### Static Routing & Interfaces

- [ ] IPv4 / IPv6 static routing; static IPv4 routes with IPv6 next hops *(IPv4 only: S10 #80 manager; its guard explicitly refuses IPv6 forms)*
- [ ] Routed interfaces and L3 subinterfaces *(partial: S6 #76 edits routed-port IPv4 addressing (`no switchport` + address); L3 subinterface spellings are refused by the name grammar — open item 7)*
- [ ] Loopback and NULL interfaces
- [ ] SVI counters (ingress and egress)
- [ ] IP unnumbered (OSPF, IS-IS, BFD)
- [x] Layer 3 access lists *(S13 #83 — same shipped screen as the Security section's "Layer 3 ACLs": IPv4 standard/extended CRUD; hit counters withheld, `show access-lists` refuses on this target)*

### Next Hops, Tunnels & Availability

- [ ] ECMP / L3 multipathing (up to 128 interfaces per ECMP group)
- [ ] IP UCMP
- [ ] IP next-hop groups
- [ ] GRE tunnel interfaces; GRE ECMP next-hop groups; GRE next-hop group liveness detection
- [ ] IP-in-IP ECMP next-hop groups; IP-in-IP termination (decap group)
- [ ] ECMP visibility over tunnels
- [ ] VRRP / VRRPv6; VRF-aware VRRP BFD; VRRP + local proxy-ARP
- [ ] IPv6 ND proxy
- [ ] BFD (v4/v6, VRF-aware, multi-hop, passive mode, hardware-accelerated TX)
- [ ] RAIL (Rapid Automated Indication of Link Loss)
- [ ] Unicast Reverse Path Forwarding (IPv4 and IPv6)
- [ ] IP directed broadcast
- [ ] RFC 9131 IPv6 unsolicited NA

### OSPF

- [ ] OSPFv2 (multiple instances, multi-agent / default VRF)
- [ ] OSPFv2 TE protocol extensions
- [ ] OSPFv3 (incl. encryption, BFD, graceful restart)
- [ ] OSPFv2/v3 graceful restart
- [ ] OSPF fallback metric
- [ ] RFC 5838 support for OSPFv3 AF
- [ ] OSPF/IS-IS over GRE tunnels

### IS-IS

- [ ] IS-IS
- [ ] IS-IS TE and IPv6 TE protocol extensions *(FlexProfile)*
- [ ] IS-IS graceful restart
- [ ] IS-IS area migration
- [ ] IS-IS conditional advertisement
- [ ] IS-IS route summarization for L1-to-L2 leaked routes
- [ ] IS-IS advertise high-metrics on startup
- [ ] Hitless key rotation for IS-IS authentication
- [ ] IS-IS LDSB OpenConfig model streaming

### BGP

- [ ] BGPv4 and MP-BGP IPv6
- [ ] BGP graceful restart
- [ ] BGP UCMP
- [ ] BGP PIC (multi-agent mode)
- [ ] BGP Add-Path
- [ ] BGP TCP-AO (Authentication Options)
- [ ] BGP min-hold-timer
- [ ] BGP session tracker
- [ ] BGP session-driven failure
- [ ] BGP route flap damping
- [ ] BGP optimal route reflection *(FlexProfile)*
- [ ] BGP Monitoring Protocol (BMP), incl. station in non-default VRF
- [ ] RPKI Phase 1 *(FlexProfile)* and multiple ROA tables *(FlexProfile)*
- [ ] RFC 5549 (IPv4 routes with IPv6 next hops)
- [ ] BGP IPv6 link-local peering
- [ ] BGP set next-hop IGP metric
- [ ] EPE BGP-LU bindings; BGP-LU AIGP; BGP-LU v4-mapped-v6 next-hop; BGP-LU resolution via SR-TE *(FlexProfile)*
- [ ] BGP Link-State producer and route reflector
- [ ] Default VRF BGP RIB streaming via OpenConfig
- [ ] BGP RIB dump into MRT file

### Policy, VRFs & DHCP/ARP

- [x] VRF instances — create/delete, rd, description, per-VRF IPv4/IPv6 routing flags, port assignment *(S16 #90: `#/vrfs` VRF manager; every staged batch is a run-9-proven or `vrfs.test.ts`-pinned composition (DR-141), the device columns ride the capture-backed `show vrf` contract — both captures are default-only today, so no named-VRF device shape is claimed)*
- [ ] Route maps
- [ ] Routing Control Plane Functions / Routing Configuration Functions (RCF)
- [ ] Selective route download
- [ ] Route prioritization across protocols and across VRFs
- [ ] Policy Based Routing (PBR) for IPv4
- [ ] RIPv2
- [ ] Dataplane VRFs (IPv4 and IPv6)
- [ ] Inter-VRF route leaking (multi-agent mode)
- [ ] DHCP relay (incl. per interface)
- [ ] DHCPv6 prefix delegation; DHCPv6 option 17
- [ ] DHCP PD persistence on reload
- [ ] DHCP in non-default VRFs
- [ ] Static ARP entries

## Multicast

- [ ] IGMPv2/v3 snooping and querier
- [ ] IGMP snooping proxy / IGMP host proxy
- [ ] MLDv2
- [ ] PIM-SSM (incl. ASU) and PIM-SMv6
- [ ] PIM-SM/SSM + IGMP, with/without BSR
- [ ] PIM bidirectional
- [ ] PIM multicast-based RPF (MBR)
- [ ] PIM graceful restart
- [ ] PIM + MLAG; PIM unnumbered
- [ ] PIMv4 over IPv6 next hop
- [ ] PIM RP multicast source filter
- [ ] Anycast RP
- [ ] MSDP
- [ ] MoFRR
- [ ] Static multicast routes
- [ ] IP multicast multipath (ECMP)
- [ ] VRF support for IP multicast
- [ ] Unicast-to-multicast BGP redistribution
- [ ] Multicast EVPN transit capability *(FlexProfile Lite)*

## MPLS

- [ ] Static MPLS label push / pop / swap *(FlexProfile Lite)*
- [ ] MPLS next-hop groups, IPv4 and IPv6 *(FlexProfile)*
- [ ] MPLS ping / traceroute *(FlexProfile)*
- [ ] MPLS static route with BGP peer tracking
- [ ] Static QoS: derive EXP from DSCP on push; copy EXP on swap; copy EXP to internal TC *(FlexProfile Lite / FlexProfile)*

## Campus / Access

- [ ] 802.1X single-host and multi-host authentication
- [ ] 802.1X MAC-based authentication (MAB), incl. simultaneous MAB + 802.1X
- [ ] Dynamic VLAN assignment for 802.1X / MAB
- [ ] 802.1X AUTH-FAIL (guest/overflow) VLAN
- [ ] Global 802.1X auth enable
- [ ] 802.1X force-authorized mode
- [ ] 802.1X fail timeout, EAP-REQ resend timeouts, re-authentication timeout, idle timeout
- [ ] 802.1X + MAB interop
- [ ] 802.1X AAA unresponsive action
- [ ] Cache after EAP logoff
- [ ] Dynamic ACL assignment by name
- [ ] Change of Authorization (CoA) from AAA server (disconnect, ACL change)
- [ ] RadSec
- [ ] LLDP-MED bypass
- [ ] Port security
- [ ] Per-interface MAC address aging timer
- [ ] DHCP server in EOS (system-wide and per interface)
- [ ] Audio Video Bridging (AVB)

## Segmentation

- [ ] MSS-FW (segmentation firewall redirect)