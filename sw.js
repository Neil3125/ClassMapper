// Offline support.
//
// App shell + building data are precached and served cache-first.
// Map tiles are cached as you view them, so ground you've already walked
// still renders with no signal. API calls are never cached.

const VERSION = 'v1';
const SHELL = `classmapper-shell-${VERSION}`;
const TILES = `classmapper-tiles-${VERSION}`;
const TILE_LIMIT = 600;

const SHELL_FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/buildings.js',
  'js/schedule.js',
  'js/route.js',
  'js/map.js',
  'js/ocr.js',
  'js/notify.js',
  'data/buildings.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then(async (cache) => {
      // addAll fails the whole install if one file 404s; add individually so a
      // missing optional asset can't brick the app.
      await Promise.all(
        SHELL_FILES.map((file) => cache.add(new Request(file, { cache: 'reload' })).catch(() => {})),
      );
      await self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isTile(url) {
  return url.hostname === 'tile.openstreetmap.org' || url.hostname === 'server.arcgisonline.com';
}

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache the AI or routing calls.
  if (url.hostname === 'generativelanguage.googleapis.com' || url.hostname === 'valhalla1.openstreetmap.de') {
    return;
  }

  if (isTile(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILES);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) {
            await cache.put(request, res.clone());
            trimTiles();
          }
          return res;
        } catch {
          return new Response('', { status: 504, statusText: 'Tile unavailable offline' });
        }
      })(),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(request, { ignoreSearch: true });

      // Cache-first, but refresh in the background so edits show up next load.
      const network = fetch(request)
        .then(async (res) => {
          if (res.ok) await cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);

      if (hit) return hit;

      const res = await network;
      if (res) return res;

      if (request.mode === 'navigate') {
        return (await cache.match('index.html')) ?? new Response('Offline', { status: 503 });
      }
      return new Response('Offline', { status: 503 });
    })(),
  );
});
