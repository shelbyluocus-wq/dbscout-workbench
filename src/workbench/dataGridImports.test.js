import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("data grid imports every Vue setup helper it uses", () => {
  const grid = read("./components/DataGrid.vue");
  const vueImport = grid.match(/import\s+\{([^}]+)\}\s+from\s+["']vue["']/)?.[1] || "";

  for (const helper of ["computed", "inject", "nextTick", "onBeforeUnmount", "onMounted", "ref", "watch"]) {
    assert.match(vueImport, new RegExp(`\\b${helper}\\b`));
  }
});
