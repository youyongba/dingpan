self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', event => {
  // 直接放行所有网络请求，绝不缓存，确保不会影响任何原有的实时数据功能
  event.respondWith(fetch(event.request));
});// version 2 - cache busting
// version 3 - cache busting
