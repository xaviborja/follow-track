// Service worker: la app funciona sin conexión y guarda los tiles ya vistos.
//
// Los ficheros de la app van por red primero y la caché es solo la red de
// seguridad para cuando no hay cobertura. Servirlos desde caché primero fue un
// error: cada fichero se refrescaba por su cuenta y la app acababa mezclando
// versiones (un HTML nuevo con un JavaScript viejo, con botones que no hacían
// nada). Pesan unos 35 KB entre todos, así que pedirlos a la red no se nota, y
// a cambio nunca hay dos versiones conviviendo.
const VERSION = 'v5';
const SHELL = `ft-shell-${VERSION}`;
const TILES = `ft-tiles-${VERSION}`;
const TILE_LIMIT = 1200; // ~30-60 MB según zona

const SHELL_FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/geo.js',
  'js/parse.js',
  'js/climbs.js',
  'js/profile.js',
  'manifest.webmanifest',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      // cache: 'reload' evita que la precarga se sirva de la caché HTTP del
      // navegador: GitHub Pages manda max-age=600 y, sin esto, una instalación
      // nueva puede guardar ficheros de hasta diez minutos antes.
      .then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  // FIFO: borramos los más antiguos (las claves salen en orden de inserción).
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Tiles del mapa: primero caché, y si no está, red (guardando copia).
  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok) { cache.put(request, res.clone()); trimTiles(); }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  // Ficheros de la app: red primero, caché como respaldo sin cobertura.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      // cache: 'no-cache' obliga a revalidar contra el servidor. Sin esto la
      // caché HTTP del navegador sigue devolviendo la versión anterior hasta
      // que expira el max-age (600 s en GitHub Pages) y la actualización
      // aparece cuando le apetece. Con ETag, revalidar cuesta un 304.
      const res = await fetch(new Request(request.url, {
        cache: 'no-cache',
        credentials: 'same-origin',
      }));
      if (res.ok) cache.put(request, res.clone());
      return res;
    } catch {
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      // Sin red y sin copia: si es una navegación, servimos la app entera.
      if (request.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      return new Response('', { status: 504, statusText: 'Sin conexión' });
    }
  })());
});
