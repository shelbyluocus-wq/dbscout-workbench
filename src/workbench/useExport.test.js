import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { useExport } from "./composables/useExport.js";

test("export table names xlsx files and sheets with table name only", async () => {
  const calls = [];
  const statusText = { value: "" };
  const feedback = [];
  const { exportTable } = useExport(
    async (command, payload) => {
      calls.push({ command, payload });
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: "player",
          columns: [{ column_name: "id" }, { column_name: "username" }],
          primaryKeys: ["id"],
          rows: [{ id: "1", username: "Ada" }],
          totalRows: 1,
          page: 1,
          pageSize: 10000,
        };
      }
      if (command === "save_export_file") {
        return "C:/exports/player.xlsx";
      }
      throw new Error(`unexpected command ${command}`);
    },
    { statusText, onSuccessFeedback: (message) => feedback.push(message) },
  );

  await exportTable({
    database: "game_db",
    tableName: "player",
    columns: [{ column_name: "id" }, { column_name: "username" }],
    rows: [{ id: "1", username: "Ada" }],
  });

  const saveCall = calls.find((call) => call.command === "save_export_file");
  assert.ok(saveCall, "expected export to save the generated workbook");
  assert.equal(saveCall.payload.fileName, "player.xlsx");

  const workbook = XLSX.read(Uint8Array.from(saveCall.payload.data), { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["player"]);
  assert.deepEqual(feedback, ["导出成功"]);
});

test("export table fetches all pages before writing workbook", async () => {
  const calls = [];
  const statusText = { value: "" };
  const { exportTable } = useExport(
    async (command, payload) => {
      calls.push({ command, payload });
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: "player",
          columns: [{ column_name: "id" }, { column_name: "username" }],
          primaryKeys: ["id"],
          rows: [
            { id: "1", username: "Ada" },
            { id: "2", username: "Grace" },
          ],
          totalRows: 5,
          page: 1,
          pageSize: 2,
        };
      }
      if (command === "fetch_table_page") {
        const page = payload.request.page;
        return {
          sessionId: "session-player",
          tableName: "player",
          columns: [{ column_name: "id" }, { column_name: "username" }],
          primaryKeys: ["id"],
          rows: page === 2
            ? [
                { id: "3", username: "Linus" },
                { id: "4", username: "Margaret" },
              ]
            : [{ id: "5", username: "Katherine" }],
          totalRows: 5,
          page,
          pageSize: 2,
        };
      }
      if (command === "save_export_file") return "C:/exports/player.xlsx";
      throw new Error(`unexpected command ${command}`);
    },
    { statusText, exportPageSize: 2 },
  );

  await exportTable({
    sessionId: "visible-session",
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    columns: [{ column_name: "id" }, { column_name: "username" }],
    rows: [{ id: "loaded-only", username: "Visible only" }],
    filter: "Ada",
    filterMode: "exact",
    sort: { columnName: "id", descending: true },
  });

  const openCall = calls.find((call) => call.command === "open_table_session");
  assert.ok(openCall, "expected export to open a fresh table session for all rows");
  assert.deepEqual(openCall.payload, {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    options: {
      page: 1,
      pageSize: 2,
      filter: { query: "Ada", columns: [], mode: "exact" },
      sort: { columnName: "id", descending: true },
    },
  });
  assert.deepEqual(
    calls
      .filter((call) => call.command === "fetch_table_page")
      .map((call) => call.payload.request),
    [
      {
        page: 2,
        pageSize: 2,
        filter: { query: "Ada", columns: [], mode: "exact" },
        sort: { columnName: "id", descending: true },
      },
      {
        page: 3,
        pageSize: 2,
        filter: { query: "Ada", columns: [], mode: "exact" },
        sort: { columnName: "id", descending: true },
      },
    ],
  );

  const saveCall = calls.find((call) => call.command === "save_export_file");
  assert.ok(saveCall, "expected export to save the generated workbook");
  const workbook = XLSX.read(Uint8Array.from(saveCall.payload.data), { type: "array" });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.player, { header: 1 });
  assert.deepEqual(rows.slice(1).map((row) => row[0]), ["1", "2", "3", "4", "5"]);
  assert.equal(statusText.value, "已导出 5 行 → C:/exports/player.xlsx");
});

test("export table opens an export session even when the active tab has no session id", async () => {
  const calls = [];
  const { exportTable } = useExport(
    async (command, payload) => {
      calls.push({ command, payload });
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: "player",
          columns: [{ column_name: "id" }],
          primaryKeys: ["id"],
          rows: [{ id: "server-row" }],
          totalRows: 1,
          page: 1,
          pageSize: 10000,
        };
      }
      if (command === "save_export_file") return "C:/exports/player.xlsx";
      throw new Error(`unexpected command ${command}`);
    },
    { statusText: { value: "" } },
  );

  await exportTable({
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    columns: [{ column_name: "id" }],
    rows: [{ id: "visible-row" }],
  });

  assert.ok(calls.some((call) => call.command === "open_table_session"));
  const saveCall = calls.find((call) => call.command === "save_export_file");
  const workbook = XLSX.read(Uint8Array.from(saveCall.payload.data), { type: "array" });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.player, { header: 1 });
  assert.equal(rows[1][0], "server-row");
});
