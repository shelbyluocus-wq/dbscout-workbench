import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjectFilesForTest,
  readProjectFileForTest,
  searchProjectFilesForTest,
} from "./projectTools.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dbscout-project-tools-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "README.md"), "# Demo\nProject entry is src/main.js\n", "utf8");
  writeFileSync(join(root, "src", "main.js"), "export const answer = 42;\n", "utf8");
  writeFileSync(join(root, "node_modules", "ignored.js"), "secret dependency text\n", "utf8");
  writeFileSync(join(root, ".env"), "TOKEN=secret\n", "utf8");
  return root;
}

function context(root) {
  return {
    project: {
      id: "fixture",
      name: "fixture",
      rootPath: root,
      shortPath: root,
      readOnly: true,
      available: true,
    },
  };
}

describe("projectTools", () => {
  it("lists project files while skipping ignored directories", async () => {
    const root = fixture();
    try {
      const result = await listProjectFilesForTest(context(root), { directory: ".", limit: 20 });
      const files = result.files.map((file) => file.path).sort();

      assert.deepEqual(files, ["README.md", "src/main.js"]);
      assert.equal(result.truncated, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a normal text file with metadata", async () => {
    const root = fixture();
    try {
      const result = await readProjectFileForTest(context(root), { path: "src/main.js" });

      assert.equal(result.path, "src/main.js");
      assert.match(result.content, /answer = 42/);
      assert.equal(result.truncated, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sensitive files with an explicit message", async () => {
    const root = fixture();
    try {
      await assert.rejects(
        () => readProjectFileForTest(context(root), { path: ".env" }),
        /敏感文件默认不可读取/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal outside the project root", async () => {
    const root = fixture();
    try {
      await assert.rejects(
        () => readProjectFileForTest(context(root), { path: "../outside.txt" }),
        /只能读取当前项目内的文件/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths outside the project root", async () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "dbscout-project-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "outside", "utf8");
      await assert.rejects(
        () => readProjectFileForTest(context(root), { path: join(outside, "secret.txt") }),
        /只能读取当前项目内的相对路径/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects symlink escapes", async (t) => {
    if (process.platform === "win32") {
      t.skip("Windows symlink creation requires privileges on many machines");
      return;
    }
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "dbscout-project-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "outside", "utf8");
      symlinkSync(join(outside, "secret.txt"), join(root, "src", "linked-secret.txt"));
      await assert.rejects(
        () => readProjectFileForTest(context(root), { path: "src/linked-secret.txt" }),
        /只能读取当前项目内的文件/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("searches text files and returns line numbers", async () => {
    const root = fixture();
    try {
      const result = await searchProjectFilesForTest(context(root), { keyword: "answer", limit: 10 });

      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].path, "src/main.js");
      assert.equal(result.matches[0].line, 1);
      assert.match(result.matches[0].text, /answer/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports when no project is selected", async () => {
    await assert.rejects(
      () => listProjectFilesForTest({}, { directory: "." }),
      /未选择项目文件夹/,
    );
  });
});
