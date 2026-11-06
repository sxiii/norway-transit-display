/* Browser-native live adapters for Entur and the Ruter app backend. */
const CONFIG = {
  enturClient: "github-sxiii-norway-transit-display",
  vehiclesUrl: "https://api.entur.io/realtime/v2/vehicles/graphql",
  journeyUrl: "https://api.entur.io/journey-planner/v3/graphql",
  ruterUrl: "https://cosmo-router.transhub.io/graphql",
  defaultStop: "NSR:StopPlace:3983",
  refreshMs: 30000
};

const $ = (id) => document.getElementById(id);
const state = { timer: null, busy: false, departures: [], vehicles: [], lastUpdated: null, stopName: null };

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
      serviceJourney { id }
    }
  } }`;
}
function flattenVehicles(results) {
  return results.flatMap(({ code, data }) => (data.vehicles || []).map(v => ({
    ...v, codespace: code, journeyId: v.serviceJourney?.id || null
  })));
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
    const vehicle = journeyId ? vehiclesByJourney.get(journeyId)?.[0] : null;
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
    const quay = call.quay?.name || call.quay?.id || "—";
    const vehicleLabel = vehicle?.vehicleId || (vehicle ? "Tracked" : "Not matched");
    const coords = vehicle?.location?.latitude != null ? vehicle.location.latitude.toFixed(4) + ", " + vehicle.location.longitude.toFixed(4) : "";
    return `<article class="departure">
      <div class="time">${esc(time)}<span class="sub">${call.realtime ? "Expected" : "Scheduled"}</span></div>
      <div class="destination">${esc(destination)}<span class="sub">${vehicle ? esc(vehicle.mode || vehicle.codespace) : " "}</span></div>
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
    state.stopName = stop.name || stopId;\n    state.departures = stop.estimatedCalls || [];
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

function introspectionQuery() {
  return `query RuterSubscriptionIntrospection {
    __type(name: "Subscription") {
      name
      fields {
        name
        args { name type { kind name ofType { kind name ofType { kind name } } } }
        type { kind name ofType { kind name ofType { kind name } } }
      }
    }
  }`;
}
function ruterWebSocketProbe(token) {
  return new Promise((resolve, reject) => {
    let settled = false, acknowledged = false, timer;
    const ws = new WebSocket(CONFIG.ruterUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:"), "graphql-transport-ws");
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { ws.close(1000, "Probe complete"); } catch {}
      error ? reject(error) : resolve(result);
    };
    timer = setTimeout(() => finish(new Error(acknowledged ? "WebSocket opened but schema probe timed out" : "WebSocket connection acknowledgement timed out")), 12000);
    ws.onerror = () => finish(new Error("WebSocket network error (browser console may contain CORS/network details)"));
    ws.onclose = event => { if (!settled) finish(new Error("WebSocket closed before probe completed (code " + event.code + ")")); };
    ws.onopen = () => ws.send(JSON.stringify({ type:"connection_init", payload:{ Authorization:"Bearer " + token, authorization:"Bearer " + token } }));
    ws.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "connection_ack") {
        acknowledged = true;
        ws.send(JSON.stringify({ id:"schema-probe", type:"subscribe", payload:{ operationName:"RuterSubscriptionIntrospection", query:introspectionQuery() } }));
      } else if (msg.type === "next" && msg.id === "schema-probe") {
        const fields = msg.payload?.data?.__type?.fields || [];
        const vehicleProgress = fields.find(field => field.name === "vehicleProgress");
        const departuresByLine = fields.find(field => field.name === "departuresByLine");
        ws.send(JSON.stringify({id:"schema-probe",type:"complete"}));
        finish(null, { fieldCount:fields.length, vehicleProgress, departuresByLine, fieldNames:fields.map(f=>f.name) });
      } else if (msg.type === "error") finish(new Error("Ruter GraphQL WebSocket error: " + JSON.stringify(msg.payload).slice(0,400)));
    };
  });
}
async function probeRuter() {
  setStatus("ruter-status", "Requesting anonymous token", "working", "No account login is used");
  $("ruter-details").textContent = "Requesting token…";
  try {
    const tokenData = await gql(CONFIG.ruterUrl, "mutation { getAnonymousCustomerToken_v2 { accessToken } }");
    const token = tokenData.getAnonymousCustomerToken_v2?.accessToken;
    if (!token) throw new Error("Token mutation returned no accessToken");
    setStatus("ruter-status", "Token acquired", "working", "Testing GraphQL WebSocket");
    log("Ruter anonymous token acquired (value deliberately not displayed or stored).", "success");
    const schema = await ruterWebSocketProbe(token);
    const details = [
      "Subscription fields discovered: " + schema.fieldCount,
      "vehicleProgress: " + (schema.vehicleProgress ? "present" : "not exposed"),
      schema.vehicleProgress ? "vehicleProgress arguments: " + schema.vehicleProgress.args.map(a=>a.name + ":" + typeName(a.type)).join(", ") : "",
      "departuresByLine: " + (schema.departuresByLine ? "present" : "not exposed"),
      schema.departuresByLine ? "departuresByLine arguments: " + schema.departuresByLine.args.map(a=>a.name + ":" + typeName(a.type)).join(", ") : ""
    ].filter(Boolean).join("\n");
    $("ruter-details").textContent = details;
    setStatus("ruter-status", "WebSocket + schema OK", "ok", "Anonymous token and subscription schema introspection succeeded");
    log("Ruter WebSocket connected; Subscription schema introspection succeeded.", "success");
  } catch (error) {
    $("ruter-details").textContent = error.message + "\nIf this is a browser CORS/network restriction, a small Cloudflare Worker can proxy the request.";
    setStatus("ruter-status", "Probe failed", "bad", error.message);
    log("Ruter probe failed: " + error.message, "error");
  }
}
function typeName(type) {
  if (!type) return "?";
  return type.name || (type.ofType ? typeName(type.ofType) : type.kind);
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
      serviceJourney:{id:d.service_journey_id}
    }));
    state.vehicles = (data.vehicles || []).map(v => ({
      vehicleId:v.vehicle_id, mode:v.mode, delay:v.delay_seconds,
      location:{latitude:v.latitude,longitude:v.longitude},
      serviceJourney:{id:v.service_journey_id}, journeyId:v.service_journey_id
    }));
    state.stopName = data.stop_place?.name || data.stop_place?.id || "Transit departures";\n    state.lastUpdated = Date.now(); renderBoard();
    log("Loaded local snapshot JSON.", "success");
  } catch (error) { log("Could not load JSON: " + error.message, "error"); }
});
function tick() { $("clock").textContent = new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date()); }
tick(); setInterval(tick,1000);
$("stop-id").value = CONFIG.defaultStop;
log("Ready. Entur auto-refresh is enabled; Ruter is an explicit one-click probe.");
refreshEntur();
state.timer = setInterval(refreshEntur, CONFIG.refreshMs);
