// Picks the fullest toolbar layout that fits its row without overflowing.
//
// Fixed width breakpoints cannot know how long labels, chips or a translated
// search mode are, so a toolbar steps down only as far as it really needs to:
// each level is applied as `data-fit` and measured, starting from the fullest.
// The CSS keys every collapse step on that attribute. While measuring,
// `data-fit-measuring` switches transitions off so each level is measured at
// its final size; the chosen level is then applied from the previous one with
// transitions back on, so animated collapses still animate.

export const TOOLBAR_FIT_ATTRIBUTE = "fit";
export const TOOLBAR_FIT_MEASURING_ATTRIBUTE = "fitMeasuring";

// Under page zoom WebKit rounds scrollWidth up and clientWidth down, and the
// flexible search field always fills the row exactly, so a 1px difference is
// rounding, not overflow: counting it collapsed every level at once (and
// flipped levels frame by frame while a pane animated).
const ROUNDING_TOLERANCE = 1;

// scrollWidth alone misses a row that only runs into the end padding of a
// toolbar that is not a scroll container, so children are checked too.
function overflows(element) {
  if (element.scrollWidth > element.clientWidth + ROUNDING_TOLERANCE) return true;
  const children = element.children;
  if (!children?.length || typeof getComputedStyle !== "function") return false;
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const contentRight = box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
  for (const child of children) {
    const right = child.getBoundingClientRect().right;
    if (right > contentRight + ROUNDING_TOLERANCE) return true;
  }
  return false;
}

/**
 * Applies the lowest level in 0..maxLevel at which `element` does not
 * overflow horizontally (maxLevel when none fits) and returns it.
 * Measuring forces layout of the toolbar only; it is called from a
 * ResizeObserver or after the toolbar's own content changed.
 */
export function fitToolbar(element, maxLevel) {
  if (!element) return 0;
  const { dataset } = element;
  const previous = dataset[TOOLBAR_FIT_ATTRIBUTE];
  dataset[TOOLBAR_FIT_MEASURING_ATTRIBUTE] = "";
  let level = 0;
  for (; level < maxLevel; level += 1) {
    dataset[TOOLBAR_FIT_ATTRIBUTE] = String(level);
    if (!overflows(element)) break;
  }
  if (previous !== undefined && previous !== String(level)) {
    dataset[TOOLBAR_FIT_ATTRIBUTE] = previous;
    void element.scrollWidth; // settle the previous level without transitions
  }
  delete dataset[TOOLBAR_FIT_MEASURING_ATTRIBUTE];
  dataset[TOOLBAR_FIT_ATTRIBUTE] = String(level);
  return level;
}
