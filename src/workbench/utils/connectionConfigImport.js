const FIELD_ALIASES = {
  kind: [
    "kind",
    "type",
    "driver",
    "engine",
    "dialect",
    "adapter",
    "protocol",
    "dbtype",
    "databasetype",
    "databasekind",
  ],
  host: [
    "host",
    "hostname",
    "hostaddress",
    "address",
    "server",
    "serverhost",
    "ip",
    "dbhost",
    "databasehost",
    "mysqlhost",
    "clickhousehost",
    "mongodbhost",
    "mongohost",
  ],
  port: [
    "port",
    "serverport",
    "dbport",
    "databaseport",
    "mysqlport",
    "clickhouseport",
    "mongodbport",
    "mongoport",
  ],
  username: [
    "user",
    "username",
    "userid",
    "userlogin",
    "login",
    "dbuser",
    "dbusername",
    "databaseuser",
    "databaseusername",
    "mysqluser",
    "mysqlusername",
    "clickhouseuser",
    "clickhouseusername",
    "mongodbuser",
    "mongodbusername",
    "mongouser",
  ],
  password: [
    "password",
    "pass",
    "passwd",
    "pwd",
    "secret",
    "dbpassword",
    "dbpass",
    "dbpasswd",
    "databasepassword",
    "mysqlpassword",
    "mysqlpass",
    "clickhousepassword",
    "clickhousepass",
    "mongodbpassword",
    "mongopassword",
  ],
  database: [
    "database",
    "databasename",
    "dbname",
    "db",
    "schema",
    "schemaname",
    "catalog",
    "initialdatabase",
    "mysqldatabase",
    "clickhousedatabase",
    "mongodbdatabase",
    "mongodatabase",
  ],
  url: [
    "url",
    "uri",
    "dsn",
    "connectionurl",
    "connectionuri",
    "connectionstring",
    "jdbcurl",
    "mysqlurl",
    "clickhouseurl",
    "mongodburl",
    "mongourl",
    "databaseurl",
  ],
};

const ALIAS_BY_KEY = Object.entries(FIELD_ALIASES).reduce((map, [field, aliases]) => {
  for (const alias of aliases) map.set(normalizeKey(alias), field);
  return map;
}, new Map());

function normalizeKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeKind(value, fallback = "mysql") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.includes("clickhouse") || raw === "ch") return "clickhouse";
  if (raw.includes("mongodb") || raw === "mongo" || raw === "mongodb+srv") return "mongodb";
  if (raw.includes("mysql") || raw.includes("mariadb")) return "mysql";
  if (raw === "http" || raw === "https") return fallback;
  return fallback;
}

function cleanValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return "";
}

function parseConnectionUrl(rawUrl, fieldName = "") {
  let text = cleanValue(rawUrl);
  if (!text) return null;
  if (/^jdbc:/i.test(text)) text = text.replace(/^jdbc:/i, "");
  const kindHint = normalizeKind(fieldName, "");
  try {
    const parsed = new URL(text);
    const protocol = parsed.protocol.replace(/:$/, "");
    const kindFallback = protocol === "http" || protocol === "https"
      ? "clickhouse"
      : protocol === "mongodb" || protocol === "mongodb+srv"
        ? "mongodb"
        : "mysql";
    const kind = normalizeKind(kindHint || protocol, kindFallback);
    const database = decodeURIComponent(parsed.pathname || "").replace(/^\/+/, "").split("/")[0] || "";
    return compactConfig({
      kind,
      host: kind === "mongodb" ? text : parsed.hostname,
      port: parsed.port || defaultPortForKind(kind),
      username: decodeURIComponent(parsed.username || ""),
      password: decodeURIComponent(parsed.password || ""),
      database,
    });
  } catch {
    return null;
  }
}

function defaultPortForKind(kind) {
  const normalized = normalizeKind(kind);
  if (normalized === "clickhouse") return "8123";
  if (normalized === "mongodb") return "27017";
  return "3306";
}

function defaultUserForKind(kind) {
  const normalized = normalizeKind(kind);
  if (normalized === "clickhouse") return "default";
  if (normalized === "mongodb") return "";
  return "root";
}

function compactConfig(config) {
  const next = {};
  for (const [key, value] of Object.entries(config || {})) {
    const cleaned = cleanValue(value);
    if (cleaned) next[key] = cleaned;
  }
  if (next.kind) next.kind = normalizeKind(next.kind);
  return next;
}

function readDirectFields(object) {
  const config = {};
  const fields = new Set();
  let urlConfig = null;
  for (const [key, value] of Object.entries(object || {})) {
    const field = ALIAS_BY_KEY.get(normalizeKey(key));
    if (!field) continue;
    if (field === "url") {
      urlConfig = parseConnectionUrl(value, key) || urlConfig;
      continue;
    }
    const cleaned = cleanValue(value);
    if (!cleaned) continue;
    config[field] = field === "kind" ? normalizeKind(cleaned) : cleaned;
    fields.add(field);
  }
  const merged = compactConfig({ ...urlConfig, ...config });
  for (const key of Object.keys(urlConfig || {})) fields.add(key);
  return { config: merged, fields: [...fields] };
}

function scoreCandidate(candidate) {
  const config = candidate.config || {};
  let score = 0;
  if (config.host) score += 8;
  if (config.port) score += 2;
  if (config.username) score += 2;
  if (config.password) score += 2;
  if (config.database) score += 2;
  if (config.kind) score += 1;
  if (config.host && (config.username || config.password || config.database)) score += 3;
  score -= candidate.depth * 0.1;
  return score;
}

function collectCandidates(value, candidates = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return candidates;
  if (Array.isArray(value)) {
    value.forEach((item) => collectCandidates(item, candidates, depth + 1));
    return candidates;
  }
  const direct = readDirectFields(value);
  if (Object.keys(direct.config).length) {
    candidates.push({ ...direct, depth });
  }
  for (const child of Object.values(value)) {
    collectCandidates(child, candidates, depth + 1);
  }
  return candidates;
}

function bestCandidateFromJson(parsed) {
  return collectCandidates(parsed)
    .filter((candidate) => candidate.config.host)
    .sort((left, right) => scoreCandidate(right) - scoreCandidate(left))[0] || null;
}

export function parseConnectionConfigText(text, { fileName = "" } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch (error) {
    const suffix = fileName ? `（${fileName}）` : "";
    throw new Error(`JSON 文件格式不正确${suffix}：${String(error?.message || error)}`);
  }

  const candidate = bestCandidateFromJson(parsed);
  if (!candidate?.config?.host) {
    throw new Error("没有识别到数据库连接信息：需要至少包含 host，最好同时包含 port、user、password 或 database");
  }

  const kind = normalizeKind(candidate.config.kind);
  const config = {
    kind,
    host: candidate.config.host,
    port: candidate.config.port || defaultPortForKind(kind),
    username: candidate.config.username || defaultUserForKind(kind),
    password: candidate.config.password || "",
    database: candidate.config.database || "",
  };

  return {
    config,
    fields: candidate.fields.filter((field) => field !== "kind" && field !== "url"),
  };
}
