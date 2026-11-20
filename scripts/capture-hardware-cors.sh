#!/usr/bin/env bash
# Supervised #159 physical-switch CORS evidence. Dry-run by default.
# The live test commits one exact origin, verifies OPTIONS + JSON-RPC POST, and always removes it.
set -euo pipefail

GO=0
HOST="${EAPI_HOST:-}"
USER_NAME="${EAPI_USER:-}"
MODEL="${EAPI_ALLOW_MODEL:-DCS-7050TX-64-R}"
VERSION="${EAPI_ALLOW_VERSION:-4.28.13.1M}"
PORT="${EAPI_PORT:-443}"
CA_FILE="${EAPI_CA_FILE:-}"
FINGERPRINT="${EAPI_FINGERPRINT:-}"
ORIGIN="${EAPI_HW_CORS_ORIGIN:-}"

usage() {
  cat <<'EOF'
Usage: scripts/capture-hardware-cors.sh [--go] --host H --user U --ca /path/public.pem --fp SHA256 --origin https://ui.example[:port]

This script defaults to a read-only dry run. --go temporarily commits one exact CORS origin to the
physical switch, captures preflight/POST evidence, and removes that exact origin in finally. It never
uses `all` or `*` and refuses origins with a path.

Required physical-switch preconditions:
- a supervised switch session and a permitted maintenance window;
- exact model/version allow-list plus the switch's public CA/certificate and fingerprint pin;
- the operator must type the exact model and exact origin as consent;
- browser trust and credential placement are separate #159 decisions this script does not settle.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;;
    --host) HOST="$2"; shift ;;
    --user) USER_NAME="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --ca) CA_FILE="$2"; shift ;;
    --fp) FINGERPRINT="$2"; shift ;;
    --origin) ORIGIN="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if ! node -e 'const u=process.argv[1]; try { const p=new URL(u); process.exit((p.protocol==="https:"||p.protocol==="http:")&&p.origin===u&&p.username===""&&p.password===""?0:1) } catch { process.exit(1) }' "$ORIGIN"; then
  echo "--origin must be one exact http(s) origin with no path, credentials, or wildcard" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

if [ "$GO" -ne 1 ]; then
  echo "== DRY RUN (pass --go only in a supervised switch session) =="
  echo "Would run the physical hardware CORS live test against:"
  echo "  host=$HOST port=$PORT model=$MODEL version=$VERSION origin=$ORIGIN"
  echo "  ca=$CA_FILE fingerprint=${FINGERPRINT:+<set>}"
  echo "The test will:"
  echo "  1. verify exact model/version and capture the origin list before the change;"
  echo "  2. commit 'management api http-commands / cors allowed-origin $ORIGIN';"
  echo "  3. issue an OPTIONS preflight and authenticated JSON-RPC POST with Origin: $ORIGIN;"
  echo "  4. in finally commit 'no cors allowed-origin $ORIGIN' and verify removal;"
  echo "  5. write arista-api-client/docs/evidence/cors-hardware.json only after cleanup."
  exit 0
fi

[ -n "$HOST" ] || { echo "--host required" >&2; exit 2; }
[ -n "$USER_NAME" ] || { echo "--user required" >&2; exit 2; }
[ -n "$CA_FILE" ] || { echo "--ca required (public cert/CA only; never a private-key PEM)" >&2; exit 2; }
[ -n "$FINGERPRINT" ] || { echo "--fp required" >&2; exit 2; }

export EAPI_HW_PW=''
read -rs -p "eAPI password for $USER_NAME (not stored): " EAPI_HW_PW; echo
[ -n "$EAPI_HW_PW" ] || { echo "empty password; refusing" >&2; exit 2; }
read -r -p "Type the exact model name to consent ($MODEL): " modelConsent
[ "$modelConsent" = "$MODEL" ] || { echo "model consent mismatch; refusing" >&2; exit 3; }
read -r -p "Type the exact origin to authorize and later remove ($ORIGIN): " originConsent
[ "$originConsent" = "$ORIGIN" ] || { echo "origin consent mismatch; refusing" >&2; exit 3; }

export EAPI_LIVE=1 EAPI_TARGET_CLASS=hardware
export EAPI_HOST="$HOST" EAPI_ALLOW_HOSTS="$HOST"
export EAPI_PORT="$PORT" EAPI_ALLOW_PORTS="$PORT"
export EAPI_USER="$USER_NAME" EAPI_PASS_VAR=EAPI_HW_PW
export EAPI_ALLOW_MODEL="$MODEL" EAPI_ALLOW_VERSION="$VERSION" EAPI_HW_CONSENT="$MODEL"
export EAPI_CA_FILE="$CA_FILE" EAPI_FINGERPRINT="$FINGERPRINT" EAPI_SERVER_NAME=self.signed
export EAPI_HW_CORS_CAPTURE=1 EAPI_HW_CORS_ORIGIN="$ORIGIN" EAPI_HW_CORS_CONSENT="$ORIGIN"

npm -w arista-api-client run test:live -- src/cors-hardware.live.test.ts

echo "Review arista-api-client/docs/evidence/cors-hardware.json and verify the post-state no longer lists $ORIGIN."
