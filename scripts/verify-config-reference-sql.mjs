// Execute Rust-generated read-only predicates against an explicitly selected
// Blackcat connection. The existing desktop app owns authentication; no secrets
// or server addresses are read or copied here.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ControlClient } from "../sidecar/controlClient.mjs";

const [directory, connectionId, database] = process.argv.slice(2);
if (!database) throw new Error("Expected private export directory, connection ID, database");
const read = async (name) => JSON.parse(await readFile(join(directory, name), "utf8"));
const exported = await read("audit.json");
if (exported.database !== database) throw new Error("Database must match the explicitly selected export");
const audit = await read("relations-audit.json");
const client = new ControlClient();
const literal = (value) => `CONVERT(0x${Buffer.from(String(value)).toString("hex")} USING utf8mb4) COLLATE utf8mb4_unicode_ci`;
const inject = (predicate, binds) => {
  let index = 0;
  const sql = predicate.replace(/\?/g, () => literal(binds[index++]));
  if (index !== binds.length) throw new Error("Bind count mismatch");
  return sql;
};
const query = (sql, limit) => client.request("db_tool", { func: "run_read_query", args: { connectionId, database, limit, sql } });
const results = [];
try {
  const databases = await client.request("db_tool", { func: "list_databases", args: { connectionId } });
  if (!databases.includes(database)) throw new Error("Selected connection does not expose the requested database");
  const groups = new Map();
  for (const check of audit.sqlChecks) {
    if (!groups.has(check.table)) groups.set(check.table, []);
    groups.get(check.table).push(check);
  }
  for (const [table, checks] of groups) {
    for (let start = 0; start < checks.length; start += 20) {
      const batch = checks.slice(start, start + 20);
      // Older desktop bridges decode aggregate integers inconsistently; CHAR
      // keeps the transport deterministic and is converted back explicitly.
      const select = batch.map((check, index) =>
        `CAST(COUNT(CASE WHEN ${inject(check.predicate, check.binds)} THEN 1 END) AS CHAR) AS n${index}`).join(", ");
      const data = await query(`SELECT /*+ MAX_EXECUTION_TIME(10000) */ ${select} FROM \`${table.replaceAll("`", "``")}\``, 1);
      const row = data.rows[0];
      batch.forEach((check, index) => {
        const actual = row?.[`n${index}`] == null ? null : Number(row[`n${index}`]);
        results.push({ relation: check.relation, value: check.value, expected: check.expected, actual, pass: actual === check.expected });
      });
    }
  }
  for (let start = 0; start < audit.fixtureChecks.length; start += 25) {
    const batch = audit.fixtureChecks.slice(start, start + 25);
    const sql = batch.map((check, index) =>
      `SELECT CAST(${start + index} AS CHAR) AS idx, CAST(CASE WHEN ${inject(check.predicate, check.binds)} THEN 1 ELSE 0 END AS CHAR) AS matched FROM (SELECT ${literal(check.text)} AS cell) AS fixture`).join(" UNION ALL ");
    const data = await query(sql, 1000);
    if (data.rows.length !== batch.length) throw new Error("Incomplete SQL fixture response");
    for (const row of data.rows) {
      if (row.idx == null) throw new Error("Unreadable SQL fixture index");
      const check = audit.fixtureChecks[Number(row.idx)];
      const actual = row.matched == null ? null : Number(row.matched);
      results.push({ fixture: check.name, value: check.value, expected: check.expected, actual, pass: actual === check.expected });
    }
  }
  const failed = results.filter((result) => !result.pass);
  await writeFile(join(directory, "sql-verification.json"), JSON.stringify({ checkedAt: new Date().toISOString(), results, failed }, null, 2));
  console.log(JSON.stringify({ checked: results.length, failedCount: failed.length, failed: failed.slice(0, 12) }, null, 2));
  if (failed.length) {
    console.error("Differences may be live data drift; re-read affected tables before classifying them as parser failures.");
    process.exitCode = 1;
  }
} finally {
  client.close();
}
