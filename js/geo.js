// Utilidades geométricas sobre coordenadas WGS84.
// Todas las distancias se devuelven en metros.

const R = 6371008.8; // radio medio terrestre (IUGG)
const D2R = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Proyección equirectangular local con origen en (lat0, lon0).
// Sobre distancias de pocos km el error es despreciable para lo que hacemos.
function toLocal(lat, lon, lat0, lon0) {
  return {
    x: (lon - lon0) * D2R * R * Math.cos(lat0 * D2R),
    y: (lat - lat0) * D2R * R,
  };
}

// Distancia del punto p al segmento a-b, y parámetro t (0..1) del pie de
// la perpendicular sobre el segmento.
function pointToSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  const a = toLocal(aLat, aLon, pLat, pLon);
  const b = toLocal(bLat, bLon, pLat, pLon);
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = 0;
  if (len2 > 0) {
    // p está en el origen del sistema local, así que el producto escalar
    // se simplifica a -(a·v)/|v|²
    t = -(a.x * vx + a.y * vy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a.x + t * vx;
  const cy = a.y + t * vy;
  return { dist: Math.hypot(cx, cy), t };
}

/**
 * Construye el modelo de track a partir de una lista de puntos {lat, lon, ele?}.
 * Precalcula longitudes de segmento y distancias acumuladas.
 */
export function buildTrack(points, name = 'Track') {
  const pts = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)
  );
  const n = pts.length;
  const segLen = new Float64Array(Math.max(0, n - 1));
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    segLen[i - 1] = haversine(
      pts[i - 1].lat,
      pts[i - 1].lon,
      pts[i].lat,
      pts[i].lon
    );
    cum[i] = cum[i - 1] + segLen[i - 1];
  }
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  return {
    name,
    points: pts,
    segLen,
    cum,
    total: n ? cum[n - 1] : 0,
    bounds: n ? [[minLat, minLon], [maxLat, maxLon]] : null,
    ...elevationProfile(pts, cum),
  };
}

/**
 * Serie de elevación lista para dibujar y para contar desnivel.
 *
 * La altitud del GPS es ruidosa, así que se suaviza con una media móvil sobre
 * una ventana de distancia (no de índices: los puntos no están equiespaciados).
 * El desnivel se cuenta sobre la serie suavizada y con un umbral de 3 m, que es
 * lo que evita inflar la subida acumulada con el temblor del sensor.
 */
function elevationProfile(pts, cum) {
  const n = pts.length;
  const raw = pts.map((p) => (Number.isFinite(p.ele) ? p.ele : null));
  const known = raw.filter((v) => v !== null).length;
  if (known < Math.max(2, n * 0.5)) {
    return { hasEle: false, ele: null, cumAscent: null, ascent: 0, descent: 0, minEle: 0, maxEle: 0 };
  }

  // Rellenamos huecos por interpolación lineal entre los puntos conocidos.
  const filled = new Float64Array(n);
  let prevIdx = -1;
  for (let i = 0; i < n; i++) {
    if (raw[i] === null) continue;
    if (prevIdx === -1) for (let j = 0; j < i; j++) filled[j] = raw[i];
    else for (let j = prevIdx + 1; j < i; j++)
      filled[j] = raw[prevIdx] + ((raw[i] - raw[prevIdx]) * (j - prevIdx)) / (i - prevIdx);
    filled[i] = raw[i];
    prevIdx = i;
  }
  for (let j = prevIdx + 1; j < n; j++) filled[j] = filled[prevIdx];

  // Media móvil sobre ±30 m recorridos.
  const WIN = 30;
  const ele = new Float64Array(n);
  let lo = 0, hi = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && cum[hi] <= cum[i] + WIN) sum += filled[hi++];
    while (cum[lo] < cum[i] - WIN) sum -= filled[lo++];
    ele[i] = sum / (hi - lo);
  }

  const cumAscent = new Float64Array(n);
  let up = 0, down = 0, ref = ele[0];
  let minEle = ele[0], maxEle = ele[0];
  for (let i = 1; i < n; i++) {
    const d = ele[i] - ref;
    if (d > 3) { up += d; ref = ele[i]; }
    else if (d < -3) { down -= d; ref = ele[i]; }
    cumAscent[i] = up;
    if (ele[i] < minEle) minEle = ele[i];
    if (ele[i] > maxEle) maxEle = ele[i];
  }

  return {
    hasEle: true,
    ele,
    cumAscent,
    ascent: Math.round(up),
    descent: Math.round(down),
    minEle,
    maxEle,
  };
}

/**
 * Interpola un valor de la serie `key` del track (ele, cumAscent…) a una
 * distancia dada desde el inicio.
 */
export function valueAtDistance(track, series, meters) {
  if (!series) return null;
  const n = track.points.length;
  const d = Math.max(0, Math.min(track.total, meters));
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (track.cum[mid] <= d) lo = mid; else hi = mid;
  }
  const span = track.cum[hi] - track.cum[lo];
  const t = span > 0 ? (d - track.cum[lo]) / span : 0;
  return series[lo] + (series[hi] - series[lo]) * t;
}

/** Coordenadas del punto del track situado a `meters` del inicio. */
export function positionAtDistance(track, meters) {
  const n = track.points.length;
  if (!n) return null;
  const d = Math.max(0, Math.min(track.total, meters));
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (track.cum[mid] <= d) lo = mid; else hi = mid;
  }
  const span = track.cum[hi] - track.cum[lo];
  const t = span > 0 ? (d - track.cum[lo]) / span : 0;
  const a = track.points[lo], b = track.points[hi];
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/**
 * Punto del track más cercano a (lat, lon).
 *
 * `hint` es el índice de segmento del cálculo anterior: buscamos primero en una
 * ventana a su alrededor para que en tracks de ida y vuelta (o que se cruzan)
 * no salte al ramal equivocado. Si dentro de la ventana no encontramos nada
 * razonablemente cerca, repetimos la búsqueda sobre el track completo.
 */
export function nearestOnTrack(track, lat, lon, hint = null, window = 400) {
  const n = track.points.length;
  if (n === 0) return null;
  if (n === 1) {
    return {
      dist: haversine(lat, lon, track.points[0].lat, track.points[0].lon),
      segIdx: 0, t: 0, along: 0,
      lat: track.points[0].lat, lon: track.points[0].lon,
    };
  }

  const scan = (from, to) => {
    let best = null;
    for (let i = from; i < to; i++) {
      const a = track.points[i];
      const b = track.points[i + 1];
      const r = pointToSegment(lat, lon, a.lat, a.lon, b.lat, b.lon);
      if (!best || r.dist < best.dist) best = { dist: r.dist, t: r.t, segIdx: i };
    }
    return best;
  };

  let best = null;
  if (hint !== null) {
    const from = Math.max(0, hint - window);
    const to = Math.min(n - 1, hint + window);
    best = scan(from, to);
    // Si estamos lejos, puede que el hint fuera erróneo: reescaneamos entero.
    if (!best || best.dist > 150) {
      const full = scan(0, n - 1);
      if (full && (!best || full.dist < best.dist - 10)) best = full;
    }
  } else {
    best = scan(0, n - 1);
  }

  const a = track.points[best.segIdx];
  const b = track.points[best.segIdx + 1];
  return {
    dist: best.dist,
    segIdx: best.segIdx,
    t: best.t,
    along: track.cum[best.segIdx] + best.t * track.segLen[best.segIdx],
    lat: a.lat + (b.lat - a.lat) * best.t,
    lon: a.lon + (b.lon - a.lon) * best.t,
  };
}
