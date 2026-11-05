// Tables dragged between lists (the sidebar, a table folder's contents) and
// folders dropped onto folders. One MIME type each, so unrelated drags such
// as tab reordering never land in a folder.
export const TABLE_DRAG_MIME = "application/x-dbscout-tables";
export const FOLDER_DRAG_MIME = "application/x-dbscout-table-folder";

function hasType(event, type) {
  return Array.from(event?.dataTransfer?.types || []).includes(type);
}

export function writeTableDrag(event, { connectionId = "", database = "", tableNames = [] } = {}) {
  const names = [...new Set((Array.isArray(tableNames) ? tableNames : []).map(String).filter(Boolean))];
  if (!event?.dataTransfer || !database || !names.length) return false;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(TABLE_DRAG_MIME, JSON.stringify({ connectionId: String(connectionId || ""), database: String(database), tableNames: names }));
  event.dataTransfer.setData("text/plain", names.join("\n"));
  return true;
}

export function writeFolderDrag(event, folderId) {
  if (!event?.dataTransfer || !folderId) return false;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(FOLDER_DRAG_MIME, String(folderId));
  return true;
}

// During dragover only the types are readable, not the data.
export function isFolderDropCandidate(event) {
  return hasType(event, TABLE_DRAG_MIME) || hasType(event, FOLDER_DRAG_MIME);
}

export function readFolderDrop(event) {
  const folderId = event?.dataTransfer?.getData?.(FOLDER_DRAG_MIME) || "";
  if (folderId) return { kind: "folder", folderId };
  try {
    const parsed = JSON.parse(event?.dataTransfer?.getData?.(TABLE_DRAG_MIME) || "null");
    const tableNames = Array.isArray(parsed?.tableNames) ? parsed.tableNames.map(String).filter(Boolean) : [];
    if (!parsed?.database || !tableNames.length) return null;
    return { kind: "tables", connectionId: String(parsed.connectionId || ""), database: String(parsed.database), tableNames };
  } catch {
    return null;
  }
}
