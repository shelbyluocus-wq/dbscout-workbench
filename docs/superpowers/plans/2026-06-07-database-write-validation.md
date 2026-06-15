# Database Write Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared database-write validation system that rejects duplicate primary keys, invalid types, NULL violations, length overflow, and malformed structured values across every write path.

**Architecture:** Add focused frontend and Rust validation modules, then route inline edits, right-side detail saves, inserts, paste, import, mock backend writes, demo/stress backend writes, and MySQL error mapping through them. Keep validation results structured so UI feedback, cell errors, import reports, and backend errors can share one rule set without duplicating message logic.

**Tech Stack:** Vue 3 composables, Node `node:test`, Rust/Tauri 2, sqlx MySQL, existing mock backend, existing demo/stress data model.

---

## File Structure

- Create `src/workbench/utils/valueValidation.js`
  - One responsibility: normalize column constraints and validate frontend cell/row/batch write values.
- Create `src/workbench/valueValidation.test.js`
  - Tests only the frontend validation utility.
- Modify `src/workbench/composables/useGridEditor.js`
  - Replace inline primary-key-only checks with shared validation for cell edits, inserts, and paste.
- Modify `src/workbench/useGridEditor.test.js`
  - Verify write workflows do not call backends for invalid values and emit the right feedback.
- Modify `src/workbench/composables/useImportWizard.js`
  - Add preflight validation before import execution and record structured import errors.
- Modify `src/workbench/useImportWizard.test.js`
  - Add import preflight tests. If the file does not exist, create it.
- Modify `src/workbench/mock/mockBackend.js`
  - Use the shared frontend validator for browser-only mock write commands.
- Modify `src/workbench/mockBackend.test.js`
  - Verify mock write commands reject invalid values.
- Create `src-tauri/src/validation.rs`
  - One responsibility: backend validation and MySQL error mapping.
- Modify `src-tauri/src/lib.rs`
  - Register the new Rust module with `mod validation;`.
- Modify `src-tauri/src/types.rs`
  - Extend `ColumnMeta` with optional validation metadata using serde defaults.
- Modify `src-tauri/src/db.rs`
  - Populate extended metadata from `information_schema.COLUMNS`.
- Modify `src-tauri/src/demo.rs`
  - Continue generating schemas, relying on parsed `column_type` for derived metadata.
- Modify `src-tauri/src/commands.rs`
  - Use backend validation in `update_cell` and `insert_row`; map MySQL errors with `validation::mysql_error_message`.

---

### Task 1: Frontend validation utility

**Files:**
- Create: `src/workbench/utils/valueValidation.js`
- Test: `src/workbench/valueValidation.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/workbench/valueValidation.test.js` with these tests:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  columnConstraint,
  validateCellValue,
  validateRowDraft,
  validateBatchEdits,
} from "./utils/valueValidation.js";

function col(name, type, extra = {}) {
  return {
    column_name: name,
    column_type: type,
    data_type: type.split("(")[0].toLowerCase(),
    is_primary_key: false,
    is_nullable: true,
    column_comment: "",
    ...extra,
  };
}

function table(columns) {
  return { table_name: "sample", columns, primaryKeys: columns.filter((c) => c.is_primary_key).map((c) => c.column_name) };
}

test("columnConstraint parses varchar length, decimal precision, enum values, and unsigned", () => {
  assert.deepEqual(columnConstraint(col("name", "varchar(32)")), {
    name: "name",
    type: "varchar",
    nullable: true,
    primaryKey: false,
    maxLength: 32,
    precision: null,
    scale: null,
    unsigned: false,
    enumValues: [],
    setValues: [],
  });
  assert.deepEqual(columnConstraint(col("price", "decimal(8,2)")), {
    name: "price",
    type: "decimal",
    nullable: true,
    primaryKey: false,
    maxLength: null,
    precision: 8,
    scale: 2,
    unsigned: false,
    enumValues: [],
    setValues: [],
  });
  assert.deepEqual(columnConstraint(col("status", "enum('open','closed')")), {
    name: "status",
    type: "enum",
    nullable: true,
    primaryKey: false,
    maxLength: null,
    precision: null,
    scale: null,
    unsigned: false,
    enumValues: ["open", "closed"],
    setValues: [],
  });
  assert.equal(columnConstraint(col("count", "int unsigned")).unsigned, true);
});

test("validateCellValue rejects duplicate primary key updates", () => {
  const meta = table([col("id", "int", { is_primary_key: true, is_nullable: false }), col("name", "varchar(32)")]);
  const rows = [{ id: "1", name: "a" }, { id: "2", name: "b" }];
  const result = validateCellValue({ table: meta, rows, row: rows[0], columnName: "id", value: "2" });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "duplicate-primary-key");
  assert.equal(result.errors[0].shortMessage, "主键重复");
});

test("validateCellValue rejects invalid scalar values", () => {
  const meta = table([
    col("id", "int", { is_primary_key: true, is_nullable: false }),
    col("age", "int", { is_nullable: false }),
    col("price", "decimal(5,2)"),
    col("name", "varchar(4)"),
    col("payload", "json"),
    col("starts_at", "datetime"),
    col("enabled", "boolean"),
  ]);
  const row = { id: "1", age: "10", price: "12.34", name: "ok", payload: "{}", starts_at: "2026-01-01 10:00:00", enabled: "1" };
  const rows = [row];
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "age", value: "abc" }).errors[0].code, "invalid-integer");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "age", value: "" }).errors[0].code, "required");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "price", value: "1234.56" }).errors[0].code, "decimal-precision");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "price", value: "12.345" }).errors[0].code, "decimal-scale");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "name", value: "abcde" }).errors[0].code, "length-overflow");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "payload", value: "{bad}" }).errors[0].code, "invalid-json");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "starts_at", value: "hello" }).errors[0].code, "invalid-datetime");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "enabled", value: "maybe" }).errors[0].code, "invalid-boolean");
});

test("validateRowDraft rejects duplicate composite primary keys and missing required fields", () => {
  const meta = table([
    col("account_id", "int", { is_primary_key: true, is_nullable: false }),
    col("role_id", "int", { is_primary_key: true, is_nullable: false }),
    col("label", "varchar(8)", { is_nullable: false }),
  ]);
  const rows = [{ account_id: "1", role_id: "7", label: "admin" }];
  const duplicate = validateRowDraft({ table: meta, rows, draft: { account_id: "1", role_id: "7", label: "copy" } });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.errors[0].code, "duplicate-primary-key");
  const missing = validateRowDraft({ table: meta, rows, draft: { account_id: "2", role_id: "8" } });
  assert.equal(missing.valid, false);
  assert.equal(missing.errors[0].code, "required");
});

test("validateBatchEdits returns valid and invalid edit partitions", () => {
  const meta = table([col("id", "int", { is_primary_key: true, is_nullable: false }), col("age", "int")]);
  const rows = [{ id: "1", age: "10" }, { id: "2", age: "20" }];
  const result = validateBatchEdits({
    table: meta,
    rows,
    edits: [
      { row: rows[0], rowIndex: 0, columnName: "age", value: "11" },
      { row: rows[1], rowIndex: 1, columnName: "age", value: "bad" },
    ],
  });
  assert.equal(result.valid, false);
  assert.equal(result.validEdits.length, 1);
  assert.equal(result.errors[0].code, "invalid-integer");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd E:\project\dbscout-workbench; node --test src/workbench/valueValidation.test.js
```

Expected: FAIL because `src/workbench/utils/valueValidation.js` does not exist or exports are missing.

- [ ] **Step 3: Write minimal implementation**

Create `src/workbench/utils/valueValidation.js`:

```js
import { columnName } from "./normalize.js";

const INTEGER_RANGES = {
  tinyint: { signed: [-128n, 127n], unsigned: [0n, 255n] },
  smallint: { signed: [-32768n, 32767n], unsigned: [0n, 65535n] },
  mediumint: { signed: [-8388608n, 8388607n], unsigned: [0n, 16777215n] },
  int: { signed: [-2147483648n, 2147483647n], unsigned: [0n, 4294967295n] },
  integer: { signed: [-2147483648n, 2147483647n], unsigned: [0n, 4294967295n] },
  bigint: { signed: [-9223372036854775808n, 9223372036854775807n], unsigned: [0n, 18446744073709551615n] },
};

const INTEGER_TYPES = new Set(Object.keys(INTEGER_RANGES));
const DECIMAL_TYPES = new Set(["decimal", "numeric", "dec", "fixed"]);
const FLOAT_TYPES = new Set(["float", "double", "real"]);
const STRING_TYPES = new Set(["char", "varchar", "binary", "varbinary"]);
const JSON_TYPES = new Set(["json"]);
const BOOLEAN_TYPES = new Set(["bool", "boolean"]);
const DATE_TYPES = new Set(["date", "datetime", "timestamp", "time", "year"]);

function text(value) {
  return String(value ?? "").trim();
}

function parseType(rawValue) {
  const raw = text(rawValue).toLowerCase();
  const type = raw.split(/[\s(]/).find(Boolean) || "";
  const lengthMatch = raw.match(/\((\d+)(?:\s*,\s*(\d+))?\)/);
  const valuesMatch = raw.match(/\((.*)\)/);
  return {
    raw,
    type,
    firstNumber: lengthMatch ? Number(lengthMatch[1]) : null,
    secondNumber: lengthMatch?.[2] ? Number(lengthMatch[2]) : null,
    values: valuesMatch ? parseQuotedValues(valuesMatch[1]) : [],
    unsigned: /\bunsigned\b/.test(raw),
  };
}

function parseQuotedValues(inner) {
  const values = [];
  const regex = /'((?:''|[^'])*)'/g;
  let match;
  while ((match = regex.exec(inner))) values.push(match[1].replaceAll("''", "'"));
  return values;
}

function bool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = text(value).toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

export function columnConstraint(column = {}) {
  const parsed = parseType(column.column_type || column.columnType || column.type || column.data_type || column.dataType || "");
  const type = text(column.data_type || column.dataType || parsed.type).toLowerCase() || parsed.type;
  const maxLength = numberOrNull(column.character_maximum_length ?? column.characterMaximumLength ?? (STRING_TYPES.has(type) ? parsed.firstNumber : null));
  const precision = numberOrNull(column.numeric_precision ?? column.numericPrecision ?? (DECIMAL_TYPES.has(type) ? parsed.firstNumber : null));
  const scale = numberOrNull(column.numeric_scale ?? column.numericScale ?? (DECIMAL_TYPES.has(type) ? parsed.secondNumber : null));
  const enumValues = Array.isArray(column.enum_values) ? column.enum_values : Array.isArray(column.enumValues) ? column.enumValues : type === "enum" ? parsed.values : [];
  const setValues = Array.isArray(column.set_values) ? column.set_values : Array.isArray(column.setValues) ? column.setValues : type === "set" ? parsed.values : [];
  const primaryKey = bool(column.is_primary_key ?? column.isPrimaryKey ?? column.primaryKey, false);
  return {
    name: columnName(column),
    type,
    nullable: primaryKey ? false : bool(column.is_nullable ?? column.isNullable ?? column.nullable, true),
    primaryKey,
    maxLength,
    precision,
    scale,
    unsigned: bool(column.is_unsigned ?? column.isUnsigned, parsed.unsigned),
    enumValues,
    setValues,
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function error(code, columnName, message, shortMessage = message, extra = {}) {
  return { code, columnName, message, shortMessage, ...extra };
}

function columns(table = {}) {
  return Array.isArray(table.columns) ? table.columns.map(columnConstraint) : [];
}

function primaryKeys(table = {}) {
  const explicit = Array.isArray(table.primaryKeys) ? table.primaryKeys.filter(Boolean) : [];
  return explicit.length ? explicit : columns(table).filter((c) => c.primaryKey).map((c) => c.name);
}

function primaryKeySignature(row, keys) {
  const values = keys.map((key) => text(row?.[key]));
  return values.every(Boolean) ? values.join("\x1f") : "";
}

function validateRequired(constraint, value) {
  if (!constraint.nullable && text(value) === "") return error("required", constraint.name, `字段 ${constraint.name} 不能为空`, "不能为空");
  return null;
}

function validateInteger(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  if (!/^-?\d+$/.test(raw)) return error("invalid-integer", constraint.name, `字段 ${constraint.name} 需要整数`, "整数格式错误");
  const range = INTEGER_RANGES[constraint.type];
  if (!range) return null;
  const numeric = BigInt(raw);
  const [min, max] = constraint.unsigned ? range.unsigned : range.signed;
  if (numeric < min || numeric > max) return error("integer-range", constraint.name, `字段 ${constraint.name} 数值超出范围`, "数值超范围");
  return null;
}

function validateDecimal(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return error("invalid-decimal", constraint.name, `字段 ${constraint.name} 需要数字`, "数字格式错误");
  const normalized = raw.replace(/^-/, "");
  const [whole, fractional = ""] = normalized.split(".");
  if (constraint.scale != null && fractional.length > constraint.scale) return error("decimal-scale", constraint.name, `字段 ${constraint.name} 小数位最多 ${constraint.scale} 位`, "小数位超限");
  if (constraint.precision != null && whole.length + fractional.length > constraint.precision) return error("decimal-precision", constraint.name, `字段 ${constraint.name} 精度最多 ${constraint.precision} 位`, "精度超限");
  return null;
}

function validateFloat(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  return Number.isFinite(Number(raw)) ? null : error("invalid-float", constraint.name, `字段 ${constraint.name} 需要数字`, "数字格式错误");
}

function validateLength(constraint, value) {
  const raw = String(value ?? "");
  if (constraint.maxLength != null && raw.length > constraint.maxLength) return error("length-overflow", constraint.name, `字段 ${constraint.name} 最多 ${constraint.maxLength} 个字符`, "长度超限");
  return null;
}

function validateJson(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  try { JSON.parse(raw); return null; } catch { return error("invalid-json", constraint.name, `字段 ${constraint.name} 需要合法 JSON`, "JSON 格式错误"); }
}

function validateBoolean(constraint, value) {
  const raw = text(value).toLowerCase();
  if (!raw) return null;
  return ["0", "1", "true", "false"].includes(raw) ? null : error("invalid-boolean", constraint.name, `字段 ${constraint.name} 需要布尔值 0/1/true/false`, "布尔格式错误");
}

function validateDateTime(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  const checks = {
    date: /^\d{4}-\d{2}-\d{2}$/,
    datetime: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    timestamp: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    time: /^\d{2}:\d{2}:\d{2}$/,
    year: /^\d{4}$/,
  };
  return checks[constraint.type]?.test(raw) ? null : error(`invalid-${constraint.type}`, constraint.name, `字段 ${constraint.name} 需要 ${constraint.type} 格式`, "日期时间格式错误");
}

function validateEnumSet(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  if (constraint.type === "enum" && constraint.enumValues.length && !constraint.enumValues.includes(raw)) return error("invalid-enum", constraint.name, `字段 ${constraint.name} 必须是：${constraint.enumValues.join("、")}`, "枚举值错误");
  if (constraint.type === "set" && constraint.setValues.length) {
    const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
    if (values.some((item) => !constraint.setValues.includes(item))) return error("invalid-set", constraint.name, `字段 ${constraint.name} 只能包含：${constraint.setValues.join("、")}`, "集合值错误");
  }
  return null;
}

function validateConstraint(constraint, value) {
  const required = validateRequired(constraint, value);
  if (required) return required;
  if (INTEGER_TYPES.has(constraint.type)) return validateInteger(constraint, value);
  if (DECIMAL_TYPES.has(constraint.type)) return validateDecimal(constraint, value);
  if (FLOAT_TYPES.has(constraint.type)) return validateFloat(constraint, value);
  if (STRING_TYPES.has(constraint.type)) return validateLength(constraint, value);
  if (JSON_TYPES.has(constraint.type)) return validateJson(constraint, value);
  if (BOOLEAN_TYPES.has(constraint.type)) return validateBoolean(constraint, value);
  if (DATE_TYPES.has(constraint.type)) return validateDateTime(constraint, value);
  if (constraint.type === "enum" || constraint.type === "set") return validateEnumSet(constraint, value);
  return null;
}

export function validateCellValue({ table, rows = [], row = {}, columnName, value }) {
  const constraint = columns(table).find((item) => item.name === columnName);
  if (!constraint) return { valid: true, errors: [] };
  const errors = [];
  const scalar = validateConstraint(constraint, value);
  if (scalar) errors.push(scalar);
  const keys = primaryKeys(table);
  if (keys.includes(columnName)) {
    const nextRow = { ...row, [columnName]: value };
    const signature = primaryKeySignature(nextRow, keys);
    if (signature && rows.some((candidate) => candidate !== row && primaryKeySignature(candidate, keys) === signature)) {
      errors.push(error("duplicate-primary-key", columnName, "主键重复，不能保存", "主键重复"));
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateRowDraft({ table, rows = [], draft = {}, draftRows = [] }) {
  const errors = [];
  for (const constraint of columns(table)) {
    const value = draft[constraint.name] ?? "";
    const scalar = validateConstraint(constraint, value);
    if (scalar) errors.push(scalar);
  }
  const keys = primaryKeys(table);
  const signature = primaryKeySignature(draft, keys);
  if (signature && [...rows, ...draftRows].some((row) => primaryKeySignature(row, keys) === signature)) {
    errors.push(error("duplicate-primary-key", keys[0] || "", "主键重复，不能保存", "主键重复"));
  }
  return { valid: errors.length === 0, errors };
}

export function validateBatchEdits({ table, rows = [], edits = [] }) {
  const errors = [];
  const validEdits = [];
  for (const edit of edits) {
    const result = validateCellValue({ table, rows, row: edit.row, columnName: edit.columnName, value: edit.value });
    if (result.valid) validEdits.push(edit);
    else errors.push(...result.errors.map((item) => ({ ...item, rowIndex: edit.rowIndex })));
  }
  return { valid: errors.length === 0, validEdits, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
cd E:\project\dbscout-workbench; node --test src/workbench/valueValidation.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/workbench/utils/valueValidation.js src/workbench/valueValidation.test.js
git commit -m "feat: add write value validation utility"
```

---

### Task 2: Route grid edits, inserts, and paste through frontend validator

**Files:**
- Modify: `src/workbench/composables/useGridEditor.js`
- Test: `src/workbench/useGridEditor.test.js`

- [ ] **Step 1: Write failing workflow tests**

Add these tests to `src/workbench/useGridEditor.test.js` after `createEditor()`:

```js
test("editing an integer cell to text is rejected before backend save", async () => {
  const { editor, tab, invokeCalls, statusText, saveFeedback } = createEditor({
    columns: [{ column_name: "id", column_type: "int", is_primary_key: true }, { column_name: "level", column_type: "int" }],
  });

  await editor.commitCellValue(tab, tab.rows[0], "level", "abc");

  assert.equal(tab.rows[0].level, "10");
  assert.equal(invokeCalls.length, 0);
  assert.equal(statusText.value, "字段 level 需要整数");
  assert.equal(saveFeedback.at(-1).message, "整数格式错误");
});

test("inserting a row with an invalid integer keeps the draft and skips insert_row", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({
    columns: [{ column_name: "id", column_type: "int", is_primary_key: true }, { column_name: "level", column_type: "int", is_nullable: false }],
  });
  editor.updateInsertDraft(tab, "id", "4");
  editor.updateInsertDraft(tab, "level", "abc");

  const result = await editor.commitInsertRows(tab);

  assert.equal(result.insertedRows, 0);
  assert.equal(invokeCalls.length, 0);
  assert.equal(statusText.value, "字段 level 需要整数");
  assert.equal(editor.getInsertRows(tab)[0].draft.level, "abc");
});

test("pasting invalid values into existing cells skips invalid cells and saves valid cells", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({
    columns: [{ column_name: "id", column_type: "int", is_primary_key: true }, { column_name: "level", column_type: "int" }],
    clipboard: { text: "11\nbad", async writeText(text) { this.text = text; }, async readText() { return this.text; } },
  });
  editor.selectCell(tab, tab.rows[0], "level", 0, 1);

  await editor.handleGridKeydown({ key: "v", ctrlKey: true, preventDefault() {} });

  assert.equal(tab.rows[0].level, "11");
  assert.equal(tab.rows[1].level, "12");
  assert.equal(invokeCalls.filter((call) => call.command === "update_cell").length, 1);
  assert.equal(statusText.value, "已粘贴 1 个单元格，1 个格式错误未保存");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
cd E:\project\dbscout-workbench; node --test src/workbench/useGridEditor.test.js
```

Expected: FAIL because grid edit paths do not yet call the shared validator for scalar invalid values and paste summaries.

- [ ] **Step 3: Modify `useGridEditor.js` imports**

At the top of `src/workbench/composables/useGridEditor.js`, add:

```js
import {
  validateBatchEdits,
  validateCellValue,
  validateRowDraft,
} from "../utils/valueValidation.js";
```

- [ ] **Step 4: Add validation helpers inside `useGridEditor()`**

Place this helper block near existing commit helpers:

```js
function tableForValidation(tab) {
  return {
    table_name: tab?.tableName || "",
    columns: activeColumns.value,
    primaryKeys: primaryKeyColumns(tab),
  };
}

function firstValidationError(result) {
  return result?.errors?.[0] || null;
}

function setValidationFeedback(tab, rowKey, column, validationError) {
  const message = validationError?.message || "输入不符合字段约束";
  const shortMessage = validationError?.shortMessage || "格式错误";
  statusText.value = message;
  if (rowKey && column) {
    const key = [tabScopeKey(tab), rowKey, column].map((value) => String(value ?? "")).join("\x1f");
    editState.cellErrors.set(key, message);
    onSaveFeedback({ kind: "error", tabId: tab.id, rowKey, column, message: shortMessage });
  }
}
```

- [ ] **Step 5: Replace duplicate-only inline validation in `commitCellValue()`**

In `commitCellValue`, replace the `wouldDuplicatePrimaryKey(...)` block with:

```js
const validation = validateCellValue({
  table: tableForValidation(tab),
  rows: tab.rows || [],
  row,
  columnName: column,
  value,
});
if (!validation.valid) {
  setValidationFeedback(tab, rowKey, column, firstValidationError(validation));
  return;
}
```

Do not remove backend conflict handling.

- [ ] **Step 6: Validate insert drafts in `commitDraftObject()`**

After `if (Object.keys(cleaned).length === 0) return false;`, add:

```js
const otherDrafts = getInsertRows(tab)
  .filter((candidate) => candidate.id !== rowId)
  .map((candidate) => cleanDraftValues(candidate.draft));
const validation = validateRowDraft({
  table: tableForValidation(tab),
  rows: tab.rows || [],
  draft: cleaned,
  draftRows: otherDrafts,
});
if (!validation.valid) {
  const validationError = firstValidationError(validation);
  statusText.value = validationError.message;
  return false;
}
```

Then remove the older `findDuplicatePrimaryKey` block or keep it only if it delegates to the shared validator. The final code should not produce two different messages for the same duplicate.

- [ ] **Step 7: Validate paste batches in `handleGridKeydown()`**

Inside the paste loop for existing cells, replace direct `await commitCellValue(...)` calls with batch validation:

```js
const edits = [];
let skipped = 0;
for (let rowOffset = 0; rowOffset < matrix.length; rowOffset++) {
  for (let colOffset = 0; colOffset < matrix[rowOffset].length; colOffset++) {
    const rowIndex = start.rowIndex + rowOffset;
    const columnIndex = start.columnIndex + colOffset;
    const row = tab.rows[rowIndex];
    const column = activeColumns.value[columnIndex];
    if (!row || !column) {
      skipped++;
      continue;
    }
    edits.push({ row, rowIndex, columnName: columnName(column), value: matrix[rowOffset][colOffset] });
  }
}
const validation = validateBatchEdits({ table: tableForValidation(tab), rows: tab.rows || [], edits });
for (const validationError of validation.errors) {
  const row = tab.rows[validationError.rowIndex];
  const rowKey = row ? buildRowKey(tab, row) : "";
  setValidationFeedback(tab, rowKey, validationError.columnName, validationError);
}
for (const edit of validation.validEdits) {
  await commitCellValue(tab, edit.row, edit.columnName, edit.value);
}
const invalidCount = validation.errors.length;
const committed = validation.validEdits.length;
statusText.value = invalidCount > 0 || skipped > 0
  ? `已粘贴 ${committed} 个单元格，${invalidCount + skipped} 个格式错误未保存`
  : `已粘贴 ${committed} 个单元格`;
```

- [ ] **Step 8: Run tests**

Run:

```powershell
cd E:\project\dbscout-workbench; node --test src/workbench/valueValidation.test.js src/workbench/useGridEditor.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/workbench/composables/useGridEditor.js src/workbench/useGridEditor.test.js
git commit -m "feat: validate grid write values"
```

---

### Task 3: Add import preflight validation

**Files:**
- Modify: `src/workbench/composables/useImportWizard.js`
- Create or modify: `src/workbench/useImportWizard.test.js`

- [ ] **Step 1: Write failing import preflight tests**

If `src/workbench/useImportWizard.test.js` does not exist, create it with this test harness:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { computed, reactive } from "vue";
import { useImportWizard } from "./composables/useImportWizard.js";

function createImportHarness() {
  const tab = reactive({
    id: "tab-1",
    sessionId: "session-1",
    page: 1,
    tableName: "player",
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "level", column_type: "int", is_nullable: false },
      { column_name: "name", column_type: "varchar(4)", is_nullable: false },
    ],
    rows: [{ id: "1", level: "10", name: "Alex" }],
    primaryKeys: ["id"],
  });
  const calls = [];
  const statusText = { value: "" };
  const api = useImportWizard(
    async (command, payload) => { calls.push({ command, payload }); return { affected: 1 }; },
    computed(() => tab),
    { async fetchPage() {} },
    { statusText },
  );
  return { ...api, tab, calls, statusText };
}

test("executeImport blocks invalid imported rows before insert_row", async () => {
  const { importWizard, executeImport, calls, statusText } = createImportHarness();
  importWizard.headerRow = true;
  importWizard.rawRows = [
    ["id", "level", "name"],
    ["2", "abc", "Bob"],
  ];
  importWizard.mapping = [
    { fileCol: "id", tableCol: "id", skip: false },
    { fileCol: "level", tableCol: "level", skip: false },
    { fileCol: "name", tableCol: "name", skip: false },
  ];

  await executeImport();

  assert.equal(calls.length, 0);
  assert.equal(importWizard.progress.errors.length, 1);
  assert.equal(importWizard.progress.errors[0].row, 2);
  assert.equal(importWizard.progress.errors[0].columnName, "level");
  assert.equal(importWizard.progress.errors[0].error, "字段 level 需要整数");
  assert.equal(statusText.value, "导入预检失败：1 个错误，未执行导入");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd E:\project\dbscout-workbench; node --test src/workbench/useImportWizard.test.js
```

Expected: FAIL because `executeImport()` currently calls `insert_row` row-by-row without a strict preflight.

- [ ] **Step 3: Import validator in `useImportWizard.js`**

Add imports:

```js
import { validateRowDraft } from "../utils/valueValidation.js";
```

- [ ] **Step 4: Add import draft builders**

Inside `useImportWizard`, add:

```js
function tableForValidation(tab) {
  return {
    table_name: tab?.tableName || "",
    columns: tab?.columns || [],
    primaryKeys: Array.isArray(tab?.primaryKeys)
      ? tab.primaryKeys
      : (tab?.columns || []).filter((column) => column.is_primary_key || column.isPrimaryKey).map(columnName),
  };
}

function importDraftsFromRows(rows, mapping) {
  return rows.map((row, index) => {
    const draft = {};
    mapping.forEach((m) => {
      const fileColIdx = importWizard.mapping.indexOf(m);
      const value = row?.[fileColIdx];
      if (value != null && String(value).trim() !== "") draft[m.tableCol] = String(value);
    });
    return { draft, sourceRowIndex: index };
  });
}

function validateImportDrafts(tab, drafts) {
  const errors = [];
  const acceptedDrafts = [];
  for (const item of drafts) {
    if (Object.keys(item.draft).length === 0) continue;
    const otherDrafts = acceptedDrafts.map((accepted) => accepted.draft);
    const validation = validateRowDraft({ table: tableForValidation(tab), rows: tab.rows || [], draft: item.draft, draftRows: otherDrafts });
    if (validation.valid) {
      acceptedDrafts.push(item);
    } else {
      errors.push(...validation.errors.map((error) => ({
        row: item.sourceRowIndex + (importWizard.headerRow ? 2 : 1),
        columnName: error.columnName,
        value: item.draft[error.columnName] ?? "",
        error: error.message,
      })));
    }
  }
  return { valid: errors.length === 0, errors, acceptedDrafts };
}
```

- [ ] **Step 5: Preflight in `executeImport()`**

In `executeImport()`, after `mapping.length === 0` guard, add:

```js
const drafts = importDraftsFromRows(rows, mapping);
const preflight = validateImportDrafts(tab, drafts);
if (!preflight.valid) {
  importWizard.progress = { done: 0, total: rows.length, errors: preflight.errors };
  importWizard.importing = false;
  statusText.value = `导入预检失败：${preflight.errors.length} 个错误，未执行导入`;
  return;
}
```

Then change the loop to iterate `preflight.acceptedDrafts`:

```js
for (const item of preflight.acceptedDrafts) {
  try {
    await invokeWorkbench("insert_row", { request: { sessionId: tab.sessionId, draft: item.draft } });
    importWizard.progress.done++;
  } catch (error) {
    importWizard.progress.errors.push({ row: item.sourceRowIndex + (importWizard.headerRow ? 2 : 1), error: String(error) });
    importWizard.progress.done++;
  }
}
```

- [ ] **Step 6: Run import tests**

Run:

```powershell
cd E:\project\dbscout-workbench; node --test src/workbench/useImportWizard.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/workbench/composables/useImportWizard.js src/workbench/useImportWizard.test.js
git commit -m "feat: preflight validate imported rows"
```

---

### Task 4: Mock backend validation

**Files:**
- Modify: `src/workbench/mock/mockBackend.js`
- Test: `src/workbench/mockBackend.test.js`

- [ ] **Step 1: Write failing mock backend tests**

Add to `src/workbench/mockBackend.test.js` near existing mutation tests:

```js
test("mock update_cell rejects invalid integer values", async () => {
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
  });

  await assert.rejects(
    () => mockWorkbenchInvoke("update_cell", {
      request: {
        sessionId: page.sessionId,
        rowIdentity: { id: "1" },
        columnName: "level",
        oldValue: page.rows[0].level,
        newValue: "abc",
      },
    }),
    /整数/,
  );
});

test("mock insert_row rejects invalid varchar length", async () => {
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
  });

  await assert.rejects(
    () => mockWorkbenchInvoke("insert_row", {
      request: {
        sessionId: page.sessionId,
        draft: { id: "9999", username: "x".repeat(64), nickname: "ok" },
      },
    }),
    /最多 32 个字符|长度/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
cd E:\project\dbscout-workbench; node --test src/workbench/mockBackend.test.js
```

Expected: FAIL because mock mutation paths only check duplicate primary keys.

- [ ] **Step 3: Import validator into mock backend**

At the top of `src/workbench/mock/mockBackend.js`, add:

```js
import { validateCellValue, validateRowDraft } from "../utils/valueValidation.js";
```

- [ ] **Step 4: Add table wrapper helper**

Near `primaryKeyColumns(table)`, add:

```js
function validationTable(table) {
  return {
    ...table,
    primaryKeys: primaryKeyColumns(table),
  };
}
```

- [ ] **Step 5: Validate `update_cell` command**

Inside `update_cell`, before `row[column] = ...`, add:

```js
const validation = validateCellValue({
  table: validationTable(table),
  rows,
  row,
  columnName: column,
  value: payload.request.newValue,
});
if (!validation.valid) throw new Error(validation.errors[0].message);
```

Remove any now-duplicated inline duplicate primary-key check if it produces the same behavior. Keeping only `validateCellValue` avoids drift.

- [ ] **Step 6: Validate `insert_row` command**

Inside `insert_row`, replace `hasPrimaryKeyConflict(...)` with:

```js
const validation = validateRowDraft({
  table: validationTable(table),
  rows,
  draft: payload.request?.draft || {},
});
if (!validation.valid) throw new Error(validation.errors[0].message);
```

- [ ] **Step 7: Run tests**

Run:

```powershell
cd E:\project\dbscout-workbench; node --test src/workbench/valueValidation.test.js src/workbench/mockBackend.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/workbench/mock/mockBackend.js src/workbench/mockBackend.test.js
git commit -m "feat: validate mock backend writes"
```

---

### Task 5: Rust validation module and metadata expansion

**Files:**
- Create: `src-tauri/src/validation.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write failing Rust validation tests**

Create `src-tauri/src/validation.rs` with test scaffolding first:

```rust
use std::collections::HashMap;

use crate::types::{ColumnMeta, TableMeta};

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, column_type: &str, pk: bool, nullable: bool) -> ColumnMeta {
        ColumnMeta {
            column_name: name.into(),
            column_type: column_type.into(),
            column_comment: String::new(),
            is_primary_key: pk,
            is_nullable: nullable,
            data_type: None,
            character_maximum_length: None,
            numeric_precision: None,
            numeric_scale: None,
            is_unsigned: false,
            is_auto_increment: false,
            enum_values: Vec::new(),
            set_values: Vec::new(),
            is_generated: false,
            default_value: None,
            default_mode: None,
        }
    }

    fn table(columns: Vec<ColumnMeta>) -> TableMeta {
        TableMeta { table_name: "sample".into(), table_comment: String::new(), columns }
    }

    #[test]
    fn validates_integer_json_datetime_and_length() {
        let table = table(vec![
            col("id", "int", true, false),
            col("age", "int", false, false),
            col("name", "varchar(4)", false, true),
            col("payload", "json", false, true),
            col("starts_at", "datetime", false, true),
        ]);
        assert_eq!(validate_cell_value(&table, &[], 0, "age", "abc").unwrap_err().code, "invalid-integer");
        assert_eq!(validate_cell_value(&table, &[], 0, "age", "").unwrap_err().code, "required");
        assert_eq!(validate_cell_value(&table, &[], 0, "name", "abcde").unwrap_err().code, "length-overflow");
        assert_eq!(validate_cell_value(&table, &[], 0, "payload", "{bad}").unwrap_err().code, "invalid-json");
        assert_eq!(validate_cell_value(&table, &[], 0, "starts_at", "hello").unwrap_err().code, "invalid-datetime");
    }

    #[test]
    fn rejects_duplicate_primary_key_updates_and_inserts() {
        let table = table(vec![col("id", "int", true, false), col("name", "varchar(16)", false, true)]);
        let rows = vec![
            HashMap::from([("id".into(), "1".into()), ("name".into(), "a".into())]),
            HashMap::from([("id".into(), "2".into()), ("name".into(), "b".into())]),
        ];
        assert_eq!(validate_cell_value(&table, &rows, 0, "id", "2").unwrap_err().code, "duplicate-primary-key");
        assert_eq!(validate_row_draft(&table, &rows, &HashMap::from([("id".into(), "2".into())])).unwrap_err().code, "duplicate-primary-key");
    }

    #[test]
    fn maps_mysql_error_codes_to_user_messages() {
        assert_eq!(mysql_error_code_message("1062"), Some("主键重复，不能保存".into()));
        assert_eq!(mysql_error_code_message("1406"), Some("字段长度超限".into()));
        assert_eq!(mysql_error_code_message("1292"), Some("日期或时间格式错误".into()));
        assert_eq!(mysql_error_code_message("9999"), None);
    }
}
```

- [ ] **Step 2: Register module and run tests to verify failure**

Add to `src-tauri/src/lib.rs` near other modules:

```rust
mod validation;
```

Run:

```powershell
cd E:\project\dbscout-workbench\src-tauri; cargo test validation::tests
```

Expected: FAIL because `ColumnMeta` has not been expanded and validation functions are missing.

- [ ] **Step 3: Expand `ColumnMeta` in `types.rs`**

Change `ColumnMeta` to:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub column_name: String,
    pub column_type: String,
    pub column_comment: String,
    pub is_primary_key: bool,
    pub is_nullable: bool,
    pub data_type: Option<String>,
    pub character_maximum_length: Option<u64>,
    pub numeric_precision: Option<u64>,
    pub numeric_scale: Option<u64>,
    pub is_unsigned: bool,
    pub is_auto_increment: bool,
    pub enum_values: Vec<String>,
    pub set_values: Vec<String>,
    pub is_generated: bool,
    pub default_value: Option<String>,
    pub default_mode: Option<String>,
}
```

Then update all test/demo constructors in Rust to include the new fields. Use this helper pattern in tests:

```rust
ColumnMeta {
    column_name: name.into(),
    column_type: typ.into(),
    column_comment: comment.into(),
    is_primary_key: pk,
    is_nullable: nullable,
    data_type: None,
    character_maximum_length: None,
    numeric_precision: None,
    numeric_scale: None,
    is_unsigned: typ.to_ascii_lowercase().contains("unsigned"),
    is_auto_increment: false,
    enum_values: Vec::new(),
    set_values: Vec::new(),
    is_generated: false,
    default_value: None,
    default_mode: None,
}
```

- [ ] **Step 4: Populate metadata in `db.rs`**

Update the `information_schema.COLUMNS` query in `read_schema()` to select:

```sql
COLUMN_NAME,
COLUMN_TYPE,
DATA_TYPE,
CHARACTER_MAXIMUM_LENGTH,
NUMERIC_PRECISION,
NUMERIC_SCALE,
COLUMN_DEFAULT,
EXTRA,
GENERATION_EXPRESSION,
COALESCE(COLUMN_COMMENT, '') AS COLUMN_COMMENT,
COLUMN_KEY = 'PRI' AS IS_PRIMARY_KEY,
IS_NULLABLE = 'YES' AS IS_NULLABLE
```

Build `ColumnMeta` with:

```rust
let column_type: String = row.try_get("COLUMN_TYPE").map_err(|error| error.to_string())?;
let data_type: Option<String> = row.try_get("DATA_TYPE").ok();
let extra: String = row.try_get("EXTRA").unwrap_or_default();
let generation_expression: Option<String> = row.try_get("GENERATION_EXPRESSION").ok();
let is_primary_key = row.try_get::<i8, _>("IS_PRIMARY_KEY").unwrap_or(0) != 0;
let is_nullable = row.try_get::<i8, _>("IS_NULLABLE").unwrap_or(0) != 0;
let default_value: Option<String> = row.try_get("COLUMN_DEFAULT").ok();
let default_mode = Some(infer_default_mode(&default_value, is_nullable, is_primary_key));
Ok(ColumnMeta {
    column_name: row.try_get("COLUMN_NAME").map_err(|error| error.to_string())?,
    column_type: column_type.clone(),
    column_comment: row.try_get("COLUMN_COMMENT").unwrap_or_default(),
    is_primary_key,
    is_nullable,
    data_type: data_type.clone(),
    character_maximum_length: row.try_get("CHARACTER_MAXIMUM_LENGTH").ok(),
    numeric_precision: row.try_get("NUMERIC_PRECISION").ok(),
    numeric_scale: row.try_get("NUMERIC_SCALE").ok(),
    is_unsigned: column_type.to_ascii_lowercase().contains("unsigned"),
    is_auto_increment: extra.to_ascii_lowercase().contains("auto_increment"),
    enum_values: if data_type.as_deref() == Some("enum") { parse_enum_set_values(&column_type) } else { Vec::new() },
    set_values: if data_type.as_deref() == Some("set") { parse_enum_set_values(&column_type) } else { Vec::new() },
    is_generated: generation_expression.as_deref().unwrap_or_default().trim().len() > 0,
    default_value,
    default_mode,
})
```

Add this helper to `db.rs`:

```rust
fn parse_enum_set_values(column_type: &str) -> Vec<String> {
    let Some(open) = column_type.find('(') else { return Vec::new(); };
    let Some(close) = column_type.rfind(')') else { return Vec::new(); };
    let mut values = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut chars = column_type[open + 1..close].chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\'' if in_quote && chars.peek() == Some(&'\'') => { current.push('\''); chars.next(); }
            '\'' => in_quote = !in_quote,
            ',' if !in_quote => { values.push(current.clone()); current.clear(); }
            _ if in_quote => current.push(ch),
            _ => {}
        }
    }
    if !current.is_empty() || column_type[open + 1..close].contains("''") { values.push(current); }
    values
}
```

- [ ] **Step 5: Implement `validation.rs`**

Add production code above the tests:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub code: String,
    pub column_name: String,
    pub message: String,
    pub short_message: String,
}

fn err(code: &str, column_name: &str, message: String, short: &str) -> ValidationError {
    ValidationError { code: code.into(), column_name: column_name.into(), message, short_message: short.into() }
}

fn normalized_type(column: &ColumnMeta) -> String {
    column.data_type.clone().unwrap_or_else(|| {
        column.column_type
            .trim()
            .to_ascii_lowercase()
            .split(|ch: char| ch == '(' || ch.is_whitespace())
            .find(|part| !part.is_empty())
            .unwrap_or("")
            .to_string()
    })
}

fn parse_type_numbers(column_type: &str) -> (Option<usize>, Option<usize>) {
    let Some(open) = column_type.find('(') else { return (None, None); };
    let Some(close) = column_type.rfind(')') else { return (None, None); };
    let mut parts = column_type[open + 1..close].split(',').map(|part| part.trim().parse::<usize>().ok());
    (parts.next().flatten(), parts.next().flatten())
}

fn primary_keys(table: &TableMeta) -> Vec<String> {
    table.columns.iter().filter(|column| column.is_primary_key).map(|column| column.column_name.clone()).collect()
}

fn pk_signature(row: &HashMap<String, String>, keys: &[String]) -> Option<Vec<String>> {
    let values = keys.iter().map(|key| row.get(key).cloned().unwrap_or_default()).collect::<Vec<_>>();
    if values.iter().all(|value| !value.trim().is_empty()) { Some(values) } else { None }
}

fn validate_required(column: &ColumnMeta, value: &str) -> Result<(), ValidationError> {
    if (column.is_primary_key || !column.is_nullable) && value.trim().is_empty() {
        return Err(err("required", &column.column_name, format!("字段 {} 不能为空", column.column_name), "不能为空"));
    }
    Ok(())
}

fn validate_scalar(column: &ColumnMeta, value: &str) -> Result<(), ValidationError> {
    validate_required(column, value)?;
    let raw = value.trim();
    if raw.is_empty() { return Ok(()); }
    let typ = normalized_type(column);
    match typ.as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" => {
            raw.parse::<i128>().map_err(|_| err("invalid-integer", &column.column_name, format!("字段 {} 需要整数", column.column_name), "整数格式错误"))?;
        }
        "decimal" | "numeric" | "dec" | "fixed" => {
            if !raw.chars().enumerate().all(|(i, ch)| ch.is_ascii_digit() || ch == '.' || (i == 0 && ch == '-')) || raw.matches('.').count() > 1 {
                return Err(err("invalid-decimal", &column.column_name, format!("字段 {} 需要数字", column.column_name), "数字格式错误"));
            }
            let (parsed_precision, parsed_scale) = parse_type_numbers(&column.column_type);
            let precision = column.numeric_precision.map(|v| v as usize).or(parsed_precision);
            let scale = column.numeric_scale.map(|v| v as usize).or(parsed_scale);
            let normalized = raw.trim_start_matches('-');
            let pieces = normalized.split('.').collect::<Vec<_>>();
            let whole = pieces[0].len();
            let frac = pieces.get(1).map(|part| part.len()).unwrap_or(0);
            if let Some(scale) = scale { if frac > scale { return Err(err("decimal-scale", &column.column_name, format!("字段 {} 小数位最多 {} 位", column.column_name, scale), "小数位超限")); } }
            if let Some(precision) = precision { if whole + frac > precision { return Err(err("decimal-precision", &column.column_name, format!("字段 {} 精度最多 {} 位", column.column_name, precision), "精度超限")); } }
        }
        "float" | "double" | "real" => {
            raw.parse::<f64>().map_err(|_| err("invalid-float", &column.column_name, format!("字段 {} 需要数字", column.column_name), "数字格式错误"))?;
        }
        "char" | "varchar" | "binary" | "varbinary" => {
            let (parsed_len, _) = parse_type_numbers(&column.column_type);
            let max = column.character_maximum_length.map(|v| v as usize).or(parsed_len);
            if let Some(max) = max { if value.chars().count() > max { return Err(err("length-overflow", &column.column_name, format!("字段 {} 最多 {} 个字符", column.column_name, max), "长度超限")); } }
        }
        "json" => { serde_json::from_str::<serde_json::Value>(raw).map_err(|_| err("invalid-json", &column.column_name, format!("字段 {} 需要合法 JSON", column.column_name), "JSON 格式错误"))?; }
        "date" => if !is_date(raw) { return Err(err("invalid-date", &column.column_name, format!("字段 {} 需要 date 格式", column.column_name), "日期时间格式错误")); },
        "datetime" | "timestamp" => if !is_datetime(raw) { return Err(err("invalid-datetime", &column.column_name, format!("字段 {} 需要 datetime 格式", column.column_name), "日期时间格式错误")); },
        "time" => if !is_time(raw) { return Err(err("invalid-time", &column.column_name, format!("字段 {} 需要 time 格式", column.column_name), "日期时间格式错误")); },
        "year" => if raw.len() != 4 || !raw.chars().all(|ch| ch.is_ascii_digit()) { return Err(err("invalid-year", &column.column_name, format!("字段 {} 需要 year 格式", column.column_name), "日期时间格式错误")); },
        "bool" | "boolean" => if !matches!(raw.to_ascii_lowercase().as_str(), "0" | "1" | "true" | "false") { return Err(err("invalid-boolean", &column.column_name, format!("字段 {} 需要布尔值 0/1/true/false", column.column_name), "布尔格式错误")); },
        "enum" => if !column.enum_values.is_empty() && !column.enum_values.iter().any(|item| item == raw) { return Err(err("invalid-enum", &column.column_name, format!("字段 {} 必须是：{}", column.column_name, column.enum_values.join("、")), "枚举值错误")); },
        "set" => if !column.set_values.is_empty() && raw.split(',').map(str::trim).any(|item| !column.set_values.iter().any(|allowed| allowed == item)) { return Err(err("invalid-set", &column.column_name, format!("字段 {} 只能包含：{}", column.column_name, column.set_values.join("、")), "集合值错误")); },
        _ => {}
    }
    Ok(())
}

fn is_date(value: &str) -> bool { value.len() == 10 && value.chars().enumerate().all(|(i, ch)| matches!(i, 4 | 7) == (ch == '-') && (matches!(i, 4 | 7) || ch.is_ascii_digit())) }
fn is_datetime(value: &str) -> bool { value.len() == 19 && &value[10..11] == " " && is_date(&value[..10]) && is_time(&value[11..]) }
fn is_time(value: &str) -> bool { value.len() == 8 && value.chars().enumerate().all(|(i, ch)| matches!(i, 2 | 5) == (ch == ':') && (matches!(i, 2 | 5) || ch.is_ascii_digit())) }

pub fn validate_cell_value(table: &TableMeta, rows: &[HashMap<String, String>], row_index: usize, column_name: &str, value: &str) -> Result<(), ValidationError> {
    let Some(column) = table.columns.iter().find(|column| column.column_name == column_name) else { return Ok(()); };
    validate_scalar(column, value)?;
    let keys = primary_keys(table);
    if keys.iter().any(|key| key == column_name) {
        let Some(row) = rows.get(row_index) else { return Ok(()); };
        let mut next = row.clone();
        next.insert(column_name.into(), value.into());
        if let Some(signature) = pk_signature(&next, &keys) {
            let duplicate = rows.iter().enumerate().any(|(index, candidate)| index != row_index && pk_signature(candidate, &keys).map(|candidate_signature| candidate_signature == signature).unwrap_or(false));
            if duplicate { return Err(err("duplicate-primary-key", column_name, "主键重复，不能保存".into(), "主键重复")); }
        }
    }
    Ok(())
}

pub fn validate_row_draft(table: &TableMeta, rows: &[HashMap<String, String>], draft: &HashMap<String, String>) -> Result<(), ValidationError> {
    for column in &table.columns {
        validate_scalar(column, draft.get(&column.column_name).map(String::as_str).unwrap_or(""))?;
    }
    let keys = primary_keys(table);
    if let Some(signature) = pk_signature(draft, &keys) {
        let duplicate = rows.iter().any(|row| pk_signature(row, &keys).map(|candidate| candidate == signature).unwrap_or(false));
        if duplicate { return Err(err("duplicate-primary-key", keys.first().map(String::as_str).unwrap_or(""), "主键重复，不能保存".into(), "主键重复")); }
    }
    Ok(())
}

pub fn mysql_error_code_message(code: &str) -> Option<String> {
    match code {
        "1062" => Some("主键重复，不能保存".into()),
        "1048" => Some("字段不能为空".into()),
        "1264" => Some("数值超出范围".into()),
        "1366" => Some("字段类型不匹配".into()),
        "1406" => Some("字段长度超限".into()),
        "1292" => Some("日期或时间格式错误".into()),
        _ => None,
    }
}

pub fn mysql_error_message(error: &sqlx::Error) -> Option<String> {
    match error {
        sqlx::Error::Database(db_error) => db_error.code().as_deref().and_then(mysql_error_code_message),
        _ => None,
    }
}
```

- [ ] **Step 6: Run tests**

Run:

```powershell
cd E:\project\dbscout-workbench\src-tauri; cargo test validation::tests
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src-tauri/src/validation.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/db.rs src-tauri/src/demo.rs src-tauri/src/commands.rs
git commit -m "feat: add backend write validation module"
```

---

### Task 6: Use Rust validation in backend commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/commands.rs`

- [ ] **Step 1: Write command-level tests**

Add tests to `commands.rs` test module:

```rust
#[test]
fn demo_update_cell_validation_rejects_invalid_integer() {
    let table = TableMeta {
        table_name: "player".into(),
        table_comment: String::new(),
        columns: vec![cm("id", true), cm("level", false)],
    };
    let rows = vec![HashMap::from([("id".into(), "1".into()), ("level".into(), "10".into())])];

    let err = crate::validation::validate_cell_value(&table, &rows, 0, "level", "abc").unwrap_err();

    assert_eq!(err.code, "invalid-integer");
    assert!(err.message.contains("整数"));
}

#[test]
fn mysql_error_mapping_covers_common_write_failures() {
    assert_eq!(crate::validation::mysql_error_code_message("1062"), Some("主键重复，不能保存".to_string()));
    assert_eq!(crate::validation::mysql_error_code_message("1048"), Some("字段不能为空".to_string()));
    assert_eq!(crate::validation::mysql_error_code_message("1366"), Some("字段类型不匹配".to_string()));
}
```

- [ ] **Step 2: Run tests to verify failure if commands are not wired**

Run:

```powershell
cd E:\project\dbscout-workbench\src-tauri; cargo test commands::tests::demo_update_cell_validation_rejects_invalid_integer commands::tests::mysql_error_mapping_covers_common_write_failures
```

Expected: PASS for pure helper tests after Task 5; command paths still need wiring in the next step.

- [ ] **Step 3: Wire `update_cell` demo validation**

In `commands.rs` demo `update_cell` path, replace the direct duplicate helper call with:

```rust
if let Err(error) = crate::validation::validate_cell_value(&table, rows, row_index, &request.column_name, &request.new_value) {
    return Err(error.message);
}
```

- [ ] **Step 4: Wire `insert_row` demo validation**

In demo `insert_row`, before `rows.push(draft);`, add:

```rust
if let Err(error) = crate::validation::validate_row_draft(&table, rows, &draft) {
    return Err(error.message);
}
```

Remove the older duplicate-only `has_primary_key_conflict` check or keep it only if it delegates to `validation::validate_row_draft`.

- [ ] **Step 5: Wire MySQL error mapping**

Replace existing duplicate-only `.map_err(...)` blocks for `update_cell` and `insert_row` with:

```rust
.map_err(|error| {
    crate::validation::mysql_error_message(&error)
        .unwrap_or_else(|| format!("保存失败: {error}"))
})?
```

For insert, use `format!("插入失败: {error}")` as the fallback instead of `保存失败`.

- [ ] **Step 6: Run Rust tests**

Run:

```powershell
cd E:\project\dbscout-workbench\src-tauri; cargo test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src-tauri/src/commands.rs src-tauri/src/validation.rs
git commit -m "feat: enforce backend write validation"
```

---

### Task 7: Browser verification

**Files:**
- No source file changes required unless verification reveals a bug.

- [ ] **Step 1: Run automated tests before browser verification**

Run:

```powershell
cd E:\project\dbscout-workbench\src-tauri; cargo test
cd E:\project\dbscout-workbench; node --test src/workbench/*.test.js src/workbench/utils/*.test.js
```

Expected: Rust reports all tests passed; JS reports all tests passed.

- [ ] **Step 2: Start the app**

Run in background or terminal:

```powershell
cd E:\project\dbscout-workbench; npm run dev
```

Expected: Vite serves the app on port `1431`.

- [ ] **Step 3: Open browser**

Use Chrome DevTools MCP or browser tooling to navigate to:

```text
http://localhost:1431
```

Expected: DB Scout Workbench opens with Stress Demo data.

- [ ] **Step 4: Verify primary-key duplicate edit**

Manual/browser steps:

1. Open a table with `id` primary key.
2. Edit row 1 `id` to row 2's `id`.
3. Commit edit.

Expected:

- Old value is restored.
- Status bar shows `主键重复，不能保存`.
- Cell feedback shows `主键重复`.

- [ ] **Step 5: Verify invalid integer edit**

Steps:

1. Edit an `int` field such as `status` or `priority`.
2. Enter `abc`.
3. Commit edit.

Expected:

- Old value is restored.
- Status bar shows `字段 <name> 需要整数`.
- Feedback shows `整数格式错误`.

- [ ] **Step 6: Verify length overflow**

Steps:

1. Edit a `varchar(32)` field.
2. Enter a string longer than 32 characters.
3. Commit edit.

Expected:

- Old value is restored.
- Status bar shows `最多 32 个字符`.
- Feedback shows `长度超限`.

- [ ] **Step 7: Verify insert row validation**

Steps:

1. Focus the insert row.
2. Enter an existing primary key.
3. Save insert row.

Expected:

- Draft remains visible.
- No insert occurs.
- Status bar shows `主键重复，不能保存`.

- [ ] **Step 8: Verify paste validation**

Steps:

1. Copy a two-line value: first line valid integer, second line `bad`.
2. Paste into an integer column spanning two rows.

Expected:

- Valid cell saves.
- Invalid cell remains unchanged.
- Status bar shows `已粘贴 1 个单元格，1 个格式错误未保存`.

- [ ] **Step 9: Document verification results**

Record results in the final response as:

```text
Browser verification:
- Primary-key duplicate edit: pass/fail
- Invalid integer edit: pass/fail
- Length overflow: pass/fail
- Insert duplicate PK: pass/fail
- Paste mixed valid/invalid: pass/fail
```

---

### Task 8: Final full verification and push decision

**Files:**
- No source file changes unless verification reveals a defect.

- [ ] **Step 1: Run full Rust tests**

Run:

```powershell
cd E:\project\dbscout-workbench\src-tauri; cargo test
```

Expected: all Rust tests pass.

- [ ] **Step 2: Run full JS tests**

Run:

```powershell
cd E:\project\dbscout-workbench; node --test src/workbench/*.test.js src/workbench/utils/*.test.js
```

Expected: all JS tests pass.

- [ ] **Step 3: Check git status**

Run:

```powershell
git status --short
```

Expected: only intentional source/test changes are listed.

- [ ] **Step 4: Commit any remaining verified changes**

Use a focused commit message:

```powershell
git add src/workbench src-tauri/src
git commit -m "feat: enforce database write validation"
```

Expected: commit created.

- [ ] **Step 5: Ask before pushing**

Ask the user whether to push to `main` or keep changes local. Do not push unless explicitly requested.

---

## Self-Review Notes

- Spec coverage: The plan covers shared frontend validation, Rust validation, metadata expansion, inline edits, detail saves through existing selected-cell path, insert rows, paste, import, mock backend, demo/stress backend, MySQL error mapping, automated tests, and browser verification.
- Placeholder scan: No `TBD`, `TODO`, or ambiguous "add validation" steps remain; each implementation task includes concrete files, code, commands, and expected outcomes.
- Type consistency: Frontend functions are consistently named `columnConstraint`, `validateCellValue`, `validateRowDraft`, and `validateBatchEdits`; Rust functions are consistently named `validate_cell_value`, `validate_row_draft`, `mysql_error_code_message`, and `mysql_error_message`.
