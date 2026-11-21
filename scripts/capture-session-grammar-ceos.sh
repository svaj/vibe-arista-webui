#!/usr/bin/env bash
# UNATTENDED cEOS-lab SESSION-GRAMMAR capture (DR-147 families: name-length/charset boundary,
# description quote depth, `no-commit`, bare `show session-config`). Safe to run while you are
# away -- it boots a THROWAWAY container, asks the questions, and always tears it down.
# EVERY session this lane opens is ABORTED (nothing commits), so running-config is net-zero by
# construction; the artifact's findings["sweep-and-net-zero"] says so from the device's own listing.
#
# Questions (see scripts/capture-session-grammar-ceos.mjs for the full design):
#   A. the longest `configure session <name>` the container accepts (ladder past the client's 64,
#      then bisection) -- DR-147's first skipped discovery stub.
#   B. the character set the name parser matches, byte by byte (space, quotes, backslash, backtick,
#      '#', ';', tab, newline) -- DR-147's second stub. Injection-shaped bytes sit at the END of the
#      name so a terminating parser can only open the truncated sg-c-* prefix, which the sweep owns.
#   C. description quoting depth (embedded ", escaped \", #, ;, backslash, backtick, ') -- the
#      family the hardware run-2 plain-text round-trip never covered.
#   D. `no-commit` opener acceptance + whether an in-session commit refuses, and with what message
#      (the client's local commit() refusal rests on an image note, never a capture).
#   E. the bare `show session-config` read shape (STATUS §3 "still missing" on both targets).
#
# Honest limit: cEOS-lab 4.28.14M answers are CONTAINER verdicts only (DR-043) -- never quote them
# as 7050TX-64 / 4.28.13.1M support. The hardware halves of every family stay open after this run;
# the hardware lane still refuses these by fence (one-scratch-port licence, DR-149/DR-150).
#
# Defaults to DRY RUN; pass --go to execute. Never run this while a CI `ceos-live`/`ceos-e2e`
# dispatch is in flight (they share the mgmt band + 8443 on this host).
set -euo pipefail

GO=0
LAB_PORT="${LAB_PORT:-8443}"
BAND="${CEOS_LAB_MGMT_BAND:-10.177}"

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
  trap - EXIT INT TERM
  npm run lab:down >/dev/null 2>&1 || true
}

cd "$(dirname "$0")/.."

if [ "$GO" -ne 1 ]; then
  echo "== DRY RUN (pass --go to boot a disposable cEOS and capture) =="
  echo "would run: CEOS_LAB_MGMT_BAND=$BAND npm run lab:run -- --quiet --no-fixtures --port $LAB_PORT -- node scripts/capture-session-grammar-ceos.mjs"
  echo "would write docs/evidence/session-grammar.ceos.json and always npm run lab:down."
  echo "band note: 192.168.255/172.16-12 intermittently look live but FAIL ARP under WSL2 mirrored"
  echo "mode; the harness probe fast-fails a dead draw (exit 7) — re-run to redraw the $BAND octet."
  exit 0
fi

echo "[1/2] read-only check of what the harness already owns -- make sure no CI lab dispatch is running:"
npm run lab:list || true

echo "[2/2] session-grammar capture on the throwaway container (band $BAND)"
trap cleanup EXIT INT TERM
CEOS_LAB_MGMT_BAND="$BAND" npm run lab:run -- --quiet --no-fixtures --port "$LAB_PORT" -- node scripts/capture-session-grammar-ceos.mjs

echo "== session-grammar cEOS capture done =="
echo "  open docs/evidence/session-grammar.ceos.json, check findings[\"sweep-and-net-zero\"].netZero=true,"
echo "  then transcribe the answers into DECISIONS / the #89 lanes (DR-147 stubs, open items 7/8)."
echo "  CONTAINER EVIDENCE ONLY (DR-043)."
