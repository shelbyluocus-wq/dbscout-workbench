import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSqlExecutionPayload,
  classifySqlStatement,
  resolveSqlExecution,
  splitSqlStatements,
  statementAtCursor,
} from "./utils/sqlStatements.js";

test("splitSqlStatements ignores semicolons in literals and comments", () => {
  const sql = "SELECT ';' AS value; -- keep ; here\nSELECT 2 /* ; */;";
  assert.deepEqual(splitSqlStatements(sql).map((item) => item.text), [
    "SELECT ';' AS value",
    "-- keep ; here\nSELECT 2 /* ; */",
  ]);
});

test("splitSqlStatements keeps a DELIMITER routine body together", () => {
  const sql = "DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n SELECT 1;\n SELECT 2;\nEND$$\nDELIMITER ;\nSELECT 3;";
  assert.deepEqual(splitSqlStatements(sql).map((item) => item.text), [
    "CREATE PROCEDURE p()\nBEGIN\n SELECT 1;\n SELECT 2;\nEND",
    "SELECT 3",
  ]);
});

test("SQL execution payload preserves a routine as one structured statement", () => {
  const sql = "DELIMITER //\nCREATE PROCEDURE p()\nBEGIN\n SELECT 1;\n SELECT 2;\nEND//\nDELIMITER ;";
  const statements = resolveSqlExecution(sql, { all: true });
  const payload = buildSqlExecutionPayload(statements);

  assert.deepEqual(payload.statements, [
    "CREATE PROCEDURE p()\nBEGIN\n SELECT 1;\n SELECT 2;\nEND",
  ]);
});

test("selection execution uses selection and cursor execution uses current statement", () => {
  const sql = "SELECT 1;\nSELECT 2;";
  assert.equal(statementAtCursor(sql, sql.indexOf("2")).text, "SELECT 2");
  assert.deepEqual(resolveSqlExecution(sql, { selectionFrom: 0, selectionTo: 8 }).map((item) => item.text), ["SELECT 1"]);
  assert.equal(resolveSqlExecution(sql, { cursor: 2 })[0].text, "SELECT 1");
});

test("classifySqlStatement treats unknown SQL as protected write", () => {
  assert.deepEqual(classifySqlStatement("SELECT * FROM player").kind, "read");
  assert.equal(classifySqlStatement("UPDATE player SET level = 1").highRisk, true);
  assert.equal(classifySqlStatement("DELETE FROM player WHERE id = 1").highRisk, false);
  assert.equal(classifySqlStatement("DROP TABLE player").highRisk, true);
  assert.deepEqual(classifySqlStatement("nonsense command"), {
    keyword: "NONSENSE",
    kind: "write",
    highRisk: true,
    readOnly: false,
  });
});

test("classifySqlStatement resolves CTE operations and only trusts an outer WHERE", () => {
  assert.equal(classifySqlStatement("WITH active AS (SELECT id FROM player) SELECT * FROM active").kind, "read");
  assert.deepEqual(classifySqlStatement("WITH active AS (SELECT id FROM player WHERE level > 1) DELETE FROM player"), {
    keyword: "DELETE",
    kind: "write",
    highRisk: true,
    readOnly: false,
  });
  assert.equal(
    classifySqlStatement("WITH active AS (SELECT id FROM player) UPDATE player SET level = 1 WHERE id IN (SELECT id FROM active)").highRisk,
    false,
  );
  assert.equal(
    classifySqlStatement("UPDATE player SET level = (SELECT MAX(level) FROM player WHERE id > 1)").highRisk,
    true,
  );
});
