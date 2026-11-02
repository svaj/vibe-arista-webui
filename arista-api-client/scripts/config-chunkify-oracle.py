#!/usr/bin/env python3
"""Generate the upstream-pyeapi parity oracle for the M6 (#8) config-text fixtures.

Why this exists
---------------
PLAN.md's M6 test line asks for "`section()` returns the same text pyeapi would for those fixtures
(parity assertions)". The honest way to assert that is to ask pyeapi, not to guess what it would do.
This script runs the **real** upstream `_chunkify` (`pyeapi/client.py:698-774`, reached through
`Node._chunkify.__wrapped__` so the `@lru_cache` at `:697` is bypassed and the function body is what
executes) over every `test/fixtures/config/*.conf` and writes the result — including the ordered
key/value entries, because `Node.section` (`client.py:791-798`) picks the *first* matching key and the
recursive merge at `client.py:770-771` reorders them — to `pyeapi-oracle.json`.

The committed JSON is therefore **a record of pyeapi's behaviour, not of a device's**. The `.conf`
inputs are hand-authored (see `test/fixtures/config/README.md`); device-captured 4.28 config text
belongs to M12 (#14).

Run it manually — it is not part of `npm test`, which must stay offline and Python-free:

    python3 arista-api-client/scripts/config-chunkify-oracle.py            # rewrite the oracle
    python3 arista-api-client/scripts/config-chunkify-oracle.py --check     # fail if it drifts

`--check` is used by `src/config/chunk.fixture.test.ts`'s provenance comment: if the committed oracle
no longer matches upstream, regenerate it deliberately rather than editing the test.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
FIXTURE_DIR = PACKAGE / "test" / "fixtures" / "config"
ORACLE = FIXTURE_DIR / "pyeapi-oracle.json"
DEFAULT_PYEAPI = Path("/home/svaj/development/arista/pyeapi")


def load_upstream(pyeapi_root: Path):
    """Import pyeapi from the read-only reference checkout, no install required."""
    sys.path.insert(0, str(pyeapi_root))
    import pyeapi  # noqa: F401
    from pyeapi import client

    chunkify = client.Node._chunkify.__wrapped__  # the undecorated body (bypasses lru_cache)

    class Stub:
        """Only `self._chunkify` is used inside the body (the recursion), so a stub is enough."""

        def _chunkify(self, config, indent=0):
            return chunkify(self, config, indent)

    return Stub(), pyeapi.__version__ if hasattr(pyeapi, "__version__") else "unknown"


def git_provenance(pyeapi_root: Path) -> dict[str, str]:
    try:
        commit = subprocess.run(
            ["git", "-C", str(pyeapi_root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
        branch = subprocess.run(
            ["git", "-C", str(pyeapi_root), "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:  # noqa: BLE001 - provenance is documentation, not a gate
        return {"commit": "unknown", "branch": "unknown"}
    return {"commit": commit, "branch": branch}


def chunk_result(stub, text: str) -> dict[str, object]:
    try:
        sections = stub._chunkify(text, 0)
    except Exception as exc:  # noqa: BLE001 - the negative fixtures are the point
        return {"error": {"type": type(exc).__name__, "message": str(exc)}}
    return {"entries": [[key, value] for key, value in sections.items()]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pyeapi", type=Path, default=DEFAULT_PYEAPI, help="path to the pyeapi checkout")
    parser.add_argument("--check", action="store_true", help="fail if the committed oracle is stale")
    args = parser.parse_args()

    fixtures = sorted(FIXTURE_DIR.glob("*.conf"))
    if not fixtures:
        print(f"no .conf fixtures under {FIXTURE_DIR}", file=sys.stderr)
        return 1

    stub, version = load_upstream(args.pyeapi)
    payload = {
        "provenance": {
            "what": "Ordered output of upstream pyeapi Node._chunkify over each fixture. NOT device output.",
            "upstream": "pyeapi",
            "upstreamVersion": version,
            "upstreamPath": str(args.pyeapi),
            "upstreamRef": git_provenance(args.pyeapi),
            "upstreamSource": "pyeapi/client.py:698-774 (_chunkify), decorator at :697 removed via __wrapped__",
            "generatedBy": "arista-api-client/scripts/config-chunkify-oracle.py",
            "python": sys.version.split()[0],
        },
        "fixtures": {path.name: chunk_result(stub, path.read_text(encoding="utf-8")) for path in fixtures},
    }
    rendered = json.dumps(payload, indent=2, sort_keys=True) + "\n"

    if args.check:
        current = ORACLE.read_text(encoding="utf-8") if ORACLE.exists() else ""
        if current != rendered:
            print("oracle is stale — re-run scripts/config-chunkify-oracle.py", file=sys.stderr)
            return 1
        print("oracle matches upstream")
        return 0

    ORACLE.write_text(rendered, encoding="utf-8")
    print(f"wrote {ORACLE.relative_to(PACKAGE)} for {len(fixtures)} fixtures (pyeapi {version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
