/* 週案プランナー Service Worker
 * 戦略: 版ごとのキャッシュに precache し、同一オリジンGETは cache-first で配信する。
 *   - 1回の表示は必ず同じ版のファイル群になる(ESモジュールの版混在=skewを防ぐ)。
 *   - 更新は VERSION を上げる→新SWが新キャッシュをprecache→activateでclaim。
 *     ページ側(app.js)は controllerchange を検知して1回だけreloadし、全モジュールを
 *     新版で読み直す(古いモジュールに新しい動的importがぶつかる事故を防ぐ)。
 * ファイルを更新したら VERSION を必ず上げること。
 */
const VERSION = 'v2.75.0';
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
  // cache-first: この版のキャッシュにあれば必ずそれを返す(裏更新で版が混ざらない)。
  // 無いものだけネットワークから取り、この版のキャッシュに足す。更新はVERSION昇格で行う。
  ev.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(ev.request).then((cached) => {
        if (cached) return cached;
        return fetch(ev.request).then((res) => {
          if (res.ok) cache.put(ev.request, res.clone());
          return res;
        }).catch(async () => {
          // オフライン等でネットワーク取得に失敗したとき:
          //  - ページ遷移(navigate)は必ず index.html を返してアプリを起動させる。
          //    SPAなので index さえ出れば全画面が描画でき、precache漏れ1件で白画面にならない。
          //  - それ以外(未キャッシュの資産)は代替が無いので 503 を返す(白画面より無害)。
          if (ev.request.mode === 'navigate') {
            return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
          }
          return new Response('', { status: 503, statusText: 'offline' });
        });
      })
    )
  );
});
