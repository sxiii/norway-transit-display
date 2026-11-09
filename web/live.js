/* Browser-native live adapters for Entur and the Ruter app backend. */
const CONFIG = {
  enturClient: "github-sxiii-norway-transit-display",
  vehiclesUrl: "https://api.entur.io/realtime/v2/vehicles/graphql",
  journeyUrl: "https://api.entur.io/journey-planner/v3/graphql",
  transitDataUrl: "https://api.entur.io/transit-data/v1beta/graphql",
  ruterUrl: "https://cosmo-router.transhub.io/graphql",
  defaultStop: "NSR:StopPlace:4000",
  refreshMs: 30000,
  ruterClientVersion: "7.105.1"
};

const $ = (id) => document.getElementById(id);
const state = { map: null, mapMarker: null, allBusMarkers: new Map(), allBusMarkersFitted: false, mapMode: "single", selectedMapJourney: null, selectedRouteFilter: "", searchTimer: null, searchAbort: null, timer: null, busy: false, departures: [], vehicles: [], lastUpdated: null, stopName: null, ruterSocket: null, ruterAutoStarted: false, ruterProgress: new Map(), ruterRouteDepartures: new Map(), ruterJourneyRoutes: new Map(), ruterLineSubscriptions: new Set(), ruterJourneySubscriptions: new Set() };

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
  const allCalls = state.selectedRouteFilter && state.ruterRouteDepartures.size
    ? [...state.ruterRouteDepartures.values()].filter(call => state.ruterProgress.has(call.serviceJourney?.id))
    : state.departures;
  const calls = state.selectedRouteFilter
    ? allCalls.filter(call => String(call.serviceJourney?.journeyPattern?.line?.publicCode || call.serviceJourney?.journeyPattern?.line?.name || "").trim().toLowerCase() === state.selectedRouteFilter.toLowerCase())
    : allCalls;
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
    $("rows").innerHTML = state.selectedRouteFilter
      ? '<div class="empty"><strong>No live route '+esc(state.selectedRouteFilter)+' buses received yet</strong>Waiting for vehicle positions from the route-wide subscriptions.</div>'
      : '<div class="empty"><strong>No departures loaded</strong>Check the stop ID and Entur connection.</div>';
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
      <div class="vehicle"><span class="pill" title="${esc(vehicleLabel)}">${esc(vehicleLabel)}</span><span class="sub">${esc(coords)}</span>${vehicle?.source === "Ruter" && vehicle.location?.latitude != null ? `<button type="button" data-map-journey="${esc(journeyId)}">Show map</button>` : ""}</div>
    </article>`;
  }).join("");
  $("rows").querySelectorAll("[data-map-journey]").forEach(button => button.addEventListener("click", () => showVehicleMap(button.dataset.mapJourney)));
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
    if (!state.ruterAutoStarted) { state.ruterAutoStarted = true; probeRuter(); }
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
  if (state.ruterSocket) { try { state.ruterSocket.close(1000, "Ruter reconnect"); } catch {} state.ruterSocket = null; }
  state.ruterProgress.clear(); state.ruterRouteDepartures.clear(); state.ruterJourneyRoutes.clear(); state.ruterLineSubscriptions.clear(); state.ruterJourneySubscriptions.clear();
}
async function discoverRouteRuterKeys(route) {
  const lineData = await gql(CONFIG.transitDataUrl,
    `query RouteLines { lines(publicCode: ${JSON.stringify(route)}, transportModes: ["bus"], first: 1000) { nodes { id publicCode name } } }`,
    enturHeaders
  );
  const lines = (lineData.lines?.nodes || []).filter(line => line.id?.startsWith("RUT:Line:"));
  if (!lines.length) throw new Error("Entur found no bus lines with public route number " + route + ".");

  const keys = new Map();
  for (const line of lines) {
    const detail = await gql(CONFIG.transitDataUrl,
      `query RouteLineQuays { line(id: ${JSON.stringify(line.id)}) { id publicCode name quays(first: 1000) { nodes { id estimatedCalls(numberOfDepartures: 1000, whiteListed: { lines: [${JSON.stringify(line.id)}] }) { aimedDepartureTime expectedDepartureTime realtime destinationDisplay { frontText } quay { id name } serviceJourney { id journeyPattern { line { publicCode name } } } } } } } }`,
      enturHeaders);
    const quays = detail.line?.quays?.nodes || [];
    for (const quay of quays) {
      for (const call of quay.estimatedCalls || []) {
        const frontText = call.destinationDisplay?.frontText;
        if (!quay.id || !frontText) continue;
        const id = [quay.id, line.id, frontText].join("|");
        keys.set(id, {id, quayId:quay.id, lineId:line.id, frontText, route:String(line.publicCode || route)});
        const journeyId = call.serviceJourney?.id;
        if (journeyId) {
          const existing = state.ruterRouteDepartures.get(journeyId);
          const callTime = call.expectedDepartureTime || call.aimedDepartureTime || "";
          if (!existing || (callTime && callTime < (existing.expectedDepartureTime || existing.aimedDepartureTime || "9999"))) {
            state.ruterRouteDepartures.set(journeyId, {
              serviceJourney:{id:journeyId, journeyPattern:{line:{publicCode:line.publicCode || route, name:line.name || route}}},
              destinationDisplay:{frontText}, quay:{id:quay.id, name:quay.name || quay.id},
              expectedDepartureTime:call.expectedDepartureTime, aimedDepartureTime:call.aimedDepartureTime,
              realtime:!!call.realtime
            });
          }
        }
      }
    }
    log("Entur route "+route+": discovered "+quays.length+" stops on "+(line.name || line.id)+".", "info");
  }
  if (!keys.size) throw new Error("Found route "+route+", but Entur returned no quay/destination combinations for its stops.");
  return [...keys.values()];
}

async function probeRuter() {
  closeRuterSocket();
  clearVehicleMarkers();
  if (state.mapMode === "all") updateAllVehicleMarkers();
  setStatus("ruter-status", "Requesting anonymous token", "working", "No account login is used");
  $("ruter-details").textContent = "Requesting token…";
  $("ruter-raw").textContent = "No WebSocket messages captured yet.";
  try {
    const tokenData = await gql(CONFIG.ruterUrl, "mutation { getAnonymousCustomerToken_v2 { accessToken } }", ruterHeaders);
    const token = tokenData.getAnonymousCustomerToken_v2?.accessToken;
    if (!token) throw new Error("Token mutation returned no accessToken");

    // Ruter requires quayId|lineId|frontText. For a selected route, discover
    // every quay served by that line through Entur Transit Data, independent
    // of the currently selected departure-board stop.
    const ruterKeys = state.selectedRouteFilter
      ? await discoverRouteRuterKeys(state.selectedRouteFilter)
      : [...new Map(state.departures.flatMap(call => {
          const quayId = call.quay?.id;
          const lineId = call.serviceJourney?.journeyPattern?.line?.id;
          const frontText = call.destinationDisplay?.frontText;
          if (!quayId || !lineId || !frontText || !lineId.startsWith("RUT:Line:")) return [];
          const id = [quayId, lineId, frontText].join("|");
          return [[id, {id, quayId, lineId, frontText, route:call.serviceJourney?.journeyPattern?.line?.publicCode || ""}]];
        })).values()];
    if (state.selectedRouteFilter) {
      $("route-filter-status").textContent = "Found "+ruterKeys.length+" stop/destination subscriptions for route "+state.selectedRouteFilter+"; waiting for live vehicle positions.";
    }
    if (!ruterKeys.length) {
      throw new Error("No usable Ruter departure keys found. Need quay.id, line.id (RUT:Line:…), and destinationDisplay.frontText on an Entur departure.");
    }

    const ws = new WebSocket(CONFIG.ruterUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:"), "graphql-transport-ws");
    state.ruterSocket = ws;
    let acknowledged = false, departureUpdates = 0, progressUpdates = 0, messageCount = 0;
    let lastType = "none", lastAt = "none";
    const pending = new Map(), rawMessages = [];
    const updateDetails = () => {
      $("ruter-details").textContent =
        "Anonymous token: acquired\nAuthenticated WebSocket: " + (acknowledged ? "acknowledged" : "waiting") +
        "\nSocket readyState: " + ws.readyState + " (1 = open)" +
        "\nComposite quay|line|destination keys submitted: " + ruterKeys.length +
        "\nWebSocket messages received: " + messageCount +
        "\nLast message: " + lastType + " at " + lastAt +
        "\nDeparture updates: " + departureUpdates +
        "\nService journeys discovered: " + state.ruterJourneySubscriptions.size +
        "\nVehicle-progress subscriptions sent: " + state.ruterJourneySubscriptions.size +
        "\nVehicle-progress updates: " + progressUpdates;
    };
    const capture = msg => {
      messageCount++; lastType = msg?.type || "unknown"; lastAt = new Date().toLocaleTimeString();
      rawMessages.push({receivedAt:new Date().toISOString(), message:msg});
      if (rawMessages.length > 30) rawMessages.shift();
      $("ruter-raw").textContent = rawMessages.map((entry,i) =>
        "["+(i+1)+"] "+entry.receivedAt+"\n"+JSON.stringify(entry.message,null,2)
      ).join("\n\n").slice(-24000);
      updateDetails();
    };
    const reportErrors = (errors, context) => {
      if (!Array.isArray(errors) || !errors.length) return false;
      errors.forEach(error => log("Ruter "+context+" GraphQL error: "+(error.message || JSON.stringify(error))+
        (error.path ? " · path "+JSON.stringify(error.path) : ""), "error"));
      setStatus("ruter-status", "GraphQL operation error", "bad",
        context+": "+errors.map(e=>e.message || "Unknown error").join("; "));
      return true;
    };
    const subscribe = (id, operationName, query, variables, routeNumber = null) => {
      pending.set(id, {operationName, variables, routeNumber});
      ws.send(JSON.stringify({id, type:"subscribe", payload:{operationName, query, variables}}));
    };
    const timeout = setTimeout(() => {
      if (state.ruterSocket !== ws) return;
      updateDetails();
      if (!messageCount) {
        setStatus("ruter-status", "Connected; no messages received", "working",
          "No GraphQL messages or keepalives received in 15 seconds");
        log("Ruter WebSocket is open but has sent no messages after 15 seconds.", "info");
      } else if (!departureUpdates && !progressUpdates) {
        setStatus("ruter-status", "Subscriptions sent; awaiting data", "working",
          messageCount+" protocol messages · no data payload yet");
      }
    }, 15000);

    ws.onerror = () => {
      clearTimeout(timeout);
      setStatus("ruter-status", "WebSocket network error", "bad", "Inspect raw diagnostics and browser console");
      log("Ruter WebSocket network error.", "error");
    };
    ws.onclose = event => {
      clearTimeout(timeout);
      capture({type:"transport_close", code:event.code, reason:event.reason, wasClean:event.wasClean});
      if (state.ruterSocket === ws) {
        state.ruterSocket = null;
        setStatus("ruter-status", "WebSocket closed", "bad", "Close code "+event.code+(event.reason ? " · "+event.reason : ""));
        log("Ruter WebSocket closed (code "+event.code+").", "error");
      }
    };
    ws.onopen = () => {
      capture({type:"transport_open", protocol:ws.protocol});
      ws.send(JSON.stringify({type:"connection_init", payload:{
        Authorization:"Bearer "+token, authorization:"Bearer "+token,
        "client-platform":"android", "client-version":CONFIG.ruterClientVersion,
        clientPlatform:"android", clientVersion:CONFIG.ruterClientVersion
      }}));
      log("Ruter WebSocket transport opened; connection_init sent.", "info");
    };
    ws.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); }
      catch { capture({type:"unparsed_message", data:String(event.data).slice(0,2000)}); return; }
      capture(msg);

      if (msg.type === "ping") {
        ws.send(JSON.stringify({type:"pong", ...(msg.payload === undefined ? {} : {payload:msg.payload})}));
        log("Ruter sent ping; replied with pong.", "info"); return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "connection_ack") {
        acknowledged = true;
        ruterKeys.forEach((key,index) => {
          const id = "ruter-line-"+index;
          state.ruterLineSubscriptions.add(id);
          subscribe(id, "departuresByLine", RUTER_DEPARTURES_SUBSCRIPTION, {id:key.id}, key.route);
        });
        setStatus("ruter-status", "Requesting Ruter departures", "working",
          ruterKeys.length+" quay|line|destination subscriptions");
        log("Ruter connection acknowledged; submitted "+ruterKeys.length+" composite departuresByLine keys.", "success");
        updateDetails(); return;
      }
      if (msg.type === "next") {
        const operation = pending.get(msg.id);
        if (!operation) { log("Ruter sent next for unknown subscription ID "+msg.id+".", "info"); return; }
        const payload = msg.payload || {};
        if (reportErrors(payload.errors, operation.operationName)) return;
        const data = payload.data || {};
        if (operation.operationName === "departuresByLine") {
          const result = data.departuresByLine;
          if (result == null) {
            log("Ruter departuresByLine payload lacks data.departuresByLine: "+JSON.stringify(payload).slice(0,1200), "error");
            return;
          }
          departureUpdates++;
          const calls = Array.isArray(result.estimatedCalls) ? result.estimatedCalls : [];
          calls.forEach(call => {
            if (!call.serviceJourneyId || !call.operatingDate) return;
            if (operation.routeNumber) state.ruterJourneyRoutes.set(call.serviceJourneyId, operation.routeNumber);
            const key = call.serviceJourneyId+"|"+call.operatingDate;
            if (state.ruterJourneySubscriptions.has(key)) return;
            state.ruterJourneySubscriptions.add(key);
            const subId = "ruter-progress-"+state.ruterJourneySubscriptions.size;
            subscribe(subId, "vehicleProgress", RUTER_PROGRESS_SUBSCRIPTION,
              {id:call.serviceJourneyId, date:call.operatingDate});
          });
          log("Ruter departuresByLine update: "+calls.length+" calls; "+
            state.ruterJourneySubscriptions.size+" unique journeys.", "success");
          setStatus("ruter-status", "Ruter departures received", "working",
            calls.length+" calls · "+state.ruterJourneySubscriptions.size+" journeys");
          updateDetails(); return;
        }
        if (operation.operationName === "vehicleProgress") {
          let progress = data.vehicleProgress;
          if (Array.isArray(progress)) progress = progress[0];
          if (!progress) {
            log("Ruter vehicleProgress emitted no progress object: "+JSON.stringify(payload).slice(0,1200), "info");
            return;
          }
          progressUpdates++;
          const journeyId = progress.serviceJourneyId || operation.variables.id;
          state.ruterProgress.set(journeyId, progress);
          renderBoard();
          if (state.mapMode === "all") updateAllVehicleMarkers();
          else if (state.selectedMapJourney === journeyId) updateVehicleMap(progress);
          const vehicleRef = progress.vehicleRef || progress.vehicleId || progress.vehicle?.id || null;
          log("Ruter vehicleProgress for "+journeyId+
            (vehicleRef ? " · vehicle "+vehicleRef : " · physical vehicle ID not present in selected fields")+
            (progress.latitude != null ? " · "+progress.latitude+", "+progress.longitude : ""), "success");
          setStatus("ruter-status", "Ruter vehicle data live",
            progress.latitude != null && progress.longitude != null ? "ok" : "working",
            progressUpdates+" progress updates · "+state.ruterProgress.size+" journeys");
          updateDetails(); return;
        }
      }
      if (msg.type === "error") {
        const detail = JSON.stringify(msg.payload || msg).slice(0,1500);
        reportErrors(Array.isArray(msg.payload) ? msg.payload : null, "subscription");
        setStatus("ruter-status", "Ruter subscription error", "bad", detail);
        log("Ruter GraphQL WebSocket error: "+detail, "error"); return;
      }
      if (msg.type === "complete") {
        const operation = pending.get(msg.id);
        log("Ruter completed subscription "+msg.id+(operation ? " ("+operation.operationName+")" : "")+".", "info");
        pending.delete(msg.id); updateDetails(); return;
      }
      if (msg.type === "connection_error") {
        setStatus("ruter-status", "Connection initialization rejected", "bad", JSON.stringify(msg.payload).slice(0,1000));
        log("Ruter connection_error: "+JSON.stringify(msg.payload).slice(0,1000),"error");
      }
    };
  } catch (error) {
    $("ruter-details").textContent = error.message;
    if (state.selectedRouteFilter) $("route-filter-status").textContent = "Route "+state.selectedRouteFilter+" tracking failed: "+error.message;
    setStatus("ruter-status", "Probe failed", "bad", error.message);
    log("Ruter probe failed: "+error.message, "error");
  }
}

function initVehicleMap() {
 if(state.map||!window.L)return;
 state.map=L.map("vehicle-map",{zoomControl:true,attributionControl:true}).setView([59.9139,10.7522],13);
 const attribution="Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community";
 L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",{maxZoom:16,attribution}).addTo(state.map);
 L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",{maxZoom:16,attribution}).addTo(state.map);
}
function routeLabelForJourney(journeyId) {
 const call=state.departures.find(item=>item.serviceJourney?.id===journeyId);
 if(!call)return "Ruter bus";
 const route=call.serviceJourney?.journeyPattern?.line?.publicCode||call.serviceJourney?.journeyPattern?.line?.name||"";
 const destination=call.destinationDisplay?.frontText||"";
 return [route,destination].filter(Boolean).join(" ")||"Ruter bus";
}
function busRouteNumber(journeyId) {
 const call=state.departures.find(item=>item.serviceJourney?.id===journeyId);
 return state.ruterJourneyRoutes.get(journeyId) || call?.serviceJourney?.journeyPattern?.line?.publicCode ||
  call?.serviceJourney?.journeyPattern?.line?.name || "";
}
function busNumberIcon(route) {
 const number=String(route||"").trim();
 return L.divIcon({
  className:"bus-number-marker",
  html:'<span class="bus-number-dot">'+(number?esc(number):"")+'</span>',
  iconSize:[30,30],
  iconAnchor:[15,15],
  popupAnchor:[0,-15]
 });
}
function clearVehicleMarkers(){
 if(state.mapMarker&&state.map)state.map.removeLayer(state.mapMarker);
 state.mapMarker=null;
 if(state.map)for(const marker of state.allBusMarkers.values())state.map.removeLayer(marker);
 state.allBusMarkers.clear();state.allBusMarkersFitted=false;
}
function updateAllVehicleMarkers() {
 initVehicleMap();if(!state.map)return;
 const bounds=[];let count=0;
 for(const [journeyId,progress] of state.ruterProgress){
  if (state.selectedRouteFilter &&
      String(busRouteNumber(journeyId)).trim().toLowerCase() !== state.selectedRouteFilter.toLowerCase()) continue;
  const lat=Number(progress.latitude),lon=Number(progress.longitude);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;
  const point=[lat,lon],label=routeLabelForJourney(journeyId),vin=progress.id||"Ruter bus";
  let marker=state.allBusMarkers.get(journeyId);
  if(!marker){
   marker=L.marker(point,{icon:busNumberIcon(busRouteNumber(journeyId))}).addTo(state.map);
   state.allBusMarkers.set(journeyId,marker);
  } else {
   marker.setLatLng(point);
   marker.setIcon(busNumberIcon(busRouteNumber(journeyId)));
  }
  marker.bindPopup("<b>"+esc(label)+"</b><br>"+esc(vin)+"<br>"+lat.toFixed(5)+", "+lon.toFixed(5));
  bounds.push(point);count++;
 }
 $("map-subtitle").textContent=(state.selectedRouteFilter ? "Route "+state.selectedRouteFilter+" · " : "")+
  count+" buses with live positions · updates in real time";
 if(bounds.length&&!state.allBusMarkersFitted){state.map.fitBounds(bounds,{padding:[28,28],maxZoom:15});state.allBusMarkersFitted=true;}
 setTimeout(()=>state.map?.invalidateSize(),0);
}
function updateVehicleMap(progress) {
 if(state.mapMode==="all"){updateAllVehicleMarkers();return;}
 const lat=Number(progress.latitude),lon=Number(progress.longitude);
 if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
 initVehicleMap();if(!state.map)return;
 const point=[lat,lon];
 const route=busRouteNumber(state.selectedMapJourney);
 if(!state.mapMarker)state.mapMarker=L.marker(point,{icon:busNumberIcon(route)}).addTo(state.map);
 else {state.mapMarker.setLatLng(point);state.mapMarker.setIcon(busNumberIcon(route));}
 state.mapMarker.bindPopup("<b>"+esc(route||"Ruter bus")+"</b><br>"+esc(progress.id||"Ruter bus")+"<br>"+lat.toFixed(5)+", "+lon.toFixed(5));
 state.map.panTo(point,{animate:false});
 $("map-subtitle").textContent=(progress.id||"Ruter bus")+" · "+lat.toFixed(5)+", "+lon.toFixed(5)+" · "+(progress.status||"Live");
 setTimeout(()=>state.map?.invalidateSize(),0);
}
function showAllSyncedBuses(){
 clearVehicleMarkers();state.mapMode="all";state.selectedMapJourney=null;
 $("map-panel").hidden=false;
 $("map-title").textContent=state.selectedRouteFilter
  ? "ROUTE "+state.selectedRouteFilter+" · LIVE BUSES" : "ALL SYNCED BUSES · LIVE";
 updateAllVehicleMarkers();setTimeout(()=>state.map?.invalidateSize(),50);
 $("map-panel").scrollIntoView({behavior:"smooth",block:"nearest"});
}
function showVehicleMap(journeyId){
 const p=state.ruterProgress.get(journeyId);if(!p)return;
 clearVehicleMarkers();state.mapMode="single";state.selectedMapJourney=journeyId;$("map-panel").hidden=false;
 $("map-title").textContent=routeLabelForJourney(journeyId)+" · LIVE BUS";
 updateVehicleMap(p);setTimeout(()=>state.map?.invalidateSize(),50);
 $("map-panel").scrollIntoView({behavior:"smooth",block:"nearest"});
}
async function searchStops(query){
 const box=$("stop-suggestions");if(state.searchAbort)state.searchAbort.abort();
 const controller=new AbortController();state.searchAbort=controller;
 try{
  const response=await fetch("https://api.entur.io/geocoder/v3/autocomplete?q="+encodeURIComponent(query)+"&lang=en&layers=stopPlace&multimodal=all&limit=12",{headers:{"ET-Client-Name":CONFIG.enturClient,"Accept":"application/json"},signal:controller.signal});
  if(!response.ok)throw new Error("Geocoder HTTP "+response.status);
  const data=await response.json();
  const stops=(data.features||[]).map(f=>{const p=f.properties||{},names=p.names||{},address=p.address||{};return{id:p.id||f.id||p.gid||p.identifier,name:names.display||names.default||p.name||p.label||f.text||"",area:address.locality||p.locality||address.county||p.county||""};}).filter(x=>x.id&&String(x.id).includes("StopPlace")&&x.name);
  box.replaceChildren();
  if(!stops.length){box.hidden=false;box.textContent="No matching stops found";return;}
  stops.slice(0,8).forEach(stop=>{
   const b=document.createElement("button");b.type="button";b.className="suggestion";
   b.innerHTML=esc(stop.name)+"<small>"+esc([stop.area,stop.id].filter(Boolean).join(" · "))+"</small>";
   b.addEventListener("click",()=>{$("stop-id").value=stop.id;$("stop-search").value=stop.name;box.hidden=true;state.ruterProgress.clear();state.selectedMapJourney=null;$("map-panel").hidden=true;refreshEntur();if(state.ruterSocket)probeRuter();});
   box.append(b);
  });box.hidden=false;
 }catch(e){if(e.name!=="AbortError")log("Stop search failed: "+e.message,"error");}
}
function setupStopSearch(){
 $("stop-search").value="Jernbanetorget";
 $("stop-search").addEventListener("input",()=>{const q=$("stop-search").value.trim();clearTimeout(state.searchTimer);if(q.length<2){$("stop-suggestions").hidden=true;return;}state.searchTimer=setTimeout(()=>searchStops(q),180);});
 document.addEventListener("click",e=>{if(!e.target.closest(".stop-search-wrap"))$("stop-suggestions").hidden=true;});
}
$("map-center").addEventListener("click",()=>{if(state.mapMode==="all"){const bounds=[...state.allBusMarkers.values()].map(marker=>marker.getLatLng());if(bounds.length)state.map.fitBounds(bounds,{padding:[28,28],maxZoom:15});}else{const p=state.selectedMapJourney&&state.ruterProgress.get(state.selectedMapJourney);if(p)updateVehicleMap(p);}});
$("ruter-all-map").addEventListener("click",showAllSyncedBuses);
$("map-close").addEventListener("click",()=>{$("map-panel").hidden=true;});
$("map-fullscreen").addEventListener("click",async()=>{try{if(!document.fullscreenElement)await $("map-panel").requestFullscreen();else await document.exitFullscreen();}catch(e){log("Fullscreen unavailable: "+e.message,"error");}});
document.addEventListener("fullscreenchange",()=>{$("map-fullscreen").textContent=document.fullscreenElement?"Exit fullscreen":"Fullscreen";setTimeout(()=>state.map?.invalidateSize(),80);});

setupStopSearch();
$("refresh").addEventListener("click", refreshEntur);
$("ruter-probe").addEventListener("click", () => { state.selectedRouteFilter=""; renderBoard(); probeRuter(); });
$("route-track").addEventListener("click", () => {
  const route=$("route-number").value.trim();
  if (!/^\d+[A-Za-z]?$/.test(route)) {
    $("route-filter-status").textContent="Enter a route number, e.g. 83.";
    return;
  }
  state.selectedRouteFilter=route;
  renderBoard();
  $("route-filter-status").textContent="Connecting subscriptions for route "+route+"…";
  showAllSyncedBuses();
  probeRuter();
});
$("route-number").addEventListener("keydown", event => {
  if (event.key === "Enter") $("route-track").click();
});
$("route-clear").addEventListener("click", () => {
  state.selectedRouteFilter="";
  renderBoard();
  $("route-number").value="";
  $("route-filter-status").textContent="Route filter cleared. Reconnecting to all currently available lines…";
  probeRuter();
  if (state.mapMode === "all") showAllSyncedBuses();
});
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
