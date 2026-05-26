# Sidebar Table Tree And Scrollbar Design

**Status:** Approved on 2026-05-26

## Goal

Make database navigation feel like a restrained Navicat-style browser with Codex-like visual polish, while fixing the false scrollbar overlay that cannot be dragged.

## Scope

The tool only needs navigation to table data. The sidebar will expose one compact path:

`connection > database > table`

It will not introduce object groups such as views, functions, queries, backups, or administration nodes.

## Sidebar Design

- Replace the current internal two-column database/table browser with one scrollable tree.
- Show each connection as a root row. The active connection exposes its databases.
- Show the active database expanded with its table rows immediately beneath it.
- Keep a small add-connection action in the sidebar header.
- Place a compact table filter inside the selected database branch; it filters the visible table list.
- Use short, single-line rows, light indentation, quiet selection fills, muted secondary text, and fine tree guides rather than cards or strong borders.
- Opening a table and switching a database continue to use the existing frontend events and backend flows.

## Scrollbar Design

- Remove the floating persistent-scrollbar overlay from the workbench lifecycle.
- Keep the platform/browser scrollbar as the actual interactive control, styled thin through the existing `--wb-scrollbar-*` tokens.
- Avoid hiding native scrollbars and avoid fixed-position scrollbar replicas, so wheel, track click, and thumb drag use standard hit testing.

## Affected Code

- `src/workbench/components/WorkbenchSidebar.vue`: render the single tree navigation structure.
- `src/workbench/workbench.css`: style the compact tree and remove custom overlay/hiding styles.
- `src/workbench/MySqlWorkbench.vue`: stop installing the persistent overlay and narrow sidebar search wiring.
- `src/workbench/workbenchShell.test.js`: assert the approved tree and native-scrollbar contract.

## Verification

- Run the frontend unit tests with `node --test src/workbench/*.test.js`.
- Build the frontend with `npm run build`.
- Open the local UI and verify that the sidebar has the `connection > database > table` hierarchy and that long lists have a clickable and draggable scrollbar with no detached visual thumb.
