import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";

import { executeExternalImport, previewExternalImport } from "./externalImport.mjs";

test("requires preview and forwards a confirmed import with mapped rows", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "blackcat-import-test-"));
  const sourcePath = path.join(temp, "players.xlsx");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["ID", "Name", "ignored"], ["1", "Alice", "x"]]),
    "Players"
  );
  await writeFile(sourcePath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const requests = [];
  const control = {
    async request(op, payload = {}) {
      requests.push({ op, payload });
      if (op === "get_context") return { connectionId: "demo", database: "game_db" };
      if (op === "db_tool") {
        return {
          columns: [
            { columnName: "id", isPrimaryKey: true },
            { columnName: "name", isPrimaryKey: false },
          ],
        };
      }
      if (op === "import_table") return { inserted: 1, backupPath: "backup.xlsx" };
      throw new Error(`unexpected op: ${op}`);
    },
  };
  try {
    const preview = await previewExternalImport(control, { sourcePath, table: "player" });
    assert.equal(preview.rowCount, 1);
    assert.deepEqual(preview.mappedColumns, ["id", "name"]);
    assert.deepEqual(preview.ignoredColumns, ["ignored"]);
    await assert.rejects(
      executeExternalImport(control, { previewId: preview.previewId, confirmReplace: false }),
      /confirmReplace=true/
    );
    const result = await executeExternalImport(control, {
      previewId: preview.previewId,
      confirmReplace: true,
    });
    assert.equal(result.backupPath, "backup.xlsx");
    const importRequest = requests.find((request) => request.op === "import_table");
    assert.deepEqual(importRequest.payload.args.rows, [{ id: "1", name: "Alice" }]);
    assert.equal(importRequest.payload.args.confirmReplace, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
