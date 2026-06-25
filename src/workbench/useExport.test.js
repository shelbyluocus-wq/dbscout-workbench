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
      return "C:/exports/player.xlsx";
    },
    { statusText, onSuccessFeedback: (message) => feedback.push(message) },
  );

  await exportTable({
    database: "game_db",
    tableName: "player",
    columns: [{ column_name: "id" }, { column_name: "username" }],
    rows: [{ id: "1", username: "Ada" }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "save_export_file");
  assert.equal(calls[0].payload.fileName, "player.xlsx");

  const workbook = XLSX.read(Uint8Array.from(calls[0].payload.data), { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["player"]);
  assert.deepEqual(feedback, ["导出成功"]);
});
