// 오프라인에서도 화면이 열리도록 정적 파일 캐시 (지도 타일·주소검색은 인터넷 필요)
const CACHE = "pestwatch-v6";
const FILES = ["./", "index.html", "style.css", "app.js", "pests.js", "manifest.webmanifest", "icon-192.png",
  "ai.js", "rda.js", "leafmodel.js", "vendor/tf.min.js", "model/model.json", "model/group1-shard1of4.bin", "model/group1-shard2of4.bin", "model/group1-shard3of4.bin", "model/group1-shard4of4.bin", "maps.js", "symptoms.js", "vendor/genai.js", "vendor/anthropic.js", "fonts/PretendardVariable.woff2", "leaflet/leaflet.js", "leaflet/leaflet.css", "leaflet/images/marker-icon.png", "leaflet/images/marker-icon-2x.png", "leaflet/images/marker-shadow.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;
  // 네트워크 우선, 실패 시 캐시
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
