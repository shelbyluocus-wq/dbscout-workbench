import { CONNECTION_KINDS, normalizeConnectionKind } from "./connectionKinds.js";

// A saved connection is identified by kind, address and user. Runtime ids
// (`mysql-3`) are handed out in restore order and can shift when a server is
// unreachable at startup, so settings that must survive that use this key.
export function savedConnectionKey(connection) {
  const kind = normalizeConnectionKind(connection?.kind);
  const defaultUser = CONNECTION_KINDS[kind].defaultUser;
  return [kind, connection?.host, connection?.port, connection?.username || defaultUser]
    .map((part) => String(part ?? "").trim())
    .join(":");
}

function hasSavedAddress(connection) {
  const host = String(connection?.host || "").trim();
  return Boolean(connection?.saved && host && host !== "configured");
}

// Stable identity of a sidebar connection: its saved address when it has one,
// otherwise its runtime id (connections configured outside the app).
export function connectionIdentityKey(connection) {
  if (!connection) return "";
  if (hasSavedAddress(connection)) return `saved:${savedConnectionKey(connection)}`;
  const id = String(connection.id || "").trim();
  return id ? `id:${id}` : "";
}
