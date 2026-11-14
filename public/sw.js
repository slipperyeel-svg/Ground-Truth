/*
 * Service worker: keeps the app working without signal once it has been used.
 *  - The page itself (index.html): fetched from the network first, so an
 *    update shows straight away; the saved copy is used only without signal.
 *    (Serving the saved page first broke the app after an update: it pointed
 *    at script and style files that the new deploy had removed.)
 *  - Other app files: their names change with every build, so they are
 *    served from cache when we have them and kept when fetched.
 *  - Elevation tiles, map tiles and fonts: served from cache if we have them,
 *    otherwise fetched and kept. So any ground you have loaded (and any map
 *    you have looked at) is available offline afterwards.
 * Bump VERSION to clear old caches after a change to this file.
 */
const VERSION = 'v3';
const SHELL = `gt-shell-${VERSION}`;
const TILES = `gt-tiles-${VERSION}`;
// OS tiles (api.os.uk) are deliberately NOT cached until we have checked
// whether the OS licence allows it — see DECISIONS.md.
const TILE_HOSTS = ['s3.amazonaws.com', 'tile.openstreetmap.org', 'tiles.openfreemap.org'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('gt-') && ![SHELL, TILES].includes(k)).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    // Cache first: tiles do not change.
    event.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          // Offline and not cached: answer quietly rather than with an error.
          return new Response('', { status: 504, statusText: 'Offline' });
        }
      }),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        if (isPage) {
          // Network first for the page, so updates appear at once.
          try {
            const res = await fetch(req, { cache: 'no-cache' });
            if (res.ok) cache.put('./index.html', res.clone());
            return res;
          } catch {
            return (await cache.match('./index.html')) ?? new Response('Offline', { status: 503 });
          }
        }
        // Cache first for everything else (file names change with each build).
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
  }
});
