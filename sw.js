// Service worker: la app funciona sin conexión y guarda los tiles ya vistos.
const VERSION = 'v1';
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
      .then((c) => c.addAll(SHELL_FILES))
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

  // App shell: caché primero, revalidando en segundo plano.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(request, { ignoreSearch: true });
    const network = fetch(request)
      .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
      .catch(() => null);
    return hit || (await network) || cache.match('index.html');
  })());
});
