import importlib.util
import json
import unittest
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

    def test_endpoint_is_https(self):
        module = load_script("entur_vehicles", "entur_vehicles.py")
        self.assertTrue(module.ENDPOINT.startswith("https://"))


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
        self.assertIn("serviceJourney { id }", query)
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
