const BATCH_IMPORT_ACTION = Object.freeze({
  id: "batch-import",
  label: "批量导入",
  hint: "导入多张表",
  icon: "import",
});

const CURRENT_TABLE_IMPORT_ACTION = Object.freeze({
  id: "import-current",
  label: "导入",
  hint: "向当前打开的数据表导入",
  icon: "import",
});

export function createTableImportToolbarActions({ busy = false, hasSession = false, readOnly = false, canImport = true } = {}) {
  const primaryDisabled = Boolean(busy || readOnly || !canImport);
  const currentTableDisabled = Boolean(busy || !hasSession || readOnly || !canImport);

  return {
    menuLabel: "导入选项",
    primary: {
      ...BATCH_IMPORT_ACTION,
      disabled: primaryDisabled,
    },
    menuItems: [
      {
        ...CURRENT_TABLE_IMPORT_ACTION,
        disabled: currentTableDisabled,
      },
    ],
    compactItems: [
      {
        ...BATCH_IMPORT_ACTION,
        disabled: primaryDisabled,
        separatorBefore: true,
      },
      {
        ...CURRENT_TABLE_IMPORT_ACTION,
        disabled: currentTableDisabled,
      },
    ],
  };
}

export function resolveTableImportToolbarEvent(actionId) {
  if (actionId === BATCH_IMPORT_ACTION.id) return "batch-import";
  if (actionId === CURRENT_TABLE_IMPORT_ACTION.id) return "import";
  return "";
}
