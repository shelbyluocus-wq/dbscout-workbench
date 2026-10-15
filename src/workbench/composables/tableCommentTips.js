import { inject, provide } from "vue";

// Surfaces that want table names to reveal their comment on hover (the
// relation page and the relation review dialog) opt in here, so the same
// table links elsewhere in the workbench stay unchanged.
const TABLE_COMMENT_TIPS = Symbol("table-comment-tips");

export function provideTableCommentTips() {
  provide(TABLE_COMMENT_TIPS, true);
}

export function useTableCommentTips() {
  return inject(TABLE_COMMENT_TIPS, false);
}
