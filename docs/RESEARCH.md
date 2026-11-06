# Norwegian public transport data research

Last updated: 2026-11-06

## Executive summary

Entur is the best common starting point for a multi-operator passenger display. Its public Vehicle Positions GraphQL API exposes real-time vehicle updates and documents feeds for Vy rail and Vy buses. Ruter's Android passenger app contains a separate GraphQL backend reference, so the current working hypothesis is **Entur adapter + Ruter-specific adapter**, not one shared private API.

There is evidence that the Vy Android app references Entur's WebSocket host. This supports an Entur integration, but static APK strings alone do not prove which API calls the app makes at runtime.

## 1. Entur public APIs

### Vehicle Positions GraphQL

- HTTP: `https://api.entur.io/realtime/v2/vehicles/graphql`
- WebSocket subscriptions: `wss://api.entur.io/realtime/v2/vehicles/subscriptions`
- Required identifying header: `ET-Client-Name` (use a stable, descriptive application identifier).
- Official docs:
  - [Vehicle Positions API](https://developer.entur.no/apis/graphql/vehicle-positions)
  - [Vehicle query](https://developer.entur.no/apis/graphql/vehicle-positions/query/vehicles)
  - [Vehicle subscription](https://developer.entur.no/apis/graphql/vehicle-positions/subscription/vehicles)
  - [Real-time data overview](https://developer.entur.no/open-data/realtime)

The documented vehicle data includes fields such as vehicle ID, origin/destination, mode, last-updated timestamp, delay, location (latitude/longitude), speed, bearing, vehicle status, progress between stops, monitored call, line, operator, and service journey. Exact field availability can vary by feed.

Example query used by the probe:

```graphql
query {
  vehicles(codespaceId: "VYG") {
    vehicleId
    originName
    destinationName
    mode
    lastUpdated
    delay
    location {
      latitude
      longitude
    }
  }
}
```

Codespaces of interest:

| Codespace | Operator / service | Published real-time coverage |
|---|---|---|
| `VYG` | Vy Group rail | SIRI ET, SIRI VM, SIRI SX, GTFS-RT vehicle positions |
| `NSB` | Legacy Vy / NSB identifier | SIRI ET, SIRI VM, SIRI SX, GTFS-RT vehicle positions |
| `VYX` | Vy Buss Norway | SIRI VM, GTFS-RT vehicle positions, GTFS-RT service alerts |
| `RUT` | Ruter | SIRI ET, SIRI SX, GTFS-RT trip updates and service alerts; the published matrix does not list RUT vehicle-position feed |
| `GOA` | Go-Ahead Nordic | Vehicle-position coverage is listed |
| `FLT` | Flytoget | Vehicle-position coverage is listed |

Source: [Entur real-time data availability](https://developer.entur.no/open-data/realtime). Feed coverage can change; consult the live documentation before relying on this table.

SIRI VM is vehicle-monitoring data; SIRI ET is estimated timetable data; SIRI SX carries situation/exchange information. GTFS-RT vehicle positions are distinct from trip updates and service alerts.

### Transit Data GraphQL

- Endpoint: `https://api.entur.io/transit-data/v1beta/graphql`
- Docs: [Transit data](https://developer.entur.no/docs/open-services/transit-data)

This NeTEx-based API provides scheduled transport structures such as lines, stop places, quays, service journeys, operators and authorities. It can provide the route/stop context needed to turn raw vehicle coordinates into a passenger display.

Entur identifiers commonly use qualified forms, e.g. `NSR:StopPlace:337`.

## 2. Vy Android app APK observations

Inspected file supplied in conversation: `Vy-19.7.1.apkm`.

Static strings observed in the APK include:

- `wss://api.entur.io`
- `ENTUR_WEBSOCKET_BASE`
- `https://www.vy.no/services/global-itinerary/api/travel-planner/search`
- `https://www.vy.no/services/feature-toggle/toggles/`
- `https://www.vy.no/services/ticket`
- `https://www.vy.no/services/user/users/`
- `https://login.vy.no/token`
- `https://api.digitalekanaler.vydev.io/services`

Interpretation:
- The Entur WebSocket host/config key is strong evidence that the app has an Entur integration.
- The Vy-owned endpoints appear to cover journey planning, feature flags, tickets, user services and authentication.
- The exact runtime use, request payloads, auth scope and relationship to onboard display systems have **not** been verified.
- The documented Entur subscription URL is more specific than the host string found in the APK. Do not assume the APK uses that exact path without runtime/network evidence.

No APK binaries or extracted proprietary code are included in this repository.

## 3. Ruter Android app APK observations

Inspected file supplied in conversation: `Ruter-7.105.1.apkm`.

Static strings and operation names observed:

- GraphQL HTTP endpoint: `https://cosmo-router.transhub.io/graphql`
- GraphQL WebSocket endpoint: `wss://cosmo-router.transhub.io/graphql`
- WebSocket subprotocol: `graphql-transport-ws`
- Required request headers observed from the live endpoint: `client-platform: android` and `client-version: 7.105.1` (the latter is set to the inspected APK version `Ruter-7.105.1`; verify against newer app releases).
- Feature flag: `vehicleProgressEnabled`
- Anonymous-token mutation:
  `getAnonymousCustomerToken_v2 { accessToken }`
- Subscription operation: `departuresByLine`
- Subscription operation: `vehicleProgress`, with fields including `latitude`, `longitude`, `status`, `quayId`, `atQuay`, and `stopPositionInJourney`.

The observed `vehicleProgress` subscription takes a service-journey identifier and operating date. The likely workflow is to discover a departure/service journey first, then subscribe to its vehicle progress.

**Verified from the browser probe:** the anonymous-token mutation succeeds and the authenticated GraphQL WebSocket responds. Cosmo Router explicitly disables schema introspection (`__schema` / `__type`), so introspection errors must not be interpreted as network or CORS failures. The browser probe now uses the harmless `__typename` meta-field to verify the authenticated WebSocket path.

**APK operation documents recovered from the earlier inspection:**

```graphql
subscription departuresByLine($id: ID!) {
  departuresByLine(id: $id) {
    id
    estimatedCalls { serviceJourneyId operatingDate }
  }
}

subscription vehicleProgress($id: String!, $date: String!) {
  vehicleProgress(serviceJourneyId: $id, operatingDate: $date) {
    id latitude longitude status quayId atQuay serviceJourneyId stopPositionInJourney
  }
}
```

The browser adapter now derives distinct line IDs from Entur departure records whose line ID begins with `RUT:Line:`, subscribes to `departuresByLine`, then subscribes to `vehicleProgress` for each returned service-journey/date pair. Vehicle progress is joined to the display by service journey ID.

**Still to validate against live Ruter responses:** whether the line IDs supplied by Entur are accepted unchanged by Ruter's app GraphQL resolver, the actual shape/cardinality of subscription payloads, and whether position events arrive for the selected journeys. These are now runtime checks rather than guessed schema details.

The Ruter app's backend appears separate from the public Entur endpoint. Entur's published coverage table does not list RUT vehicle positions, although Ruter's own app may have a separate vehicle-progress facility.

## 4. Proposed architecture

```text
Entur Vehicle Positions ──┐
                          ├── Normalized vehicle/event model ── Display renderer
Entur Transit Data ───────┤
                          │
Ruter GraphQL adapter ────┘
```

Recommended stages:

1. Validate Entur queries for `VYG` and `VYX` with the included script.
2. Inspect representative records and identify stable IDs / timestamp semantics.
3. Join vehicle positions to scheduled service journeys and stop sequences.
4. Investigate the Ruter anonymous-token flow and subscriptions without embedding credentials.
5. Implement a normalized domain model and browser-based display renderer.
6. Add reconnect/backoff and stale-data indicators for WebSocket feeds.

## 5. Security and responsible use

- Use documented public APIs and a meaningful `ET-Client-Name`.
- Respect provider terms, rate limits and attribution requirements.
- Never commit access tokens, cookies, private account data or raw APKs.
- Treat APK string extraction as reverse-engineering evidence, not authorization to access private services.
- The included Ruter probe only requests an anonymous token and a harmless GraphQL `__typename` probe. It does not access personal accounts or attempt to bypass authorization.
- Before deploying a public display, confirm data licensing, permitted caching, attribution and operational restrictions.

## References

1. [Entur — Real-time data](https://developer.entur.no/open-data/realtime)
2. [Entur — Vehicle Positions GraphQL API](https://developer.entur.no/apis/graphql/vehicle-positions)
3. [Entur — vehicles query](https://developer.entur.no/apis/graphql/vehicle-positions/query/vehicles)
4. [Entur — vehicles subscription](https://developer.entur.no/apis/graphql/vehicle-positions/subscription/vehicles)
5. [Entur — Transit data](https://developer.entur.no/docs/open-services/transit-data)
