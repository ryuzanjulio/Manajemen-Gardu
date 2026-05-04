// ============================================================
//  sw.js — Service Worker PWA  v8
//  PLN UP3 Jayapura — Monitoring Gardu
//
//  Perubahan v8:
//  - kirimAntrianInspeksi() pakai fetch POST + Content-Type: text/plain
//    agar lolos CORS Apps Script tanpa preflight
//  - Foto ikut dalam satu payload (tidak terpisah lagi)
//  - Notifikasi SYNC_SUCCESS dikirim ke semua tab
// ============================================================

var CACHE_NAME  = 'gardu-pln-v8';
var DB_NAME     = 'gardu-pln-db';
var DB_VERSION  = 1;
var QUEUE_STORE = 'gardu-sync-queue';
var SYNC_TAG    = 'sync-inspeksi';

var APP_SHELL = [
  '/index.html',
  '/manifest.json',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) { return cache.addAll(APP_SHELL); })
      .then(function() { return self.skipWaiting(); })
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k)   { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // POST ke API jangan intercept (ditangani IndexedDB + sync)
  if (event.request.method === 'POST') return;

  // GET ke Apps Script API → network-first, fallback cache
  if (url.includes('script.google.com')) {
    event.respondWith(networkFirstAPI(event.request));
    return;
  }

  // App shell → cache-first
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      return cached || fetch(event.request).then(function(response) {
        if (response.ok && event.request.method === 'GET') {
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, response.clone());
          });
        }
        return response;
      });
    })
  );
});

function networkFirstAPI(request) {
  return fetch(request).then(function(response) {
    if (response.ok) {
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(request, response.clone());
      });
    }
    return response;
  }).catch(function() {
    return caches.match(request).then(function(cached) {
      if (cached) return cached;
      return new Response(
        JSON.stringify({ status: 'offline', message: 'Tidak ada koneksi. Menampilkan data terakhir.' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    });
  });
}

// ── BACKGROUND SYNC ──────────────────────────────────────────
self.addEventListener('sync', function(event) {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(kirimAntrianInspeksi());
  }
});

// ── Kirim semua antrian dari IndexedDB ke Apps Script ────────
function kirimAntrianInspeksi() {
  return bukaDB().then(function(db) {
    return getAllQueue(db).then(function(items) {
      if (!items || !items.length) return;
      // Kirim satu per satu berurutan agar tidak membebani Apps Script
      return items.reduce(function(chain, item) {
        return chain.then(function() { return kirimSatu(db, item); });
      }, Promise.resolve());
    });
  });
}

function kirimSatu(db, item) {
  return fetch(item.apiUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' },
    body:    JSON.stringify(item.payload)
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    if (res.status === 'ok') {
      return hapusQueue(db, item.id).then(function() {
        return self.clients.matchAll({ includeUncontrolled: true }).then(function(clients) {
          clients.forEach(function(c) {
            c.postMessage({
              type:    'SYNC_SUCCESS',
              idGardu: item.payload.idGardu,
              message: '☁️ Inspeksi ' + item.payload.idGardu + ' berhasil dikirim ke server' +
                       (item.payload.foto && item.payload.foto.length
                         ? ' beserta ' + item.payload.foto.length + ' foto.'
                         : '.')
            });
          });
        });
      });
    } else {
      console.log('[SW] Server menolak:', res.message);
    }
  })
  .catch(function(err) {
    console.log('[SW] Gagal kirim (akan retry):', err.message);
  });
}

// ── IndexedDB helpers ─────────────────────────────────────────
function bukaDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

function getAllQueue(db) {
  return new Promise(function(resolve, reject) {
    var req = db.transaction(QUEUE_STORE, 'readonly').objectStore(QUEUE_STORE).getAll();
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

function hapusQueue(db, id) {
  return new Promise(function(resolve, reject) {
    var req = db.transaction(QUEUE_STORE, 'readwrite').objectStore(QUEUE_STORE).delete(id);
    req.onsuccess = function() { resolve(); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

// ── MESSAGE dari halaman ──────────────────────────────────────
self.addEventListener('message', function(event) {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data.type === 'SYNC_NOW')     kirimAntrianInspeksi();
});
