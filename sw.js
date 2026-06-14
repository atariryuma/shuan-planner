/* 週案プランナー Service Worker
 * 戦略: 同一オリジンのGETは stale-while-revalidate(キャッシュ即返し+裏で更新)。
 * ファイルを更新したら VERSION を必ず上げること(上げないと旧キャッシュが配信され続ける)。
 */
const VERSION = 'v2.38.0';
const CACHE = `shuan-planner-${VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/print.css',
  './js/app.js',
  './js/store.js',
  './js/standards.js',
  './js/utils.js',
  './js/ui.js',
  './js/csv.js',
  './js/gas.js',
  './js/gws.js',
  './js/holidays.js',
  './js/print.js',
  './js/print-hours.js',
  './js/views/week.js',
  './js/views/onboarding.js',
  './js/views/plans.js',
  './js/views/stats.js',
  './js/views/settings.js',
  './js/views/data.js',
  './docs/gas-setup.html',
  './icons/icon.svg',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    // cache:'reload' でHTTPキャッシュを介さずネットワークから取得する
    // (VERSIONを上げたのに旧資産がprecacheされる事故を防ぐ)
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('shuan-planner-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin) return; // GAS等の外部リクエストは素通し
  ev.respondWith(
    caches.open(CACHE).then((cache) => {
      return cache.match(ev.request).then((cached) => {
        const fetching = fetch(ev.request)
          .then(res => {
            if (res.ok) cache.put(ev.request, res.clone());
            return res;
          })
          .catch(() => cached);
        // 応答返却後もSWを生かして裏側のキャッシュ更新を完了させる
        ev.waitUntil(fetching.catch(() => {}));
        return cached || fetching;
      });
    })
  );
});
