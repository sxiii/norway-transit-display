# Norway Transit Display

Research and tooling for recreating real-time passenger-information displays using Norwegian public transport data.

**Current focus:** Entur vehicle positions for Vy rail and Vy buses, plus stop-level departures from Entur Journey Planner and a separately documented Ruter GraphQL investigation.

This independent research project is not affiliated with Entur, Vy, Ruter, or their contractors. It contains no APKs, extracted proprietary source code, credentials, or access tokens.

## Contents

- [Research notes](docs/RESEARCH.md): endpoints, feed coverage, APK observations, confidence levels, and limitations.
- `scripts/entur_vehicles.py`: real-time vehicle-position snapshots.
- `scripts/entur_departures.py`: upcoming departures at a supplied Entur stop-place ID, including service-journey IDs.
- `scripts/ruter_probe.py`: anonymous-token and harmless GraphQL connectivity probe.
- `.github/workflows/collect-vehicle-data.yml`: scheduled and manually-triggered collection.
- `tests/`: offline unit tests.

## Quick start

Python 3.11+; no third-party packages required.

```bash
ET_CLIENT_NAME=github-sxiii-norway-transit-display python scripts/entur_vehicles.py --codespaces VYG VYX --output vehicles.json
python scripts/entur_departures.py --stop-place-id 'NSR:StopPlace:YOUR_ID'
python scripts/ruter_probe.py
python -m unittest discover -s tests -v
```

## GitHub Actions

Open **Actions → Collect Norwegian vehicle positions → Run workflow**. You can optionally enter an Entur `stop_place_id` to fetch a departure board in the same run. Scheduled runs collect VYG/VYX vehicle positions every 15 minutes.

JSON output is uploaded as an artifact, not committed to the repository. Artifacts are retained for 14 days. No GitHub secrets are required; requests use the identifying `ET-Client-Name` header.

## Next development stage

The departure-board response includes service-journey identifiers. The next integration step is to correlate these with the Entur vehicle feed, then normalize the current/next stop, delay, position and freshness into one display-ready model. The stop-place ID is intentionally configurable; do not assume one ID works for every station or operator.

## Limitations

- A successful API response proves reachability, not that the endpoint is the same backend used by onboard passenger displays.
- The Ruter endpoint was found by inspecting the passenger APK. Its live availability and subscription behavior are not yet independently confirmed.
- Do not commit bearer tokens, personal data, APK files, or unredacted API captures.

## License

MIT. See [LICENSE](LICENSE).
