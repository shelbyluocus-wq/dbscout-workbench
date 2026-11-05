import { inject } from "vue";

// Provided by the workbench root so the table folder page, deep inside the
// split layout, can open windows and tabs and load table lists without a
// prop chain: { loadTables, openWindow, openHere, openTable, notify, confirm }.
export const TABLE_FOLDER_CONTEXT = Symbol("table-folder-context");

export function useTableFolderContext() {
  return inject(TABLE_FOLDER_CONTEXT, null);
}
