# Supported Features — Arista 7050X

Feature checklist for what this Web UI project plans to support, derived from the
[Arista supported-features matrix](https://www.arista.com/en/support/product-documentation/supported-features)
for the **7050X** series, and what's in EOS 4.28.13M.

> - Only features marked **Yes** in the source matrix are listed; unsupported features are intentionally omitted.
> - Check an item off once the UI covers it.
> - *(FlexProfile)* / *(FlexProfile Lite)* = the source matrix ties the feature to a programmable
>   forwarding-profile partition (FLX / FLX-Lite). Other footnote tags from the source (E, Z, V2) are dropped.

### Note
Since this was pulled from a feature list, this needs to be turned into relevant terminology for our project.  (E.g "IEEE 1588 PTP — two-step transparent clock" might just be "IEE 1588 PTP configuration")

## Management & System Services

- [ ] (Medium priority) Allow command execution / a shell to EOS
- [ ] SSH v2 (with SSH host keys) config
- [ ] Telnet config
- [ ] Management VRF
- [ ] Management port isolation
- [ ] Management to IPv6 addresses on VLAN and management interfaces
- [ ] (Low priority) DNS client
- [ ] NTP / NTPv6
- [ ] NTP extensions for DHCP in ZTP
- [ ] IEEE 1588 PTP — two-step boundary clock
- [ ] IEEE 1588 PTP — two-step transparent clock
- [ ] IEEE 1588 PTP — one-step transparent clock
- [ ] IEEE 802.1AB LLDP
- [ ] (Medium priority) View Syslog
- [ ] File download via FTP, TFTP, HTTP, HTTPS
- [ ] Login and MOTD banners
- [ ] Interface range support
- [ ] Show reload cause
- [ ] VMs on EOS / VMTracer
- [ ] Locator LED control
- [ ] Digital Optical Monitoring (DOM)
- [ ] Zero Touch Provisioning (ZTP)
- [ ] CLI Scheduler
- [ ] Event Manager / Event Monitor
- [ ] Tcpdump sessions
- [ ] Smart System Upgrade (SSU) — leaf, and spine in maintenance mode
- [ ] Configure replace
- [ ] Config sessions (incl. merge on commit)
- [ ] Config versions
- [ ] Bug Alerts

## Security & Access Control

- [ ] (Medium-high priority) Ingress and egress IPv6 ACLs
- [ ] Control-Plane ACLs (CP-ACL)
- [ ] ACL counters
- [ ] ACL deny logging
- [ ] Discontiguous masks for IPv6 ACLs
- [ ] Layer 3 ACLs
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

- [ ] (High priority) EOS API (eAPI) Typescript client
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

- [ ] (High priority) VLAN-based port segmentation
- [ ] Tagged native VLAN mode
- [ ] IEEE 802.1D bridging
- [ ] IEEE 802.1Q trunking
- [ ] IEEE 802.1Q-in-Q and selective Q-in-Q
- [ ] VLAN translation / dual-tag VLAN manipulation
- [ ] PVLAN
- [ ] IEEE 802.1w RSTP
- [ ] IEEE 802.1s MSTP
- [ ] Rapid Per-VLAN Spanning Tree (Rapid-PVSTP)
- [ ] MST–PVST interop
- [ ] BPDU guard / BPDU filtering
- [ ] Root guard / loop guard / loop protection
- [ ] Bridge assurance
- [ ] Disable STP on a VLAN (routed ports)
- [ ] Backup interface
- [ ] (High priority) Link Aggregation Groups — up to 16 ports per LAG, 64 member interfaces total
- [ ] (High priority) IEEE 802.3ad LACP (incl. minimum links)
- [ ] LAG hash on L2 & L3 header fields
- [ ] Multi-chassis LAG (MLAG), incl. peer gateway
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
- [ ] Jumbo frames up to 9214 bytes
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

- [ ] IPv4 / IPv6 static routing; static IPv4 routes with IPv6 next hops
- [ ] Routed interfaces and L3 subinterfaces
- [ ] Loopback and NULL interfaces
- [ ] SVI counters (ingress and egress)
- [ ] IP unnumbered (OSPF, IS-IS, BFD)
- [ ] Layer 3 access lists

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