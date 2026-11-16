#!/usr/bin/env bash
# UNATTENDED cEOS-lab unblock capture. Safe to run while you are away -- it boots a THROWAWAY
# container, captures, and always tears it down. Captures:
#   A. the new read/schema models added to scripts/ceos-lab.mjs -> CAPTURE_CATALOG
#      (show vxlan * / ip ospf / bgp / route-map / ip route vrf all) via `npm run fixtures:refresh`,
#   B. the #89 persistence-verb DEVICE ANSWERS (copy-run-start / configure-replace / rollback) via
#      scripts/capture-unblock-ceos.mjs -- these are fence-refused on the physical switch, so the
#      disposable container is the only safe place to record them.
#
# Honest limit (so you do not over-trust the output): cEOS-lab 4.28.14M REFUSES `ip routing`, so
# routing/VXLAN/VRF content lands as a populated schema OR a recorded 1002 negative -- the populated
# adjacency tables and the real-VXLAN/VRF *routing* state are a hardWARE-only question (#14). Container
# results are never a 7050TX verdict (DR-043).
#
# Defaults to DRY RUN; pass --go to execute. Never run this while a CI `ceos-live`/`ceos-e2e` dispatch
# is in flight (they share the mgmt band + 8443 on this host).
set -euo pipefail

GO=0
LAB_PORT="${LAB_PORT:-8443}"
DECOY_A="rea-decoy-192168255"
DECOY_B="rea-decoy-17231"
DECOYS_CREATED=0

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "usage: $0 [--go] [--port $LAB_PORT]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;;
    --port) LAB_PORT="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

cleanup() {
  # guaranteed teardown even on failure/Ctrl-C: the harness child already does its own finally, but
  # this backstops the decoy bands and any half-created network. Idempotent + tolerant.
  trap - EXIT INT TERM
  if [ "$DECOYS_CREATED" -eq 1 ]; then
    docker network rm "$DECOY_A" >/dev/null 2>&1 || true
    docker network rm "$DECOY_B" >/dev/null 2>&1 || true
    echo "[cleanup] removed mgmt-band decoy networks"
  fi
  npm run lab:down >/dev/null 2>&1 || true
}

cd "$(dirname "$0")/.."

if [ "$GO" -ne 1 ]; then
  echo "== DRY RUN (pass --go to boot a disposable cEOS and capture) =="
  echo "would create 2 decoy docker networks so the lab mgmt bridge is forced onto the clean 10.177.x"
  echo "band (192.168.255.0/24 and 172.16/12 intermittently look live but FAIL ARP under WSL2 mirrored"
  echo "mode -> mgmt-path-owned-by-host-nat / exit 7; forcing off them is what made the #91 run green)."
  echo "would run A: npm run fixtures:refresh --yes"
  echo "would run B: npm run lab:run -- --quiet --no-fixtures --port $LAB_PORT -- node scripts/capture-unblock-ceos.mjs"
  echo "would always remove the decoys + npm run lab:down."
  exit 0
fi

echo "[0/3] read-only check of what the harness already owns -- make sure no CI lab dispatch is running:"
npm run lab:list || true

echo "[1/3] forcing the clean mgmt band with throwaway decoy networks"
# candidate filter reads `docker network ls`, so claiming the contested ranges pushes the harness to 10.177.x.
if docker network create --subnet 192.168.255.0/24 "$DECOY_A" >/dev/null 2>&1 \
   && docker network create --subnet 172.31.0.0/16 "$DECOY_B" >/dev/null 2>&1; then
  DECOYS_CREATED=1
  trap cleanup EXIT INT TERM
else
  echo "[warn] could not create decoys (band may already be owned, or docker perms). Continuing; a band refusal = re-run."
fi

echo "[2/3] capture A: configured-container models (the new CAPTURE_CATALOG entries)"
npm run fixtures:refresh -- --yes

echo "[3/3] capture B: #89 persistence-verb answers on the throwaway container"
npm run lab:run -- --quiet --no-fixtures --port "$LAB_PORT" -- node scripts/capture-unblock-ceos.mjs

if [ "$DECOYS_CREATED" -eq 1 ]; then
  docker network rm "$DECOY_A" >/dev/null 2>&1 || true
  docker network rm "$DECOY_B" >/dev/null 2>&1 || true
  DECOYS_CREATED=0
fi

echo "== unblock cEOS capture done =="
echo "  A: review 'git status' under arista-api-client/test/fixtures/live/ceos-4.28.14M/ for the new show-*.json"
echo "     (missing files mean the command refused on cEOS-lab -- that negative is itself the #86/#87/#90 finding)."
echo "  B: open arista-api-client/docs/evidence/unblock-persistence.ceos.json and transcribe the answers into"
echo "     DECISIONS open item 8 / STATUS section 3, then post under #89. CONTAINER EVIDENCE ONLY (DR-043)."
