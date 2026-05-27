# Sidebar Table Name Priority Design

**Status:** Approved by user direction on 2026-05-27

## Goal

Keep table comments visible in the sidebar when horizontal room exists, while ensuring the table name is the first content protected from truncation.

## Behavior

- Each table row continues to show `table name + table comment` on one line.
- The table name is rendered first and remains fully visible whenever it fits in the current sidebar width.
- The comment consumes only the horizontal space remaining after the name.
- Narrowing the sidebar hides/truncates the comment first; only widths too narrow for the table name itself may truncate the name.
- Widening the sidebar naturally reveals more of multiple table comments at once.
- The existing title tooltip continues to expose the complete name and comment.

## Implementation

- Keep the existing markup and data flow in `WorkbenchSidebar.vue`.
- Replace the competing flex truncation in `src/workbench/workbench.css` with one-line overflow on `wb-table-copy`, so truncation happens at the end of the combined visible text.
- Keep table-name and comment visual roles distinct through the existing comment color treatment.
- Add a static shell regression assertion that rejects a percentage width cap on names when comments exist and requires the combined-line overflow contract.

## Verification

- Run `node --test src/workbench/workbenchShell.test.js` through a red-green cycle.
- Run `node --test src/workbench/*.test.js` and `npm run build`.
- In the local UI, resize the sidebar with commented tables visible and confirm that comments disappear/reappear before table names do.
