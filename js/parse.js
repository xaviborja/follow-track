// Lectura de ficheros de track: GPX, KML, TCX y GeoJSON.

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function textOf(el, tag) {
  if (!el) return null;
  const found = el.getElementsByTagName(tag);
  return found.length ? found[0].textContent.trim() : null;
}

function parseGPX(doc) {
  const readPts = (tag) =>
    Array.from(doc.getElementsByTagName(tag)).map((p) => ({
      lat: num(p.getAttribute('lat')),
      lon: num(p.getAttribute('lon')),
      ele: num(textOf(p, 'ele')),
      time: textOf(p, 'time'),
    }));

  // Preferimos trkpt; si el fichero es una ruta, usamos rtept.
  let points = readPts('trkpt');
  if (!points.length) points = readPts('rtept');

  const name =
    textOf(doc.getElementsByTagName('trk')[0], 'name') ||
    textOf(doc.getElementsByTagName('rte')[0], 'name') ||
    textOf(doc.getElementsByTagName('metadata')[0], 'name');

  const waypoints = Array.from(doc.getElementsByTagName('wpt')).map((w) => ({
    lat: num(w.getAttribute('lat')),
    lon: num(w.getAttribute('lon')),
    name: textOf(w, 'name') || '',
  }));

  return { points, waypoints, name };
}

function parseKML(doc) {
  const points = [];
  // LineString y también gx:Track (Google Earth)
  for (const ls of doc.getElementsByTagName('LineString')) {
    const raw = textOf(ls, 'coordinates');
    if (!raw) continue;
    for (const chunk of raw.split(/\s+/)) {
      if (!chunk) continue;
      const [lon, lat, ele] = chunk.split(',').map(num);
      if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon, ele });
    }
  }
  if (!points.length) {
    for (const c of doc.getElementsByTagName('coord')) {
      const [lon, lat, ele] = c.textContent.trim().split(/\s+/).map(num);
      if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon, ele });
    }
  }
  const waypoints = Array.from(doc.getElementsByTagName('Placemark'))
    .map((pm) => {
      const raw = textOf(pm.getElementsByTagName('Point')[0], 'coordinates');
      if (!raw) return null;
      const [lon, lat] = raw.trim().split(',').map(num);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat, lon, name: textOf(pm, 'name') || '' };
    })
    .filter(Boolean);
  return { points, waypoints, name: textOf(doc, 'name') };
}

function parseTCX(doc) {
  const points = [];
  for (const tp of doc.getElementsByTagName('Trackpoint')) {
    const pos = tp.getElementsByTagName('Position')[0];
    if (!pos) continue;
    const lat = num(textOf(pos, 'LatitudeDegrees'));
    const lon = num(textOf(pos, 'LongitudeDegrees'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push({
      lat, lon,
      ele: num(textOf(tp, 'AltitudeMeters')),
      time: textOf(tp, 'Time'),
    });
  }
  return { points, waypoints: [], name: textOf(doc, 'Name') };
}

function parseGeoJSON(text) {
  const gj = JSON.parse(text);
  const points = [];
  const waypoints = [];
  const push = (coords) => {
    for (const c of coords) {
      if (Number.isFinite(c[0]) && Number.isFinite(c[1]))
        points.push({ lat: c[1], lon: c[0], ele: Number.isFinite(c[2]) ? c[2] : undefined });
    }
  };
  const walk = (geom, props) => {
    if (!geom) return;
    if (geom.type === 'LineString') push(geom.coordinates);
    else if (geom.type === 'MultiLineString') geom.coordinates.forEach(push);
    else if (geom.type === 'Point')
      waypoints.push({ lat: geom.coordinates[1], lon: geom.coordinates[0], name: props?.name || '' });
    else if (geom.type === 'GeometryCollection') geom.geometries.forEach((g) => walk(g, props));
  };
  if (gj.type === 'FeatureCollection') gj.features.forEach((f) => walk(f.geometry, f.properties));
  else if (gj.type === 'Feature') walk(gj.geometry, gj.properties);
  else walk(gj, null);
  return { points, waypoints, name: gj.name || null };
}

/**
 * Detecta el formato por contenido (no por extensión) y devuelve
 * { points, waypoints, name }. Lanza Error si no encuentra puntos.
 */
export function parseTrackFile(text, filename = '') {
  const head = text.slice(0, 4000);
  let result;

  if (head.trimStart().startsWith('{')) {
    result = parseGeoJSON(text);
  } else {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length)
      throw new Error('El fichero no es un XML válido.');
    const root = doc.documentElement?.nodeName.replace(/^.*:/, '');
    if (root === 'gpx') result = parseGPX(doc);
    else if (root === 'kml') result = parseKML(doc);
    else if (root === 'TrainingCenterDatabase') result = parseTCX(doc);
    else if (doc.getElementsByTagName('trkpt').length) result = parseGPX(doc);
    else if (doc.getElementsByTagName('LineString').length) result = parseKML(doc);
    else throw new Error('Formato no reconocido. Usa GPX, KML, TCX o GeoJSON.');
  }

  if (!result.points.length)
    throw new Error('El fichero no contiene ningún track con coordenadas.');

  result.name =
    result.name || filename.replace(/\.[^.]+$/, '') || 'Track sin nombre';
  return result;
}
