import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";

const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
const css = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");

test("folder contents and picker use the scoped shared database decoration", () => {
  assert.match(source, /getDatabaseDecoration\(scope\.value\.connectionId, scope\.value\.database\)/);
  assert.match(source, /computed\(\(\) => databaseTableIconComponent\(databaseDecoration\.value\)\)/);
  assert.match(source, /"--wb-folder-icon-color": databaseDecoration\.value\?\.color \|\| undefined/);
  assert.match(source, /"--wb-folder-table-color": databaseTextColorCss\(databaseDecoration\.value\?\.textColor\) \|\| undefined/);
  assert.match(source, /class="wb-folder-page" :style="databaseDecorationStyle"/);
  assert.equal(source.match(/<component :is="tableIcon" :size="15" aria-hidden="true" class="wb-folder-row-icon"/g)?.length, 2);
});

test("folder decoration preserves defaults, comment styling and missing-table state", () => {
  assert.match(css, /\.wb-folder-row-icon\s*\{[^}]*color: var\(--wb-folder-icon-color, var\(--wb-secondary-text\)\)/);
  assert.match(css, /\.wb-folder-table\s*\{[^}]*color: var\(--wb-folder-table-color, var\(--wb-identifier-text\)\)/);
  assert.match(css, /\.wb-folder-comment\s*\{[^}]*color: var\(--wb-remark-text\)/);
  assert.match(css, /\.wb-folder-row\.is-missing \.wb-folder-table\s*\{[^}]*color: var\(--wb-quiet-text\)/);
});

test("decorated folder page compiles", () => {
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: "folder-decoration" });
  const template = compileTemplate({
    source: descriptor.template.content,
    filename: "TableFolderPage.vue",
    id: "folder-decoration",
    compilerOptions: { bindingMetadata: script.bindings },
  });
  assert.deepEqual(template.errors, []);
});
