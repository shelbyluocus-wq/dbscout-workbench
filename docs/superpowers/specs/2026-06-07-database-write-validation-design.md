# Database Write Validation Design

## Context

DB Scout Workbench currently validates some write operations, but validation is fragmented. Insert rows have primary-key checks, recent inline edits now reject duplicate primary keys for loaded rows, and real MySQL can reject some invalid writes at execution time. However, the data grid, right-side detail editor, paste flows, import flows, mock backend, demo/stress backend, and real MySQL error mapping do not share a complete validation contract.

Because this is a database workbench, invalid writes must not be silently accepted. The application needs a consistent validation layer that prevents duplicate primary keys, values incompatible with column types, NOT NULL violations, length overflow, precision/scale overflow, invalid dates, invalid JSON, and unsupported enum/set values across every write entry point.

## Goals

- Route every write entry point through a shared validation model.
- Reject invalid data before saving when the rule is knowable from metadata.
- Keep demo/stress and mock backends from accepting data that real database semantics would reject.
- Map real MySQL failures to clear Chinese messages when the database is the final enforcement layer.
- Preserve good editing ergonomics: restore invalid inline values, keep insert drafts, show cell-level errors, and use short save/error feedback.
- Add strong automated coverage and perform browser-driven manual verification when necessary.

## Non-goals

- Full SQL expression validation for generated/default expressions in data editing.
- Foreign-key validation in the first implementation. MySQL should remain the final authority for foreign keys, with user-friendly error mapping added later if needed.
- Advanced import conflict resolution such as "import only valid rows". The first implementation should default to strict import blocking when validation errors exist.

## Architecture

### Frontend validation utility

Add a focused frontend utility, `src/workbench/utils/valueValidation.js`, responsible for converting table metadata into constraints and validating writes.

The utility should expose behavior-oriented functions, for example:

- `columnConstraint(column)` — normalize a column's write constraints.
- `validateCellValue({ table, rows, row, columnName, value })` — validate a single inline edit.
- `validateRowDraft({ table, rows, draft, draftRows })` — validate an inserted row.
- `validateBatchEdits({ table, rows, edits })` — validate paste/import-like batches.

The utility should return structured errors rather than plain strings:

```js
{
  valid: false,
  errors: [
    {
      rowIndex: 0,
      columnName: "id",
      code: "duplicate-primary-key",
      message: "主键重复，不能保存",
      shortMessage: "主键重复",
    },
  ],
}
```

This keeps UI behavior consistent while letting status bars, toasts, cell errors, and import reports choose the right level of detail.

### Rust validation module

Add `src-tauri/src/validation.rs` for backend validation in demo/stress paths and reusable MySQL error mapping.

Responsibilities:

- Parse `ColumnMeta`/column type strings into validation constraints.
- Validate `update_cell` and `insert_row` inputs for demo/stress data.
- Detect duplicate primary-key updates and inserts.
- Validate basic scalar types and lengths before mutating in-memory rows.
- Map MySQL errors to user-facing Chinese messages.

### Metadata expansion

Current `ColumnMeta` is too thin for complete validation. Extend it with optional fields that can be filled by real MySQL and derived for demo/stress/mock data:

- `data_type`
- `character_maximum_length`
- `numeric_precision`
- `numeric_scale`
- `is_unsigned`
- `is_auto_increment`
- `enum_values`
- `set_values`
- `is_generated`
- `default_value`
- `default_mode`

Existing callers must continue to work. New fields should be optional or have sensible defaults so old table metadata does not break.

## Validation Rules

### Primary keys

- Reject duplicate primary-key values for inserts.
- Reject duplicate primary-key values for updates.
- Support composite primary keys.
- Ignore the current row when validating an update.
- Treat incomplete composite primary keys as invalid for insert when required by NOT NULL/primary-key constraints.

### NULL and empty values

- Primary-key columns cannot be empty/null.
- NOT NULL columns cannot be empty/null unless a backend default can safely fill the value during insert.
- Preserve the existing UI convention for empty strings, but validate them according to the target column's nullability and operation.

### Numeric types

- Integer types reject non-integers and decimal strings.
- Integer types enforce signed/unsigned range when metadata is available.
- Decimal/numeric types reject non-numeric values.
- Decimal/numeric types enforce precision and scale.
- Float/double/real reject non-numeric values but do not enforce exact precision.

### String and binary types

- `char`, `varchar`, `binary`, and `varbinary` enforce length when metadata or parsed type length is available.
- Text/blob families accept larger content without first-version length checks unless metadata is explicit.

### Date/time types

- `date`, `datetime`, `timestamp`, `time`, and `year` reject clearly invalid formats.
- Accepted formats should match common MySQL text formats:
  - `YYYY-MM-DD`
  - `YYYY-MM-DD HH:mm:ss`
  - `HH:mm:ss`
  - `YYYY`

### JSON

- JSON columns reject invalid JSON strings.
- Empty values follow nullability rules.

### Boolean

- `bool`/`boolean` accept `0`, `1`, `true`, and `false`.
- Other non-empty values are rejected.

### enum/set

- Enum values must be one of the parsed allowed values.
- Set values must be a comma-separated subset of allowed values.

## Write Entry Points

### Inline cell editing

Before calling `update_cell`, validate the cell. On failure:

- Restore the old value.
- Set a cell-level error.
- Set status text to the detailed error message.
- Emit save feedback with the short error message.
- Do not call the backend.

### Right-side detail editor

The detail editor uses the same selected-cell save path and should inherit the same validation behavior.

### Insert rows

Before calling `insert_row`, validate the draft row against loaded rows and other pending insert drafts. On failure:

- Keep the draft intact.
- Focus the first invalid field when possible.
- Set status text to the detailed error message.
- Do not call the backend.

### Paste

For paste into existing cells:

- Validate each target cell independently.
- Commit valid cells.
- Skip invalid cells.
- Record cell-level errors for skipped cells.
- Show a summary such as `已粘贴 15 个单元格，2 个格式错误未保存`.

For paste into insert rows:

- Validate each resulting draft row before insert.
- Stop at the first invalid insert row for keyboard workflows, preserving user input.

### Import

Import should run a batch validation pass before executing writes.

- If any validation error exists, do not execute the import.
- Show an error report in the import dialog with Excel row number, field name, raw value, and reason.
- Support exporting the report.

## Backend Behavior

### Demo/stress backend

`update_cell` and `insert_row` must validate values before mutating `demo_rows`.

- Duplicate primary keys return `主键重复，不能保存`.
- Type, NULL, length, date/time, JSON, and enum/set failures return clear validation messages.

### Mock backend

Mock commands should mirror frontend/Rust validation enough for browser-only development:

- `update_cell` rejects duplicate primary keys and invalid values.
- `insert_row` rejects duplicate primary keys and invalid values.

### Real MySQL backend

Before executing writes, validate what can be known from metadata. After execution, map MySQL database errors:

- `1062` → `主键重复，不能保存` or `唯一键重复，不能保存` when distinguishable.
- `1048` → `字段不能为空`.
- `1264` → `数值超出范围`.
- `1366` → `字段类型不匹配`.
- `1406` → `字段长度超限`.
- `1292` → `日期或时间格式错误`.

## Testing Plan

### Frontend unit tests

Add `src/workbench/valueValidation.test.js` covering:

- Single and composite duplicate primary keys.
- NOT NULL empty values.
- Integer types, non-integers, decimals in integer fields, and ranges.
- Decimal precision and scale.
- Float/double invalid values.
- `char`/`varchar` length overflow.
- Date/time/year formats.
- Valid and invalid JSON.
- Boolean accepted and rejected values.
- Enum/set accepted and rejected values.
- Batch validation output shape.

### Frontend workflow tests

Extend existing composable tests:

- Inline invalid cell edits do not call `update_cell`.
- Inline invalid cell edits restore values and emit error feedback.
- Detail-panel saves use the same validation.
- Insert invalid drafts do not call `insert_row` and remain editable.
- Paste skips invalid target cells and records errors.
- Import blocks execution when the preflight report has errors.

### Mock backend tests

Extend `mockBackend.test.js`:

- `update_cell` rejects duplicate primary keys and invalid types.
- `insert_row` rejects duplicate primary keys and invalid types.
- Length and NOT NULL failures are represented.

### Rust tests

Add `validation.rs` tests:

- Column type parsing.
- Duplicate primary-key update and insert checks.
- Numeric, string, date/time, JSON, boolean, enum/set validation.
- MySQL error-code mapping.

Extend command tests for demo/stress command behavior where practical.

### Browser verification

After automated tests pass, run the app when needed and verify:

1. Stress Demo table opens.
2. Editing a primary key to an existing value is rejected and shows feedback.
3. Entering `abc` into an `int` field is rejected.
4. Entering overlong text into a limited `varchar` field is rejected.
5. Entering `hello` into `datetime` is rejected.
6. Duplicate primary key in an insert row is rejected.
7. Paste with mixed valid/invalid values saves only valid cells and reports skipped errors.
8. Importing invalid data shows an error report and does not execute writes.

## Acceptance Criteria

- All write entry points use the shared validation model or an equivalent backend validator.
- Invalid values are not saved in frontend state, mock state, demo/stress state, or real MySQL.
- Errors are specific and user-facing, not generic `保存失败` unless no better mapping is available.
- Automated tests cover validator rules and write workflows.
- Browser verification is performed for high-risk UI flows when implementation is complete.
