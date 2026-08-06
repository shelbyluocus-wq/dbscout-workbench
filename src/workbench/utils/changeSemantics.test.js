import test from "node:test";
import assert from "node:assert/strict";

import { firstRealChange, isFormatOnlyChange } from "./changeSemantics.js";

test("identical values and whitespace-only differences are format-only", () => {
  assert.equal(isFormatOnlyChange({ oldValue: "a", newValue: "a" }), true);
  assert.equal(isFormatOnlyChange({ oldValue: " 2026-03-03 02:00:00 ", newValue: "2026-03-03 02:00:00" }), true);
});

test("json with same content but different formatting is format-only", () => {
  const compact = '{"table":"db01_activity_0032","row":1,"enabled":false,"weight":1}';
  const pretty = `{
  "table": "db01_activity_0032",
  "row": 1,
  "enabled": false,
  "weight": 1
}`;
  assert.equal(isFormatOnlyChange({ oldValue: pretty, newValue: compact }), true);
  // 键顺序不同也算内容相同
  assert.equal(
    isFormatOnlyChange({ oldValue: '{"a":1,"b":[1,2]}', newValue: '{"b":[1,2],"a":1}' }),
    true,
  );
});

test("real differences are not format-only", () => {
  assert.equal(isFormatOnlyChange({ oldValue: "2026-02-02 01:00:00", newValue: "2026-03-03 02:00:00" }), false);
  assert.equal(isFormatOnlyChange({ oldValue: '{"a":1}', newValue: '{"a":2}' }), false);
  assert.equal(isFormatOnlyChange({ oldValue: '{"a":1}', newValue: '{"a":1,"b":2}' }), false);
  assert.equal(isFormatOnlyChange({ oldValue: null, newValue: "x" }), false);
  // 无法解析为 JSON 时按文本差异处理
  assert.equal(isFormatOnlyChange({ oldValue: "{not json", newValue: "{also not}" }), false);
});

test("firstRealChange skips format-only changes and picks the first real one", () => {
  const rows = [
    {
      changes: [
        { columnName: "payload", oldValue: '{"a":1}', newValue: '{\n  "a": 1\n}' },
      ],
    },
    {
      changes: [
        { columnName: "payload", oldValue: '{"a":1}', newValue: '{"a":1}' },
        { columnName: "start_time", oldValue: "2026-02-02 01:00:00", newValue: "2026-03-03 02:00:00" },
      ],
    },
  ];
  const target = firstRealChange(rows);
  assert.equal(target.rowIndex, 1);
  assert.equal(target.columnName, "start_time");
});

test("firstRealChange falls back to the first change when everything is format-only", () => {
  const rows = [{ changes: [{ columnName: "payload", oldValue: '{"a":1}', newValue: '{"a":1}' }] }];
  const target = firstRealChange(rows);
  assert.equal(target.rowIndex, 0);
  assert.equal(target.columnName, "payload");
  assert.equal(firstRealChange([]), null);
  assert.equal(firstRealChange([{ changes: [] }]), null);
});
