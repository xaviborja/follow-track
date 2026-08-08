// Detección de las subidas principales de una ruta.
//
// El método es el habitual en este problema y tiene tres pasos:
//
// 1. Buscar los máximos y mínimos *con prominencia*: un punto solo cuenta como
//    cima si después se baja de él al menos `prominence` metros. Así los dientes
//    de sierra del GPS no generan cien subidas de tres metros.
// 2. Cada valle→cima es una subida candidata, y se fusionan las consecutivas
//    separadas por un bajón pequeño respecto al desnivel total: un puerto con un
//    falso llano en medio es un puerto, no dos.
// 3. Filtrar lo que no merece llamarse subida: poco desnivel, poca pendiente
//    media o muy corta.
//
// Trabaja sobre la elevación ya suavizada del track (media móvil de ±30 m).

const DEFAULTS = {
  prominence: 12,   // m que hay que bajar de una cima para que cuente como tal
  minGain: 50,      // m de desnivel mínimo para listar una subida
  minGrade: 0.03,   // 3 % de pendiente media mínima
  minLength: 200,   // m de longitud mínima
  mergeDrop: 0.3,   // se fusionan si el bajón intermedio es menor que este
};                  // porcentaje del desnivel total de la subida resultante

export function detectClimbs(track, options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!track?.hasEle) return [];
  const { ele, cum } = track;
  const n = track.points.length;
  if (n < 3) return [];

  const ext = findExtrema(track, o.prominence);
  const found = [];
  collectRange(track, 0, n - 1, ext, o, found, 0);

  return found
    .map((c) => {
      const gain = ele[c.to] - ele[c.from];
      const length = cum[c.to] - cum[c.from];
      return {
        fromIdx: c.from,
        toIdx: c.to,
        startDist: cum[c.from],
        endDist: cum[c.to],
        length,
        gain,
        avgGrade: length > 0 ? gain / length : 0,
        maxGrade: steepestStretch(track, c.from, c.to),
        topEle: ele[c.to],
      };
    })
    .filter((c) => c.gain >= o.minGain && c.length >= o.minLength && c.avgGrade >= o.minGrade)
    .sort((a, b) => a.startDist - b.startDist);
}

// --- 1. Extremos con prominencia ---
function findExtrema(track, prominence) {
  const { ele } = track;
  const n = track.points.length;
  const ext = [];
  let candMin = 0, candMax = 0, dir = 0;
  for (let i = 1; i < n; i++) {
    const e = ele[i];
    if (e > ele[candMax]) candMax = i;
    if (e < ele[candMin]) candMin = i;
    if (dir !== -1 && e < ele[candMax] - prominence) {
      ext.push({ idx: candMax, type: 'max' });
      dir = -1;
      candMin = i;
    } else if (dir !== 1 && e > ele[candMin] + prominence) {
      ext.push({ idx: candMin, type: 'min' });
      dir = 1;
      candMax = i;
    }
  }
  if (dir === 1) ext.push({ idx: candMax, type: 'max' });
  else if (dir === -1) ext.push({ idx: candMin, type: 'min' });
  return ext;
}

/**
 * Busca subidas dentro del rango [lo, hi] y las acumula en `out`.
 *
 * Fusiona, recorta y —esto es lo importante— vuelve a buscar dentro de lo que
 * el recorte ha descartado. Puede pasar que dos subidas se fusionen por tener
 * un bajón tolerable entre ellas y que después el recorte decida que cruzar ese
 * bajón no compensaba: sin esta segunda pasada, la subida del final se perdía
 * en vez de quedarse como una subida aparte. Es lo que ocurría con la tercera
 * subida de una carrera de montaña, 200 m de desnivel al 23 % que no aparecían.
 */
function collectRange(track, lo, hi, ext, o, out, depth) {
  if (depth > 5 || hi - lo < 2) return;

  // --- 2. Valle → cima dentro del rango, y fusión de las separadas por un
  //        bajón pequeño en relación al desnivel total ---
  let climbs = [];
  for (let i = 0; i < ext.length - 1; i++) {
    if (ext[i].type === 'min' && ext[i + 1].type === 'max'
        && ext[i].idx >= lo && ext[i + 1].idx <= hi)
      climbs.push({ from: ext[i].idx, to: ext[i + 1].idx });
  }
  if (!climbs.length) return;

  const { ele, cum } = track;
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < climbs.length - 1; i++) {
      const a = climbs[i], b = climbs[i + 1];
      const dip = ele[a.to] - ele[b.from];    // lo que se baja entre las dos
      const gain = ele[b.to] - ele[a.from];   // desnivel si se fusionan
      const length = cum[b.to] - cum[a.from];
      if (gain <= 0 || length <= 0) continue;
      if (dip <= o.mergeDrop * gain && gain / length >= o.minGrade) {
        climbs.splice(i, 2, { from: a.from, to: b.to });
        merged = true;
        break;
      }
    }
  }

  // --- 3. Recortar los extremos llanos y rescatar lo descartado ---
  for (const c of climbs) {
    const t = trimFlatEnds(track, c.from, c.to, o.minGrade);
    if (t.to > t.from) out.push(t);
    if (t.from - c.from > 2) collectRange(track, c.from, t.from, ext, o, out, depth + 1);
    if (c.to - t.to > 2) collectRange(track, t.to, c.to, ext, o, out, depth + 1);
  }
}

/**
 * Quita el llano de los extremos de una subida.
 *
 * El valle detectado cae al principio de una zona plana, no donde empieza a
 * empinarse, y eso alarga la subida y hunde su pendiente media. Nos quedamos
 * con el tramo que maximiza `desnivel − minGrade × longitud`: es el subtramo
 * cuya pendiente supera el mínimo por más margen, así que descarta los bordes
 * planos y conserva los descansos de en medio.
 */
function trimFlatEnds(track, from, to, minGrade) {
  const { ele, cum } = track;
  let best = -Infinity, bestFrom = from, bestTo = from;
  let cur = 0, curFrom = from;
  for (let i = from; i < to; i++) {
    const v = ele[i + 1] - ele[i] - minGrade * (cum[i + 1] - cum[i]);
    if (cur <= 0) { cur = v; curFrom = i; } else cur += v;
    if (cur > best) { best = cur; bestFrom = curFrom; bestTo = i + 1; }
  }
  return best > 0 ? { from: bestFrom, to: bestTo } : { from, to };
}

// Pendiente del tramo de ~100 m más duro dentro de la subida. Da una idea de si
// la media esconde una rampa fuerte.
function steepestStretch(track, from, to, window = 100) {
  const { ele, cum } = track;
  let worst = 0;
  let j = from;
  for (let i = from; i < to; i++) {
    if (j < i) j = i;
    while (j < to && cum[j] - cum[i] < window) j++;
    const d = cum[j] - cum[i];
    if (d <= 0) continue;
    const g = (ele[j] - ele[i]) / d;
    if (g > worst) worst = g;
  }
  return worst;
}
