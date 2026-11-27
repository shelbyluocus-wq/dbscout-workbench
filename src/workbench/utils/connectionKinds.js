export const CONNECTION_KINDS = {
  mysql: { kind: "mysql", defaultPort: "3306", defaultUser: "root", scheme: "mysql", label: "MySQL" },
  clickhouse: { kind: "clickhouse", defaultPort: "8123", defaultUser: "default", scheme: "http", label: "ClickHouse" },
  mongodb: { kind: "mongodb", defaultPort: "27017", defaultUser: "", scheme: "mongodb", label: "MongoDB" },
};

const MYSQL_CAPABILITIES = {
  gridEdit: true,
  sqlConsole: true,
  tableDesign: true,
  snapshots: true,
  sync: true,
  tableCopy: true,
  import: true,
  findReplace: true,
  renameDrop: true,
  configRelations: true,
};

const CLICKHOUSE_CAPABILITIES = {
  gridEdit: false,
  sqlConsole: true,
  tableDesign: false,
  snapshots: false,
  sync: false,
  tableCopy: false,
  import: false,
  findReplace: false,
  renameDrop: false,
  configRelations: false,
};

const MONGODB_CAPABILITIES = {
  gridEdit: true,
  sqlConsole: false,
  tableDesign: false,
  snapshots: false,
  sync: false,
  tableCopy: false,
  import: false,
  findReplace: false,
  renameDrop: false,
  configRelations: false,
};

export function normalizeConnectionKind(kind, url = "") {
  const raw = String(kind || "").trim().toLowerCase();
  if (raw === "clickhouse" || raw === "click_house" || raw === "ch") return CONNECTION_KINDS.clickhouse.kind;
  if (raw === "mongodb" || raw === "mongo" || raw === "mongodb+srv") return CONNECTION_KINDS.mongodb.kind;
  const source = String(url || "").trim().toLowerCase();
  if (source.startsWith("mongodb://") || source.startsWith("mongodb+srv://")) return CONNECTION_KINDS.mongodb.kind;
  if (source.startsWith("http://") || source.startsWith("https://")) return CONNECTION_KINDS.clickhouse.kind;
  return CONNECTION_KINDS.mysql.kind;
}

export function isReadOnlyKind(kind) {
  return normalizeConnectionKind(kind) === CONNECTION_KINDS.clickhouse.kind;
}

export function connectionCapabilities(kind) {
  const normalized = normalizeConnectionKind(kind);
  if (normalized === CONNECTION_KINDS.clickhouse.kind) return CLICKHOUSE_CAPABILITIES;
  if (normalized === CONNECTION_KINDS.mongodb.kind) return MONGODB_CAPABILITIES;
  return MYSQL_CAPABILITIES;
}

export function connectionHasCapability(kind, name) {
  return Boolean(connectionCapabilities(kind)[name]);
}

export function connectionKindLabel(kind) {
  const normalized = normalizeConnectionKind(kind);
  return CONNECTION_KINDS[normalized]?.label || CONNECTION_KINDS.mysql.label;
}

export function connectionKindBadge(kind) {
  const normalized = normalizeConnectionKind(kind);
  if (normalized === CONNECTION_KINDS.clickhouse.kind) return "CH";
  if (normalized === CONNECTION_KINDS.mongodb.kind) return "Mongo";
  return "MySQL";
}

export function isMongoConnectionString(host) {
  const value = String(host || "").trim().toLowerCase();
  return value.startsWith("mongodb://") || value.startsWith("mongodb+srv://");
}

export function isSupportedConnectionKind(kind) {
  const normalized = normalizeConnectionKind(kind);
  return normalized === "mysql" || normalized === "clickhouse" || normalized === "mongodb";
}

export function isConnFormComplete(dialog) {
  const kind = normalizeConnectionKind(dialog?.kind);
  if (kind === CONNECTION_KINDS.mongodb.kind) {
    if (isMongoConnectionString(dialog?.host)) return true;
    return Boolean(String(dialog?.host || "").trim() && String(dialog?.port || "").trim());
  }
  return Boolean(String(dialog?.host || "").trim() && String(dialog?.port || "").trim() && String(dialog?.username || "").trim());
}

export function isConnTestReady(dialog) {
  if (!isConnFormComplete(dialog)) return false;
  const kind = normalizeConnectionKind(dialog?.kind);
  if (kind === CONNECTION_KINDS.mongodb.kind || kind === CONNECTION_KINDS.clickhouse.kind) return true;
  return Boolean(String(dialog?.password ?? "").length);
}

export function buildConnectionUrl({ kind = "mysql", host, port, username, password }) {
  const normalizedKind = normalizeConnectionKind(kind);
  const trimmedHost = String(host || "").trim();
  if (normalizedKind === CONNECTION_KINDS.mongodb.kind) {
    if (isMongoConnectionString(trimmedHost)) return trimmedHost;
    if (!trimmedHost || !port) return "";
    const user = String(username || "").trim();
    const pass = String(password || "");
    if (user) {
      return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${trimmedHost}:${String(port).trim()}`;
    }
    return `mongodb://${trimmedHost}:${String(port).trim()}`;
  }
  if (!trimmedHost || !port) return "";
  const { defaultUser, scheme } = CONNECTION_KINDS[normalizedKind];
  return `${scheme}://${encodeURIComponent(username || defaultUser)}:${encodeURIComponent(password || "")}@${trimmedHost}:${String(port).trim()}`;
}
