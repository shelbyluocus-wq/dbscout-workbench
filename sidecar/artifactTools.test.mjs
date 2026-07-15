import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import {
  createSpreadsheetForTest,
  createTextFileForTest,
  defaultArtifactOutputDir,
} from "./artifactTools.mjs";

function fixture() {
  return mkdtempSync(join(tmpdir(), "dbscout-artifacts-"));
}

describe("artifactTools", () => {
  it("uses a stable user-facing output directory", () => {
    assert.equal(
      defaultArtifactOutputDir("C:/Users/Demo"),
      join("C:/Users/Demo", "Documents", "DB Scout Workbench", "Agent Files"),
    );
  });

  it("creates a multi-sheet xlsx workbook with Chinese content", async () => {
    const outputDir = fixture();
    try {
      const artifact = await createSpreadsheetForTest({
        fileName: "玩家报表.xlsx",
        sheets: [
          { name: "玩家", headers: ["ID", "名称"], rows: [[1, "小明"], [2, "小红"]] },
          { name: "汇总", headers: ["指标", "值"], rows: [["玩家数", 2]] },
        ],
      }, { outputDir });

      assert.equal(artifact.format, "xlsx");
      assert.equal(artifact.sheetCount, 2);
      assert.equal(artifact.rowCount, 3);
      assert.ok(artifact.sizeBytes > 0);

      const workbook = XLSX.read(readFileSync(artifact.path), { type: "buffer" });
      assert.deepEqual(workbook.SheetNames, ["玩家", "汇总"]);
      assert.deepEqual(
        XLSX.utils.sheet_to_json(workbook.Sheets["玩家"], { header: 1, raw: true }),
        [["ID", "名称"], [1, "小明"], [2, "小红"]],
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing artifact", async () => {
    const outputDir = fixture();
    try {
      const args = { fileName: "report.md", format: "md", content: "first" };
      const first = await createTextFileForTest(args, { outputDir });
      const second = await createTextFileForTest({ ...args, content: "second" }, { outputDir });

      assert.equal(first.fileName, "report.md");
      assert.equal(second.fileName, "report-2.md");
      assert.equal(readFileSync(first.path, "utf8"), "first");
      assert.equal(readFileSync(second.path, "utf8"), "second");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps path-like names inside the output directory", async () => {
    const outputDir = fixture();
    try {
      const artifact = await createTextFileForTest({
        fileName: "../../outside.json",
        format: "json",
        content: "{\"ok\":true}",
      }, { outputDir });

      assert.equal(artifact.fileName, "outside.json");
      assert.equal(artifact.directory, outputDir);
      assert.equal(readFileSync(artifact.path, "utf8"), "{\n  \"ok\": true\n}\n");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON instead of writing a broken file", async () => {
    const outputDir = fixture();
    try {
      await assert.rejects(
        () => createTextFileForTest({ fileName: "bad.json", format: "json", content: "{" }, { outputDir }),
        /JSON 内容无效/,
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
