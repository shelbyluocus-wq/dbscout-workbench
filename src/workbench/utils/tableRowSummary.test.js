import test from "node:test";
import assert from "node:assert/strict";

import { formatTableRowSummary } from "./tableRowSummary.js";
import zhCN from "../i18n/zhCN.js";

const t = (key, params = {}) =>
  String(zhCN[key] || key).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => String(params[name] ?? ""));

test("formatTableRowSummary reports exact loaded count for complete tables", () => {
  assert.equal(formatTableRowSummary({ rows: new Array(54), totalRows: 54, totalRowsExact: true, hasMore: false }, t), "共 54 行");
  assert.equal(formatTableRowSummary({ rows: [], totalRows: 0, totalRowsExact: true, hasMore: false }, t), "共 0 行");
  assert.equal(formatTableRowSummary({ rows: new Array(12), totalRows: 0, totalRowsExact: false, hasMore: false }, t), "共 12 行");
});

test("formatTableRowSummary reports loaded vs total and open-ended counts for large tables", () => {
  assert.equal(
    formatTableRowSummary({ rows: new Array(200), totalRows: 1240, totalRowsExact: true, hasMore: true }, t),
    "已加载 200 / 1,240 行",
  );
  assert.equal(
    formatTableRowSummary({ rows: new Array(200), totalRows: 0, totalRowsExact: false, hasMore: true }, t),
    "已加载 200+ 行",
  );
});

test("formatTableRowSummary reports window ranges when scrolled to a non-zero boundary offset", () => {
  assert.equal(
    formatTableRowSummary({ rows: new Array(100), rowWindowOffset: 900, totalRows: 1000, totalRowsExact: true }, t),
    "第 901–1,000 行 · 共 1,000 行",
  );
  assert.equal(
    formatTableRowSummary({ rows: new Array(100), rowWindowOffset: 900, totalRows: 0, totalRowsExact: false }, t),
    "第 901–1,000 行",
  );
});

test("formatTableRowSummary returns empty while loading or errored", () => {
  assert.equal(formatTableRowSummary({ loading: true, rows: [] }, t), "");
  assert.equal(formatTableRowSummary({ loadError: "boom", rows: [] }, t), "");
  assert.equal(formatTableRowSummary(null, t), "");
});
