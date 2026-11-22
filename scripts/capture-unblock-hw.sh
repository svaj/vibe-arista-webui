#!/usr/bin/env bash
# Operator runner for the AUTHORIZED physical-7050TX-64 unblock capture day.
#
# Captures, in order, the device evidence the blocked Web-UI issues still need:
#   1. read-only inventory (incl. the new VXLAN / OSPF / BGP / route-map / VRF reads added to
#      src/testing/hw-capture.ts -> HW_INVENTORY_CATALOG), then
#   2. the abort-only staged-grammar probes in docs/hw-capture-unblock.draft.json.
#
# SAFETY: step 2 never commits (allowCommit:false), so default forwarding on the live ports is
# untouched -- the scoped authorization granted 2026-11-15. #89's persistence verbs are deliberately
# NOT here (the hardware lane refuses copy-run-start/configure-replace/rollback by fence); run those
# on a throwaway container instead: npm run lab:run -- --quiet --no-fixtures -- node scripts/capture-unblock-ceos.mjs
#
# Defaults to DRY RUN: it prints exactly what it would do and exits 0. Pass --go to actually run.
# Credentials are read securely; NOTHING here prints the password or writes it to shell history.
set -euo pipefail

GO=0
HOST="${EAPI_HOST:-}"
USER_NAME="${EAPI_USER:-}"
MODEL="${EAPI_ALLOW_MODEL:-DCS-7050TX-64-R}"
VERSION="${EAPI_ALLOW_VERSION:-4.28.13.1M}"
PORT="${EAPI_PORT:-443}"
CA_FILE="${EAPI_CA_FILE:-}"
FINGERPRINT="${EAPI_FINGERPRINT:-}"
SCRUB="${EAPI_HW_SCRUB:-}"   # comma list: hostname,mgmt-ip,lab-domain,default-gateway,lan-dns -- every occurrence scrubbed
DO_INVENTORY=1
DO_PROBE=1
# Run 8 (2026-11-16) proved the silent-default hazard: re-running "the unblock script" without
# EAPI_HW_PROBE_SPEC re-stages ROUND 1 (already-answered) batches. Round 2 stays the default (it is
# the last EXECUTED round); --spec1/--spec2 re-confirm, --spec3 selects the DRAFT round-3 spec
# (rapid-pvst + MST-region removals + subinterface context, DR-158 — needs --scratch). Any explicit
# EAPI_HW_PROBE_SPEC prefix still overrides.
SPEC_SELECT=2
SCRATCH="${EAPI_SCRATCH_INTERFACE:-}"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "usage: $0 --go [--host H] [--user U] [--port 443] [--ca /tmp/eapi.pem] [--fp AA:BB:..] [--scrub h,ip,domain,gateway,dns] [--spec1|--spec2|--spec3 [--scratch Ethernet33]]"
  echo "       (no --go -> dry run only; --spec2 default = round-2 port-composed probes, --spec1 = run-7 set,"
  echo "        --spec3 = DRAFT round 3 (DR-158): rapid-pvst + MST-region removals + subinterface context;"
  echo "        round 3 names {{SCRATCH}}, so --spec3 requires --scratch <proven-unused-port>)"
  echo "       --scrub MUST include every literal that maps YOUR network: hostname, mgmt ip, lab domain,"
  echo "       DEFAULT GATEWAY and LAN DNS server -- diff-context lines and read replies carry those."
  echo "       (no --go  -> dry run only)"
  echo
  echo "cert triple (HARDWARE-CAPTURE.md section 2.3 -- the box serves a self-signed leaf,"
  echo "CN=self.signed, NO SAN). Grab --ca and --fp from any machine that can reach the switch:"
  echo "  openssl s_client -connect H:443 </dev/null 2>/dev/null | openssl x509 -outform PEM > /tmp/eapi-H.pem"
  echo "  openssl x509 -in /tmp/eapi-H.pem -noout -subject              # sanity: expect 'CN = self.signed'"
  echo "  openssl x509 -in /tmp/eapi-H.pem -noout -fingerprint -sha256  # shows 'sha256 Fingerprint=AA:BB:..'"
  echo "pass --fp the HEX ONLY (colons fine; the client does NOT strip the 'Fingerprint=' label), e.g.:"
  echo "  --fp \"\$(openssl x509 -in /tmp/eapi-H.pem -noout -fingerprint -sha256 | sed 's/.*=//')\""
  echo "EAPI_SERVER_NAME=self.signed is exported below automatically; without it every call dies in TLS."
}

while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;;
    --host) HOST="$2"; shift ;;
    --user) USER_NAME="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --ca) CA_FILE="$2"; shift ;;
    --fp) FINGERPRINT="$2"; shift ;;
    --scrub) SCRUB="$2"; shift ;;
    --spec1) SPEC_SELECT=1 ;;
    --spec2) SPEC_SELECT=2 ;;
    --spec3) SPEC_SELECT=3 ;;
    --scratch) SCRATCH="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

# Resolve the probe spec once, against the REPO ROOT (the script's location -- not $PWD, which
# depends on where the operator invoked it). An explicit EAPI_HW_PROBE_SPEC always wins (runbook
# compat, and then it is the operator's path verbatim); else --spec1/--spec2 pick the repo file.
# A missing file is a hard exit BEFORE the password prompt.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# NOTE the asymmetric file names: round 1 shipped as hw-capture-unblock.draft.json (no digit).
if [ "$SPEC_SELECT" = "1" ]; then
  SPEC_DEFAULT="$REPO_ROOT/arista-api-client/docs/hw-capture-unblock.draft.json"
elif [ "$SPEC_SELECT" = "3" ]; then
  SPEC_DEFAULT="$REPO_ROOT/arista-api-client/docs/hw-capture-unblock3.draft.json"
else
  SPEC_DEFAULT="$REPO_ROOT/arista-api-client/docs/hw-capture-unblock2.draft.json"
fi
SPEC="${EAPI_HW_PROBE_SPEC:-$SPEC_DEFAULT}"
if [ ! -f "$SPEC" ]; then
  echo "probe spec not found: $SPEC" >&2
  echo "  round files: arista-api-client/docs/hw-capture-unblock.draft.json (run 7) / hw-capture-unblock2.draft.json (round 2) / hw-capture-unblock3.draft.json (round 3, DRAFT)" >&2
  exit 2
fi
# Round 3 is the first unblock round whose spec names {{SCRATCH}} (the subinterface-context batch),
# so --spec3 (or any scratch-naming spec) requires the declared unused port up front -- the lane's
# requireScratchInterface gate would refuse later anyway; failing here keeps it out of the password
# prompt. Parsed from the batches, not grepped: round 2's $comment literally says "NO batch uses
# {{SCRATCH}}", and a text grep would false-positive on that sentence.
if node -e '
  const fs = require("node:fs")
  const spec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const hit = (spec.batches ?? []).some((b) => (b.commands ?? []).some((c) => String(c).includes("{{SCRATCH}}")))
  process.exit(hit ? 0 : 1)
' "$SPEC"; then
  if [ -z "$SCRATCH" ]; then
    echo "the selected spec names {{SCRATCH}}: pass --scratch <proven-unused-interface> (e.g. Ethernet33, verified unused in the DR-150/DR-158 persistence runs)" >&2
    exit 2
  fi
fi

if [ "$GO" -ne 1 ]; then
  echo "== DRY RUN (pass --go to execute against the switch) =="
  echo "would set: EAPI_HOST=$HOST EAPI_ALLOW_HOSTS=$HOST EAPI_PORT=$PORT EAPI_ALLOW_PORTS=$PORT"
  echo "           EAPI_ALLOW_MODEL=$MODEL EAPI_ALLOW_VERSION=$VERSION EAPI_HW_CONSENT=$MODEL"
  echo "           EAPI_CA_FILE=$CA_FILE EAPI_FINGERPRINT=<set?> EAPI_SERVER_NAME=self.signed"
  echo "           EAPI_HW_SCRUB=$SCRUB"
  echo "would run 1: EAPI_HW_CAPTURE=1 npm -w arista-api-client run test:live -- src/hw-inventory.live.test.ts"
  echo "would run 2: EAPI_HW_SESSION_PROBE=1 EAPI_HW_PROBE_SPEC=$SPEC${SCRATCH:+ EAPI_SCRATCH_INTERFACE=$SCRATCH} \\"
  echo "                 npm -w arista-api-client run test:live -- src/hw-session-probe.live.test.ts"
  echo "(spec resolves from --spec1/--spec2/--spec3 or an explicit EAPI_HW_PROBE_SPEC; a missing spec file hard-exits)"
  echo "(npm -w, NOT 'npx vitest run -w ... --project live': the live project is defined only in"
  echo " arista-api-client/vitest.config.ts, and --project resolution from the repo root fails --"
  echo " ci.yml records the same fix for the lab lane, probed 2026-11-08)"
  echo "NO commit is made in step 2 (allowCommit:false); step 1 is read-only."
  exit 0
fi

# --- executing for real -------------------------------------------------------
[ -n "$HOST" ] || { echo "--host required" >&2; exit 2; }
[ -n "$USER_NAME" ] || { echo "--user required" >&2; exit 2; }
[ -n "$CA_FILE" ] || { echo "--ca (leaf PEM) required: the box cert is CN=self.signed with no SAN" >&2; exit 2; }
[ -n "$FINGERPRINT" ] || { echo "--fp (sha256 fingerprint) required" >&2; exit 2; }

export EAPI_HW_PW=''   # MUST be exported BEFORE the read: EAPI_PASS_VAR names this variable, and
# resolveLiveEnv reads process.env[EAPI_PASS_VAR] -- a shell-only var never reaches the vitest
# child. Hit live 2026-11-15: without this, the guard refused EAPI_PASS_VAR_UNSET and BOTH files
# skipped loudly while the script printed "done" (the switch was never contacted -- skip precedes TLS).
read -rs -p "eAPI password for $USER_NAME (not stored): " EAPI_HW_PW; echo
[ -n "$EAPI_HW_PW" ] || { echo "empty password -- refusing (would skip everything)" >&2; exit 2; }
# The runbook's consent echo binds the exact variant; wrong box -> EAPI_HW_CONSENT_MISMATCH, nothing captured.
read -rs -p "re-type the model name to consent to writing a probe session on $MODEL: " consent; echo
[ "$consent" = "$MODEL" ] || { echo "consent echo did not match $MODEL -- refusing" >&2; exit 3; }

export EAPI_LIVE=1 EAPI_TARGET_CLASS=hardware
export EAPI_HOST="$HOST" EAPI_ALLOW_HOSTS="$HOST"
export EAPI_PORT="$PORT" EAPI_ALLOW_PORTS="$PORT"
export EAPI_USER="$USER_NAME" EAPI_PASS_VAR=EAPI_HW_PW
export EAPI_ALLOW_MODEL="$MODEL" EAPI_ALLOW_VERSION="$VERSION" EAPI_HW_CONSENT="$MODEL"
export EAPI_CA_FILE="$CA_FILE" EAPI_FINGERPRINT="$FINGERPRINT" EAPI_SERVER_NAME=self.signed
export EAPI_HW_SCRUB="$SCRUB"
# Rounds 1-2 name no {{SCRATCH}}, so EAPI_SCRATCH_INTERFACE stays unset for them. Round 3 does name
# it (subinterface-context batch) -- export only when the operator declared a port.
if [ -n "$SCRATCH" ]; then export EAPI_SCRATCH_INTERFACE="$SCRATCH"; fi

cd "$REPO_ROOT"
RECORDINGS_DIR=arista-api-client/test/fixtures/recordings/7050tx-64-r-4.28.13.1M

guard_nothing_recorded() {
  # A green-exiting run that wrote NO recording means the gates skipped us (live files skip with
  # exit 0 by DR-034 design). Fail loudly here instead of letting "done" lie -- the 2026-11-15 run
  # did exactly this because of the unexported password var.
  if [ -z "$(git status --short "$RECORDINGS_DIR")" ]; then
    echo "FATAL: the run exited without a single new/changed file under $RECORDINGS_DIR" >&2
    echo "       -- the hardware gates SKIPPED (look for 'SKIPPED (DR-034)' + the refusal code above)." >&2
    exit 1
  fi
}

if [ "$DO_INVENTORY" -eq 1 ]; then
  echo "== step 1: hardware inventory reads (incl. new vxlan/ospf/bgp/route-map/vrf) =="
  EAPI_HW_CAPTURE=1 npm -w arista-api-client run test:live -- src/hw-inventory.live.test.ts
fi

if [ "$DO_PROBE" -eq 1 ]; then
  echo "== step 2: abort-only staged-grammar probes (no commit; default traffic untouched) =="
  echo "   spec = $SPEC   (batches stage as configure-session-<name>--hw-session-probe)"
  EAPI_HW_SESSION_PROBE=1 \
    EAPI_HW_PROBE_SPEC="$SPEC" \
    npm -w arista-api-client run test:live -- src/hw-session-probe.live.test.ts
fi

guard_nothing_recorded   # both lanes skip with exit 0 -- this is the step that turns a silent skip into a failure

# Post-run scrub scan (2026-11-22, DR-159): the 2026-11-22 day committed 58 recordings carrying the
# dialed host and the device hostname because --scrub was skipped and the lanes only WARNED. The
# lanes now scrub those two derived literals unconditionally (hwDerivedSecrets), so the dialed host
# surviving into a changed file means the defense itself broke -> hard fail. Any OTHER RFC1918
# literal that is NEW relative to HEAD's copy of the same file is the operator-literal gap
# (gateway/DNS/other hosts) -> loud warning with the file list, never a silent pass.
scan_scrub() {
  local changed f hits newlits
  changed=$(git status --porcelain "$RECORDINGS_DIR" | awk '{print $2}')
  [ -z "$changed" ] && return 0
  hits=""
  for f in $changed; do
    [ -f "$f" ] || continue
    # (the executing path guarantees HOST is non-empty; the -n guard keeps the function safe standalone)
    if [ -n "$HOST" ] && grep -qF "$HOST" "$f"; then hits="$hits $f"; fi
  done
  if [ -n "$hits" ]; then
    echo "FATAL: the dialed host $HOST survived into:$hits" >&2
    echo "       -- the derived scrub (hwDerivedSecrets) did NOT fire. Do not commit; re-scrub by hand" >&2
    echo "          (sed 's/<host>/<hw-redacted>/g') and open an issue against the lane." >&2
    exit 1
  fi
  newlits=""
  for f in $changed; do
    [ -f "$f" ] || continue
    # RFC1918 literals present now but absent from HEAD's copy of the same file (new files: all).
    local now head
    now=$(grep -oE '\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})\b' "$f" | sort -u)
    head=$(git show "HEAD:$f" 2>/dev/null | grep -oE '\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})\b' | sort -u)
    newlits_now=$(comm -23 <(echo "$now") <(echo "$head") | tr '\n' ' ')
    [ -n "${newlits_now// /}" ] && newlits="$newlits\n  $f: $newlits_now"
  done
  if [ -n "$newlits" ]; then
    echo "WARNING: NEW RFC1918 literals appeared in this run's recordings (gateway/DNS/other-host" >&2
    echo "         gap -- EAPI_HW_SCRUB/--scrub must name them; re-scrub before committing):" >&2
    printf "%b\n" "$newlits" >&2
  fi
}
scan_scrub

echo "== done. Review 'git status' under $RECORDINGS_DIR =="
echo "   1) confirm each NEW file has an identity envelope matching this box,"
echo "   2) check the stage-then-abort diff recordings show the staged grammar + 'aborted',"
echo "   3) transcribe the verdicts into DECISIONS open items 2/6 and STATUS section 3, then post under #86/#87/#90/#88."
