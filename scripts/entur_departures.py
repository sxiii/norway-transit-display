#!/usr/bin/env python3
"""Fetch a stop's upcoming departures from Entur Journey Planner v3."""

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

ENDPOINT = "https://api.entur.io/journey-planner/v3/graphql"


def build_query(stop_place_id: str, number_of_departures: int) -> str:
    # JSON string escaping is compatible with GraphQL string literals.
    stop_id = json.dumps(stop_place_id)
    return f"""
query {{
  stopPlace(id: {stop_id}) {{
    id
    name
    estimatedCalls(numberOfDepartures: {number_of_departures}) {{
      realtime
      aimedDepartureTime
      expectedDepartureTime
      actualDepartureTime
      destinationDisplay {{ frontText }}
      quay {{ id name }}
      serviceJourney {{ id journeyPattern {{ line {{ publicCode name }} }} }}
    }}
  }}
}}
"""


def fetch_departures(
    stop_place_id: str, client_name: str, number_of_departures: int, timeout: int
) -> dict[str, Any]:
    payload = json.dumps({"query": build_query(stop_place_id, number_of_departures)}).encode()
    request = urllib.request.Request(
        ENDPOINT,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "ET-Client-Name": client_name,
            "User-Agent": "norway-transit-display/0.2",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"Entur Journey Planner HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Entur Journey Planner request failed: {exc}") from exc

    try:
        result = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Entur Journey Planner returned non-JSON data") from exc
    if result.get("errors"):
        raise RuntimeError(
            "Entur Journey Planner GraphQL errors: "
            + json.dumps(result["errors"], ensure_ascii=False)[:2000]
        )

    stop = (result.get("data") or {}).get("stopPlace")
    if stop is None:
        raise RuntimeError(
            f"Stop place not found or unavailable: {stop_place_id}"
        )
    return {"http_status": status, "stop": stop}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--stop-place-id",
        default=os.getenv("STOP_PLACE_ID"),
        help="Entur stop-place ID, e.g. NSR:StopPlace:...",
    )
    parser.add_argument("--departures", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=25)
    parser.add_argument(
        "--output", default="data/stop-departures.json",
    )
    parser.add_argument(
        "--client-name",
        default=os.getenv("ET_CLIENT_NAME", "github-sxiii-norway-transit-display"),
    )
    args = parser.parse_args()

    if not args.stop_place_id:
        parser.error("--stop-place-id or STOP_PLACE_ID is required")
    if not 1 <= args.departures <= 100:
        parser.error("--departures must be between 1 and 100")
    if not args.client_name.strip():
        parser.error("client name must not be empty")

    report: dict[str, Any] = {
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "source": ENDPOINT,
        "requested_stop_place_id": args.stop_place_id,
    }
    try:
        result = fetch_departures(
            args.stop_place_id, args.client_name, args.departures, args.timeout
        )
        report["stop"] = result["stop"]
        calls = result["stop"].get("estimatedCalls") or []
        print(f"{result['stop'].get('name')}: {len(calls)} departure(s)")
    except RuntimeError as exc:
        report["error"] = str(exc)
        print(str(exc), file=sys.stderr)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {output}")
    return 0 if "stop" in report else 1


if __name__ == "__main__":
    raise SystemExit(main())
