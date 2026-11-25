import {
  CONNECTION_KINDS,
  buildConnectionUrl,
  isMongoConnectionString,
  normalizeConnectionKind,
} from "./connectionKinds.js";

const IMPORTABLE_KINDS = new Set(["mysql", "mongodb"]);

export function isNavicatNcxFileName(fileName) {
  return /\.ncx$/i.test(String(fileName || "").trim());
}

export function isImportableNavicatKind(kind) {
  return IMPORTABLE_KINDS.has(normalizeConnectionKind(kind));
}

export function navicatConnectionKey(connection) {
  const kind = normalizeConnectionKind(connection?.kind, connection?.url);
  const defaults = CONNECTION_KINDS[kind];
  const host = String(connection?.host || "").trim();
  const port = String(connection?.port || defaults.defaultPort).trim();
  const username = String(connection?.username ?? "").trim() || defaults.defaultUser;
  return [kind, host, port, username].join(":");
}

export function injectPasswordIntoConnectionUrl(rawUrl, { username = "", password = "" } = {}) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    const trimmedUser = String(username || "").trim();
    if (trimmedUser && !parsed.username) parsed.username = trimmedUser;
    if (parsed.username) {
      parsed.password = String(password ?? "");
    }
    return parsed.toString();
  } catch {
    return text;
  }
}

export function buildImportedConnectionRecord(item, { passwordOverride } = {}) {
  const kind = normalizeConnectionKind(item?.kind, item?.url);
  const defaults = CONNECTION_KINDS[kind];
  const host = String(item?.host || "").trim();
  const port = String(item?.port || defaults.defaultPort).trim() || defaults.defaultPort;
  const username = String(item?.username ?? "").trim() || defaults.defaultUser;
  const hasOverride = passwordOverride !== undefined && passwordOverride !== null;
  const password = hasOverride ? String(passwordOverride) : String(item?.password ?? "");
  const database = String(item?.database || "").trim();
  const alias = String(item?.name || item?.alias || "").trim();

  let url = String(item?.url || "").trim();
  if (url) {
    if (hasOverride || (password && kind === "mongodb")) {
      url = injectPasswordIntoConnectionUrl(url, { username, password });
    }
  } else {
    url = buildConnectionUrl({ kind, host, port, username, password });
  }

  return {
    kind,
    host,
    port,
    username,
    password,
    database,
    alias,
    readOnly: false,
    url,
  };
}

export function hasConnectableCredentials(record) {
  const kind = normalizeConnectionKind(record?.kind, record?.url);
  if (!String(record?.host || "").trim()) return false;
  if (kind === "mongodb") {
    if (isMongoConnectionString(record?.url) || isMongoConnectionString(record?.host)) return true;
    return Boolean(String(record?.port || "").trim());
  }
  return Boolean(
    String(record?.port || "").trim() &&
    String(record?.username || "").trim() &&
    String(record?.password ?? "").length > 0,
  );
}

export function formatNavicatAddress(item) {
  const host = String(item?.host || "").trim();
  const port = String(item?.port || "").trim();
  const username = String(item?.username || "").trim();
  const endpoint = port ? `${host}:${port}` : host;
  return username ? `${username}@${endpoint}` : endpoint;
}

export function annotateNavicatCandidates(candidates = [], existingConnections = [], savedConnections = []) {
  const existingByKey = new Map();
  for (const saved of Array.isArray(savedConnections) ? savedConnections : []) {
    if (!saved?.host || saved.host === "configured") continue;
    existingByKey.set(navicatConnectionKey(saved), { id: "", connected: false });
  }
  for (const conn of Array.isArray(existingConnections) ? existingConnections : []) {
    if (!conn?.host || conn.host === "configured") continue;
    existingByKey.set(navicatConnectionKey(conn), {
      id: String(conn.id || ""),
      connected: Boolean(conn.connected),
    });
  }

  const seenBatchKeys = new Set();
  const result = [];
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const kind = normalizeConnectionKind(raw?.kind, raw?.url);
    if (!IMPORTABLE_KINDS.has(kind)) continue;
    const host = String(raw?.host || "").trim();
    if (!host) continue;
    const key = navicatConnectionKey({ ...raw, kind });
    const existing = existingByKey.get(key) || null;
    const duplicateInBatch = seenBatchKeys.has(key);
    seenBatchKeys.add(key);

    result.push({
      ...raw,
      kind,
      host,
      port: String(raw?.port || CONNECTION_KINDS[kind].defaultPort),
      username: String(raw?.username ?? ""),
      password: String(raw?.password ?? ""),
      database: String(raw?.database || ""),
      url: String(raw?.url || ""),
      warnings: Array.isArray(raw?.warnings) ? [...raw.warnings] : [],
      key,
      addressLabel: formatNavicatAddress(raw),
      alreadyExists: Boolean(existing),
      existingConnectionId: existing?.id || "",
      existingConnected: Boolean(existing?.connected),
      duplicateInBatch,
      defaultSelected: !existing && !duplicateInBatch,
    });
  }
  return result;
}
