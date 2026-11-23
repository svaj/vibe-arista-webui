#!/usr/bin/env bash
# Supervised #89 physical persistence-verb lane (owner authorization 2026-11-21: "copy run start is
# fine; a minimal change can be run via configure replace and rollback; scripted and reviewable
# before executing"). DRY RUN BY DEFAULT — the plan prints in full and nothing touches a device.
#
# Two modes:
#   (default)      dry run: print the exact plan for review.
#   --rehearse     run the SAME suite against a throwaway cEOS container (booted and torn down by
#                  the harness). Container observations only — never hardware evidence (DR-043).
#   --go           run against the physical switch under the full consent chain.
set -euo pipefail

MODE="dry"
HOST="${EAPI_HOST:-}"
USER_NAME="${EAPI_USER:-}"
MODEL="${EAPI_ALLOW_MODEL:-DCS-7050TX-64-R}"
VERSION="${EAPI_ALLOW_VERSION:-4.28.13.1M}"
PORT="${EAPI_PORT:-443}"
CA_FILE="${EAPI_CA_FILE:-}"
FINGERPRINT="${EAPI_FINGERPRINT:-}"
SCRATCH="${EAPI_SCRATCH_INTERFACE:-}"
VERBS="${EAPI_HW_PERSISTENCE_VERBS:-copy,rollback}"
BAND="${CEOS_LAB_MGMT_BAND:-192.168.255}"
LABPORT="${EAPI_PORT:-8443}"

usage() {
  cat <<'EOF'
Usage:
  scripts/capture-hw-persistence.sh                          # dry run: print the plan
  scripts/capture-hw-persistence.sh --rehearse \
      [--verbs copy,rollback,rollback-name,rollback-hyphenfree,replace]
  scripts/capture-hw-persistence.sh --go --host H --user U --scratch EthernetNN \
      [--verbs copy,rollback,rollback-name,rollback-hyphenfree] \
      [--ca /path/public.pem --fp SHA256]

The lane (arista-api-client/src/persistence-hardware.live.test.ts) is the SECOND and only other
lane ever admitted past the hardware write fence (after hw-session-probe). Consent chain:
  EAPI_HW_PERSISTENCE=1  +  EAPI_HW_PERSISTENCE_CONSENT typed as an exact echo of the scratch port
  +  exact model/version allow-list + EAPI_HW_CONSENT model echo  +  the scratch port must read
  linkStatus != connected/errdisabled before any mutating verb.

Defaults to --verbs copy,rollback. `replace` must be named EXPLICITLY: it is the wholesale
running-config rewrite step (snapshot to flash, one-line marker commit, configure replace back).
`rollback-name` must be named EXPLICITLY too (S1, #182): it decouples the `rollback <name>` probe
from the replace step — it commits its OWN scratch-port marker session and rolls back to THAT, so
the one-slot completed-session store's survival is observed with NO `configure replace` in the way.
It stages + diffs + ABORTs the rollback (never commits); a second batch waits ~60s to separate
"slot ages out in seconds" from "replace clears the slot" (the DR-158 confound). Aborts only.
`rollback-hyphenfree` must also be named EXPLICITLY: it repeats the rollback <name> attempt with a
hyphen-free completed-session name to distinguish an unsupported verb from a name-token grammar
restriction. It stages + diffs + ABORTs the rollback and restores its own marker. Aborts only.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --go) MODE="go" ;;
    --rehearse) MODE="rehearse" ;;
    --host) HOST="$2"; shift ;;
    --user) USER_NAME="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --ca) CA_FILE="$2"; shift ;;
    --fp) FINGERPRINT="$2"; shift ;;
    --scratch) SCRATCH="$2"; shift ;;
    --verbs) VERBS="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

case "$VERBS" in
  *[!a-z,-]*) echo "--verbs accepts only copy, rollback, rollback-name, rollback-hyphenfree, replace (comma list)" >&2; exit 2 ;;
esac
for v in ${VERBS//,/ }; do
  case "$v" in copy|rollback|rollback-name|rollback-hyphenfree|replace) ;; *) echo "--verbs: unknown verb '$v'" >&2; exit 2 ;; esac
done

cd "$(dirname "$0")/.."

print_plan() {
  local class="$1"
  echo "== PLAN (${class}) — verbs: ${VERBS} =="
  cat <<EOF
 0. identity gate: the device must self-report model=${MODEL} version=${VERSION} before any write.
    On hardware the declared scratch port ${SCRATCH:-<none declared yet>} must NOT read
    linkStatus connected/errdisabled (the "unused scratch" contradiction check).
 1. copy   — baseline 'show startup-config' (TEXT), run 'copy running-config startup-config',
             re-read and record the before/after flip. Authorized explicitly 2026-11-21;
             startup-config is the ONE file this lane may write.
 2. replace (ONLY if named in --verbs) — snapshot running to flash:hw-persist-<runtag>.cfg
             ('copy running-config flash:...' — a scratch file, never startup), commit a ONE-LINE
             description marker on the scratch port via a named session, then 'configure replace
             flash:hw-persist-<runtag>.cfg' re-mounts the snapshot (marker gone = proof). The
             snapshot file stays in flash for hand-cleanup (no 'delete' — its prompt can hang
             eAPI); the run prints its exact name.
 3. rollback — 'rollback clean-config' and 'rollback <name>' staged inside NAMED SESSIONS, the
             session diff recorded (the would-be blast), then ABORTed. NEVER committed. A refusal
             is recorded as the answer (DR-134).
 3b. rollback-name (ONLY if named in --verbs; S1 #182) — commits its OWN scratch-port marker
             session, reads 'show configuration sessions detail' IMMEDIATELY (completedSlotHolds),
             stages 'rollback <that-marker>' in a fresh session, records its diff, ABORTs; then a
             second batch (~60s controlled wait, no intervening op) repeats the detail read to tell
             seconds-fast slot aging apart from replace-window clearing. Its committed marker is
             cleared by the final restore. Aborts only.
 3c. rollback-hyphenfree (ONLY if named in --verbs; S1 #189) — commits a scratch-port marker in a
             hyphen-free named session, verifies the completed slot holds that exact name, then stages
             'rollback <that-name>' in a fresh owned session. Records the diff or refusal, ABORTs,
             and clears its marker; this is the DR-161 verb-vs-name-grammar disambiguator. Aborts only.
 4. final restore — the scratch port must carry no lane marker; afterAll clears any live marker
             and aborts any session the run left pending.
 5. artifact — arista-api-client/docs/evidence/persistence-hardware.json (hardware) or
             persistence-rehearsal.ceos.json (rehearsal), written only after cleanup and
             credential-scanned before write.
EOF
}

if [ "$MODE" = "dry" ]; then
  print_plan "DRY RUN — nothing was sent to any device"
  echo
  echo "Review this plan, then re-run with --rehearse (throwaway container) or --go (physical switch)."
  exit 0
fi

if [ "$MODE" = "rehearse" ]; then
  echo "== REHEARSAL on a throwaway cEOS container — observations do NOT settle hardware behavior (DR-043) =="
  print_plan "rehearsal"
  read -r -p "Type REHEARSAL-CEOS to run the plan against a disposable container: " echo1
  [ "$echo1" = "REHEARSAL-CEOS" ] || { echo "rehearsal echo mismatch; refusing" >&2; exit 3; }
  EAPI_HW_PERSISTENCE=1 EAPI_HW_PERSISTENCE_CONSENT='REHEARSAL-CEOS' EAPI_HW_PERSISTENCE_VERBS="$VERBS" \
    npm run lab:run -- --quiet --no-fixtures --port "$LABPORT" --band "$BAND" -- \
    npm -w arista-api-client run test:live -- src/persistence-hardware.live.test.ts
  echo "Review arista-api-client/docs/evidence/persistence-rehearsal.ceos.json (container-only, DR-043)."
  exit 0
fi

# --- hardware run -----------------------------------------------------------------------------
[ -n "$HOST" ] || { echo "--host required" >&2; exit 2; }
[ -n "$USER_NAME" ] || { echo "--user required" >&2; exit 2; }
[ -n "$SCRATCH" ] || { echo "--scratch required (the ONE port this lane may mutate)" >&2; exit 2; }
case "$SCRATCH" in Ethernet[0-9]*) ;; *) echo "--scratch must be an Ethernet port" >&2; exit 2 ;; esac
[ -n "$CA_FILE" ] || echo "note: no --ca given; the guard then requires the --fp pin alone" >&2
[ -n "$FINGERPRINT" ] || echo "note: no --fp given; the guard then requires the --CA chain alone" >&2

print_plan "HARDWARE ${HOST}"
echo
echo "The replace step is the wholesale one. It is included ONLY if 'replace' is in --verbs (current: ${VERBS})."
echo
export EAPI_HW_PW=''
read -rs -p "eAPI password for $USER_NAME (not stored): " EAPI_HW_PW; echo
[ -n "$EAPI_HW_PW" ] || { echo "empty password; refusing" >&2; exit 2; }
read -r -p "Type the exact model name to consent ($MODEL): " modelConsent
[ "$modelConsent" = "$MODEL" ] || { echo "model consent mismatch; refusing" >&2; exit 3; }
read -r -p "Type the exact scratch port this lane may mutate ($SCRATCH): " portConsent
[ "$portConsent" = "$SCRATCH" ] || { echo "scratch consent mismatch; refusing" >&2; exit 3; }
if [[ ",$VERBS," == *",replace,"* ]]; then
  read -r -p "replace is named: type CONFIGURE REPLACE to authorize the wholesale running-config rewrite: " replaceConsent
  [ "$replaceConsent" = "CONFIGURE REPLACE" ] || { echo "replace consent mismatch; refusing" >&2; exit 3; }
fi
if [[ ",$VERBS," == *",rollback-name,"* ]]; then
  read -r -p "rollback-name is named: type ROLLBACK NAME to authorize the self-contained rollback <name> slot probe (aborts only) " rbNameConsent
  [ "$rbNameConsent" = "ROLLBACK NAME" ] || { echo "rollback-name consent mismatch; refusing" >&2; exit 3; }
fi
if [[ ",$VERBS," == *",rollback-hyphenfree,"* ]]; then
  read -r -p "rollback-hyphenfree is named: type ROLLBACK HYPHENFREE to authorize the rollback <hyphen-free-name> grammar probe (aborts only) " rbHyphenfreeConsent
  [ "$rbHyphenfreeConsent" = "ROLLBACK HYPHENFREE" ] || { echo "rollback-hyphenfree consent mismatch; refusing" >&2; exit 3; }
fi

export EAPI_LIVE=1 EAPI_TARGET_CLASS=hardware
export EAPI_HOST="$HOST" EAPI_ALLOW_HOSTS="$HOST"
export EAPI_PORT="$PORT" EAPI_ALLOW_PORTS="$PORT"
export EAPI_USER="$USER_NAME" EAPI_PASS_VAR=EAPI_HW_PW
export EAPI_ALLOW_MODEL="$MODEL" EAPI_ALLOW_VERSION="$VERSION" EAPI_HW_CONSENT="$MODEL"
[ -n "$CA_FILE" ] && export EAPI_CA_FILE="$CA_FILE"
[ -n "$FINGERPRINT" ] && export EAPI_FINGERPRINT="$FINGERPRINT"
export EAPI_SERVER_NAME="${EAPI_SERVER_NAME:-self.signed}"
export EAPI_SCRATCH_INTERFACE="$SCRATCH"
export EAPI_HW_PERSISTENCE=1 EAPI_HW_PERSISTENCE_CONSENT="$SCRATCH" EAPI_HW_PERSISTENCE_VERBS="$VERBS"

npm -w arista-api-client run test:live -- src/persistence-hardware.live.test.ts

echo "Review arista-api-client/docs/evidence/persistence-hardware.json, the scratch port's running-config,"
echo "and the flash:hw-persist-*.cfg snapshot the run names (hand-cleanup is the operator's call)."
