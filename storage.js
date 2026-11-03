/* IndexedDB persistence layer for Controle de Despesas.
   Keeps the existing synchronous LS.get/LS.set API through an in-memory cache.
   IndexedDB is the canonical store; localStorage is read once for migration. */
(() => {
  'use strict';

  const DB_NAME = 'controle-despesas';
  const DB_VERSION = 1;
  const STORE = 'kv';
  const MIGRATION_FLAG = '__idb_migrated_v1__';
  const cache = Object.create(null);
  let db = null;
  let writeChain = Promise.resolve();

  function showStorageError(message, error) {
    console.error('[Armazenamento]', message, error || '');
    const render = () => {
      let box = document.getElementById('storageError');
      if (!box) {
        box = document.createElement('div');
        box.id = 'storageError';
        box.setAttribute('role', 'alert');
        box.style.cssText = 'position:fixed;left:10px;right:10px;top:10px;z-index:9999;background:#7f1d1d;color:#fff;border-radius:12px;padding:12px 14px;font:14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)';
        document.body.appendChild(box);
      }
      box.textContent = message;
    };
    if (document.body) render(); else document.addEventListener('DOMContentLoaded', render, {once:true});
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Falha no IndexedDB'));
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Falha na transacao do IndexedDB'));
      tx.onabort = () => reject(tx.error || new Error('Transacao do IndexedDB cancelada'));
    });
  }

  async function openDatabase() {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    return request(req);
  }

  async function readAll() {
    const tx = db.transaction(STORE, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE);
    const keysRequest = request(store.getAllKeys());
    const valuesRequest = request(store.getAll());
    const [keys, values] = await Promise.all([keysRequest, valuesRequest]);
    keys.forEach((key, index) => { cache[key] = values[index]; });
    await done;
  }

  async function importLegacyLocalStorage() {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return;
    const APP_KEYS = new Set(['cartoes','items2','items','orc','orcDirty','cfgDirty','cats','catsR','lastPag','mig3','auto','url','senha','autoDone','estP','lastCat_despesa','lastCat_receita']);
    const isAppKey = key => APP_KEYS.has(key) || key.startsWith('colap_');
    const rows = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || key === MIGRATION_FLAG || !isAppKey(key)) continue;
      try { rows.push([key, JSON.parse(localStorage.getItem(key))]); }
      catch (error) { console.warn('[Migracao] Chave ignorada:', key, error); }
    }
    if (rows.length) {
      const tx = db.transaction(STORE, 'readwrite');
      const done = transactionDone(tx);
      const store = tx.objectStore(STORE);
      rows.forEach(([key, value]) => {
        cache[key] = value;
        store.put(value, key);
      });
      await done;
    }
    localStorage.setItem(MIGRATION_FLAG, '1');
    // Remove only successfully imported application values. Keep the marker.
    rows.forEach(([key]) => localStorage.removeItem(key));
  }

  function queueWrite(key, value) {
    writeChain = writeChain
      .then(async () => {
        const tx = db.transaction(STORE, 'readwrite');
        const done = transactionDone(tx);
        tx.objectStore(STORE).put(value, key);
        await done;
      })
      .catch(error => showStorageError('Nao foi possivel salvar os dados. Exporte um backup e verifique o armazenamento do navegador.', error));
    return writeChain;
  }

  window.LS = {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : fallback;
    },
    set(key, value) {
      cache[key] = value;
      queueWrite(key, value);
      return true;
    },
    remove(key) {
      delete cache[key];
      writeChain = writeChain.then(async () => {
        const tx = db.transaction(STORE, 'readwrite');
        const done = transactionDone(tx);
        tx.objectStore(STORE).delete(key);
        await done;
      }).catch(error => showStorageError('Nao foi possivel excluir o dado salvo.', error));
    },
    flush() { return writeChain; },
    engine: 'IndexedDB'
  };

  async function boot() {
    if (!('indexedDB' in window)) throw new Error('Este navegador nao oferece IndexedDB.');
    db = await openDatabase();
    await readAll();
    await importLegacyLocalStorage();
    const script = document.createElement('script');
    script.src = 'app.js';
    script.defer = false;
    script.onerror = () => showStorageError('Nao foi possivel carregar o aplicativo.');
    document.body.appendChild(script);
  }

  boot().catch(error => showStorageError('Falha ao abrir o banco local. Seus dados anteriores nao foram apagados.', error));
})();
