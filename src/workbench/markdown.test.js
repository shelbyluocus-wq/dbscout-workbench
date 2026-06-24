import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./utils/markdown.js";

test("renderMarkdown renders pipe tables as structured scrollable tables", () => {
  const markdown = [
    "| Type | Dsc 描述 | BaseAttrAddPer 基础属性加成% |",
    "|---|---|---:|",
    "| 0 | 玩家 | 70 |",
    "| 1 | 小城NPC | 40 |",
  ].join("\n");

  const { html } = renderMarkdown(markdown);

  assert.match(html, /<div class="wb-md-table-wrap">/);
  assert.match(html, /<table class="wb-md-table">/);
  assert.match(html, /<th[^>]*>Type<\/th>/);
  assert.match(html, /<th[^>]*>Dsc 描述<\/th>/);
  assert.match(html, /<td[^>]*>小城NPC<\/td>/);
  assert.match(html, /wb-md-cell-align-right/);
  assert.doesNotMatch(html, /<p class="wb-md-p">\| Type \|/);
});

test("renderMarkdown escapes HTML inside table cells", () => {
  const { html } = renderMarkdown("| Name | Note |\n|---|---|\n| <script> | **safe** |");

  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<strong>safe<\/strong>/);
});
