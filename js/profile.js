import { valueAtDistance } from './geo.js';

// Perfil de elevación: una sola serie (altitud frente a distancia) dibujada en
// canvas. Se parte en dos tonos por el punto donde estás, con los mismos colores
// que el track del mapa: azul lo recorrido, naranja lo que falta.
//
// Los pasos son los de superficie oscura, porque el perfil vive sobre el panel;
// el mapa usa los pasos claros del mismo par de tonos, sobre los tiles.
const DONE = '#3987e5';
const PENDING = '#d95926';
const SURFACE = '#111922';
const GRID = 'rgba(147, 164, 184, 0.22)';
const INK = '#93a4b8';

const PAD = { top: 12, right: 10, bottom: 16, left: 38 };

const fmtM = (v) => `${Math.round(v).toLocaleString('es-ES')} m`;
const fmtKm = (m) => (m < 1000
  ? `${Math.round(m)} m`
  : `${(m / 1000).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`);

export function createProfile(canvas, { onScrub } = {}) {
  const ctx = canvas.getContext('2d');
  let track = null;
  let along = null;   // metros recorridos según el GPS
  let scrub = null;   // metros bajo el dedo, al consultar el perfil
  let climbs = [];
  let selected = -1;
  let w = 0, h = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  const plot = () => ({
    x: PAD.left,
    y: PAD.top,
    w: Math.max(1, w - PAD.left - PAD.right),
    h: Math.max(1, h - PAD.top - PAD.bottom),
  });

  const xOf = (meters) => {
    const p = plot();
    return p.x + (meters / track.total) * p.w;
  };
  const distOf = (px) => {
    const p = plot();
    return Math.max(0, Math.min(track.total, ((px - p.x) / p.w) * track.total));
  };

  // Escala vertical redondeada a múltiplos "limpios", con algo de aire arriba.
  function scaleY() {
    const span = Math.max(20, track.maxEle - track.minEle);
    const step = span > 800 ? 200 : span > 400 ? 100 : span > 150 ? 50 : 20;
    const lo = Math.floor(track.minEle / step) * step;
    const hi = Math.ceil((track.maxEle + span * 0.08) / step) * step;
    const p = plot();
    return {
      lo, hi, step,
      y: (ele) => p.y + p.h - ((ele - lo) / (hi - lo)) * p.h,
    };
  }

  function draw() {
    if (!w && !resize()) return;
    ctx.clearRect(0, 0, w, h);
    if (!track?.hasEle) return;

    const p = plot();
    const sc = scaleY();

    // Rejilla: hairlines sólidas, un paso por encima del fondo.
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = INK;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let e = sc.lo; e <= sc.hi; e += sc.step) {
      const y = Math.round(sc.y(e)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p.x, y);
      ctx.lineTo(p.x + p.w, y);
      ctx.stroke();
      ctx.fillText(String(e), p.x - 6, y);
    }

    // Bandas de las subidas: son una anotación sobre la serie, no otra serie,
    // así que van en tinta neutra y por debajo de la línea.
    climbs.forEach((c, i) => {
      const x0 = xOf(c.startDist);
      const x1 = xOf(c.endDist);
      ctx.fillStyle = i === selected ? 'rgba(232, 238, 245, 0.16)' : 'rgba(232, 238, 245, 0.07)';
      ctx.fillRect(x0, p.y, Math.max(1, x1 - x0), p.h);
      if (i === selected) {
        ctx.strokeStyle = 'rgba(232, 238, 245, 0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) + 0.5, p.y + 0.5, Math.max(1, x1 - x0), p.h - 1);
      }
      // Número de la subida, solo si la banda tiene sitio para él.
      if (x1 - x0 >= 16) {
        ctx.fillStyle = INK;
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(String(i + 1), (x0 + x1) / 2, p.y + 2);
      }
    });

    // Muestreamos una altitud por columna de píxel.
    const cols = Math.round(p.w);
    const pts = new Array(cols + 1);
    for (let i = 0; i <= cols; i++) {
      const d = (i / cols) * track.total;
      pts[i] = { x: p.x + i, y: sc.y(valueAtDistance(track, track.ele, d)) };
    }

    const splitX = along === null ? p.x : xOf(along);
    const paint = (from, to, color) => {
      if (to <= from) return;
      const a = Math.max(0, Math.floor(from - p.x));
      const b = Math.min(cols, Math.ceil(to - p.x));
      if (b <= a) return;

      ctx.save();
      ctx.beginPath();
      ctx.rect(from, p.y - PAD.top, to - from, h);
      ctx.clip();

      // Relleno: lavado al 10 %, nunca un bloque saturado.
      ctx.beginPath();
      ctx.moveTo(pts[a].x, p.y + p.h);
      for (let i = a; i <= b; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[b].x, p.y + p.h);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.1;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Línea de 2 px, uniones redondeadas.
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      for (let i = a; i <= b; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    };

    paint(p.x, splitX, DONE);
    paint(splitX, p.x + p.w, PENDING);

    // Etiquetas del eje X: solo los extremos, que el resto lo da el tooltip.
    ctx.fillStyle = INK;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText('0', p.x, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText(fmtKm(track.total), p.x + p.w, h - 4);

    // Punto donde estás: 10 px de diámetro con anillo del color del panel.
    if (along !== null) {
      const y = sc.y(valueAtDistance(track, track.ele, along));
      ctx.beginPath();
      ctx.arc(splitX, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = DONE;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = SURFACE;
      ctx.stroke();
    }

    if (scrub !== null) drawScrub(p, sc);
  }

  // Consulta: línea vertical, punto y etiqueta con distancia y altitud.
  function drawScrub(p, sc) {
    const x = xOf(scrub);
    const ele = valueAtDistance(track, track.ele, scrub);
    const y = sc.y(ele);

    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, p.y);
    ctx.lineTo(Math.round(x) + 0.5, p.y + p.h);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = scrub <= (along ?? -1) ? DONE : PENDING;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = SURFACE;
    ctx.stroke();

    const text = `${fmtKm(scrub)} · ${fmtM(ele)}`;
    ctx.font = '11px system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    const bx = Math.min(Math.max(x - tw / 2 - 6, p.x), p.x + p.w - tw - 12);
    ctx.fillStyle = 'rgba(7, 14, 20, 0.92)';
    ctx.beginPath();
    ctx.roundRect(bx, 0, tw + 12, 18, 5);
    ctx.fill();
    ctx.fillStyle = '#e8eef5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 6, 9);
  }

  // --- interacción ---
  let dragging = false;
  const pointerDist = (e) => distOf(e.clientX - canvas.getBoundingClientRect().left);

  canvas.addEventListener('pointerdown', (e) => {
    if (!track?.hasEle) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    scrub = pointerDist(e);
    onScrub?.(scrub);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    scrub = pointerDist(e);
    onScrub?.(scrub);
    draw();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    scrub = null;
    onScrub?.(null);
    draw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);

  const ro = new ResizeObserver(() => { resize(); draw(); });
  ro.observe(canvas);

  return {
    setTrack(t) { track = t; along = null; scrub = null; climbs = []; selected = -1; resize(); draw(); },
    setPosition(meters) { along = meters; draw(); },
    setClimbs(list) { climbs = list || []; selected = -1; draw(); },
    setSelected(i) { selected = i; draw(); },
    redraw() { resize(); draw(); },
  };
}
