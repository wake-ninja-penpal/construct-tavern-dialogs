/* «Ветви» — service worker для офлайн-работы.
   Приложение — одиночный /vetvi/index.html со встроенными стилями и кодом,
   поэтому офлайн-оболочка — это он + socket.io-клиент + шрифты.
   Стратегии:
   - документ приложения (/, /vetvi, /vetvi/, /vetvi/index.html): сеть в приоритете,
     при сбое — кэш (обновления не застревают, офлайн страница открывается);
     параметр ?offlinesim=1 принудительно отвечает из кэша (самопроверка офлайна);
   - /vendor/socket.io.min.js: cache-first (статичный вендор);
   - Google Fonts: cache-first с докачкой при первом онлайн-использовании;
   - остальное (/_next/*, polling-запросы сокета, API) не перехватывается. */
var CACHE = 'vetvi-offline-v1';
var CORE = ['/vetvi/index.html', '/vendor/socket.io.min.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(CORE); })
      .catch(function () { /* не блокируем установку — кэш наполнится в runtime */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isFont(u) {
  return u.origin === 'https://fonts.googleapis.com' || u.origin === 'https://fonts.gstatic.com';
}
function isAppPath(p) {
  return p === '/' || p === '/vetvi' || p === '/vetvi/' || p === '/vetvi/index.html';
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  var font = isFont(url);
  var nav = (req.mode === 'navigate');
  if (!font && !nav && url.origin !== location.origin) return;

  /* шрифты: cache-first */
  if (font) {
    e.respondWith(caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        try { if (res && (res.ok || res.type === 'opaque')) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); } } catch (err) {}
        return res;
      }).catch(function () { return caches.match(req); });
    }));
    return;
  }

  /* документ приложения: сеть-first, при сбое — кэш приложения */
  if (nav && isAppPath(url.pathname)) {
    if (url.search.indexOf('offlinesim=1') >= 0) {
      e.respondWith(caches.match('/vetvi/index.html').then(function (hit) {
        return hit || new Response('Офлайн-копия ещё не готова — откройте приложение онлайн один раз.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }));
      return;
    }
    e.respondWith(
      fetch(req).then(function (res) {
        try {
          if (res && res.ok && url.pathname.indexOf('/vetvi') === 0) {
            var cp = res.clone();
            caches.open(CACHE).then(function (c) { c.put('/vetvi/index.html', cp); });
          }
        } catch (err) {}
        return res;
      }).catch(function () {
        return caches.match('/vetvi/index.html').then(function (hit) {
          return hit || new Response('Нет сети и офлайн-копии. Откройте приложение онлайн один раз — дальше оно будет работать и без сети.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        });
      })
    );
    return;
  }

  /* socket.io-клиент: cache-first */
  if (url.origin === location.origin && url.pathname === '/vendor/socket.io.min.js') {
    e.respondWith(caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        try { if (res && res.ok) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); } } catch (err) {}
        return res;
      });
    }));
    return;
  }
});
