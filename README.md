# Norway Transit Display

Research and tooling for building a real-time passenger-information display using public Norwegian transport data.

**Current focus:** Entur real-time vehicle positions for Vy rail and Vy buses, plus a separately documented Ruter GraphQL investigation.

This independent research project is not affiliated with Entur, Vy, Ruter, or their contractors. It contains no APKs, extracted proprietary source code, credentials, or access tokens.

## Contents

- [Research notes](docs/RESEARCH.md): endpoints, feed coverage, APK observations, confidence levels, and limitations.
- [Entur vehicle probe](scripts/entur_vehicles.py): queries the public Entur Vehicle Positions GraphQL API.
- [Ruter probe](scripts/ruter_probe.py): requests an anonymous Ruter customer token and performs a harmless authenticated GraphQL probe.
- [GitHub Actions](.github/workflows/collect-vehicle-data.yml): scheduled and manually-triggered collection.
- [Tests](tests/): offline unit tests.

## Quick start

Python 3.11+; no third-party packages required.

```bash
ET_CLIENT_NAME=github-sxiii-norway-transit-display python scripts/entur_vehicles.py --codespaces VYG VYX --output vehicles.json
python scripts/ruter_probe.py
python -m unittest discover -s tests -v
```

## GitHub Actions

Open **Actions → Collect Norwegian vehicle positions → Run workflow**. It also runs every 15 minutes. Entur results and the Ruter probe report are uploaded as a workflow artifact; they are not committed to the repository.

No GitHub secrets are needed. The workflow uses an identifying `ET-Client-Name` value.

## Limitations

- A successful API response proves reachability, not that the endpoint is the same backend used by onboard passenger displays.
- Vehicle positions and timetable data are separate concerns. A future display renderer must join live updates to scheduled service journeys and stop sequences.
- The Ruter endpoint was found by inspecting the passenger APK. Its live availability, authorization requirements, and stability have not been independently confirmed.
- Do not commit bearer tokens, personal data, APK files, or unredacted API captures.

## License

MIT. See [LICENSE](LICENSE).
