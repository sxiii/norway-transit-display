# Norway Transit Display

Research and tooling for recreating real-time passenger-information displays using Norwegian public transport data.

**Current focus:** Entur vehicle positions for Vy rail and Vy buses, plus stop-level departures from Entur Journey Planner and a separately documented Ruter GraphQL investigation.

This independent research project is not affiliated with Entur, Vy, Ruter, or their contractors.

## Contents

- [Research notes](docs/RESEARCH.md): endpoints, feed coverage, APK observations, confidence levels, and limitations.
- `scripts/entur_vehicles.py`: real-time vehicle-position snapshots.
- `scripts/entur_departures.py`: upcoming departures at a supplied Entur stop-place ID, including service-journey IDs.
- `scripts/normalize_display.py`: joins vehicle positions and stop departures by service-journey ID and emits a display-ready JSON model.
- `web/index.html` + `web/live.js`: browser-native live display with Entur polling, route-number badges, and an experimental Ruter anonymous-token / GraphQL WebSocket probe.
- `.github/workflows/collect-vehicle-data.yml`: scheduled and manually-triggered data collection (does not run on ordinary source pushes).
- `.github/workflows/ci.yml`: offline Python tests and browser JavaScript syntax validation on pushes and pull requests.
- `.github/workflows/deploy-pages.yml`: publishes the browser display to GitHub Pages.
- `tests/`: offline unit tests.

## Browser display (GitHub Pages)

The display is a static website and can run directly from GitHub Pages; no local checkout, Python server, or downloaded project artifact is needed.

1. In the repository, open **Settings → Pages**.
2. Set **Source** to **GitHub Actions** (one-time setup).
3. Open **Actions → Deploy transit display to GitHub Pages** and run it once, or push a change under `web/`.
4. Open the Pages URL shown in the deployment summary. It will be:

   https://sxiii.github.io/norway-transit-display/

The page loads `web/index.html` and `web/live.js` together. Entur data is fetched directly by the browser; Ruter live probing remains a manual action. The optional **Load snapshot JSON** control still lets you load a locally saved snapshot, but it is no longer required for the live display.

## Quick start (data collection tools)

Python 3.11+; no third-party packages required.

```bash
ET_CLIENT_NAME=github-sxiii-norway-transit-display python scripts/entur_vehicles.py --codespaces VYG VYX --output vehicles.json
python scripts/entur_departures.py --stop-place-id 'NSR:StopPlace:YOUR_ID'
python scripts/normalize_display.py --vehicles vehicles.json --departures stop-departures.json --output display.json
python scripts/ruter_probe.py
python -m unittest discover -s tests -v
```

## GitHub Actions data collection

Open **Actions → Collect Norwegian vehicle positions → Run workflow**. The default departure stop is the central/night-bus stop (`NSR:StopPlace:4000`); you can override it when manually launching the workflow. Scheduled runs collect VYG/VYX vehicle positions and departures from this stop every 15 minutes.

JSON output is uploaded as an artifact, not committed to the repository. Artifacts are retained for 14 days. No GitHub secrets are required; requests use the identifying `ET-Client-Name` header.

## Current data model

The normalizer retains the complete stop departure board, including calls without a matching vehicle. Each departure includes its destination, aimed/expected/actual times, quay, service-journey ID and any matched vehicle records. Vehicle records include coordinates, delay, source timestamp and freshness classification. Matching is by exact service-journey ID.

## Limitations

- A successful API response proves reachability, not that the endpoint is the same backend used by onboard passenger displays.
- The browser display queries Entur directly and is subject to the APIs' availability and browser CORS policies.
- The Ruter app-backend integration is experimental and may stop working if the app protocol changes. Global discovery is deliberately bounded to 500 line keys and 1,000 live journey subscriptions per session to avoid unbounded browser/API load; a cap warning is shown in the activity log.
- Vehicle markers are expired after three minutes without a fresh provider update. The Entur mode WebSocket reconnects automatically with exponential backoff; Ruter reconnects automatically while a Ruter tracking scope is active.
- A vehicle may not appear in the position feed or may not match a departure, even when the departure itself is valid.

## License

MIT. See [LICENSE](LICENSE).
