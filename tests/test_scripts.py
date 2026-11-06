import importlib.util
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class EnturScriptTests(unittest.TestCase):
    def test_query_contains_requested_codespace(self):
        module = load_script("entur_vehicles", "entur_vehicles.py")
        self.assertIn('codespaceId: "VYG"', module.QUERY % "VYG")
        self.assertIn("latitude", module.QUERY % "VYX")
        self.assertIn("longitude", module.QUERY % "VYX")
        self.assertIn("serviceJourney { id }", module.QUERY % "VYX")

    def test_endpoint_is_https(self):
        module = load_script("entur_vehicles", "entur_vehicles.py")
        self.assertTrue(module.ENDPOINT.startswith("https://"))


class NormalizerTests(unittest.TestCase):
    def test_joins_vehicle_and_departure_by_service_journey(self):
        module = load_script("normalize_display", "normalize_display.py")
        now = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)
        vehicles = {
            "collected_at": "2026-11-06T11:59:00+00:00",
            "results": {
                "VYG": {
                    "vehicles": [{
                        "vehicleId": "train-1",
                        "serviceJourney": {"id": "VYG:ServiceJourney:42", "journeyPattern": {"line": {"publicCode": "L1", "name": "Line 1"}}},
                        "lastUpdated": "2026-11-06T11:59:30+00:00",
                        "delay": 90,
                        "location": {"latitude": 59.9, "longitude": 10.8},
                    }]
                }
            },
        }
        departures = {
            "stop": {
                "id": "NSR:StopPlace:451",
                "name": "Lillestrøm",
                "estimatedCalls": [{
                    "serviceJourney": {"id": "VYG:ServiceJourney:42"},
                    "expectedDepartureTime": "2026-11-06T12:05:00+01:00",
                    "aimedDepartureTime": "2026-11-06T12:03:00+01:00",
                    "realtime": True,
                    "destinationDisplay": {"frontText": "Oslo S"},
                    "quay": {"id": "Q1", "name": "1"},
                }],
            }
        }
        result = module.build_display_payload(vehicles, departures, now=now)
        self.assertEqual(result["vehicle_count"], 1)
        self.assertEqual(result["matched_vehicle_count"], 1)
        self.assertEqual(result["matched_departure_count"], 1)
        self.assertEqual(result["departure_count"], 1)
        self.assertEqual(result["vehicles"][0]["freshness"], "fresh")
        self.assertEqual(len(result["vehicles"][0]["stop_departures"]), 1)
        self.assertEqual(result["departures"][0]["destination"], "Oslo S")
        self.assertEqual(result["departures"][0]["line_public_code"], "L1")
        self.assertEqual(result["departures"][0]["line_name"], "Line 1")
        self.assertEqual(result["departures"][0]["quay"]["name"], "1")
        self.assertEqual(result["departures"][0]["matched_vehicles"][0]["vehicle_id"], "train-1")

    def test_keeps_unmatched_departures_on_the_board(self):
        module = load_script("normalize_display", "normalize_display.py")
        vehicles = {"results": {"VYX": {"vehicles": []}}}
        departures = {"stop": {"id": "NSR:StopPlace:1", "name": "Test", "estimatedCalls": [
            {
                "serviceJourney": {"id": "journey-unmatched"},
                "expectedDepartureTime": "2026-11-06T12:05:00+01:00",
                "destinationDisplay": {"frontText": "Oslo"},
                "quay": {"name": "A"},
            }
        ]}}
        result = module.build_display_payload(vehicles, departures)
        self.assertEqual(result["departure_count"], 1)
        self.assertEqual(result["matched_departure_count"], 0)
        self.assertEqual(result["departures"][0]["destination"], "Oslo")
        self.assertEqual(result["departures"][0]["matched_vehicles"], [])

    def test_marks_old_positions_stale_and_keeps_unmatched_vehicles(self):
        module = load_script("normalize_display", "normalize_display.py")
        now = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)
        vehicles = {"results": {"VYX": {"vehicles": [{
            "vehicleId": "bus-1",
            "lastUpdated": "2026-11-06T11:50:00+00:00",
        }]}}}
        result = module.build_display_payload(vehicles, now=now)
        self.assertEqual(result["vehicles"][0]["freshness"], "stale")
        self.assertEqual(result["matched_vehicle_count"], 0)


class RuterScriptTests(unittest.TestCase):
    def test_probe_does_not_request_personal_data(self):
        module = load_script("ruter_probe", "ruter_probe.py")
        self.assertEqual(module.AUTH_PROBE, "{ __typename }")
        self.assertIn("getAnonymousCustomerToken_v2", module.TOKEN_MUTATION)

    def test_endpoint_is_https(self):
        module = load_script("ruter_probe", "ruter_probe.py")
        self.assertTrue(module.ENDPOINT.startswith("https://"))


class JourneyPlannerTests(unittest.TestCase):
    def test_query_includes_service_journey_and_live_times(self):
        module = load_script("entur_departures", "entur_departures.py")
        query = module.build_query("NSR:StopPlace:123", 12)
        self.assertIn('stopPlace(id: "NSR:StopPlace:123")', query)
        self.assertIn("expectedDepartureTime", query)
        self.assertIn("serviceJourney { id journeyPattern", query)
        self.assertIn("publicCode", query)
        self.assertIn("line { publicCode name }", query)
        self.assertIn("numberOfDepartures: 12", query)

    def test_stop_id_is_escaped_as_graphql_string(self):
        module = load_script("entur_departures", "entur_departures.py")
        query = module.build_query('id"\nInjected', 5)
        self.assertIn(json.dumps('id"\nInjected'), query)

    def test_endpoint_is_https(self):
        module = load_script("entur_departures", "entur_departures.py")
        self.assertTrue(module.ENDPOINT.startswith("https://"))


if __name__ == "__main__":
    unittest.main()
