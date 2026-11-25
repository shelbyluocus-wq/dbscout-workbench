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

  assert.match(home, /const HOME_NAVIGATION_KEYS = new Set\(\["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"\]\)/);
  assert.match(home, /isHomeTableNavigationTarget\(event\.target\)/);
  assert.match(home, /\.wb-tab\[data-kind="home"\]\.active/);
  assert.match(home, /if \(handleHomeArrowKeydown\(event\)\) \{[\s\S]*?event\.stopPropagation/);
  assert.match(home, /if \(key === "ArrowDown"\) return 1;\s*if \(key === "ArrowUp"\) return -1;/);
  assert.match(home, /if \(key === "PageDown"\) return page;[\s\S]*?return key === "End" \? Infinity : -Infinity;/);
  // Home, End and the page keys keep editing the search text.
  assert.match(home, /if \(fromSearch && key !== "ArrowUp" && key !== "ArrowDown"\) return false;/);
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
  assert.match(home, /isHomeListCommandTarget\(target\) \|\| target\?\.closest\?\.\('\.wb-tab\[data-kind="home"\]\.active'\)/);
  assert.match(home, /void openSelection\(controller\.focusedName\.value\)/);
  assert.match(home, /if \(typeahead\.handleKeydown\(event\)\)[\s\S]*?if \(handleHomeEnterKeydown\(event\)\)/);
});

test("homepage Enter on a ctrl or shift selected row opens every selected table", () => {
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");

  assert.match(tableList, /function\s+handleRowOpen\(table\)\s*\{[\s\S]*?const name = selectForAction\(table\);[\s\S]*?emit\("open-selection", name\)/);
  assert.match(home, /@open-selection="openSelection"/);
  assert.match(home, /function openSelection\(focusedName = ""\)\s*\{[\s\S]*?selectionOpenPlan\(focusedName, controller\.selectedNames\.value, order\)/);
  // Only the table the user acted on takes focus; the rest open in the background.
  assert.match(home, /names\.forEach\(\(name\) => openTable\(name, \{ activate: name === activeName \}\)\)/);
  assert.match(home, /confirmOpeningTables\(names\.length, \{ confirm, t \}\)/);
});

test("homepage double-click anywhere on a row opens the selection it belongs to", () => {
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");
  const selectTable = home.match(/function\s+selectTable\(name, event = \{\}\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(tableList, /class="wb-dbhome-object-row"[\s\S]*?@click="select\(table, \$event\)"[\s\S]*?@dblclick="handleRowDoubleClick\(table, \$event\)"/);
  assert.doesNotMatch(tableList, /@dblclick="emit\('open-table'/);
  assert.match(home, /@activate-row="activateRow"/);
  assert.match(selectTable, /if \(plain && Number\(event\?\.detail\) > 1\) return;/);
  assert.match(selectTable, /selectionRecall\.remember\(name, controller\.selectedNames\.value\)/);
  assert.match(home, /function activateRow\(name\)\s*\{[\s\S]*?selectionRecall\.recall\(name\)[\s\S]*?controller\.setSelection\(restored\)[\s\S]*?openSelection\(name\)/);
});

test("homepage Delete, F2, Esc and Shift+F10 work wherever list focus sits", () => {
  const home = read("./components/DatabaseHome.vue");
  const listKeydown = home.match(/function\s+handleHomeListKeydown\(event\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(home, /function handleHomeKeydown\(event\)\s*\{[\s\S]*?handleHomeListKeydown\(event\);/);
  assert.match(listKeydown, /isDeleteCommandKey\(event\)[\s\S]*?deleteSelection\(\)/);
  assert.match(listKeydown, /key === "F2"[\s\S]*?renameFromKeyboard\(\)/);
  assert.match(listKeydown, /isContextMenuKey\(event\)[\s\S]*?openKeyboardContextMenu\(\)/);
  assert.match(listKeydown, /key === "Escape"[\s\S]*?cancelRename\(\)[\s\S]*?clearSelection\(\)/);
  assert.doesNotMatch(home, /@keydown\.esc="closeMenu"/);
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

  assert.match(home, /useTableFolderStore/);
  assert.match(home, /:favorite-names="favoriteTableNames"/);
  assert.match(home, /@toggle-favorite="toggleTableFavorite"/);
  assert.match(home, /function\s+toggleTableFavorite\(name\)[\s\S]*?const\s+favorite\s*=\s*tableFavoriteStore\.toggleFavorite[\s\S]*?if\s*\(!favorite\)\s*return;[\s\S]*?nextTick\(\(\)\s*=>\s*tableListRef\.value\?\.scrollTableIntoView\?\.\(name,\s*\{\s*block:\s*"nearest"\s*\}\)\)/);
  assert.match(tableList, /import\s+\{[^}]*\bStar\b[^}]*\}\s+from\s+"lucide-vue-next"/);
  assert.match(tableList, /import\s+\{\s*databaseTableIconComponent\s*\}\s+from\s+"\.\/databaseDecorationIcons\.js"/);
  assert.match(tableList, /const\s+tableIcon\s*=\s*computed\(\(\)\s*=>\s*databaseTableIconComponent\(props\.databaseDecoration\)\)/);
  assert.match(tableList, /class="wb-dbhome-favorite-button"/);
  assert.match(tableList, /:aria-pressed="favoriteSet\.has\(tableName\(table\)\)/);
  assert.match(tableList, /@click\.stop="toggleFavorite\(table\)"/);
  assert.match(styles, /\.wb-dbhome-object-name\s*\{[^}]*gap:\s*4px/s);
  assert.match(styles, /\.wb-dbhome-favorite-button\s*\{[^}]*flex:\s*0 0 26px[^}]*height:\s*28px[^}]*place-items:\s*center/s);
  assert.match(styles, /\.wb-dbhome-favorite-button\.is-favorite\s*\{[^}]*color:\s*var\(--wb-warning-text\)/s);
  // Unstarred tables reveal the star on row hover/selection; favorites always show it.
  assert.match(styles, /\.wb-dbhome-favorite-button\s*\{[^}]*opacity:\s*0;/s);
  assert.match(styles, /\.wb-dbhome-object-row:hover \.wb-dbhome-favorite-button,[\s\S]*?\.wb-dbhome-favorite-button\.is-favorite,[\s\S]*?\{\s*opacity:\s*1;/);
  assert.match(tableList, /t\(favoriteSet\.has\(tableName\(table\)\) \? 'home\.unfavoriteTable' : 'home\.favoriteTable', \{ table: tableName\(table\) \}\)/);
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

  assert.match(home, /deleteMenuLabel\s*=\s*computed\(\(\)\s*=>\s*menu\.selectedNames\.length\s*>\s*1\s*\?\s*t\("home\.deleteTables", \{ count: menu\.selectedNames\.length \}\)\s*:\s*["']删除表["']\)/);
  assert.match(home, /menu\.selectedNames\s*=\s*\[\.\.\.controller\.selectedNames\.value\]/);
  assert.match(home, /<button[^>]*class="danger"[^>]*@click="deleteSelection\(menu\.tableName, menu\.selectedNames\)"[^>]*><Trash2 :size="14" class="wb-context-icon"[^>]*\/>\{\{ deleteMenuLabel \}\}<kbd class="wb-context-shortcut" aria-hidden="true">\{\{ menuShortcuts\.delete \}\}<\/kbd><\/button>/);
  assert.match(home, /if\s*\(tableName\s*&&\s*!controller\.selectedSet\.value\.has\(tableName\)\)\s*controller\.selectTable\(tableName,\s*\{\}\)/);
  assert.match(home, /tableNames,\s*\n\s*\}\)/);
  assert.match(orchestrator, /const\s+confirmed\s*=\s*await\s+confirmDialogConfirm\(/);
  assert.match(orchestrator, /title:\s*count\s*===\s*1\s*\?\s*'删除表'\s*:\s*t\("home\.deleteTables", \{ count \}\)/);
  assert.match(orchestrator, /message:\s*t\("home\.deleteMessage", \{ database: source\.database \}\)/);
  assert.match(orchestrator, /items:\s*tableNames/);
  assert.match(orchestrator, /note:\s*t\("home\.deleteNote"\)/);
  assert.match(orchestrator, /danger:\s*true/);
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

test("favorite database shortcuts do not reserve a built-in home tab shortcut", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  assert.match(orchestrator, /function favoriteShortcutConflict\(target, shortcut\)/);
  assert.doesNotMatch(orchestrator, /isReservedTabShortcutCombo/);
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
  assert.match(rail, /emit\((['"])select\1, item\.id, event\)/);
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
