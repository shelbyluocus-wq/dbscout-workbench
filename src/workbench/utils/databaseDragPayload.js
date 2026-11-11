import { ref } from "vue";

export const DATABASE_DRAG_MIME = "application/x-dbscout-database";

export const activeDatabaseDrag = ref(null);

export function beginDatabaseDrag(event, { connectionId, database } = {}) {
  const payload = {
    connectionId: String(connectionId || ""),
    database: String(database || ""),
  };
  if (event?.dataTransfer) {
    event.dataTransfer.effectAllowed = "copyMove";
    try {
      event.dataTransfer.setData(DATABASE_DRAG_MIME, JSON.stringify(payload));
    } catch {
    }
  }
  activeDatabaseDrag.value = payload;
}

export function endDatabaseDrag() {
  activeDatabaseDrag.value = null;
}

export function readDatabaseDrop(event) {
  try {
    const raw = event?.dataTransfer?.getData?.(DATABASE_DRAG_MIME);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.database) {
        return {
          connectionId: String(parsed.connectionId || ""),
          database: String(parsed.database),
        };
      }
    }
  } catch {
  }
  return activeDatabaseDrag.value;
}
