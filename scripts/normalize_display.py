#!/usr/bin/env python3
"""Join Entur vehicle positions to an optional stop departure board."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except (TypeError, ValueError):
        return None


def build_display_payload(
    vehicle_snapshot: dict[str, Any],
    departure_snapshot: dict[str, Any] | None = None,
    now: datetime | None = None,
    stale_after_seconds: int = 180,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    departures_by_journey: dict[str, list[dict[str, Any]]] = {}
    stop = (departure_snapshot or {}).get("stop") or {}
    for call in stop.get("estimatedCalls") or []:
        journey = call.get("serviceJourney") or {}
        journey_id = journey.get("id")
        if journey_id:
            departures_by_journey.setdefault(journey_id, []).append(call)

    vehicles: list[dict[str, Any]] = []
    for codespace, result in (vehicle_snapshot.get("results") or {}).items():
        for vehicle in result.get("vehicles") or []:
            journey = vehicle.get("serviceJourney") or {}
            journey_id = journey.get("id")
            updated = vehicle.get("lastUpdated")
            updated_at = parse_time(updated)
            age = None
            if updated_at:
                age = max(0, int((now - updated_at).total_seconds()))
            freshness = (
                "unknown" if age is None
                else "stale" if age > stale_after_seconds
                else "fresh"
            )
            matched_calls = departures_by_journey.get(journey_id, []) if journey_id else []
            vehicles.append({
                "operator_codespace": codespace,
                "vehicle_id": vehicle.get("vehicleId"),
                "service_journey_id": journey_id,
                "mode": vehicle.get("mode"),
                "origin": vehicle.get("originName"),
                "destination": vehicle.get("destinationName"),
                "delay_seconds": vehicle.get("delay"),
                "location": vehicle.get("location"),
                "last_updated": updated,
                "position_age_seconds": age,
                "freshness": freshness,
                "stop_departures": matched_calls,
            })

    vehicles.sort(
        key=lambda item: (
            item.get("destination") or "",
            item.get("vehicle_id") or "",
        )
    )
    return {
        "generated_at": now.isoformat(),
        "source_collected_at": vehicle_snapshot.get("collected_at"),
        "stop_place": (
            {"id": stop.get("id"), "name": stop.get("name")}
            if stop else None
        ),
        "vehicle_count": len(vehicles),
        "matched_vehicle_count": sum(bool(v["stop_departures"]) for v in vehicles),
        "vehicles": vehicles,
        "source_errors": vehicle_snapshot.get("errors") or {},
    }


def read_json(path: str) -> dict[str, Any] | None:
    if not path or not Path(path).exists():
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vehicles", default="data/vehicles.json")
    parser.add_argument("--departures", default="data/stop-departures.json")
    parser.add_argument("--output", default="data/display.json")
    args = parser.parse_args()

    vehicle_snapshot = read_json(args.vehicles)
    if vehicle_snapshot is None:
        parser.error(f"vehicle snapshot not found: {args.vehicles}")
    departure_snapshot = read_json(args.departures)
    payload = build_display_payload(vehicle_snapshot, departure_snapshot)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Normalized {payload['vehicle_count']} vehicles; "
        f"{payload['matched_vehicle_count']} matched to stop departures"
    )
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
