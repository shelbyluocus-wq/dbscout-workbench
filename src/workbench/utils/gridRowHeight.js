import {
  GRID_FIELD_COMMENT_HEIGHT,
  GRID_FIELD_COMMENT_MAX_HEIGHT,
  GRID_FIELD_COMMENT_MIN_HEIGHT,
  GRID_ROW_HEIGHT,
  GRID_ROW_MAX_HEIGHT,
  GRID_ROW_MIN_HEIGHT,
} from "../constants.js";

function clampHeight(value, minimum, maximum, fallback) {
  const height = Number(value);
  if (!Number.isFinite(height)) return fallback;
  return Math.round(Math.max(minimum, Math.min(maximum, height)));
}

export function clampGridRowHeight(value) {
  return clampHeight(value, GRID_ROW_MIN_HEIGHT, GRID_ROW_MAX_HEIGHT, GRID_ROW_HEIGHT);
}

export function clampFieldCommentHeight(value) {
  return clampHeight(
    value,
    GRID_FIELD_COMMENT_MIN_HEIGHT,
    GRID_FIELD_COMMENT_MAX_HEIGHT,
    GRID_FIELD_COMMENT_HEIGHT,
  );
}

export function resolveGridRowHeight(tab) {
  return clampGridRowHeight(tab?.rowHeight);
}

export function resolveFieldCommentHeight(tab) {
  return clampFieldCommentHeight(tab?.fieldCommentHeight);
}
