export const DEFAULT_PAGE_SIZE = 100;
export const REQUEST_PAGE_SIZE = 1000;
export const GRID_ROW_HEIGHT = 28;
export const GRID_HEADER_HEIGHT = 28;
export const GRID_ROW_MIN_HEIGHT = 24;
export const GRID_ROW_MAX_HEIGHT = 72;
export const GRID_FIELD_COMMENT_HEIGHT = 32;
export const GRID_FIELD_COMMENT_MIN_HEIGHT = 24;
export const GRID_FIELD_COMMENT_MAX_HEIGHT = 96;
export const GRID_FIELD_COMMENT_COLLAPSED_HEIGHT = 18;
export const VIRTUAL_BUFFER = 10;

// Sidebar table list virtual scrolling. Rows are single-line (comment truncates
// with ellipsis), so they are effectively fixed-height. Used as the fallback
// height before the first real row is measured at runtime (touch = ~32px).
export const SIDEBAR_TABLE_ROW_HEIGHT = 27;

// Adaptive column width constants
export const ROW_INDEX_WIDTH = 38;
export const MIN_COL_WIDTH = 70;
// Minimum width a user can drag a column down to. Smaller than MIN_COL_WIDTH
// so users can collapse a column to just a visible sliver; auto-fit and the
// default CSS floor still use MIN_COL_WIDTH for readability. Honored because
// `.wb-grid th, .wb-grid td` sets `overflow: hidden`, which drops each cell's
// min-content to 0 — otherwise the default `auto` table layout gives every
// column a different, content-driven floor (long field = wide floor) that
// defeats this value (#13).
export const COL_RESIZE_MIN_WIDTH = 40;
// Cap applied only by the adaptive auto-fit heuristic so a single long-value
// column doesn't swallow the whole viewport when opening a wide table.
// Manual drag-resize is intentionally uncapped — see useColumnResize.onMove.
export const AUTOFIT_MAX_COL_WIDTH = 600;
// Kept for backwards compatibility with existing imports/tests. Auto-fit uses
// AUTOFIT_MAX_COL_WIDTH above; nothing enforces this as a hard drag limit now.
export const MAX_COL_WIDTH = AUTOFIT_MAX_COL_WIDTH;
export const COL_PADDING = 14;
export const AUTOFIT_DEBOUNCE_MS = 120;

// Freeze panes (Excel-style frozen rows/columns). Hard upper bounds guard
// against freezing so much of the viewport that the scrollable region
// collapses. Within these, the UI also applies a soft 70%-of-viewport check.
export const MAX_FROZEN_ROWS = 50;
export const MAX_FROZEN_COLS = 20;
