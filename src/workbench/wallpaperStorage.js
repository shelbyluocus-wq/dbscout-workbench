// Only small settings/revision metadata goes in localStorage. IndexedDB owns
// one custom ArrayBuffer plus MIME metadata (WebKit cannot reliably persist
// Blob/File records). The public API still uses Blobs. Its transaction serializes writers
// across windows (including engines without Web Locks).
export const WALLPAPER_STORAGE_KEY = "dbscout.wallpaper.v1";
export const WALLPAPER_DATABASE = "dbscout-wallpaper-v1";
const STORE = "wallpaper";
const CUSTOM = "custom";

export function wallpaperError(code) {
  return new Error(`wallpaper.error.${code}`);
}

export function createWallpaperStorage({
  getLocalStorage = () => globalThis.localStorage,
  getIndexedDB = () => globalThis.indexedDB,
} = {}) {
  let databasePromise;
  let closed = false;

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
    return { blob: new Blob([record.bytes], { type: record.mime }), kind: record.kind, revision: record.revision };
  }

  async function transaction(change, candidate) {
    // Blob reads must finish BEFORE opening the IDB transaction. Awaiting them
    // inside a request handler lets WebKit auto-commit an inactive transaction.
    let encoded;
    if (candidate) {
      try {
        encoded = {
          bytes: await candidate.blob.arrayBuffer(), mime: candidate.blob.type,
          kind: candidate.kind, revision: candidate.revision,
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
        tx.oncomplete = () => resolve(result);
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
        const request = store.get(CUSTOM);
        request.onsuccess = () => {
          try {
            oldRaw = local.getItem(WALLPAPER_STORAGE_KEY);
            let metadata = null;
            if (oldRaw !== null) {
              try { metadata = JSON.parse(oldRaw); }
              catch { throw wallpaperError("settings"); }
            }
            const current = { metadata, custom: restoreCustom(request.result) };
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
            if (result.custom !== current.custom) {
              // New custom media must be supplied as mutate's second argument
              // so its bytes can be prepared outside this synchronous callback.
              if (result.custom && result.custom !== candidate) throw wallpaperError("storage");
              const write = result.custom ? store.put(encoded, CUSTOM) : store.delete(CUSTOM);
              write.onsuccess = publish;
            } else publish();
          } catch (error) {
            failure = error?.message?.startsWith("wallpaper.error.") ? error : wallpaperError("storage");
            tx.abort();
          }
        };
      } catch {
        if (tx) tx.abort();
        else reject(wallpaperError("storage"));
      }
    });
  }

  return {
    read: () => transaction(),
    mutate: (change, candidate) => transaction(change, candidate),
    close() {
      closed = true;
      databasePromise?.then((db) => db.close()).catch(() => {});
    },
  };
}
