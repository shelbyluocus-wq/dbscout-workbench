import { createApp, watch } from "vue";
import MySqlWorkbench from "./workbench/MySqlWorkbench.vue";
import "./workbench/workbench.css";

import { language } from "./workbench/i18n/index.js";
import { detectDesktopPlatform } from "./workbench/utils/desktopPlatform.js";

// Platform attribute so CSS can scope macOS-only styling (menus, fonts,
// scrollbars) without touching Windows; also true in the browser preview.
document.documentElement.dataset.wbPlatform = detectDesktopPlatform();

watch(language.locale, (locale) => {
  document.documentElement.lang = locale;
  document.title = "Blackcat";
}, { immediate: true });

createApp(MySqlWorkbench).mount("#app");
