#!/usr/bin/env bash
# Run the remaining disposable cEOS evidence lanes for blocked issues #87, #88, and #89.
# Defaults to dry-run. Every real command goes through scripts/ceos-lab.mjs, which owns the
# container/network/credential lifecycle and tears it down on failure.
set -euo pipefail

GO=0
ISSUE="all"
PORT="${LAB_PORT:-8443}"
# 192.168.255.0/24 is the band the harness itself prefers (mgmtSubnetCandidates,
# "proven first"). WSL2 mirrored-mode HNS poisoning on this host proved intermittent
# per-/24 (10.177.114.0/24 verified live at create then ARP-FAILED minutes later,
# 2026-11-19), so the default follows the harness preference; override with --band.
BAND="${CEOS_LAB_MGMT_BAND:-192.168.255}"
# --nodes 2 needs TWO free /24s in the pinned band (primary mgmt + peer bmgmt): a
# single-/24 pin like 192.168.255 always refuses the peer walk with "no free /24"
# (observed 2026-11-19, run lab-385883-b63480). 10.177.16-255 offers many candidates.
BAND_2NODE="${CEOS_LAB_MGMT_BAND_2NODE:-10.177}"
EVIDENCE="0"

usage() {
  cat <<'EOF'
Usage: scripts/run-blocked-evidence.sh [--go] [--issue 87|88|89|all] [--port N] [--band PREFIX] [--evidence]

Without --go this prints the exact commands and exits without starting Docker.

Lanes:
  #87  OSPF two-node adjacency / route-withdraw blast evidence
  #88  STP configured-state + mode-change blast evidence
  #89  commit-timer/persistence mechanics and the cEOS persistence artifact

--evidence sets EAPI_TWO_NODE_EVIDENCE=1 for the live suites so their review artifacts are written
under docs/evidence/. It never writes hardware fixtures.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;;
    --issue) ISSUE="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --band) BAND="$2"; shift ;;
    --evidence) EVIDENCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

case "$ISSUE" in
  87|88|89|all) ;;
  *) echo "--issue must be 87, 88, 89, or all" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

cmd_ospf="EAPI_TWO_NODE_EVIDENCE=$EVIDENCE npm run lab:run -- --quiet --no-fixtures --port $PORT --band $BAND_2NODE --nodes 2 -- npm -w arista-api-client run test:live -- src/ospf-two-node.live.test.ts"
cmd_stp="EAPI_TWO_NODE_EVIDENCE=$EVIDENCE npm run lab:run -- --quiet --no-fixtures --port $PORT --band $BAND -- npm -w arista-api-client run test:live -- src/stp-mode-change.live.test.ts"
cmd_timer="EAPI_TWO_NODE_EVIDENCE=$EVIDENCE npm run lab:run -- --quiet --no-fixtures --port $PORT --band $BAND -- npm -w arista-api-client run test:live -- src/commit-timer-persistence.live.test.ts"
cmd_persist="npm run lab:run -- --quiet --no-fixtures --port $PORT --band $BAND -- node scripts/capture-unblock-ceos.mjs"

if [ "$GO" -ne 1 ]; then
  echo "== DRY RUN: no Docker, cEOS, or EOS device call will occur =="
  echo "[host gate] cat /proc/sys/kernel/unprivileged_bpf_disabled; expected 0 or 1, never 2"
  [ "$ISSUE" = 87 ] || [ "$ISSUE" = all ] && echo "#87: $cmd_ospf"
  [ "$ISSUE" = 88 ] || [ "$ISSUE" = all ] && echo "#88: $cmd_stp"
  if [ "$ISSUE" = 89 ] || [ "$ISSUE" = all ]; then
    echo "#89 timers: $cmd_timer"
    echo "#89 persistence verbs: $cmd_persist"
  fi
  echo "All commands are disposable-container only and never target the physical switch."
  exit 0
fi

BPF="$(cat /proc/sys/kernel/unprivileged_bpf_disabled 2>/dev/null || echo unknown)"
if [ "$BPF" = 2 ]; then
  echo "BLOCKED BEFORE DOCKER: kernel.unprivileged_bpf_disabled=2" >&2
  echo "Move this lane to native Linux, switch WSL/cgroup policy so the value is 0 or 1 at boot," >&2
  echo "or use a trusted runner with container-to-container L2 already proven." >&2
  exit 64
fi

npm run lab:list || true

run() {
  echo "+ $*"
  # One retry: WSL2 mirrored-mode HNS poisoning is intermittent per-/24 (a band can
  # verify a live connected route at create and ARP-FAIL minutes later — 2026-11-19).
  # The harness tears down fully on failure, so a second attempt draws fresh subnets.
  if eval "$*"; then
    return 0
  fi
  echo "lane failed — retrying once with fresh lab subnets" >&2
  eval "$*"
}

if [ "$ISSUE" = 87 ] || [ "$ISSUE" = all ]; then run "$cmd_ospf"; fi
if [ "$ISSUE" = 88 ] || [ "$ISSUE" = all ]; then run "$cmd_stp"; fi
if [ "$ISSUE" = 89 ] || [ "$ISSUE" = all ]; then
  run "$cmd_timer"
  run "$cmd_persist"
fi

npm run lab:list
