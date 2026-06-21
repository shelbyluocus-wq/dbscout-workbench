export function isDemoConnection(connection) {
  const id = String(connection?.id || "");
  return id === "demo" || id.startsWith("demo-");
}

export function isRealConnection(connection) {
  return !isDemoConnection(connection);
}

export function filterVisibleConnections(connections) {
  const list = Array.isArray(connections) ? connections : [];
  const hasReal = list.some((item) => isRealConnection(item));
  if (!hasReal) return list;
  return list.filter((item) => isRealConnection(item));
}