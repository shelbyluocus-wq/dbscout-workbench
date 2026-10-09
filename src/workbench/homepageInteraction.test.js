import { readLocalizedContractSource } from "./test-support/localizedContractSource.js";
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => readLocalizedContractSource(join(__dirname, path), "utf8");

test("homepage tab stays first across restoration and tab dragging", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const tabs = read("./components/WorkbenchTabs.vue");

  assert.match(orchestrator, /normalizeHomeTabOrder\(workspace\)/);
  assert.match(tabs, /:draggable="!tab\.opening && tabKind\(tab\) !== 'home'"/);
  assert.match(tabs, /function\s+pinHomeTabFirst\(tabs\)/);
  assert.match(tabs, /function\s+normalizeDropPosition\(tabId, position\)/);
  assert.match(tabs, /tabKind\(targetTab\)\s*===\s*["']home["']/);
  assert.match(tabs, /pinHomeTabFirst\(previewDragOrder/);
});

test("homepage box selection starts outside the table-name column", () => {
  const tableList = read("./components/DatabaseTableList.vue");
  const beginBoxSelection = tableList.match(/function\s+beginBoxSelection\(event\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(beginBoxSelection, /\.wb-dbhome-object-name/);
  assert.match(beginBoxSelection, /\.wb-dbhome-table-header/);
  assert.match(beginBoxSelection, /\.wb-dbhome-empty-list/);
  assert.doesNotMatch(beginBoxSelection, /\.wb-dbhome-object-row/);
  assert.match(beginBoxSelection, /event\.preventDefault\(\)/);
  assert.match(tableList, /box\.width\s*<\s*4\s*\|\|\s*box\.height\s*<\s*4/);
});

test("homepage selection clears after clicks elsewhere without cancelling box selection", () => {
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");

  assert.match(home, /createHomepageSelectionDismissal/);
  assert.match(home, /document\.addEventListener\("click",\s*selectionDismissal\.handleDocumentClick,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /document\.removeEventListener\("click",\s*selectionDismissal\.handleDocumentClick,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /@box-selection-complete="selectionDismissal\.markBoxSelectionComplete"/);
  assert.match(tableList, /emit\("box-selection-complete"\)/);
});

test("homepage direct typing is scoped to the focused pane and scrolls to its match", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");
  const styles = read("./workbench.css");

  assert.match(pane, /:active="isFocused"/);
  assert.match(home, /createHomepageTypeahead/);
  assert.match(home, /isEditableTypeaheadTarget/);
  assert.match(home, /document\.addEventListener\("keydown",\s*handleTypeaheadKeydown,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /scrollTableIntoView/);
  assert.match(home, /class="wb-dbhome-typeahead"/);
  assert.match(home, /highlightSearchRanges\(typeaheadResultLabel\.value,\s*typeahead\.matchRanges\.value\)/);
  assert.match(home, /v-html="typeaheadResultHtml"/);
  assert.match(home, /:typeahead-query="typeahead\.query\.value"/);
  assert.match(tableList, /typeaheadQuery:\s*\{\s*type:\s*String/);
  assert.match(tableList, /typeaheadNameRanges\(table,\s*typeaheadQuery\)/);
  assert.match(tableList, /matchTableSearch\(table,\s*query,\s*\{\s*includedKinds:\s*\["tableName"\]\s*\}\)/);
  assert.doesNotMatch(tableList, /tableComment:[^\n]*typeahead/);
  assert.match(tableList, /function\s+scrollTableIntoView\(name,/);
  assert.match(styles, /\.wb-dbhome-typeahead-result mark\s*\{[^}]*background:\s*var\(--wb-mark-surface\)/s);
});

test("homepage arrow keys move table selection and keep the target visible", () => {
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");
  const controller = read("./composables/useDatabaseHome.js");

  assert.match(home, /key !== "ArrowUp" && key !== "ArrowDown"/);
  assert.match(home, /isHomeTableNavigationTarget\(event\.target\)/);
  assert.match(home, /\.wb-tab\[data-kind="home"\]\.active/);
  assert.match(home, /if \(handleHomeArrowKeydown\(event\)\) \{[\s\S]*?event\.stopPropagation/);
  assert.match(home, /const delta = key === "ArrowDown" \? 1 : -1/);
  assert.match(home, /controller\.moveSelection\(delta, event\)/);
  assert.match(home, /typeahead\.dismiss\(\)/);
  assert.match(home, /scrollTableIntoView\?\.\(name, \{ block: "nearest" \}\)/);
  assert.match(tableList, /function scrollTableIntoView\(name, \{ block = "center" \} = \{\}\)/);
  assert.match(tableList, /block === "nearest"/);
  assert.match(controller, /function moveSelection\(delta, event = \{\}\)/);
  assert.match(controller, /selectTable\(nextName, \{ shiftKey: Boolean\(event\.shiftKey\) \}\)/);
});

test("homepage search keyboard navigation selects matches and Enter opens the active result", () => {
  const home = read("./components/DatabaseHome.vue");

  assert.match(home, /if \(target === searchInputRef\.value\) return true/);
  assert.match(home, /const searchNavigationName = ref\(""\)/);
  assert.match(home, /function moveSearchSelection\(delta, event = \{\}\)/);
  assert.match(home, /currentIndex < 0[\s\S]*?\? \(delta > 0 \? 0 : tables\.length - 1\)/);
  assert.match(home, /function openSearchResult\(\)[\s\S]*?navigatedTable\?\.tableName \|\| tables\[0\]\?\.tableName[\s\S]*?openTable\(name\)/);
  assert.match(home, /function handleSearchKeydown\(event\) \{[\s\S]*?handleHomeArrowKeydown\(event\)[\s\S]*?String\(event\.key \|\| ""\) !== "Enter"[\s\S]*?openSearchResult\(\)/);
  assert.match(home, /ref="searchInputRef"[\s\S]*?@input="setQuery\(\$event\.target\.value\)"[\s\S]*?@keydown="handleSearchKeydown"/);
});

test("homepage search uses a full-height clear target and returns focus to the field", () => {
  const home = read("./components/DatabaseHome.vue");
  const styles = read("./workbench.css");

  assert.match(home, /class="wb-dbhome-search-clear"[\s\S]*?aria-label="清除搜索"[\s\S]*?@mousedown\.prevent[\s\S]*?@click\.stop="clearSearchQuery"/);
  assert.match(home, /function clearSearchQuery\(\) \{[\s\S]*?controller\.setQuery\(""\)[\s\S]*?searchInputRef\.value\?\.focus\(\)/);
  assert.match(styles, /\.wb-dbhome-search-clear\s*\{[^}]*inset:\s*0 0 0 auto[^}]*width:\s*34px[^}]*height:\s*100%/s);
  assert.match(styles, /\.wb-dbhome-search input::-webkit-search-cancel-button\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.wb-dbhome-search-clear:hover:not\(:disabled\),[\s\S]*?\.wb-dbhome-search-clear:active:not\(:disabled\)\s*\{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.wb-dbhome-search-clear:hover:not\(:disabled\) svg\s*\{[^}]*background:\s*var\(--wb-accent-soft\)/s);
  assert.match(styles, /\.wb-dbhome-search-clear:focus-visible svg\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px/s);
});

test("homepage Enter opens tables selected from the homepage tab", () => {
  const home = read("./components/DatabaseHome.vue");

  assert.match(home, /function\s+handleHomeEnterKeydown\(event\)/);
  assert.match(home, /target === root \|\| target\?\.closest\?\.\('\.wb-tab\[data-kind="home"\]\.active'\)/);
  assert.match(home, /controller\.selectedNames\.value\.forEach\(\(name\) => openTable\(name\)\)/);
  assert.match(home, /if \(typeahead\.handleKeydown\(event\)\)[\s\S]*?if \(handleHomeEnterKeydown\(event\)\)/);
});

test("homepage Enter on a ctrl or shift selected row opens every selected table", () => {
  const tableList = read("./components/DatabaseTableList.vue");

  assert.match(tableList, /import\s+\{\s*homeEnterOpenNames\s*\}\s+from\s+"\.\.\/utils\/homeEnterOpen\.js"/);
  assert.match(tableList, /function\s+openEnteredTables\(focusedName = ""\)\s*\{[\s\S]*?homeEnterOpenNames\(focusedName,\s*props\.selectedNames\)/);
  assert.match(tableList, /function\s+handleRowOpen\(table\)\s*\{[\s\S]*?if\s*\(!selectedSet\.value\.has\(name\)\)\s*selectForAction\(table\);[\s\S]*?openEnteredTables\(name\)/);
  assert.match(tableList, /if\s*\(key === "Enter"\)\s*\{[\s\S]*?openEnteredTables\(\)/);
});

test("homepage search highlights matching table names and comments in visible rows", () => {
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");
  const styles = read("./workbench.css");

  assert.match(home, /:search-query="controller\.query\.value"/);
  assert.match(tableList, /visibleSearchMatches\s*=\s*computed/);
  assert.match(tableList, /visibleRows\.value\.map/);
  assert.match(tableList, /parseSearchKeywords\(props\.searchQuery\)/);
  assert.match(tableList, /matchTableKeywords\(table,\s*keywords\)/);
  assert.match(tableList, /\.\.\.keywordMatch\.nameRanges/);
  assert.match(tableList, /tableComment:\s*keywordMatch\.commentRanges/);
  assert.match(tableList, /v-html="highlightedTableField\(table, 'tableName'\)"/);
  assert.match(tableList, /v-html="highlightedTableField\(table, 'tableComment'\)"/);
  assert.match(styles, /\.wb-dbhome-object-name-button mark,[\s\S]*?background:\s*var\(--wb-mark-surface\)/);
});

test("homepage table favorites use aligned accessible star controls", () => {
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");
  const styles = read("./workbench.css");

  assert.match(home, /useTableFavoriteStore/);
  assert.match(home, /:favorite-names="favoriteTableNames"/);
  assert.match(home, /@toggle-favorite="toggleTableFavorite"/);
  assert.match(home, /function\s+toggleTableFavorite\(name\)[\s\S]*?const\s+favorite\s*=\s*tableFavoriteStore\.toggleFavorite[\s\S]*?if\s*\(!favorite\)\s*return;[\s\S]*?nextTick\(\(\)\s*=>\s*tableListRef\.value\?\.scrollTableIntoView\?\.\(name,\s*\{\s*block:\s*"nearest"\s*\}\)\)/);
  assert.match(tableList, /import\s+\{\s*Star\s*\}\s+from\s+"lucide-vue-next"/);
  assert.match(tableList, /import\s+\{\s*databaseTableIconComponent\s*\}\s+from\s+"\.\/databaseDecorationIcons\.js"/);
  assert.match(tableList, /const\s+tableIcon\s*=\s*computed\(\(\)\s*=>\s*databaseTableIconComponent\(props\.databaseDecoration\)\)/);
  assert.match(tableList, /class="wb-dbhome-favorite-button"/);
  assert.match(tableList, /:aria-pressed="favoriteSet\.has\(tableName\(table\)\)/);
  assert.match(tableList, /@click\.stop="toggleFavorite\(table\)"/);
  assert.match(styles, /\.wb-dbhome-object-name\s*\{[^}]*gap:\s*4px/s);
  assert.match(styles, /\.wb-dbhome-favorite-button\s*\{[^}]*flex:\s*0 0 26px[^}]*height:\s*28px[^}]*place-items:\s*center/s);
  assert.match(styles, /\.wb-dbhome-favorite-button\.is-favorite\s*\{[^}]*color:\s*var\(--wb-warning-text\)/s);
});

test("homepage releases search focus and keeps direct typing active after non-control clicks", () => {
  const home = read("./components/DatabaseHome.vue");
  const styles = read("./workbench.css");

  assert.match(home, /function\s+handleHomeSurfaceClick\(event\)/);
  assert.match(home, /homeRootRef\.value\?\.focus\?\.\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(home, /function\s+handleDocumentPointerDown\(event\)/);
  assert.match(home, /input\.setSelectionRange\?\.\(end,\s*end\)/);
  assert.match(home, /input\.blur\(\)/);
  assert.match(home, /document\.addEventListener\("pointerdown",\s*handleDocumentPointerDown,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /document\.removeEventListener\("pointerdown",\s*handleDocumentPointerDown,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /tabindex="-1"/);
  assert.match(home, /@click\.capture="handleHomeSurfaceClick"/);
  assert.match(styles, /\.wb-database-home:focus\s*\{[^}]*outline:\s*none/s);
});

test("homepage omits selection summaries and the footer action bar", () => {
  const home = read("./components/DatabaseHome.vue");

  assert.doesNotMatch(home, /\{\{\s*selectedCount\s*\}\}\s*已选/);
  assert.doesNotMatch(home, /wb-dbhome-status/);
  assert.doesNotMatch(home, /打开选中/);
  assert.doesNotMatch(home, /function\s+openSelectedTables/);
});

test("homepage context menu deletes the complete multi-table selection after confirmation", () => {
  const home = read("./components/DatabaseHome.vue");
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(home, /deleteMenuLabel\s*=\s*computed\(\(\)\s*=>\s*menu\.selectedNames\.length\s*>\s*1\s*\?\s*`删除 \$\{menu\.selectedNames\.length\} 张表`\s*:\s*["']删除表["']\)/);
  assert.match(home, /menu\.selectedNames\s*=\s*\[\.\.\.controller\.selectedNames\.value\]/);
  assert.match(home, /<button[^>]*class="danger"[^>]*@click="deleteSelection\(menu\.tableName, menu\.selectedNames\)"[^>]*><Trash2 :size="14" class="wb-context-icon"[^>]*\/>\{\{ deleteMenuLabel \}\}<\/button>/);
  assert.match(home, /if\s*\(tableName\s*&&\s*!controller\.selectedSet\.value\.has\(tableName\)\)\s*controller\.selectTable\(tableName,\s*\{\}\)/);
  assert.match(home, /tableNames,\s*\n\s*\}\)/);
  assert.match(orchestrator, /const\s+confirmed\s*=\s*await\s+confirmDialogConfirm\(/);
  assert.match(orchestrator, /title:\s*tableNames\.length\s*===\s*1\s*\?\s*"删除表"\s*:\s*`删除 \$\{tableNames\.length\} 张表`/);
  assert.match(orchestrator, /message:\s*`即将从 \$\{source\.database\} 删除以下表`/);
  assert.match(orchestrator, /items:\s*tableNames/);
  assert.match(orchestrator, /note:\s*"删除表会同时移除数据和结构，此操作不可撤销。"/);
  assert.match(orchestrator, /if\s*\(!confirmed\)\s*return/);
  assert.match(orchestrator, /const batch = tableNames\.slice\(offset, offset \+ 32\)/);
  assert.match(orchestrator, /invokeWorkbench\("drop_tables",\s*\{[\s\S]*?tables:\s*batch/);
});

test("homepage tab keeps the normal arrow cursor", () => {
  const styles = read("./workbench.css");
  const homeCursorRule = styles.match(
    /\.wb-tab\[data-kind="home"\],\s*\n\.wb-tab\[data-kind="home"\] \*\s*\{([^}]*)\}/s,
  )?.[1] || "";

  assert.match(homeCursorRule, /cursor:\s*default/);
  assert.match(homeCursorRule, /user-select:\s*none/);
});

test("favorite database shortcuts cannot reuse Ctrl+digit or Ctrl+Backquote tab switching", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  assert.match(orchestrator, /function favoriteShortcutConflict\(target, shortcut\)/);
  assert.match(
    orchestrator,
    /function favoriteShortcutConflict\([\s\S]*?isReservedTabShortcutCombo\(shortcut\)[\s\S]*?切换打开的标签/,
  );
});

test("database favorites surface opens from an activity rail button instead of home-tab hover", () => {
  const tabs = read("./components/WorkbenchTabs.vue");
  const favorites = read("./components/HomeDatabaseFavorites.vue");
  const rail = read("./components/WorkbenchActivityRail.vue");
  const railGroups = read("./composables/useActivityRail.js");
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");
  const orchestrator = read("./MySqlWorkbench.vue");
  const styles = read("./workbench.css");

  assert.doesNotMatch(tabs, /HomeDatabaseFavorites/);
  assert.doesNotMatch(tabs, /homeFavoritesRef|scheduleHomeFavorites|showHomeFavorites|hideHomeFavorites/);
  assert.match(railGroups, /id:\s*"databaseFavorites"[\s\S]*?popup:\s*"menu"/);
  assert.match(rail, /emit\((['"])select\1, item\.id, \$event\)/);
  assert.match(orchestrator, /import HomeDatabaseFavorites from "\.\/components\/HomeDatabaseFavorites\.vue"/);
  assert.match(orchestrator, /<HomeDatabaseFavorites ref="homeFavoritesRef" :pane-id="workspace\.focusedPaneId" \/>/);
  assert.match(orchestrator, /function openDatabaseFavorites\(event\)[\s\S]*?homeFavoritesRef\.value\?\.toggle\?\.\(event\?\.currentTarget\)/);
  assert.match(favorites, /function toggle\(anchor\)[\s\S]*?panelVisible\.value\) hide\(\)[\s\S]*?else show\(anchor\)/);
  assert.match(favorites, /defineExpose\(\{ show, hide, toggle, scheduleHide \}\)/);
  assert.doesNotMatch(favorites, /AUTO_SHOW_DELAY_MS|scheduleShow/);
  assert.match(favorites, /class="wb-home-favorites-panel wb-floating-themed"/);
  assert.match(favorites, /class="wb-home-favorites-add"/);
  assert.match(favorites, /选择一个已连接的数据库/);
  assert.match(favorites, /data-wb-shortcut-capture="true"/);
  assert.match(orchestrator, /const pendingHome = openDatabaseHomeTab[\s\S]*?pendingHome\.loading = sourceChanging/);
  assert.match(orchestrator, /selectConnection\(targetConnectionId, \{ preferredDatabase: targetDatabase \}\)/);
  assert.match(home, /const tableSource = computed\(\(\) => homeLoading\.value \? \[\] : props\.tables\)/);
  assert.match(home, /:loading="homeLoading"/);
  assert.match(tableList, /正在读取表列表…/);
  assert.match(orchestrator, /provide\(HOME_DATABASE_FAVORITES_CONTEXT/);
  assert.match(orchestrator, /function handleFavoriteDatabaseShortcutKeydown\(event\)/);
  assert.match(styles, /\.wb-home-favorites-panel\s*\{/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.wb-home-favorites-panel/);
});

test("tab drag preview keeps its transform transition after base tab styles", () => {
  const tabs = read("./components/WorkbenchTabs.vue");
  const styles = read("./workbench.css");
  const moveRule = styles.match(/\.wb-tab\.wb-tab-reorder-move\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(tabs, /<div ref="tabListRef" class="wb-tab-list"/);
  assert.match(tabs, /@dragover\.prevent\.stop="markTabDragTarget\(tab\.id, \$event\)"/);
  assert.match(moveRule, /transform\s+0\.18s\s+cubic-bezier\(0\.25,\s*1,\s*0\.5,\s*1\)/);
});
