# Norway Transit Display

Research and tooling for recreating real-time passenger-information displays using Norwegian public transport data.

**Current focus:** Entur vehicle positions for Vy rail and Vy buses, plus stop-level departures from Entur Journey Planner and a separately documented Ruter GraphQL investigation.

This independent research project is not affiliated with Entur, Vy, Ruter, or their contractors.

## Contents

- [Research notes](docs/RESEARCH.md): endpoints, feed coverage, APK observations, confidence levels, and limitations.
- `scripts/entur_vehicles.py`: real-time vehicle-position snapshots.
- `scripts/entur_departures.py`: upcoming departures at a supplied Entur stop-place ID, including service-journey IDs.
- `scripts/normalize_display.py`: joins vehicle positions and stop departures by service-journey ID and emits a display-ready JSON model.
- `web/index.html` + `web/live.js`: browser-native live display with Entur polling and an experimental Ruter anonymous-token / GraphQL WebSocket probe.
- `scripts/ruter_probe.py`: anonymous-token and harmless GraphQL connectivity probe.
- `.github/workflows/collect-vehicle-data.yml`: scheduled and manually-triggered collection.
- `tests/`: offline unit tests.

## Quick start

Python 3.11+; no third-party packages required.

```bash
ET_CLIENT_NAME=github-sxiii-norway-transit-display python scripts/entur_vehicles.py --codespaces VYG VYX --output vehicles.json
python scripts/entur_departures.py --stop-place-id 'NSR:StopPlace:YOUR_ID'
python scripts/normalize_display.py --vehicles vehicles.json --departures stop-departures.json --output display.json
python scripts/ruter_probe.py
python -m unittest discover -s tests -v
```

## Browser display

1. Download and extract the latest `norway-transit-N` artifact from the [Actions runs](https://github.com/sxiii/norway-transit-display/actions).
2. Open `web/index.html` in a modern browser.
3. Choose the extracted `display.json` using **Load display.json**.

The renderer runs locally in your browser. It does not upload the snapshot anywhere. **Show demo layout** previews the design without needing an artifact.

## GitHub Actions

Open **Actions → Collect Norwegian vehicle positions → Run workflow**. The default departure stop is Bjørvika (`NSR:StopPlace:3983`); you can override it when manually launching the workflow. Scheduled runs collect VYG/VYX vehicle positions and Bjørvika departures every 15 minutes.

JSON output is uploaded as an artifact, not committed to the repository. Artifacts are retained for 14 days. No GitHub secrets are required; requests use the identifying `ET-Client-Name` header.

## Current data model

The normalizer retains the complete stop departure board, including calls without a matching vehicle. Each departure includes its destination, aimed/expected/actual times, quay, service-journey ID and any matched vehicle records. Vehicle records include coordinates, delay, source timestamp and freshness classification. Matching is by exact service-journey ID.

## Limitations

- A successful API response proves reachability, not that the endpoint is the same backend used by onboard passenger displays.
- The renderer currently loads a downloaded JSON snapshot; it is not yet a continuously updating WebSocket client.
- A vehicle may not appear in the position feed or may not match a departure, even when the departure itself is valid.
- The Ruter endpoint was found by inspecting the passenger APK. Its live availability and subscription behavior are not yet independently confirmed.
- Do not commit bearer tokens, personal data, APK files, or unredacted API captures.

## License

MIT. See [LICENSE](LICENSE).
