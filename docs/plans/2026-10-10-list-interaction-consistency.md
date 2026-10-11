# List Interaction Consistency Pass

**Date:** 2026-10-10

## Goal

Make selecting, opening and deleting tables behave the same way everywhere,
following desktop file-manager habits: double-clicking a multi-selection opens
all of it, Delete deletes the selection after a confirmation, and the keyboard,
mouse and context menus agree with each other.

## Audit Findings

1. **Delete did nothing after a drag selection.** Box selection and clicks on
   the size, modified or comment cells left focus on the home page itself,
   which only handled Ctrl+A, the arrows and Enter. Delete and F2 lived on the
   list surface and on each table-name button, so they only worked after
   clicking the name text.
2. **Double-click opened one table, and only from the name text.** The other
   cells ignored double-clicks, and the first click of a double-click collapsed
   a multi-selection before the double-click arrived.
3. **The context menu disagreed with itself.** "Open table" opened only the
   clicked table while "Table design" opened the whole selection; the
   multi-table delete label was hard-coded Simplified Chinese; no item showed
   its shortcut.
4. **Confirmations.** The delete-tables and delete-rows confirmations were
   Simplified Chinese in every language. Initial focus landed on the × button,
   so Enter silently cancelled, and answering the dialog cleared the home
   selection it was asking about.
5. **The sidebar table list had no multi-selection.** No Ctrl/Shift click, no
   Enter for several tables, no Delete, no arrow-key navigation, and its menu
   had neither Open nor Delete. F2 renamed tables but not databases or
   connections, although the events already existed.
6. **Tabs.** No middle-click close, no "Close tab" or "Close other tabs", and
   the menu items had no roles, icons or shortcut hints.
7. **F5 reloaded the whole window** (the WebView default), discarding unsaved
   SQL and insert drafts, instead of refreshing the current view.
8. **Shortcut settings** listed action names in Simplified Chinese in every
   language, and the fixed list keys were not documented anywhere.
9. **No guard against opening everything.** Ctrl+A then Enter opened every
   table at once.
10. **Selection extension.** Ctrl+Shift+click and Ctrl+drag replaced the
    selection instead of adding to it.

## Decisions

### Shared selection rules

`utils/listSelection.js` holds the rules both lists use: click selects,
Ctrl/Cmd+click toggles, Shift+click selects the range from the anchor and
Ctrl/Cmd+Shift adds it. A plain click remembers the multi-selection it
collapsed (`createSelectionRecall`), so the double-click that follows restores
and opens it, as Explorer and Finder do. `selectionOpenPlan` opens a selection
in list order and activates only the row the user acted on; the others load in
the background. More than 15 tables ask first (`confirmOpeningTables`).

### Database home page

- Rows take clicks and double-clicks on every cell; Ctrl/Cmd+drag adds to the
  selection and a plain drag no longer shows the old selection meanwhile.
- The page owns the list keys wherever focus sits in the list: Enter opens,
  Delete (Backspace on macOS) deletes, F2 renames (the focused table of a
  selection), Esc clears, Home/End/PageUp/PageDown move (Shift extends) and
  Shift+F10 or the Menu key opens the context menu with focus inside.
- Keyboard Delete on read-only or unsupported connections still reaches the
  workbench, which explains why nothing was deleted.
- The menu opens the selection ("Open 3 tables") and shows hints.

### Sidebar table list

`useSidebarTableSelection.js` keeps the sidebar's own selection. A plain click
still opens the table immediately; Ctrl/Cmd and Shift clicks only select.
Enter and double-click open the selection, Delete deletes it (the home page
keeps the current tab), arrows/Home/End move focus across the virtualized list,
Ctrl+A selects all, Esc clears and Shift+F10 opens the menu. The menu gains
Open and Delete and applies Design and Send to the selection. F2 renames
database and connection aliases; Delete removes a connection after its
existing confirmation.

### Tabs, menus and dialogs

- Middle-click closes a tab; the tab menu adds Close tab (Ctrl+W) and Close
  other tabs, plus icons and roles. Refresh now also works on the home tab.
- Context menus share `utils/menuKeyboard.js` (arrows, Home/End, Escape/Tab)
  and stop right-clicks inside them. Hints use `.wb-context-shortcut` with
  `aria-hidden`, so item names stay plain for assistive technology; a hint is
  shown only where the key does the same thing in that place.
- Destructive confirmations focus Cancel; others focus the primary button.
- F5 is the rebindable `refresh` shortcut. It refreshes the home list or the
  current table, leaves the SQL editor's run key alone, skips while a cell is
  being edited, and never lets the WebView reload.
- Shortcut settings use localized labels and list the fixed list keys.

## Verification

- `node scripts/test-workbench.mjs`: all tests pass except the activity-rail
  favorites contract that already failed before this work.
- Browser (mock backend): drag selection then Delete shows the localized
  confirmation with Cancel focused and keeps the selection after cancelling;
  double-clicking a cell of a Ctrl-selected row opens the three tables with
  that one active; Esc, Home/End, Shift+PageDown, Shift+F10 menu navigation
  and focus return; Ctrl+A then Enter asks before opening 27 tables; F5 keeps
  the same document. Sidebar Ctrl/Shift selection, Enter, double-click,
  Delete, menu items, arrows, F2 on a connection; tab middle-click and Close
  other tabs. English and Traditional Chinese (dark) shortcut dialog and menus.
- `test-grid-columns`, `test-grid-insert-drag` and `test-language-browser`
  pass. `smoke-tablecopy-dialog` and `smoke-dbdisplay-dialog` assume the
  Simplified Chinese interface and pass once it is selected, on both this
  change and the base commit; `smoke-sidebar-scroll-isolation` fails the same
  way on the base commit.

## Follow-ups

- Mouse-opened context menus do not take focus; only keyboard-opened ones do.
- The sidebar multi-selection is visual only; the list has no listbox
  semantics for assistive technology yet.
- Middle-clicking a sidebar table could open it in the background.
- The two dialog smoke scripts should select their language explicitly.
