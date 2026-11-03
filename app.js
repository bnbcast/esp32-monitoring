"use strict";

// ---- settings -------------------------------------------------------------
const BROKER_URL = "wss://broker.hivemq.com:8884/mqtt";   // keep in sync with the CSP in index.html
const TOPIC_ROOT = "esp32-dash/";
const STALE_AFTER_MS = 6000;                              // no live data for this long = NO SIGNAL
const N = 120;                                            // history points (one per second)

// ---- helpers --------------------------------------------------------------
const $ = id => document.getElementById(id);
const C = { ink: "#000", blue: "#2447ff", red: "#ff3b1f" };
const fmt = (v, d = 1) => (typeof v !== "number" || Number.isNaN(v)) ? "--" : v.toFixed(d);
const setPill = (el, text, cls) => { el.textContent = text; el.className = "pill " + cls; };
const uptime = s => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
  .map(n => String(n).padStart(2, "0")).join(":");

// ---- topic key (from the link: #t=KEY or #KEY) ----------------------------
function readKey() {
  const raw = location.hash.slice(1);
  const key = raw.startsWith("t=") ? raw.slice(2) : raw;
  // Only plain characters: no "/", "+" or "#", so the key can never become a wildcard
  return /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : null;
}

// ---- state ----------------------------------------------------------------
const H = { t: [], a: [] };
let warn = 30, danger = 50;
let last = null;            // last valid data object
let lastLiveAt = 0;         // when a non-retained data message last arrived
let lastPush = 0;
let linkState = "connecting";
let deviceState = "unknown";   // "online" | "offline" | "unknown"

// ---- canvas drawing -------------------------------------------------------
function fit(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = parseInt(c.getAttribute("height"), 10);
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { x, w, h };
}

function chart(c, arr, min, max, marks, color) {
  const { x, w, h } = fit(c);
  x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
  const Y = v => h - 4 - (Math.max(min, Math.min(max, v)) - min) / (max - min) * (h - 8);
  x.lineWidth = 2; x.strokeStyle = C.ink; x.setLineDash([6, 5]);
  marks.forEach(m => { x.beginPath(); x.moveTo(0, Y(m)); x.lineTo(w, Y(m)); x.stroke(); });
  x.setLineDash([]);
  if (arr.length > 1) {
    x.lineWidth = 4; x.strokeStyle = color; x.lineJoin = "miter"; x.beginPath();
    arr.forEach((v, i) => {
      const px = w - (arr.length - 1 - i) / (N - 1) * w;
      if (i) x.lineTo(px, Y(v)); else x.moveTo(px, Y(v));
    });
    x.stroke();
  }
  x.fillStyle = C.ink; x.font = "bold 12px monospace";
  x.fillText(max.toFixed(1), 6, 14); x.fillText(min.toFixed(1), 6, h - 6);
}

function drawLevel(roll, pitch, ok) {
  const c = $("cLevel"), { x, w, h } = fit(c);
  const cx = w / 2, cy = h / 2, half = Math.min(w, h) / 2 - 8, R = 60;
  x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
  [[danger, C.red], [warn, "#ffe600"]].forEach(([deg, col]) => {
    const s = deg / R * half;
    x.fillStyle = col; x.fillRect(cx - s, cy - s, s * 2, s * 2);
    x.lineWidth = 3; x.strokeStyle = C.ink; x.strokeRect(cx - s, cy - s, s * 2, s * 2);
  });
  const sw = warn / R * half;
  x.fillStyle = "#fff"; x.fillRect(cx - sw + 3, cy - sw + 3, sw * 2 - 6, sw * 2 - 6);
  x.lineWidth = 2; x.beginPath();
  x.moveTo(cx, cy - half); x.lineTo(cx, cy + half); x.moveTo(cx - half, cy); x.lineTo(cx + half, cy); x.stroke();
  if (ok) {
    const px = cx + Math.max(-R, Math.min(R, roll)) / R * half;
    const py = cy - Math.max(-R, Math.min(R, pitch)) / R * half;
    x.fillStyle = C.ink; x.fillRect(px - 9, py - 9, 18, 18);
    x.fillStyle = "#fff"; x.fillRect(px - 3, py - 3, 6, 6);
  }
}

// ---- message validation ---------------------------------------------------
const num = v => typeof v === "number" && Number.isFinite(v);
function validData(d) {
  return d && typeof d === "object" &&
    num(d.tilt) && num(d.roll) && num(d.pitch) && num(d.yaw) && num(d.lvl) && d.lvl >= 0 && d.lvl <= 2 &&
    num(d.warn) && num(d.danger) &&
    d.acs && typeof d.acs === "object" && d.gps && typeof d.gps === "object" &&
    d.sys && typeof d.sys === "object";
}

// ---- rendering ------------------------------------------------------------
function renderBanner() {
  const b = $("banner"), sub = $("bannerSub");
  const age = Date.now() - lastLiveAt;
  const live = lastLiveAt > 0 && age < STALE_AFTER_MS;
  const set = (cls, text, small) => { b.className = "banner " + cls; b.firstChild.nodeValue = text; sub.textContent = small; };

  document.body.classList.toggle("stale", !live);

  if (linkState !== "connected") {
    set("lx", "CONNECTING", "opening link to broker");
  } else if (deviceState === "offline") {
    set("lx", "DEVICE OFFLINE", last ? "showing last known values" : "waiting for the ESP32 to come online");
  } else if (!live) {
    set("lx", last ? "NO SIGNAL" : "WAITING", last ? "no live data, showing last known values" : "waiting for first reading");
  } else if (!last.mpu) {
    set("lx", "NO MPU DATA", "check MPU6050 wiring");
  } else {
    set("l" + last.lvl, ["SAFE", "WARNING", "DANGER"][last.lvl],
      "tilt " + fmt(last.tilt, 0) + " deg  |  warn " + last.warn + "  danger " + last.danger);
  }

  setPill($("pLink"), linkState === "connected" ? "BROKER OK" : "BROKER ...", linkState === "connected" ? "ok" : "wait");
  if (deviceState === "offline") setPill($("pDev"), "DEVICE OFFLINE", "bad");
  else if (live) setPill($("pDev"), "DEVICE LIVE", "ok");
  else setPill($("pDev"), last ? "NO SIGNAL" : "DEVICE ...", last ? "bad" : "wait");

  $("lState").textContent = linkState.toUpperCase();
  $("sState").textContent = live ? "LIVE" : "NOT LIVE";
  $("sAge").textContent = lastLiveAt ? Math.round(age / 1000) + " s ago" : "--";
  $("fTime").textContent = new Date().toLocaleTimeString();
}

function renderData(d) {
  warn = d.warn; danger = d.danger;
  const ok = !!d.mpu, acs = d.acs, gps = d.gps, sys = d.sys;

  setPill($("pMpu"), ok ? "MPU OK" : "MPU FAIL", ok ? "ok" : "bad");
  setPill($("pAcs"), acs.ok ? "ACS OK" : "ACS CHECK", acs.ok ? "ok" : "bad");
  setPill($("pGps"), gps.fix ? "GPS FIX" : (gps.chars < 10 ? "GPS NO DATA" : "GPS WAIT"),
    gps.fix ? "ok" : (gps.chars < 10 ? "bad" : "wait"));

  $("vRoll").textContent = fmt(d.roll); $("vPitch").textContent = fmt(d.pitch); $("vYaw").textContent = fmt(d.yaw);
  $("vMax").textContent = fmt(d.maxTilt, 0); $("vTilt").textContent = fmt(d.tilt) + " deg";
  $("vAx").textContent = fmt(d.ax, 2) + " g"; $("vAy").textContent = fmt(d.ay, 2) + " g"; $("vAz").textContent = fmt(d.az, 2) + " g";
  $("vWarn").textContent = d.warn + " deg"; $("vDanger").textContent = d.danger + " deg";
  $("tTemp").textContent = fmt(d.temp) + " C";
  $("ledB").classList.toggle("on", ok && d.lvl === 0);
  $("ledW").classList.toggle("on", ok && d.lvl === 1);
  $("ledR").classList.toggle("on", ok && d.lvl === 2);
  drawLevel(d.roll, d.pitch, ok);

  $("vAmps").textContent = acs.ok ? fmt(acs.amps, 2) : "ERR";
  $("vPeak").textContent = fmt(d.peakA, 2); $("vSv").textContent = fmt(acs.v, 3); $("vZv").textContent = fmt(acs.zero, 3);
  $("tCur").textContent = acs.ok ? "OK" : "CHECK WIRING";

  $("tFix").textContent = gps.fix ? "FIX OK" : "NO FIX";
  $("gSat").textContent = num(gps.sats) ? gps.sats : "--";
  $("gLat").textContent = fmt(gps.lat, 3); $("gLng").textContent = fmt(gps.lng, 3);
  $("gAlt").textContent = num(gps.alt) ? fmt(gps.alt, 0) + " m" : "--";
  $("gSpd").textContent = num(gps.kmh) ? fmt(gps.kmh) + " km/h" : "--";
  const m = $("gMap");
  if (gps.fix && num(gps.lat) && num(gps.lng)) {
    m.href = "https://www.openstreetmap.org/?mlat=" + gps.lat + "&mlon=" + gps.lng + "#map=12/" + gps.lat + "/" + gps.lng;
    m.hidden = false;
  } else m.hidden = true;

  $("sUp").textContent = num(d.up) ? uptime(d.up) : "--";
  $("sRssi").textContent = num(sys.rssi) ? sys.rssi + " dBm" : "--";
  $("sHeap").textContent = num(sys.heap) ? Math.round(sys.heap / 1024) + " KB" : "--";

  redrawCharts();
}

function redrawCharts() {
  chart($("cTilt"), H.t, 0, 90, [warn, danger], C.blue);
  const span = Math.max(0.5, ...H.a.map(Math.abs)) * 1.2;
  chart($("cAmps"), H.a, -span, span, [0], C.red);
}

// ---- MQTT -----------------------------------------------------------------
function onMessage(topic, payload, retained) {
  if (topic === TOPIC_STATUS) {
    deviceState = payload === "online" ? "online" : payload === "offline" ? "offline" : "unknown";
    renderBanner();
    return;
  }
  if (topic !== TOPIC_DATA) return;

  let d;
  try { d = JSON.parse(payload); } catch (e) { return; }
  if (!validData(d)) return;

  last = d;
  if (!retained) {                 // retained = stored last reading, not live
    lastLiveAt = Date.now();
    const now = Date.now();
    if (now - lastPush >= 1000) {
      lastPush = now;
      H.t.push(d.tilt); H.a.push(d.acs.ok && num(d.acs.amps) ? d.acs.amps : 0);
      if (H.t.length > N) { H.t.shift(); H.a.shift(); }
    }
  }
  renderData(d);
  renderBanner();
}

// ---- start ----------------------------------------------------------------
const KEY = readKey();
const TOPIC_DATA = KEY ? TOPIC_ROOT + KEY + "/data" : "";
const TOPIC_STATUS = KEY ? TOPIC_ROOT + KEY + "/status" : "";

if (!KEY) {
  $("setup").style.display = "block";
  $("grid").style.display = "none";
  $("banner").style.display = "none";
  $("keyForm").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("keyInput").value.trim();
    if (/^[A-Za-z0-9_-]{8,64}$/.test(v)) { location.hash = "t=" + v; location.reload(); }
    else $("keyInput").setCustomValidity("Use 8-64 letters, digits, - or _");
  });
  $("keyInput").addEventListener("input", () => $("keyInput").setCustomValidity(""));
} else {
  $("lKey").textContent = KEY.slice(0, 4) + "..." + KEY.slice(-2);
  renderBanner();
  const client = new MiniMqtt({
    url: BROKER_URL,
    topics: [TOPIC_DATA, TOPIC_STATUS],
    onMessage,
    onState: s => { linkState = s; if (s !== "connected") deviceState = "unknown"; renderBanner(); }
  });
  client.start();
  setInterval(renderBanner, 500);          // keeps "last update" and the stale check moving
  window.addEventListener("resize", () => { if (last) renderData(last); else redrawCharts(); });
  redrawCharts();
  drawLevel(0, 0, false);
}
