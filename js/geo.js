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
  let up = 0, down = 0, prevEle = null;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (Number.isFinite(p.ele)) {
      if (prevEle !== null) {
        const d = p.ele - prevEle;
        // filtro de ruido barométrico/GPS: ignoramos saltos < 3 m
        if (d > 3) { up += d; prevEle = p.ele; }
        else if (d < -3) { down -= d; prevEle = p.ele; }
      } else prevEle = p.ele;
    }
  }
  return {
    name,
    points: pts,
    segLen,
    cum,
    total: n ? cum[n - 1] : 0,
    bounds: n ? [[minLat, minLon], [maxLat, maxLon]] : null,
    ascent: Math.round(up),
    descent: Math.round(down),
  };
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
