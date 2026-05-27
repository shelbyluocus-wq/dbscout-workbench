# Refresh-Only Context Menu Design

**Status:** Approved on 2026-05-27

## Goal

Replace exposed browser/WebView context-menu behavior with a consistent
workbench-owned menu. Right-clicking anywhere in the application must no
longer offer browser actions such as save, print, or inspect. The only visible
right-click action is `刷新`.

Remove the existing `设为 NULL` menu item. This task does not remove null-value
support from editing logic; it removes only the context-menu entry that
exposes that operation.

## User Experience

The existing `wb-context-menu` presentation remains the visual basis for the
right-click menu so it continues to match the glass surfaces, accent color,
border, and shadow tokens used throughout the workbench.

Right-click behavior is:

- On a table node in the navigation tree, show `刷新`; activating it refreshes
  that table's schema and, when its matching tab is active, reloads that page.
- On the open table data workspace or inspector, show `刷新`; activating it
  refreshes the current table schema and reloads the currently visible page.
- On navigation background, toolbar, tabs, status bar, empty workspace, or
  other application chrome, show `刷新`; activating it refreshes the database
  object tree.
- On form controls such as search and editor inputs, use the same custom menu.
  Native copy/paste context-menu commands are intentionally not retained;
  keyboard shortcuts continue to provide those text actions. This keeps the
  user's requirement that the right-click menu contain only `刷新`.

## Event And State Design

`MySqlWorkbench.vue` owns the application-wide `contextmenu` interception at
the root container. The handler prevents the default WebView menu and opens
the shared custom menu with a refresh target derived from the event context.

Specific table-node events continue passing table metadata through
`WorkbenchSidebar.vue`, because they need the clicked table's connection and
database identity rather than the currently active tab. These more-specific
events stop propagation before the root fallback opens a second menu.

`useContextMenu.js` stores one of three refresh contexts:

- A named table source supplied by a sidebar table node.
- The active table session for a context invocation inside the table work
  area.
- No table source for general application chrome, which preserves the current
  object-tree refresh behavior.

When refreshing a table source, the composable keeps using connection and
database identifiers to avoid updating a same-named active table from a
different database.

## Component Changes

- `components/ContextMenu.vue` renders only a single `刷新` button and emits
  only the corresponding refresh action.
- `MySqlWorkbench.vue` removes the unused `set-null` wiring, installs global
  context-menu interception, and marks the active table area as a
  current-session refresh target.
- `components/WorkbenchSidebar.vue` no longer leaves native input context
  menus available and continues forwarding explicit table targets.
- `composables/useContextMenu.js` accepts the context required to select
  current-session or object-tree refresh behavior without introducing new
  backend calls.
- Existing `workbench.css` menu styling is reused unless a small adjustment is
  required to fit the single-action menu; any adjustment uses `--wb-*` tokens.

## Verification

Add or adjust focused frontend tests before implementation to demonstrate:

- The context-menu component exposes `刷新` and no longer exposes `设为 NULL`.
- The application root prevents native right-click menus and presents the
  custom menu throughout the workbench.
- Form inputs no longer escape to a native WebView context menu.
- Table-node refresh continues to use its database source identity.
- A right-click from the active data workspace refreshes the current table and
  current page instead of only refreshing the object tree.
- A right-click on general chrome refreshes the object tree.

Run the frontend Node tests and frontend production build after implementation.
Open the browser-mode app and manually verify representative right-click
locations, since suppression of the host menu is an interaction-level
behavior.

## Out Of Scope

- Adding copy, paste, delete, export, or row-editing context-menu actions.
- Changing cell-editing capabilities outside removal of the menu entry.
- Adding Rust-native menus or modifying backend command contracts.
- Styling redesigns unrelated to the existing workbench context menu.
