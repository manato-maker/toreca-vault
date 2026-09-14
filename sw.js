const CACHE='toreca-vault-v10';
const ASSETS=['./','./index.html','./styles.css','./js/app.js','./js/remote-sync.js','./js/schema.js','./js/storage.js','./js/calculations.js','./js/inventory.js','./market-update.json','./manifest.webmanifest','./assets/icon.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response}).catch(()=>caches.match(event.request)))})
