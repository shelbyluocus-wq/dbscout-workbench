import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAutoHomeColumnWidths,
  defaultHomeColumnLayout,
  estimateHomeTextWidth,
  fittedFillWidth,
  formatDataSize,
  formatModifiedAtTooltip,
  formatModifiedDisplayParts,
  homeColumnDefinition,
  homeGridTemplateColumns,
  homeTableWidthCss,
  loadHomeColumnLayout,
  moveHomeColumn,
  normalizeHomeColumnLayout,
} from "./homeColumnLayout.js";

test("homepage columns default to name size modified comment", () => {
  assert.deepEqual(defaultHomeColumnLayout().map((column) => column.key), ["name", "size", "modified", "comment"]);
});

test("homepage column layout validates widths and restores missing columns", () => {
  const layout = normalizeHomeColumnLayout([
    { key: "comment", width: 9999 },
    { key: "name", width: 20 },
    { key: "size", width: 10 },
    { key: "modified", width: 10 },
  ]);
  assert.deepEqual(layout.map((column) => column.key), ["comment", "name", "size", "modified"]);
  assert.equal(layout[0].width, 640);
  assert.equal(layout[1].width, 120);
  assert.equal(layout[2].width, 72);
  assert.equal(layout[3].width, 88);
  assert.deepEqual(loadHomeColumnLayout({ getItem: () => "broken" }), defaultHomeColumnLayout());
});

test("homepage column layout allows compact manual widths for every column", () => {
  const layout = normalizeHomeColumnLayout([
    { key: "name", width: 120 },
    { key: "comment", width: 80 },
    { key: "size", width: 72 },
    { key: "modified", width: 96 },
  ]);
  assert.deepEqual(layout, [
    { key: "name", width: 120 },
    { key: "comment", width: 80 },
    { key: "size", width: 72 },
    { key: "modified", width: 96 },
  ]);
});

test("homepage columns reorder without dropping metadata", () => {
  const moved = moveHomeColumn(defaultHomeColumnLayout(), "comment", "name", "before");
  assert.deepEqual(moved.map((column) => column.key), ["comment", "name", "size", "modified"]);
});

test("homepage layout removes the retired field-count column from saved preferences", () => {
  const layout = normalizeHomeColumnLayout([
    { key: "name", width: 240 },
    { key: "fields", width: 92 },
    { key: "comment", width: 280 },
  ]);

  assert.deepEqual(layout.map((column) => column.key), ["name", "comment", "size", "modified"]);
});

test("data size formatting covers raw bytes through terabytes", () => {
  assert.equal(formatDataSize(null), "—");
  assert.equal(formatDataSize(512), "512 B");
  assert.equal(formatDataSize(1536), "1.50 KB");
  assert.equal(formatDataSize(1024 ** 3), "1.00 GB");
});

test("numeric home columns align to the end and every column keeps an explicit pixel track", () => {
  assert.equal(homeColumnDefinition("size").align, "end");
  assert.equal(homeColumnDefinition("name").align, "start");
  const sized = [
    { key: "name", width: 210 },
    { key: "comment", width: 160 },
    { key: "size", width: 96 },
    { key: "modified", width: 160 },
  ];
  assert.equal(homeGridTemplateColumns(sized), "210px 160px 96px 160px");
  assert.equal(homeTableWidthCss(sized), "max(100%, 626px)");
});

test("automatic homepage widths stay compact despite long outliers and wide CJK comments", () => {
  assert.ok(estimateHomeTextWidth("活动配置", 13) > estimateHomeTextWidth("abcd", 13));
  const tables = [
    ...Array.from({ length: 18 }, (_, index) => ({
      tableName: `act${index + 1}shouchong1prop`,
      tableComment: "H-活动-多轮冲刺任务奖励模板",
    })),
    {
      tableName: "super_long_outlier_cross_server_activity_rank_reward_template_prop",
      tableComment: "这是一个非常非常非常非常长的异常表格说明备注用于测试自动列宽不会被极端条目撑爆",
    },
  ];

  const widths = computeAutoHomeColumnWidths(tables, { emptyComment: "无备注" });
  assert.ok(widths.name >= 156 && widths.name <= 250, `expected compact name width, got ${widths.name}`);
  assert.ok(widths.comment >= 120 && widths.comment <= 240, `expected compact comment width, got ${widths.comment}`);
  assert.equal(widths.size, 96);
  assert.equal(widths.modified, 160);

  const emptyCommentWidths = computeAutoHomeColumnWidths(
    [{ tableName: "users", tableComment: "" }, { tableName: "orders", tableComment: "" }],
    { emptyComment: "无备注" },
  );
  assert.equal(emptyCommentWidths.name, 156);
  assert.equal(emptyCommentWidths.comment, 120);

  const readOnlyWidths = computeAutoHomeColumnWidths(tables, { readOnly: true, emptyComment: "无备注" });
  assert.ok(readOnlyWidths.name > widths.name, "read-only badge reserves extra width in name column");
});

test("automatic comment width trims to fit narrow panes without expanding on wide panes", () => {
  assert.equal(fittedFillWidth({ preferred: 240, minWidth: 120, available: 640, otherColumnsWidth: 466 }), 174);
  assert.equal(fittedFillWidth({ preferred: 240, minWidth: 120, available: 1400, otherColumnsWidth: 466 }), 240);
  assert.equal(fittedFillWidth({ preferred: 240, minWidth: 120, available: 520, otherColumnsWidth: 466 }), 120);
  assert.equal(fittedFillWidth({ preferred: 240, minWidth: 120, available: 0, otherColumnsWidth: 466 }), 240);
});

test("modified-time tooltip formats source and actor labels cleanly", () => {
  const labels = {
    empty: "暂无修改记录",
    blackcat: "黑猫修改",
    shared: "团队同步",
    database: "数据库记录",
    external: "检测到外部变动",
  };
  assert.equal(formatModifiedAtTooltip({ modified_at: null }, labels), "暂无修改记录");
  assert.equal(
    formatModifiedAtTooltip({ modified_at: "2026-11-23 17:15:40", modified_source: "blackcat", modified_actor: "张三" }, labels),
    "2026-11-23 17:15:40 · 黑猫修改（张三）",
  );
  assert.equal(
    formatModifiedAtTooltip({ modified_at: "2026-11-23 17:15:40", modified_source: "shared", modified_actor: "Alice" }, labels),
    "2026-11-23 17:15:40 · 团队同步（Alice）",
  );
  assert.equal(
    formatModifiedAtTooltip({ modified_at: "2026-11-23 17:15:40", modified_source: "external" }, labels),
    "2026-11-23 17:15:40 · 检测到外部变动",
  );
  assert.equal(
    formatModifiedAtTooltip({ modified_at: "2026-11-23 17:15:40", modified_source: "blackcat" }, { ...labels, self: "我" }),
    "2026-11-23 17:15:40 · 黑猫修改（我）",
  );
});

test("modified display combines compact minute timestamp with modifier name and adapts column width", () => {
  assert.deepEqual(
    formatModifiedDisplayParts({ modified_at: null }, { selfLabel: "我" }),
    { time: "—", actor: "", text: "—" },
  );
  assert.deepEqual(
    formatModifiedDisplayParts({ modified_at: "2026-11-23 10:46:39", modified_source: "database" }, { selfLabel: "我" }),
    { time: "2026-11-23 10:46:39", actor: "", text: "2026-11-23 10:46:39" },
  );
  assert.deepEqual(
    formatModifiedDisplayParts({
      modified_at: "2026-11-23 10:46:39",
      modified_source: "shared",
      modified_actor: "张三",
    }, { selfLabel: "我" }),
    { time: "2026-11-23 10:46", actor: "张三", text: "2026-11-23 10:46 · 张三" },
  );
  assert.deepEqual(
    formatModifiedDisplayParts({
      modified_at: "2026-11-23 10:46:39",
      modified_source: "blackcat",
      modified_actor: null,
    }, { selfLabel: "我" }),
    { time: "2026-11-23 10:46", actor: "我", text: "2026-11-23 10:46 · 我" },
  );

  const withActors = computeAutoHomeColumnWidths([
    { tableName: "goodsprop", tableComment: "道具", modified_at: "2026-11-23 10:46:39", modified_source: "shared", modified_actor: "张三" },
    { tableName: "heroprop", tableComment: "英雄", modified_at: "2026-11-23 10:55:02", modified_source: "shared", modified_actor: "欧阳明" },
  ], { emptyComment: "无备注", selfLabel: "我" });
  assert.ok(withActors.modified > 160 && withActors.modified <= 240, `expected expanded modified width, got ${withActors.modified}`);
});
