// Only small settings/revision metadata goes in localStorage. IndexedDB owns
// custom ArrayBuffers plus a small library index (WebKit cannot reliably persist
// Blob/File records). The public API uses { metadata, customs: [{ id, name,
// blob, kind, revision }] }. Its transaction serializes writers
// across windows (including engines without Web Locks).
export const WALLPAPER_STORAGE_KEY = "dbscout.wallpaper.v1";
export const WALLPAPER_DATABASE = "dbscout-wallpaper-v1";
const STORE = "wallpaper";
const CUSTOM = "custom";
const LIBRARY = "library";

export function wallpaperError(code) {
  return new Error(`wallpaper.error.${code}`);
}

export function createWallpaperStorage({
  getLocalStorage = () => globalThis.localStorage,
  getIndexedDB = () => globalThis.indexedDB,
} = {}) {
  let databasePromise;
  let closed = false;
  const cache = new Map();

  function open() {
    if (closed) return Promise.reject(wallpaperError("storage"));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        let request;
        try {
          request = getIndexedDB().open(WALLPAPER_DATABASE, 1);
        } catch {
          reject(wallpaperError("storage"));
          return;
        }
        let failed = false;
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) {
            request.result.createObjectStore(STORE);
          }
        };
        request.onerror = request.onblocked = () => {
          failed = true;
          reject(wallpaperError("storage"));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (failed || closed) {
            db.close();
            reject(wallpaperError("storage"));
            return;
          }
          db.onversionchange = () => {
            db.close();
            databasePromise = undefined;
          };
          resolve(db);
        };
      }).catch((error) => {
        databasePromise = undefined;
        throw error;
      });
    }
    return databasePromise;
  }

  function restoreCustom(record) {
    if (!record) return null;
    // Read earlier Blob records without a destructive database migration.
    if (record.blob instanceof Blob) return record;
    if (!(record.bytes instanceof ArrayBuffer) || typeof record.mime !== "string") {
      throw wallpaperError("storage");
    }
    const { bytes, mime, ...metadata } = record;
    return { ...metadata, blob: new Blob([bytes], { type: mime }) };
  }

  async function transaction(change, candidate) {
    // Blob reads must finish BEFORE opening the IDB transaction. Awaiting them
    // inside a request handler lets WebKit auto-commit an inactive transaction.
    let encoded;
    if (candidate) {
      try {
        encoded = {
          bytes: await candidate.blob.arrayBuffer(), mime: candidate.blob.type,
          id: candidate.id, name: candidate.name, kind: candidate.kind, revision: candidate.revision,
        };
      } catch { throw wallpaperError("storage"); }
    }
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      let local;
      let oldRaw;
      let publishedRaw;
      let result;
      let failure;
      try {
        local = getLocalStorage();
        tx = db.transaction(STORE, change ? "readwrite" : "readonly");
        const store = tx.objectStore(STORE);
        tx.oncomplete = () => {
          if (result && !closed) {
            cache.clear();
            for (const custom of result.customs) cache.set(custom.id, custom);
          }
          resolve(result);
        };
        tx.onabort = () => {
          // setItem failure is atomic. If a later IDB failure follows a
          // successful setItem, restore only our own publication.
          try {
            if (publishedRaw !== undefined && local.getItem(WALLPAPER_STORAGE_KEY) === publishedRaw) {
              if (oldRaw === null) local.removeItem(WALLPAPER_STORAGE_KEY);
              else local.setItem(WALLPAPER_STORAGE_KEY, oldRaw);
            }
          } catch {
            failure = wallpaperError("storage");
          }
          reject(failure || wallpaperError("storage"));
        };
        tx.onerror = () => { failure ||= wallpaperError("storage"); };
        const request = store.get(LIBRARY);
        request.onsuccess = () => {
          // Missing index means the original single-file format. Read it under
          // its existing key; the first library edit writes an index, not a copy
          // of the legacy media. Cache hits avoid reading large bytes on sliders.
          if (request.result === undefined) {
            const legacy = store.get(CUSTOM);
            legacy.onsuccess = () => {
              try {
                const record = restoreCustom(legacy.result);
                finish(record ? [{ ...record, id: CUSTOM, name: record.name || record.blob.name || "" }] : []);
              } catch (error) { abort(error); }
            };
            return;
          }
          const entries = request.result;
          if (!Array.isArray(entries) || entries.some((entry) => !entry
            || !/^custom(?:-[a-zA-Z0-9-]+)?$/.test(entry.id) || typeof entry.revision !== "string")
            || new Set(entries.map(({ id }) => id)).size !== entries.length) {
            abort(wallpaperError("storage")); return;
          }
          const customs = new Array(entries.length);
          let remaining = entries.length;
          if (!remaining) finish(customs);
          entries.forEach((entry, index) => {
            const cached = cache.get(entry.id);
            if (cached && cached.revision === entry.revision) {
              customs[index] = { ...cached, ...entry };
              if (!--remaining) finish(customs);
              return;
            }
            const read = store.get(entry.id);
            read.onsuccess = () => {
              try {
                const record = restoreCustom(read.result);
                if (!record) throw wallpaperError("customMissing");
                customs[index] = { ...record, ...entry };
                if (!--remaining) finish(customs);
              } catch (error) { abort(error); }
            };
          });
        };
        const abort = (error) => {
          failure = error?.message?.startsWith("wallpaper.error.") ? error : wallpaperError("storage");
          tx.abort();
        };
        const finish = (customs) => {
          try {
            oldRaw = local.getItem(WALLPAPER_STORAGE_KEY);
            let metadata = null;
            if (oldRaw !== null) {
              try { metadata = JSON.parse(oldRaw); }
              catch { throw wallpaperError("settings"); }
            }
            const current = { metadata, customs };
            if (!change) {
              result = current;
              return;
            }
            // The callback must be synchronous: no decode or Blob reads here.
            result = change(current);
            if (!result) return; // Superseded intent: no writes.
            const publish = () => {
              try {
                const raw = JSON.stringify(result.metadata);
                local.setItem(WALLPAPER_STORAGE_KEY, raw);
                publishedRaw = raw;
              } catch {
                failure = wallpaperError("storage");
                tx.abort();
              }
            };
            const previous = new Map(customs.map((entry) => [entry.id, entry]));
            const retained = new Set();
            let changed = request.result === undefined; // Migrate the index without rewriting legacy bytes.
            for (const entry of result.customs) {
              if (retained.has(entry.id) || !/^custom(?:-[a-zA-Z0-9-]+)?$/.test(entry.id)) {
                throw wallpaperError("storage");
              }
              retained.add(entry.id);
              const old = previous.get(entry.id);
              if (old?.revision === entry.revision) continue;
              // Only the supplied candidate has bytes prepared outside IDB.
              if (entry !== candidate) throw wallpaperError("storage");
              store.put(encoded, entry.id);
              changed = true;
            }
            for (const entry of customs) {
              if (!retained.has(entry.id)) { store.delete(entry.id); changed = true; }
            }
            if (changed) {
              const index = result.customs.map(({ id, name, kind, revision }) => ({ id, name, kind, revision }));
              store.put(index, LIBRARY).onsuccess = publish;
            } else publish();
          } catch (error) { abort(error); }
        };
      } catch {
        if (tx) tx.abort();
        else reject(wallpaperError("storage"));
      }
    });
  }

  // Settings only, without waiting for IndexedDB. Unreadable settings are
  // reported by read(); here they simply yield nothing.
  function peek() {
    try {
      const raw = getLocalStorage().getItem(WALLPAPER_STORAGE_KEY);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return {
    peek,
    read: () => transaction(),
    mutate: (change, candidate) => transaction(change, candidate),
    close() {
      closed = true;
      cache.clear();
      databasePromise?.then((db) => db.close()).catch(() => {});
    },
  };
}
