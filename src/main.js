import { createApp, watch } from "vue";
import MySqlWorkbench from "./workbench/MySqlWorkbench.vue";
import "./workbench/workbench.css";

import { language } from "./workbench/i18n/index.js";

watch(language.locale, (locale) => {
  document.documentElement.lang = locale;
  document.title = "Blackcat";
}, { immediate: true });

createApp(MySqlWorkbench).mount("#app");
