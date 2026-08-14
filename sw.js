// Offline support.
//
// Strategy is network-first for the app's own files: whatever is on the server
// always wins, so edits land on the next load. The cache is a fallback for when
// there's no signal, not the source of truth. (An earlier cache-first version
// meant updates never appeared and an emptied cache bricked the app.)
//
// Map tiles are cache-first — they never change and re-downloading them on
// campus wifi is a waste.

const VERSION = 'v6';
const SHELL = `classmapper-shell-${VERSION}`;
const TILES = `classmapper-tiles-${VERSION}`;
const TILE_LIMIT = 600;
const NET_TIMEOUT = 4000;

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
  'js/external.js',
  'js/version.js',
  'data/buildings.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/fonts/barlow-condensed-600.woff2',
  'vendor/fonts/barlow-condensed-700.woff2',
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
    (async () => {
      const cache = await caches.open(SHELL);
      // Add individually: one 404 shouldn't fail the whole install.
      await Promise.all(
        SHELL_FILES.map((f) => cache.add(new Request(f, { cache: 'reload' })).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
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

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  // Lets the page (and the reset screen) confirm which worker is really live.
  if (event.data === 'version' && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION, shell: SHELL });
  }
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

function timeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch the AI or routing calls — route.js does its own caching.
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

      // Network first. `cache: 'no-cache'` forces revalidation so the browser's
      // own HTTP cache can't serve a stale file behind our back.
      let res = null;
      try {
        res = await Promise.race([
          fetch(new Request(request, { cache: 'no-cache' })),
          timeout(NET_TIMEOUT),
        ]);
      } catch {
        res = null;
      }

      if (res && res.ok) {
        cache.put(request, res.clone()).catch(() => {});
        return res;
      }

      // Offline (or the server errored): fall back to whatever we have.
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;

      // A server response we don't want to cache is still better than nothing.
      if (res) return res;

      if (request.mode === 'navigate') {
        const shell = await cache.match('index.html', { ignoreSearch: true });
        if (shell) return shell;
      }
      return new Response('ClassMapper is offline and this file was never cached.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    })(),
  );
});
