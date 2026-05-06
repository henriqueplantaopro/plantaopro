// PlantãoPro — Service Worker
// Versão: incrementar aqui para forçar atualização do cache
const CACHE_VERSION = 'plantaopro-v1';
const CACHE_STATIC = 'plantaopro-static-v1';

// Recursos que ficam em cache (funcionam offline)
const STATIC_ASSETS = [
  '/medico/',
  '/medico/index.html',
  '/medico/manifest.json',
  '/medico/icons/icon-192.png',
  '/medico/icons/icon-512.png',
];

// INSTALL — cachear recursos estáticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ACTIVATE — limpar caches antigas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// FETCH — estratégia: Network First para API, Cache First para estáticos
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Supabase e APIs — sempre buscar da rede (dados em tempo real)
  if (url.hostname.includes('supabase.co') || 
      url.hostname.includes('vercel.app') ||
      url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Sem conexão' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Recursos estáticos — Cache First (carrega instantâneo)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cachear novos recursos estáticos
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_STATIC).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('/medico/'));
    })
  );
});

// PUSH — notificações (base para futuro)
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'PlantãoPro', {
      body: data.body || '',
      icon: '/medico/icons/icon-192.png',
      badge: '/medico/icons/icon-96.png',
      tag: data.tag || 'plantaopro',
      data: { url: data.url || '/medico/' },
      actions: data.actions || [],
      requireInteraction: data.requireInteraction || false,
    })
  );
});

// Clicar na notificação — abrir o app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/medico/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('/medico/'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
