import { buildTrack, nearestOnTrack, haversine } from './geo.js';
import { parseTrackFile } from './parse.js';

const $ = (id) => document.getElementById(id);
const STORE_TRACK = 'ft.track.v1';
const STORE_OPTS = 'ft.opts.v1';

const opts = Object.assign(
  { threshold: 50, sound: true, vibrate: true, wake: true, test: false, follow: true },
  readJSON(STORE_OPTS, {})
);

const state = {
  track: null,
  watchId: null,
  hintIdx: null,
  offTrack: false,
  muted: false,
  lastAlertAt: 0,
  lastFix: null,
  wakeLock: null,
};

/* --- Mapa ---------------------------------------------------------------- */

const map = L.map('map', { zoomControl: true, tap: true }).setView([40.4, -3.7], 6);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap',
}).addTo(map);

const trackLayer = L.polyline([], { color: '#f97316', weight: 5, opacity: 0.9 }).addTo(map);
const doneLayer = L.polyline([], { color: '#38bdf8', weight: 5, opacity: 0.95 }).addTo(map);
const linkLayer = L.polyline([], {
  color: '#ef4444', weight: 2, dashArray: '6 6', opacity: 0.9,
}).addTo(map);
const markers = L.layerGroup().addTo(map);

const meIcon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18] });
const meOffIcon = L.divIcon({ className: '', html: '<div class="me-dot off"></div>', iconSize: [18, 18] });
let meMarker = null;
let accCircle = null;

// Si el usuario arrastra el mapa, dejamos de seguirle la posición.
map.on('dragstart', () => setFollow(false));
map.on('click', (e) => {
  if (opts.test) onPosition({
    coords: { latitude: e.latlng.lat, longitude: e.latlng.lng, accuracy: 8, speed: null },
    timestamp: performance.timeOrigin + performance.now(),
  });
});

/* --- Carga de track ------------------------------------------------------ */

function showTrack(parsed, { save = true, fit = true } = {}) {
  const track = buildTrack(parsed.points, parsed.name);
  if (!track.points.length) throw new Error('El track no tiene puntos válidos.');

  state.track = track;
  state.hintIdx = null;
  state.offTrack = false;
  state.muted = false;

  const latlngs = track.points.map((p) => [p.lat, p.lon]);
  trackLayer.setLatLngs(latlngs);
  doneLayer.setLatLngs([]);
  markers.clearLayers();

  L.circleMarker(latlngs[0], {
    radius: 7, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1,
  }).bindTooltip('Inicio').addTo(markers);
  L.circleMarker(latlngs[latlngs.length - 1], {
    radius: 7, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1,
  }).bindTooltip('Final').addTo(markers);

  for (const w of parsed.waypoints || []) {
    L.circleMarker([w.lat, w.lon], {
      radius: 4, color: '#fbbf24', weight: 2, fillOpacity: 0.9,
    }).bindTooltip(w.name || 'Waypoint').addTo(markers);
  }

  $('trackName').textContent = track.name;
  $('trackInfo').textContent =
    `${track.name}\n${fmtKm(track.total)} · ${track.points.length} puntos` +
    (track.ascent ? `\n↑ ${track.ascent} m  ↓ ${track.descent} m` : '');

  if (fit && track.bounds) map.fitBounds(track.bounds, { padding: [40, 40] });
  if (save) saveTrack(parsed);
  updateReadout(null);
}

async function loadFile(file) {
  if (!file) return;
  if (/\.kmz$/i.test(file.name)) {
    toast('Los KMZ van comprimidos: descomprímelo y carga el .kml de dentro.');
    return;
  }
  try {
    const text = await file.text();
    const parsed = parseTrackFile(text, file.name);
    showTrack(parsed);
    toast(`Track cargado: ${fmtKm(state.track.total)}`);
  } catch (err) {
    toast(err.message || 'No se ha podido leer el fichero.');
  }
}

function saveTrack(parsed) {
  // Redondeamos a 5 decimales (~1 m) para que quepa en localStorage.
  const compact = {
    name: parsed.name,
    p: parsed.points.map((p) => [
      +p.lat.toFixed(5),
      +p.lon.toFixed(5),
      Number.isFinite(p.ele) ? Math.round(p.ele) : null,
    ]),
    w: (parsed.waypoints || []).map((w) => [+w.lat.toFixed(5), +w.lon.toFixed(5), w.name || '']),
  };
  try {
    localStorage.setItem(STORE_TRACK, JSON.stringify(compact));
  } catch {
    toast('El track es muy grande para guardarlo; se ha cargado igualmente.');
  }
}

function restoreTrack() {
  const saved = readJSON(STORE_TRACK, null);
  if (!saved?.p?.length) return;
  try {
    showTrack(
      {
        name: saved.name,
        points: saved.p.map(([lat, lon, ele]) => ({ lat, lon, ele: ele ?? undefined })),
        waypoints: (saved.w || []).map(([lat, lon, name]) => ({ lat, lon, name })),
      },
      { save: false }
    );
  } catch {
    localStorage.removeItem(STORE_TRACK);
  }
}

/* --- Geolocalización ----------------------------------------------------- */

function startGps() {
  if (!navigator.geolocation) {
    toast('Este navegador no soporta geolocalización.');
    return;
  }
  if (state.watchId !== null) return;
  $('gpsInfo').textContent = 'Buscando señal…';
  state.watchId = navigator.geolocation.watchPosition(onPosition, onPosError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 20000,
  });
  $('btnGps').textContent = 'Parar GPS';
  $('btnGps').classList.add('stop');
  requestWakeLock();
  unlockAudio();
}

function stopGps() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  $('btnGps').textContent = 'Iniciar GPS';
  $('btnGps').classList.remove('stop');
  $('gpsInfo').textContent = 'GPS parado';
  releaseWakeLock();
}

function onPosError(err) {
  const msgs = {
    1: 'Permiso de ubicación denegado. Actívalo en los ajustes del navegador.',
    2: 'Sin señal de GPS por ahora.',
    3: 'El GPS está tardando; sigue buscando…',
  };
  $('gpsInfo').textContent = msgs[err.code] || 'Error de GPS';
  if (err.code === 1) stopGps();
}

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy, speed } = pos.coords;
  state.lastFix = { lat, lon, accuracy, speed, t: pos.timestamp };

  const ll = [lat, lon];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: meIcon, zIndexOffset: 1000, interactive: false }).addTo(map);
    accCircle = L.circle(ll, {
      radius: accuracy || 0, color: '#38bdf8', weight: 1, fillOpacity: 0.1, interactive: false,
    }).addTo(map);
    if (!state.track) map.setView(ll, 16);
  } else {
    meMarker.setLatLng(ll);
    accCircle.setLatLng(ll).setRadius(accuracy || 0);
  }
  if (opts.follow) map.panTo(ll, { animate: true, duration: 0.4 });

  const parts = [`±${Math.round(accuracy || 0)} m`];
  if (Number.isFinite(speed) && speed !== null) parts.push(`${(speed * 3.6).toFixed(1)} km/h`);
  if (opts.test) parts.push('modo prueba');
  $('gpsInfo').textContent = parts.join(' · ');

  updateReadout(state.lastFix);
}

/* --- Cálculo y aviso ----------------------------------------------------- */

function updateReadout(fix) {
  const track = state.track;
  if (!track || !fix) {
    $('devValue').textContent = '—';
    $('progValue').textContent = '—';
    $('remValue').textContent = track ? fmtKm(track.total) : '—';
    linkLayer.setLatLngs([]);
    return;
  }

  const near = nearestOnTrack(track, fix.lat, fix.lon, state.hintIdx);
  state.hintIdx = near.segIdx;

  const dist = near.dist;
  const pct = track.total > 0 ? Math.min(100, (near.along / track.total) * 100) : 0;
  const remaining = Math.max(0, track.total - near.along);

  $('devValue').textContent = dist < 1000 ? `${Math.round(dist)} m` : fmtKm(dist);
  $('progValue').textContent = `${pct.toFixed(0)} %`;
  $('remValue').textContent = fmtKm(remaining);
  $('progFill').style.width = `${pct}%`;

  // Coloreamos la parte ya recorrida y dibujamos la línea al punto más cercano.
  const done = track.points.slice(0, near.segIdx + 1).map((p) => [p.lat, p.lon]);
  done.push([near.lat, near.lon]);
  doneLayer.setLatLngs(done);
  linkLayer.setLatLngs(dist > 10 ? [[fix.lat, fix.lon], [near.lat, near.lon]] : []);

  const statEl = $('statDev');
  statEl.classList.toggle('off-track', dist > opts.threshold);
  statEl.classList.toggle('near', dist > opts.threshold * 0.6 && dist <= opts.threshold);
  statEl.classList.toggle('on-track', dist <= opts.threshold * 0.6);

  evaluateAlert(dist, near);
}

function evaluateAlert(dist, near) {
  const now = Date.now();
  // Histéresis: salimos con `threshold`, volvemos a "en ruta" con el 70 %.
  if (!state.offTrack && dist > opts.threshold) {
    state.offTrack = true;
    state.muted = false;
    state.lastAlertAt = 0;
    if (meMarker) meMarker.setIcon(meOffIcon);
  } else if (state.offTrack && dist < opts.threshold * 0.7) {
    state.offTrack = false;
    state.muted = false;
    if (meMarker) meMarker.setIcon(meIcon);
    banner(false);
    toast('De vuelta en el track');
    return;
  }

  if (!state.offTrack) {
    banner(false);
    return;
  }

  const bearing = bearingText(near, state.lastFix);
  $('alertText').textContent = `Fuera de ruta · ${Math.round(dist)} m ${bearing}`;
  banner(true);

  // Repetimos el aviso sonoro cada 25 s mientras sigamos fuera.
  if (!state.muted && now - state.lastAlertAt > 25000) {
    state.lastAlertAt = now;
    if (opts.vibrate && navigator.vibrate) navigator.vibrate([180, 90, 180]);
    if (opts.sound) beep();
  }
}

function bearingText(near, fix) {
  if (!fix) return '';
  const dLat = near.lat - fix.lat;
  const dLon = (near.lon - fix.lon) * Math.cos(fix.lat * Math.PI / 180);
  const deg = (Math.atan2(dLon, dLat) * 180) / Math.PI;
  const dirs = ['al N', 'al NE', 'al E', 'al SE', 'al S', 'al SO', 'al O', 'al NO'];
  return dirs[Math.round(((deg + 360) % 360) / 45) % 8];
}

function banner(show) {
  const el = $('alertBanner');
  if (show) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

/* --- Sonido, pantalla ---------------------------------------------------- */

let audioCtx = null;
function unlockAudio() {
  if (!audioCtx && window.AudioContext) audioCtx = new AudioContext();
  if (audioCtx?.state === 'suspended') audioCtx.resume();
}
function beep() {
  unlockAudio();
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < 2; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.28);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.28 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.28 + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + i * 0.28);
    osc.stop(t0 + i * 0.28 + 0.22);
  }
}

async function requestWakeLock() {
  if (!opts.wake || !navigator.wakeLock || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch { /* el navegador puede denegarlo; no es crítico */ }
}
function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.watchId !== null) requestWakeLock();
});

/* --- UI ------------------------------------------------------------------ */

function setFollow(on) {
  opts.follow = on;
  $('btnFollow').setAttribute('aria-pressed', String(on));
  saveOpts();
  if (on && state.lastFix) map.panTo([state.lastFix.lat, state.lastFix.lon]);
}

function openSheet(open) {
  for (const el of [$('sheet'), $('sheetBackdrop')]) {
    if (open) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.removeAttribute('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.setAttribute('hidden', ''), 3200);
}

$('btnLoad').onclick = () => $('fileInput').click();
$('btnLoad2').onclick = () => { openSheet(false); $('fileInput').click(); };
$('fileInput').onchange = (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
};

$('btnGps').onclick = () => (state.watchId === null ? startGps() : stopGps());
$('btnFollow').onclick = () => setFollow(!opts.follow);
$('btnFit').onclick = () => {
  if (state.track?.bounds) {
    setFollow(false);
    map.fitBounds(state.track.bounds, { padding: [40, 40] });
  } else toast('Carga primero un track.');
};

$('btnSettings').onclick = () => openSheet(true);
$('sheetClose').onclick = () => openSheet(false);
$('sheetBackdrop').onclick = () => openSheet(false);
$('alertMute').onclick = () => { state.muted = true; toast('Avisos silenciados hasta volver al track'); };

$('btnClear').onclick = () => {
  localStorage.removeItem(STORE_TRACK);
  state.track = null;
  state.hintIdx = null;
  trackLayer.setLatLngs([]);
  doneLayer.setLatLngs([]);
  linkLayer.setLatLngs([]);
  markers.clearLayers();
  banner(false);
  $('trackName').textContent = 'Sin track cargado';
  $('trackInfo').textContent = '';
  updateReadout(null);
  openSheet(false);
  toast('Track borrado');
};

$('thrRange').oninput = (e) => {
  opts.threshold = +e.target.value;
  $('thrLabel').textContent = `${opts.threshold} m`;
  saveOpts();
  if (state.lastFix) updateReadout(state.lastFix);
};
for (const [id, key] of [['optSound', 'sound'], ['optVibrate', 'vibrate'], ['optWake', 'wake'], ['optTest', 'test']]) {
  $(id).onchange = (e) => {
    opts[key] = e.target.checked;
    saveOpts();
    if (key === 'wake') e.target.checked ? requestWakeLock() : releaseWakeLock();
    if (key === 'test' && e.target.checked) toast('Toca el mapa para simular tu posición.');
  };
}

// Arrastrar y soltar (escritorio)
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) $('dropHint').removeAttribute('hidden');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').setAttribute('hidden', ''); }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').setAttribute('hidden', '');
  loadFile(e.dataTransfer.files[0]);
});

/* --- Helpers ------------------------------------------------------------- */

function fmtKm(m) {
  if (!Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveOpts() {
  try { localStorage.setItem(STORE_OPTS, JSON.stringify(opts)); } catch {}
}

/* --- Arranque ------------------------------------------------------------ */

$('thrRange').value = opts.threshold;
$('thrLabel').textContent = `${opts.threshold} m`;
$('optSound').checked = opts.sound;
$('optVibrate').checked = opts.vibrate;
$('optWake').checked = opts.wake;
$('optTest').checked = opts.test;
$('btnFollow').setAttribute('aria-pressed', String(opts.follow));

// ?track=ruta.gpx permite abrir la app con un track ya cargado (enlace compartible).
const trackParam = new URLSearchParams(location.search).get('track');
if (trackParam) {
  fetch(trackParam)
    .then((r) => {
      if (!r.ok) throw new Error(`No se ha podido descargar (${r.status})`);
      return r.text();
    })
    .then((text) => showTrack(parseTrackFile(text, trackParam.split('/').pop())))
    .catch((err) => { toast(err.message); restoreTrack(); });
} else {
  restoreTrack();
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exponemos utilidades mínimas para depurar desde la consola.
window.followTrack = { state, opts, map, showTrack };
