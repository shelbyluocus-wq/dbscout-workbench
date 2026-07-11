# Backup Center Responsive Layout Fix

## Goal

Prevent the snapshot list from overlapping the snapshot-scope controls, and make the close button fit the backup center header consistently.

## User-visible behavior

- At desktop widths, the snapshot-scope and selected-database panels remain side by side and keep their full content height.
- At narrower widths, those panels stack vertically without overlapping the snapshot list.
- When the dialog content is taller than the available viewport, the backup center body scrolls as one continuous surface.
- The close button keeps a stable square hit target, stays aligned to the top-right of the header, and has clear hover and keyboard-focus states.

## Layout ownership

The backup center dialog continues to own the viewport height limit. Its active tab panel owns vertical scrolling. The snapshot-scope layout must use its natural height and must not shrink below its children; the snapshot list follows it in normal document flow.

The close button remains the existing semantic button and keeps its current accessible label and disabled behavior. Backup-center-specific styles may adjust its alignment and interaction states without changing other dialogs.

## Scope

Only the backup center component, its CSS, and focused layout tests are in scope. Snapshot creation, restoration, filtering, persistence, and other dialogs are unchanged.

## Verification

- Add a regression test that requires the snapshot-scope layout to be non-shrinking.
- Add a focused test for the backup center close-button sizing and header alignment.
- Run the backup center layout tests and the existing CSS polish tests.
- Verify the snapshot tab in the browser at desktop and narrow viewport sizes, including a populated snapshot list.
