import { createApp, watch } from "vue";
import MySqlWorkbench from "./workbench/MySqlWorkbench.vue";
import "./workbench/workbench.css";

import { language } from "./workbench/i18n/index.js";
import { detectDesktopPlatform } from "./workbench/utils/desktopPlatform.js";
import { setWorkspaceSnapshotOverride } from "./workbench/utils/workspacePersistence.js";
import { useTableFolderStore } from "./workbench/composables/tableFolderStore.js";
import {
  buildTableFolderSnapshot,
  isTableFolderWindowRole,
  resolveWindowRole,
  setCurrentWindowRole,
} from "./workbench/utils/windowRole.js";
import { installGlobalErrorHandlers } from "./workbench/utils/frontendErrorLog.js";

// Platform attribute so CSS can scope macOS-only styling (menus, fonts,
// scrollbars) without touching Windows; also true in the browser preview.
document.documentElement.dataset.wbPlatform = detectDesktopPlatform();

// A table folder window starts from the folder's tables and never touches the
// main window's saved tabs; decide before the workbench reads them.
const windowRole = resolveWindowRole({ resolveFolder: (id) => useTableFolderStore().getFolder(id) });
setCurrentWindowRole(windowRole);
if (isTableFolderWindowRole(windowRole)) {
  setWorkspaceSnapshotOverride(buildTableFolderSnapshot(windowRole));
  document.documentElement.dataset.wbWindow = "table-folder";
}

watch(language.locale, (locale) => {
  document.documentElement.lang = locale;
  document.title = isTableFolderWindowRole(windowRole) && windowRole.folderName
    ? `${windowRole.folderName} - Blackcat`
    : "Blackcat";
}, { immediate: true });

const app = createApp(MySqlWorkbench);
installGlobalErrorHandlers(app);
app.mount("#app");
