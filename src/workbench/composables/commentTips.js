import { inject, provide } from "vue";

// Surfaces that want table and field names to reveal their comment on hover
// (the relation page and the relation review dialog) opt in here, so the same
// table links elsewhere in the workbench stay unchanged.
const COMMENT_TIPS = Symbol("comment-tips");

export function provideCommentTips() {
  provide(COMMENT_TIPS, true);
}

export function useCommentTips() {
  return inject(COMMENT_TIPS, false);
}
