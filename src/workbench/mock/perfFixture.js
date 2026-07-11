import fixtureProfile from "../../../scripts/perf/fixture-profile.v1.json" with { type: "json" };

const ALLOWED_QUERY_KEYS = new Set(["perfProfile", "scenario"]);
const MAX_PAGE_SIZE = 10_000;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function scenarioByName(name) {
  const scenario = fixtureProfile.scenarios[String(name || "")];
  return scenario ? { name: String(name), ...scenario } : null;
}

function padded(value, width) {
  return String(value).padStart(width, "0");
}

function columnNameAt(index, primaryKey) {
  return primaryKey && index === 0 ? "id" : `field_${padded(index, 3)}`;
}

function tableNameFor(scenarioName, tableIndex = 1) {
  if (scenarioName === "schema-800x60") {
    return `perf_schema_table_${padded(tableIndex, 4)}`;
  }
  return `perf_${scenarioName.replace(/[^a-z0-9]+/gi, "_")}`;
}

function rowValue(scenarioName, rowNumber, columnIndex, primaryKey) {
  if (primaryKey && columnIndex === 0) return String(rowNumber);
  if (scenarioName === "table-search-10k-20-no-pk" && columnIndex < 2) {
    return `search-target-${padded(rowNumber, 6)}`;
  }
  return `${scenarioName}|r${padded(rowNumber, 6)}|c${padded(columnIndex, 3)}`;
}

export function parsePerfFixtureLocation(search = globalThis.location?.search || "") {
  const params = new URLSearchParams(String(search || ""));
  const entries = [...params.entries()];
  if (entries.length !== 2 || entries.some(([key]) => !ALLOWED_QUERY_KEYS.has(key))) return null;
  if (entries.filter(([key]) => key === "perfProfile").length !== 1) return null;
  if (entries.filter(([key]) => key === "scenario").length !== 1) return null;
  const profile = params.get("perfProfile");
  const scenario = params.get("scenario");
  if (profile !== fixtureProfile.profile || !scenarioByName(scenario)) return null;
  return { profile, scenario };
}

export function listPerfFixtureScenarios() {
  return Object.entries(fixtureProfile.scenarios).map(([name, scenario]) => ({ name, ...scenario }));
}

export function canonicalPerfFixtureText() {
  return canonicalJson(fixtureProfile);
}

export async function perfFixtureHash() {
  const bytes = new TextEncoder().encode(canonicalPerfFixtureText());
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function perfFixtureMetadata(search = globalThis.location?.search || "") {
  const active = parsePerfFixtureLocation(search);
  if (!active) return null;
  return {
    profile: fixtureProfile.profile,
    version: fixtureProfile.version,
    hash: await perfFixtureHash(),
    debugAssertions: true,
    frontendSource: "devUrl",
    usesExternalDatabase: false,
    scenario: active.scenario,
  };
}

export function createPerfFixtureColumns(scenarioName) {
  const scenario = scenarioByName(scenarioName);
  if (!scenario) throw new Error(`Unknown performance fixture scenario: ${scenarioName}`);
  return Array.from({ length: scenario.columnCount }, (_, index) => {
    const name = columnNameAt(index, scenario.primaryKey);
    const primary = Boolean(scenario.primaryKey && index === 0);
    return {
      column_name: name,
      columnName: name,
      column_type: primary ? "bigint" : "varchar(96)",
      columnType: primary ? "bigint" : "varchar(96)",
      data_type: primary ? "bigint" : "varchar",
      dataType: primary ? "bigint" : "varchar",
      column_comment: primary ? "Deterministic fixture primary key" : `Deterministic field ${index}`,
      columnComment: primary ? "Deterministic fixture primary key" : `Deterministic field ${index}`,
      is_primary_key: primary,
      isPrimaryKey: primary,
      is_nullable: !primary,
      isNullable: !primary,
      ordinal_position: index + 1,
      ordinalPosition: index + 1,
    };
  });
}

function createTable(scenarioName, tableIndex = 1) {
  const scenario = scenarioByName(scenarioName);
  const columns = createPerfFixtureColumns(scenarioName);
  return {
    table_name: tableNameFor(scenarioName, tableIndex),
    table_comment: `Deterministic ${scenarioName} fixture${scenario.kind === "schema" ? ` table ${tableIndex}` : ""}`,
    columns,
  };
}

export function listPerfFixtureTables(scenarioName) {
  const scenario = scenarioByName(scenarioName);
  if (!scenario) throw new Error(`Unknown performance fixture scenario: ${scenarioName}`);
  const tableCount = scenario.kind === "schema" ? scenario.tableCount : 1;
  return Array.from({ length: tableCount }, (_, index) => ({
    table_name: tableNameFor(scenarioName, index + 1),
    table_comment: `Deterministic ${scenarioName} fixture${scenario.kind === "schema" ? ` table ${index + 1}` : ""}`,
    column_count: scenario.columnCount,
    columnCount: scenario.columnCount,
  }));
}

export function createPerfFixtureTable(scenarioName, tableName = "") {
  const scenario = scenarioByName(scenarioName);
  if (!scenario) throw new Error(`Unknown performance fixture scenario: ${scenarioName}`);
  if (scenario.kind !== "schema") return createTable(scenarioName);
  const match = String(tableName || "").match(/_(\d{4})$/u);
  const tableIndex = match ? Number(match[1]) : 1;
  if (!Number.isInteger(tableIndex) || tableIndex < 1 || tableIndex > scenario.tableCount) {
    throw new Error(`Unknown performance fixture table: ${tableName}`);
  }
  return createTable(scenarioName, tableIndex);
}

export function createPerfFixtureSchema(scenarioName) {
  const scenario = scenarioByName(scenarioName);
  if (!scenario) throw new Error(`Unknown performance fixture scenario: ${scenarioName}`);
  const tableCount = scenario.kind === "schema" ? scenario.tableCount : 1;
  const tables = Array.from({ length: tableCount }, (_, index) => createTable(scenarioName, index + 1));
  return {
    tables,
    generatedTables: tables.length,
    generatedColumns: tables.length * scenario.columnCount,
  };
}

export function createPerfFixturePage(scenarioName, { offset = 0, limit = 100, tableName = "" } = {}) {
  const scenario = scenarioByName(scenarioName);
  if (!scenario) throw new Error(`Unknown performance fixture scenario: ${scenarioName}`);
  const start = Math.max(0, Math.min(scenario.rowCount, Math.trunc(Number(offset) || 0)));
  const size = Math.max(0, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(limit) || 0)));
  const end = Math.min(scenario.rowCount, start + size);
  const columns = createPerfFixtureColumns(scenarioName);
  const rows = Array.from({ length: Math.max(0, end - start) }, (_, rowOffset) => {
    const rowNumber = start + rowOffset + 1;
    return Object.fromEntries(
      columns.map((column, columnIndex) => [
        column.column_name,
        rowValue(scenarioName, rowNumber, columnIndex, scenario.primaryKey),
      ]),
    );
  });
  return {
    tableName: tableName || tableNameFor(scenarioName),
    columns,
    primaryKeys: scenario.primaryKey ? ["id"] : [],
    rows,
    totalRows: scenario.rowCount,
    generatedRows: rows.length,
  };
}

export function createPerfInsertMatrix(scenarioName) {
  const scenario = scenarioByName(scenarioName);
  if (!scenario || scenario.kind !== "insert") {
    throw new Error(`Not an insert performance fixture scenario: ${scenarioName}`);
  }
  return Array.from({ length: scenario.rowCount }, (_, rowIndex) =>
    Array.from({ length: scenario.columnCount }, (_, columnIndex) =>
      rowValue(scenarioName, rowIndex + 1, columnIndex, scenario.primaryKey)),
  );
}

export function activePerfFixture(search = globalThis.location?.search || "") {
  const active = parsePerfFixtureLocation(search);
  if (!active) return null;
  return {
    ...active,
    connectionId: fixtureProfile.connectionId,
    database: fixtureProfile.database,
  };
}
