import en from "../i18n/en.js";

const BATCH_IMPORT_ACTION = Object.freeze({
  id: "batch-import",
  labelKey: "toolbar.batchImport",
  hintKey: "toolbar.batchImportHint",
  icon: "import",
});

const CURRENT_TABLE_IMPORT_ACTION = Object.freeze({
  id: "import-current",
  labelKey: "toolbar.importCurrent",
  hintKey: "toolbar.importCurrentHint",
  icon: "import",
});

export function createTableImportToolbarActions({ busy = false, hasSession = false, readOnly = false, canImport = true, translate = (key) => en[key] ?? key } = {}) {
  const primaryDisabled = Boolean(busy || readOnly || !canImport);
  const currentTableDisabled = Boolean(busy || !hasSession || readOnly || !canImport);

  const localize = ({ labelKey, hintKey, ...action }) => ({ ...action, label: translate(labelKey), hint: translate(hintKey) });
  return {
    menuLabel: translate("toolbar.importOptions"),
    primary: {
      ...localize(BATCH_IMPORT_ACTION),
      disabled: primaryDisabled,
    },
    menuItems: [
      {
        ...localize(CURRENT_TABLE_IMPORT_ACTION),
        disabled: currentTableDisabled,
      },
    ],
    compactItems: [
      {
        ...localize(BATCH_IMPORT_ACTION),
        disabled: primaryDisabled,
        separatorBefore: true,
      },
      {
        ...localize(CURRENT_TABLE_IMPORT_ACTION),
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
