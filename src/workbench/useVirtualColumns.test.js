import test from "node:test";
import assert from "node:assert/strict";
import { computeColumnWindow } from "./composables/useVirtualColumns.js";

const widths = (count, width = 120) => Array.from({ length: count }, () => width);
const sum = (list) => list.reduce((total, value) => total + value, 0);
const renderedWidth = (window, allWidths) => sum(window.segments.map((segment) => (
  segment.kind === "spacer" ? segment.width : allWidths[segment.index]
)));

test("全部列装得下时不产生占位格，结构与旧实现一致", () => {
  const window = computeColumnWindow({ widths: widths(8), frozenCount: 0, scrollLeft: 0, viewportWidth: 1400, gutterWidth: 38 });
  assert.equal(window.allRendered, true);
  assert.deepEqual(window.renderedIndexes, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(window.segments.some((segment) => segment.kind === "spacer"), false);
});

test("视口内列 + 过扫描被渲染，其余折叠成右侧占位格，总宽守恒", () => {
  const all = widths(60);
  const window = computeColumnWindow({ widths: all, frozenCount: 0, scrollLeft: 0, viewportWidth: 1000, gutterWidth: 38, overscanPx: 240 });
  // 可见宽 1000-38=962px，右界 962+240=1202px；列左边缘 120*i < 1202 → i ≤ 10，共 11 列
  assert.deepEqual(window.renderedIndexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(window.segments.at(-1).kind, "spacer");
  assert.equal(window.segments.at(-1).width, 120 * 49);
  assert.equal(renderedWidth(window, all), sum(all));
});

test("滚到中间时左右各一个占位格；冻结列永远渲染且位于最前", () => {
  const all = widths(60);
  const window = computeColumnWindow({ widths: all, frozenCount: 2, scrollLeft: 3000, viewportWidth: 1000, gutterWidth: 38, overscanPx: 240 });
  assert.deepEqual(window.renderedIndexes.slice(0, 2), [0, 1]);
  assert.equal(window.segments[0].kind, "column");
  assert.equal(window.segments[1].kind, "column");
  assert.equal(window.segments[2].kind, "spacer");
  assert.equal(window.segments.at(-1).kind, "spacer");
  assert.equal(renderedWidth(window, all), sum(all));
  assert.equal(window.frozenWidth, 240);
  assert.equal(window.frozenCount, 2);
});

test("pinned 列在窗口外时作为独立列段插入，左右占位格自动拆分", () => {
  const all = widths(60);
  const window = computeColumnWindow({ widths: all, frozenCount: 0, scrollLeft: 0, viewportWidth: 1000, gutterWidth: 38, pinned: [45] });
  assert.ok(window.renderedIndexes.includes(45));
  const kinds = window.segments.map((segment) => segment.kind);
  assert.deepEqual(kinds.slice(-3), ["spacer", "column", "spacer"]);
  assert.equal(renderedWidth(window, all), sum(all));
  assert.deepEqual([...window.renderedIndexes].sort((a, b) => a - b), window.renderedIndexes);
});

test("offsets 是前缀和，可直接用于列几何计算", () => {
  const window = computeColumnWindow({ widths: [100, 50, 70], frozenCount: 0, scrollLeft: 0, viewportWidth: 500, gutterWidth: 38 });
  assert.deepEqual(window.offsets, [0, 100, 150, 220]);
});
