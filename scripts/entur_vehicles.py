#!/usr/bin/env python3
"""Fetch a snapshot of public Entur vehicle positions using only Python stdlib."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ENDPOINT = "https://api.entur.io/realtime/v2/vehicles/graphql"
QUERY = """
query {
  vehicles(codespaceId: "%s") {
    vehicleId
    originName
    destinationName
    mode
    lastUpdated
    delay
    location { latitude longitude }
  }
}
"""


def fetch_codespace(codespace: str, client_name: str, timeout: int) -> dict[str, Any]:
    payload = json.dumps({"query": QUERY % codespace}).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "ET-Client-Name": client_name,
            "User-Agent": "norway-transit-display/0.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"Entur HTTP {exc.code} for {codespace}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Entur request failed for {codespace}: {exc}") from exc

    try:
        result = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Entur returned non-JSON data for {codespace}") from exc

    if result.get("errors"):
        raise RuntimeError(
            f"Entur GraphQL errors for {codespace}: "
            + json.dumps(result["errors"], ensure_ascii=False)[:2000]
        )

    vehicles = (result.get("data") or {}).get("vehicles")
    if vehicles is None:
        raise RuntimeError(
            f"Entur response has no data.vehicles for {codespace}: "
            + json.dumps(result, ensure_ascii=False)[:2000]
        )
    return {"http_status": status, "vehicles": vehicles}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--codespaces", nargs="+", default=["VYG", "VYX"],
        help="Entur codespaces to query (default: VYG VYX)",
    )
    parser.add_argument(
        "--output", default="data/vehicles.json",
        help="Output JSON path (default: data/vehicles.json)",
    )
    parser.add_argument("--timeout", type=int, default=25)
    parser.add_argument(
        "--client-name",
        default=os.getenv("ET_CLIENT_NAME", "github-sxiii-norway-transit-display"),
        help="ET-Client-Name header; may also be set with ET_CLIENT_NAME",
    )
    args = parser.parse_args()

    if not args.client_name.strip():
        parser.error("client name must not be empty")

    snapshot: dict[str, Any] = {
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "source": ENDPOINT,
        "results": {},
        "errors": {},
    }

    for codespace in args.codespaces:
        try:
            result = fetch_codespace(codespace, args.client_name, args.timeout)
            snapshot["results"][codespace] = result
            print(f"{codespace}: {len(result['vehicles'])} vehicle(s)")
        except RuntimeError as exc:
            snapshot["errors"][codespace] = str(exc)
            print(str(exc), file=sys.stderr)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {output}")

    return 0 if snapshot["results"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
