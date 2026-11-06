/* Browser-native live adapters for Entur and the Ruter app backend. */
const CONFIG = {
  enturClient: "github-sxiii-norway-transit-display",
  vehiclesUrl: "https://api.entur.io/realtime/v2/vehicles/graphql",
  journeyUrl: "https://api.entur.io/journey-planner/v3/graphql",
  ruterUrl: "https://cosmo-router.transhub.io/graphql",
  defaultStop: "NSR:StopPlace:3983",
  refreshMs: 30000,
  ruterClientVersion: "7.105.1"
};

const $ = (id) => document.getElementById(id);
const state = { timer: null, busy: false, departures: [], vehicles: [], lastUpdated: null, stopName: null, ruterSocket: null, ruterProgress: new Map(), ruterLineSubscriptions: new Set(), ruterJourneySubscriptions: new Set() };

function setStatus(id, label, kind = "neutral", detail = "") {
  const node = $(id);
  node.className = "status-line " + kind;
  node.querySelector(".status-label").textContent = label;
  node.querySelector(".status-detail").textContent = detail;
}
function log(message, kind = "info") {
  const line = document.createElement("div");
  line.className = "log-entry " + kind;
  line.textContent = "[" + new Date().toLocaleTimeString() + "] " + message;
  $("log").prepend(line);
  while ($("log").children.length > 30) $("log").lastElementChild.remove();
}
function gql(endpoint, query, headers = {}, signal) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", ...headers },
    body: JSON.stringify({ query }),
    signal
  }).then(async response => {
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { throw new Error("HTTP " + response.status + ": non-JSON response " + raw.slice(0, 180)); }
    if (!response.ok) throw new Error("HTTP " + response.status + ": " + JSON.stringify(body).slice(0, 350));
    if (body.errors?.length) throw new Error("GraphQL: " + body.errors.map(e => e.message).join("; "));
    return body.data;
  });
}
const enturHeaders = { "ET-Client-Name": CONFIG.enturClient };
// Ruter rejects anonymous GraphQL requests without this app-platform header.
const ruterHeaders = { "client-platform": "android", "client-version": CONFIG.ruterClientVersion };

function vehicleQuery(code) {
  return `query { vehicles(codespaceId: "${code}") {
    vehicleId originName destinationName mode lastUpdated delay
    location { latitude longitude }
    serviceJourney { id }
  } }`;
}
function departureQuery(stopId, count) {
  const id = JSON.stringify(stopId);
  return `query { stopPlace(id: ${id}) {
    id name
    estimatedCalls(numberOfDepartures: ${count}) {
      realtime aimedDepartureTime expectedDepartureTime actualDepartureTime
      destinationDisplay { frontText }
      quay { id name }
      serviceJourney { id journeyPattern { line { id publicCode name } } }
    }
  } }`;
}
function flattenVehicles(results) {
  return results.flatMap(({ code, data }) => (data.vehicles || []).map(v => ({
    ...v, codespace: code, journeyId: v.serviceJourney?.id || null
  })));
}
function ruterVehicleFor(journeyId) {
  const progress = state.ruterProgress.get(journeyId);
  if (!progress) return null;
  return {
    source: "Ruter",
    vehicleId: progress.id || "Ruter",
    mode: progress.status || "Ruter vehicle",
    location: { latitude: progress.latitude, longitude: progress.longitude }
  };
}
function renderBoard() {
  const calls = state.departures;
  const vehiclesByJourney = new Map();
  for (const v of state.vehicles) if (v.journeyId) {
    const list = vehiclesByJourney.get(v.journeyId) || [];
    list.push(v); vehiclesByJourney.set(v.journeyId, list);
  }
  const matched = calls.reduce((n, c) => n + (vehiclesByJourney.has(c.serviceJourney?.id) ? 1 : 0), 0);
  $("departure-count").textContent = calls.length;
  $("vehicle-count").textContent = state.vehicles.length;
  $("matched-count").textContent = matched;
  if (!calls.length) {
    $("rows").innerHTML = '<div class="empty"><strong>No departures loaded</strong>Check the stop ID and Entur connection.</div>';
    return;
  }
  const sorted = [...calls].sort((a,b) => new Date(a.expectedDepartureTime || a.aimedDepartureTime || 0) - new Date(b.expectedDepartureTime || b.aimedDepartureTime || 0));
  $("rows").innerHTML = sorted.map(call => {
    const journeyId = call.serviceJourney?.id;
    const vehicle = journeyId ? (vehiclesByJourney.get(journeyId)?.[0] || ruterVehicleFor(journeyId)) : null;
    const expected = call.expectedDepartureTime || call.aimedDepartureTime || call.actualDepartureTime;
    const time = expected ? new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit"}).format(new Date(expected)) : "—";
    const delay = vehicle?.delay;
    let delayText = call.realtime ? "Real-time" : "Scheduled";
    let delayClass = "muted";
    if (delay != null) {
      const seconds = typeof delay === "number" ? delay : null;
      delayText = seconds == null ? "Vehicle tracked" : seconds > 30 ? "Delayed +" + Math.round(seconds/60) + " min" : seconds < -30 ? "Early " + Math.round(Math.abs(seconds)/60) + " min" : "On time";
      delayClass = seconds > 30 ? "delay" : "ontime";
    }
    const destination = call.destinationDisplay?.frontText || "Destination unavailable";
    const route = call.serviceJourney?.journeyPattern?.line?.publicCode || call.serviceJourney?.journeyPattern?.line?.name || "";
    const quay = call.quay?.name || call.quay?.id || "—";
    const vehicleLabel = vehicle?.vehicleId || (vehicle?.source === "Ruter" ? "Ruter live" : vehicle ? "Tracked" : "Not matched");
    const coords = vehicle?.location?.latitude != null ? vehicle.location.latitude.toFixed(4) + ", " + vehicle.location.longitude.toFixed(4) : "";
    return `<article class="departure">
      <div class="time">${esc(time)}<span class="sub">${call.realtime ? "Expected" : "Scheduled"}</span></div>
      <div class="destination">${route ? `<span class="route-badge">${esc(route)}</span>` : ""}${esc(destination)}<span class="sub">${vehicle ? esc(vehicle.mode || vehicle.codespace) : " "}</span></div>
      <div class="platform quay">${esc(quay)}</div>
      <div class="status ${delayClass}">${esc(delayText)}<span class="sub">${vehicle ? "Vehicle position available" : "No position match"}</span></div>
      <div class="vehicle"><span class="pill"><i class="dot ${vehicle ? "" : "warn"}"></i>${esc(vehicleLabel)}</span><span class="sub">${esc(coords)}</span></div>
    </article>`;
  }).join("");
  $("stop-name").textContent = state.stopName || $("stop-id").value.trim();
  $("date-label").textContent = "Live data · " + new Date().toLocaleDateString();
  $("updated").textContent = "Last successful refresh: " + new Date(state.lastUpdated).toLocaleTimeString();
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

async function refreshEntur() {
  if (state.busy) return;
  state.busy = true;
  setStatus("entur-status", "Connecting / refreshing", "working", "Entur HTTP GraphQL");
  const stopId = $("stop-id").value.trim();
  const count = Math.max(1, Math.min(50, Number($("departure-limit").value) || 20));
  try {
    const [departureData, vyg, vyx] = await Promise.all([
      gql(CONFIG.journeyUrl, departureQuery(stopId, count), enturHeaders),
      gql(CONFIG.vehiclesUrl, vehicleQuery("VYG"), enturHeaders),
      gql(CONFIG.vehiclesUrl, vehicleQuery("VYX"), enturHeaders)
    ]);
    const stop = departureData.stopPlace;
    if (!stop) throw new Error("Entur returned no stopPlace for " + stopId);
    state.stopName = stop.name || stopId;
    state.departures = stop.estimatedCalls || [];
    state.vehicles = flattenVehicles([{code:"VYG",data:vyg},{code:"VYX",data:vyx}]);
    state.lastUpdated = Date.now();
    $("stop-name").textContent = stop.name || stopId;
    renderBoard();
    setStatus("entur-status", "Connected", "ok", stop.name + " · " + state.departures.length + " departures · " + state.vehicles.length + " vehicles");
    log("Entur refreshed: " + state.departures.length + " departures, " + state.vehicles.length + " VYG/VYX vehicles.", "success");
  } catch (error) {
    setStatus("entur-status", "Request failed", "bad", error.message);
    log("Entur failed: " + error.message, "error");
  } finally {
    state.busy = false;
  }
}

const RUTER_DEPARTURES_SUBSCRIPTION = `subscription departuresByLine($id: ID!) {
  departuresByLine(id: $id) {
    id
    estimatedCalls { serviceJourneyId operatingDate }
  }
}`;
const RUTER_PROGRESS_SUBSCRIPTION = `subscription vehicleProgress($id: String!, $date: String!) {
  vehicleProgress(serviceJourneyId: $id, operatingDate: $date) {
    id latitude longitude status quayId atQuay serviceJourneyId stopPositionInJourney
  }
}`;
function closeRuterSocket() {
  if (state.ruterSocket) {
    try { state.ruterSocket.close(1000, "Ruter reconnect"); } catch {}
    state.ruterSocket = null;
  }
  state.ruterProgress.clear();
  state.ruterLineSubscriptions.clear();
  state.ruterJourneySubscriptions.clear();
}
async function probeRuter() {
  closeRuterSocket();
  setStatus("ruter-status", "Requesting anonymous token", "working", "No account login is used");
  $("ruter-details").textContent = "Requesting token…";
  try {
    const tokenData = await gql(CONFIG.ruterUrl, "mutation { getAnonymousCustomerToken_v2 { accessToken } }", ruterHeaders);
    const token = tokenData.getAnonymousCustomerToken_v2?.accessToken;
    if (!token) throw new Error("Token mutation returned no accessToken");

    const lineIds = [...new Set(state.departures
      .map(call => call.serviceJourney?.journeyPattern?.line?.id)
      .filter(id => typeof id === "string" && id.startsWith("RUT:Line:")))];
    if (!lineIds.length) {
      throw new Error("No Ruter line IDs found in the current Entur departures. Entur returned " +
        state.departures.length + " calls; only lines with IDs beginning RUT:Line: can be passed to departuresByLine.");
    }

    const ws = new WebSocket(CONFIG.ruterUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:"), "graphql-transport-ws");
    state.ruterSocket = ws;
    let acknowledged = false, departureUpdates = 0, progressUpdates = 0;
    const pending = new Map();
    const timeout = setTimeout(() => {
      if (state.ruterSocket !== ws) return;
      const journeys = state.ruterJourneySubscriptions.size;
      $("ruter-details").textContent =
        "Anonymous token: acquired\nAuthenticated WebSocket: " + (acknowledged ? "connected" : "not acknowledged") +
        "\nRuter line IDs submitted: " + lineIds.length +
        "\nDeparture updates: " + departureUpdates +
        "\nVehicle-progress subscriptions: " + journeys +
        "\nVehicle-progress updates: " + progressUpdates +
        "\nThe subscriptions remain open for live updates.";
      if (departureUpdates || progressUpdates) {
        setStatus("ruter-status", "Ruter live subscriptions active", "ok",
          departureUpdates + " departure updates · " + progressUpdates + " vehicle updates");
        log("Ruter subscriptions active: " + departureUpdates + " departure updates, " + progressUpdates + " vehicle updates.", "success");
      } else {
        setStatus("ruter-status", "Subscriptions sent; awaiting data", "working",
          lineIds.length + " line subscriptions · no payload received yet");
        log("Ruter subscription requests sent; no data payload received before the initial wait expired.", "info");
      }
    }, 15000);

    const subscribe = (id, operationName, query, variables) => {
      ws.send(JSON.stringify({ id, type:"subscribe", payload:{ operationName, query, variables } }));
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      setStatus("ruter-status", "WebSocket network error", "bad", "Check browser console for transport details");
      log("Ruter WebSocket network error.", "error");
    };
    ws.onclose = event => {
      clearTimeout(timeout);
      if (state.ruterSocket === ws) {
        state.ruterSocket = null;
        setStatus("ruter-status", "WebSocket closed", "bad", "Close code " + event.code);
        log("Ruter WebSocket closed (code " + event.code + ").", "error");
      }
    };
    ws.onopen = () => ws.send(JSON.stringify({
      type:"connection_init",
      payload:{
        Authorization:"Bearer " + token,
        authorization:"Bearer " + token,
        "client-platform":"android",
        "client-version":CONFIG.ruterClientVersion,
        clientPlatform:"android",
        clientVersion:CONFIG.ruterClientVersion
      }
    }));
    ws.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "connection_ack") {
        acknowledged = true;
        lineIds.forEach((lineId, index) => {
          const id = "ruter-line-" + index;
          state.ruterLineSubscriptions.add(id);
          pending.set(id, {kind:"departures",lineId});
          subscribe(id, "departuresByLine", RUTER_DEPARTURES_SUBSCRIPTION, {id:lineId});
        });
        setStatus("ruter-status", "Requesting Ruter departures", "working", lineIds.length + " RUT:Line subscriptions");
        log("Ruter authenticated; subscribed to departuresByLine for " + lineIds.length + " Ruter line IDs.", "success");
      } else if (msg.type === "next") {
        const operation = pending.get(msg.id);
        if (!operation) return;
        const payload = msg.payload?.data;
        if (operation.kind === "departures") {
          const result = payload?.departuresByLine;
          if (!result) {
            if (msg.payload?.errors?.length) log("Ruter departuresByLine error: " + msg.payload.errors.map(e=>e.message).join("; "), "error");
            return;
          }
          departureUpdates++;
          const calls = result.estimatedCalls || [];
          calls.forEach((call, index) => {
            if (!call.serviceJourneyId || !call.operatingDate) return;
            const key = call.serviceJourneyId + "|" + call.operatingDate;
            if (state.ruterJourneySubscriptions.has(key)) return;
            state.ruterJourneySubscriptions.add(key);
            const subId = "ruter-progress-" + state.ruterJourneySubscriptions.size;
            pending.set(subId, {kind:"progress",journeyId:call.serviceJourneyId,operatingDate:call.operatingDate});
            subscribe(subId, "vehicleProgress", RUTER_PROGRESS_SUBSCRIPTION, {
              id:call.serviceJourneyId, date:call.operatingDate
            });
          });
          $("ruter-details").textContent =
            "Anonymous token: acquired\nAuthenticated WebSocket: connected\nRuter lines queried: " + lineIds.length +
            "\nDeparture updates received: " + departureUpdates +
            "\nService journeys found: " + state.ruterJourneySubscriptions.size +
            "\nVehicle-progress subscriptions sent: " + state.ruterJourneySubscriptions.size +
            "\nVehicle-progress updates: " + progressUpdates;
          setStatus("ruter-status", "Ruter departures received", "working",
            calls.length + " calls · " + state.ruterJourneySubscriptions.size + " journeys");
          log("Ruter departuresByLine update: " + calls.length + " calls; " + state.ruterJourneySubscriptions.size + " service journeys.", "success");
        } else if (operation.kind === "progress") {
          const progress = payload?.vehicleProgress;
          if (!progress) {
            if (msg.payload?.errors?.length) log("Ruter vehicleProgress error: " + msg.payload.errors.map(e=>e.message).join("; "), "error");
            return;
          }
          progressUpdates++;
          const journeyId = progress.serviceJourneyId || operation.journeyId;
          state.ruterProgress.set(journeyId, progress);
          renderBoard();
          $("ruter-details").textContent =
            "Anonymous token: acquired\nAuthenticated WebSocket: connected\nRuter lines queried: " + lineIds.length +
            "\nDeparture updates received: " + departureUpdates +
            "\nService journeys found: " + state.ruterJourneySubscriptions.size +
            "\nVehicle-progress subscriptions sent: " + state.ruterJourneySubscriptions.size +
            "\nVehicle-progress updates: " + progressUpdates;
          setStatus("ruter-status", "Ruter vehicle data live", "ok",
            progressUpdates + " position updates · " + state.ruterProgress.size + " journeys tracked");
          log("Ruter vehicleProgress update for " + journeyId + (progress.latitude != null ? " at " + progress.latitude + ", " + progress.longitude : "") + ".", "success");
        }
      } else if (msg.type === "error") {
        const message = JSON.stringify(msg.payload).slice(0,500);
        setStatus("ruter-status", "Ruter subscription error", "bad", message);
        log("Ruter GraphQL WebSocket error: " + message, "error");
      }
    };
  } catch (error) {
    $("ruter-details").textContent = error.message;
    setStatus("ruter-status", "Probe failed", "bad", error.message);
    log("Ruter probe failed: " + error.message, "error");
  }
}
$("refresh").addEventListener("click", refreshEntur);
$("ruter-probe").addEventListener("click", probeRuter);
$("auto-refresh").addEventListener("change", () => {
  if (state.timer) clearInterval(state.timer);
  state.timer = $("auto-refresh").checked ? setInterval(refreshEntur, CONFIG.refreshMs) : null;
});
$("file").addEventListener("change", async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    state.departures = (data.departures || []).map(d => ({
      realtime:d.realtime, aimedDepartureTime:d.aimed_departure_time,
      expectedDepartureTime:d.expected_departure_time, actualDepartureTime:d.actual_departure_time,
      destinationDisplay:{frontText:d.destination}, quay:d.quay,
      serviceJourney:{id:d.service_journey_id,journeyPattern:{line:{publicCode:d.line_public_code,name:d.line_name}}}
    }));
    state.vehicles = (data.vehicles || []).map(v => ({
      vehicleId:v.vehicle_id, mode:v.mode, delay:v.delay_seconds,
      location:{latitude:v.latitude,longitude:v.longitude},
      serviceJourney:{id:v.service_journey_id}, journeyId:v.service_journey_id
    }));
    state.stopName = data.stop_place?.name || data.stop_place?.id || "Transit departures";
    state.lastUpdated = Date.now(); renderBoard();
    log("Loaded local snapshot JSON.", "success");
  } catch (error) { log("Could not load JSON: " + error.message, "error"); }
});
function tick() { $("clock").textContent = new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date()); }
tick(); setInterval(tick,1000);
$("stop-id").value = CONFIG.defaultStop;
log("Ready. Entur auto-refresh is enabled; Ruter is an explicit one-click probe.");
refreshEntur();
state.timer = setInterval(refreshEntur, CONFIG.refreshMs);
