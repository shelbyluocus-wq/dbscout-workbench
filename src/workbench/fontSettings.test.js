import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("workbench exposes the persisted font preference through settings", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");

  assert.match(orchestrator, /import\s+\{\s*useFontPreference\s*\}\s+from\s+["']\.\/composables\/useFontPreference\.js["']/);
  assert.match(orchestrator, /useFontPreference\(\)/);
  assert.match(orchestrator, /:font-preference="fontPreference"/);
  assert.match(orchestrator, /:font-weight="fontWeight"/);
  assert.match(orchestrator, /:font-label="fontLabel"/);
  assert.match(orchestrator, /@change-font="applyFontSettings"/);
  assert.match(orchestrator, /setFontPreference\(settings\?\.preference\)/);
  assert.match(orchestrator, /setFontWeight\(settings\?\.weight\)/);

  assert.match(sidebar, /界面字体/);
  assert.match(sidebar, /class="wb-sidebar-font-icon"[^>]*>Aa</);
  assert.match(sidebar, /class="wb-sidebar-settings-action wb-sidebar-font-action"/);
  assert.match(sidebar, /<FontSettingsDialog[\s\S]*?:preference="fontPreference"[\s\S]*?:weight="fontWeight"[\s\S]*?:invoke-workbench="invokeWorkbench"[\s\S]*?@apply="emit\('change-font', \$event\)"/);
});

test("font dialog loads the searchable system picker and keeps preview actions", () => {
  const dialog = read("./components/FontSettingsDialog.vue");
  const picker = read("./components/SystemFontPicker.vue");

  assert.match(dialog, /class="wb-shortcut-dialog-overlay wb-font-dialog-overlay wb-floating-themed"/);
  assert.match(dialog, /:data-theme="theme"/);
  assert.match(dialog, /createSystemFontsController\(props\.invokeWorkbench\)/);
  assert.match(dialog, /systemFonts\.load\(\)/);
  assert.match(dialog, /<span>选择界面字体<\/span>/);
  assert.match(dialog, /<SystemFontPicker[\s\S]*?v-model="draftPreference"/);
  assert.match(dialog, /v-model:weight="draftWeight"/);
  assert.match(dialog, /:fonts="systemFonts\.fonts\.value"/);
  assert.match(dialog, /class="wb-font-preview"\s+:style="previewStyle"/);
  assert.match(dialog, /fontWeight:\s*draftWeight\.value/);
  assert.match(dialog, /class="wb-font-preview-label">效果预览/);
  assert.match(dialog, /class="wb-font-preview-sample"/);
  assert.match(dialog, /@click="restoreDefault">恢复默认/);
  assert.match(dialog, /@click="close">取消/);
  assert.match(dialog, /@click="apply">应用/);
  assert.match(dialog, /event\.key === "Escape"/);

  assert.match(picker, /type="search"/);
  assert.match(picker, /placeholder="搜索本机字体"/);
  assert.match(picker, /@keydown\.enter\.prevent="chooseCustomQuery"/);
  assert.match(picker, /aria-label="界面字体字重"/);
  assert.match(picker, /availableWeights/);
  assert.match(picker, /selectedFont\.value\?\.weights/);
  assert.match(picker, /closestAvailableWeight/);
  assert.match(picker, /emit\("update:weight",\s*normalizeFontWeight/);
  assert.match(picker, /class="wb-font-family-list"/);
  assert.match(picker, /size="7"/);
  assert.match(picker, /本机字体/);
  assert.match(picker, /fonts\.length/);
  assert.match(picker, /使用 “\{\{ customQueryFamily \}\}”/);
  assert.match(picker, /role="alert"/);
  assert.match(picker, />重试<\/button>/);
});

test("font settings remain readable and responsive in both themes", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-font-dialog\s*\{[^}]*width:\s*min\(640px,\s*calc\(100vw - 32px\)\)/s);
  assert.match(styles, /\.wb-font-dialog\s*\{[^}]*background:\s*var\(--wb-dialog-surface\)/s);
  assert.match(styles, /\.wb-font-dialog-overlay\s*\{[^}]*background:\s*var\(--wb-overlay\)[^}]*backdrop-filter:\s*blur\(1\.5px\)/s);
  assert.match(styles, /\.wb-font-dialog-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 328px\) minmax\(0, 1fr\)[^}]*grid-template-areas:\s*"controls preview"[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.wb-font-field\s*>\s*span\s*\{[^}]*font-size:\s*15px[^}]*font-weight:\s*700/s);
  assert.match(styles, /\.wb-font-search,\s*\.wb-font-family-list\s*\{[^}]*background:\s*var\(--wb-field-surface\)/s);
  assert.match(styles, /\.wb-font-family-list\s*\{[^}]*height:\s*176px[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(styles, /\.wb-font-search::placeholder\s*\{[^}]*color:\s*var\(--wb-quiet-text\)[^}]*opacity:\s*1/s);
  assert.match(styles, /--wb-font-weight-ui:\s*400/);
  assert.match(styles, /font-weight:\s*var\(--wb-font-weight-ui\)/);
  assert.match(styles, /\.wb-font-weight-field select\s*\{[^}]*height:\s*34px/s);
  assert.match(styles, /\.wb-font-preview\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(styles, /\.wb-font-preview-sample strong\s*\{[^}]*font-weight:\s*inherit/s);
  assert.match(styles, /@media\s*\(max-width:\s*560px\)[\s\S]*?grid-template-areas:\s*"preview"\s*"controls"[\s\S]*?\.wb-font-preview\s*\{[^}]*border-bottom:/s);
  assert.match(styles, /@media\s*\(max-width:\s*420px\)[\s\S]*?\.wb-font-dialog-footer-actions\s*\{[\s\S]*?grid-template-columns:\s*1fr 1fr/s);
});

test("system font command is wired across desktop and browser modes", () => {
  const commands = read("../../src-tauri/src/commands.rs");
  const lib = read("../../src-tauri/src/lib.rs");
  const systemFonts = read("../../src-tauri/src/system_fonts.rs");
  const mock = read("./mock/mockBackend.js");

  assert.match(commands, /pub async fn list_system_fonts\(\)/);
  assert.match(commands, /spawn_blocking\(system_fonts::list_system_font_families\)/);
  assert.match(lib, /mod system_fonts;/);
  assert.match(lib, /commands::list_system_fonts/);
  assert.match(systemFonts, /SystemFontFamilies/);
  assert.match(systemFonts, /fontdb::Database/);
  assert.match(systemFonts, /load_font_file/);
  assert.match(systemFonts, /load_system_fonts/);
  assert.match(systemFonts, /face_name_matches_weight/);
  assert.match(mock, /command === "list_system_fonts"/);
});
