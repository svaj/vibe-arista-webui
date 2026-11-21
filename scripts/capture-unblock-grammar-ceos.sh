#!/usr/bin/env bash
# UNATTENDED cEOS-lab GRAMMAR capture (MST region removal + OSPF divergence 10/4). Safe to run
# while you are away -- it boots a THROWAWAY container, asks the questions, and always tears it
# down. Everything MST is staged in named sessions and ABORTED; the OSPF redistribute commit is
# restored to net-zero in the same run (the artifact's findings.netZero says whether it was).
#
# Questions (see scripts/capture-unblock-grammar-ceos.mjs for the full design):
#   1. #88: the `no instance …` / `no name` / `no revision` MST region removal spellings — the
#      editor at #/stp/global deliberately has no mapping removal until one of these is captured.
#   2. #87: does bare `no redistribute <proto>` clear a route-map-QUALIFIED line (client
#      divergence 10), and does the device normalize a bare `area 0` (divergence 4's device half).
#
# Honest limit: cEOS-lab 4.28.14M answers are CONTAINER verdicts only (DR-043) — never quote them
# as 7050TX-64 / 4.28.13.1M support. The harness refuses to run at all if the container shape
# rejects routing provisioning, so a green run means the OSPF questions were asked of a live process.
#
# Defaults to DRY RUN; pass --go to execute. Never run this while a CI `ceos-live`/`ceos-e2e`
# dispatch is in flight (they share the mgmt band + 8443 on this host).
set -euo pipefail

GO=0
LAB_PORT="${LAB_PORT:-8443}"
BAND="${CEOS_LAB_MGMT_BAND:-10.177}"

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
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
  trap - EXIT INT TERM
  npm run lab:down >/dev/null 2>&1 || true
}

cd "$(dirname "$0")/.."

if [ "$GO" -ne 1 ]; then
  echo "== DRY RUN (pass --go to boot a disposable cEOS and capture) =="
  echo "would run: CEOS_LAB_MGMT_BAND=$BAND npm run lab:run -- --quiet --no-fixtures --port $LAB_PORT -- node scripts/capture-unblock-grammar-ceos.mjs"
  echo "would write docs/evidence/unblock-grammar-ceos.json and always npm run lab:down."
  echo "band note: 192.168.255/172.16-12 intermittently look live but FAIL ARP under WSL2 mirrored"
  echo "mode; the harness probe fast-fails a dead draw (exit 7) — re-run to redraw the $BAND octet."
  exit 0
fi

echo "[1/2] read-only check of what the harness already owns -- make sure no CI lab dispatch is running:"
npm run lab:list || true

echo "[2/2] grammar capture on the throwaway container (band $BAND)"
trap cleanup EXIT INT TERM
CEOS_LAB_MGMT_BAND="$BAND" npm run lab:run -- --quiet --no-fixtures --port "$LAB_PORT" -- node scripts/capture-unblock-grammar-ceos.mjs

echo "== grammar cEOS capture done =="
echo "  open docs/evidence/unblock-grammar-ceos.json, check findings.netZero=true (OSPF left as"
echo "  provisioned), then transcribe the answers into DECISIONS / the #88 + #87 lanes."
echo "  CONTAINER EVIDENCE ONLY (DR-043)."
