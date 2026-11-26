import test from "node:test";
import assert from "node:assert/strict";
import {
  dataTransferHasFiles,
  extractDroppedBatchImportFiles,
  isBatchImportSpreadsheetName,
  isExcelLockFileName,
  planBatchImportDrop,
} from "./batchImportDrop.js";

function fakeFile(name) {
  return { name, size: 128 };
}

test("detects spreadsheet files and ignores Excel lock files", () => {
  assert.equal(isBatchImportSpreadsheetName("heroprop.xlsx"), true);
  assert.equal(isBatchImportSpreadsheetName("LEGACY.XLS"), true);
  assert.equal(isBatchImportSpreadsheetName("folder/nested.xlsx"), true);
  assert.equal(isExcelLockFileName("~$heroprop.xlsx"), true);
  assert.equal(isBatchImportSpreadsheetName("~$heroprop.xlsx"), false);
  assert.equal(isBatchImportSpreadsheetName("notes.csv"), false);
  assert.equal(isBatchImportSpreadsheetName(".DS_Store"), false);
});

test("detects file drags from DataTransfer types, files, or items without matching plain text drags", () => {
  assert.equal(dataTransferHasFiles({ types: ["Files"] }), true);
  assert.equal(dataTransferHasFiles({ types: [], files: [fakeFile("a.xlsx")] }), true);
  assert.equal(dataTransferHasFiles({ types: [], items: [{ kind: "file" }] }), true);
  assert.equal(dataTransferHasFiles({ types: ["text/plain"], items: [{ kind: "string" }] }), false);
  assert.equal(dataTransferHasFiles(null), false);
});

test("plans single, multi-file, mixed, and unsupported drops cleanly", () => {
  const oneWorkbook = planBatchImportDrop([fakeFile("all.xlsx")], "workbook");
  assert.equal(oneWorkbook.accepted, true);
  assert.equal(oneWorkbook.mode, "workbook");
  assert.equal(oneWorkbook.switchedToSeparate, false);
  assert.deepEqual(oneWorkbook.files.map((f) => f.name), ["all.xlsx"]);
  assert.equal(oneWorkbook.skippedCount, 0);

  // Dropping multiple Excel files while on combined-workbook mode switches to per-table Excel mode.
  const multiInWorkbook = planBatchImportDrop(
    [fakeFile("hero.xlsx"), fakeFile("skill.xls"), fakeFile("~$hero.xlsx"), fakeFile(".DS_Store")],
    "workbook",
  );
  assert.equal(multiInWorkbook.accepted, true);
  assert.equal(multiInWorkbook.mode, "separate");
  assert.equal(multiInWorkbook.switchedToSeparate, true);
  assert.deepEqual(multiInWorkbook.files.map((f) => f.name), ["hero.xlsx", "skill.xls"]);
  assert.equal(multiInWorkbook.skippedCount, 0);

  // Separate mode stays separate even for a single Excel file.
  const singleInSeparate = planBatchImportDrop([fakeFile("hero.xlsx"), fakeFile("readme.txt")], "separate");
  assert.equal(singleInSeparate.accepted, true);
  assert.equal(singleInSeparate.mode, "separate");
  assert.equal(singleInSeparate.switchedToSeparate, false);
  assert.deepEqual(singleInSeparate.files.map((f) => f.name), ["hero.xlsx"]);
  assert.equal(singleInSeparate.skippedCount, 1);

  const unsupported = planBatchImportDrop([fakeFile("notes.txt"), fakeFile("~$lock.xlsx")], "workbook");
  assert.equal(unsupported.accepted, false);
  assert.equal(unsupported.reason, "no-spreadsheet");
  assert.equal(unsupported.files.length, 0);
  assert.equal(unsupported.skippedCount, 1);
});

test("extracts direct files and top-level files inside dropped folders even after DataTransfer invalidation", async () => {
  const directFiles = await extractDroppedBatchImportFiles({
    files: [fakeFile("a.xlsx"), fakeFile("b.xlsx")],
    items: [],
  });
  assert.deepEqual(directFiles.map((f) => f.name), ["a.xlsx", "b.xlsx"]);

  let invalidated = false;
  const folderEntry = {
    isDirectory: true,
    isFile: false,
    createReader() {
      let step = 0;
      return {
        readEntries(resolve) {
          step += 1;
          if (step === 1) {
            invalidated = true;
            resolve([
              { isFile: true, isDirectory: false, file: (ok) => ok(fakeFile("table_10.xlsx")) },
              { isFile: true, isDirectory: false, file: (ok) => ok(fakeFile("table_2.xlsx")) },
            ]);
          } else if (step === 2) {
            resolve([
              { isFile: false, isDirectory: true },
              { isFile: true, isDirectory: false, file: (ok) => ok(fakeFile("readme.txt")) },
            ]);
          } else {
            resolve([]);
          }
        },
      };
    },
  };
  const standaloneEntry = {
    isDirectory: false,
    isFile: true,
    file: (ok) => ok(fakeFile("extra.xls")),
  };
  const dataTransfer = {
    files: [fakeFile("export-folder")],
    items: [
      { kind: "file", webkitGetAsEntry: () => (invalidated ? null : folderEntry) },
      { kind: "file", webkitGetAsEntry: () => (invalidated ? null : standaloneEntry) },
    ],
  };

  const extracted = await extractDroppedBatchImportFiles(dataTransfer);
  assert.deepEqual(extracted.map((f) => f.name), ["readme.txt", "table_2.xlsx", "table_10.xlsx", "extra.xls"]);
  const planned = planBatchImportDrop(extracted, "workbook");
  assert.equal(planned.accepted, true);
  assert.equal(planned.mode, "separate");
  assert.deepEqual(planned.files.map((f) => f.name), ["table_2.xlsx", "table_10.xlsx", "extra.xls"]);
  assert.equal(planned.skippedCount, 1);
});
