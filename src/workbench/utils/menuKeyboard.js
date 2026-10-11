// Keyboard support shared by the workbench context menus. A menu opened from
// the keyboard (Shift+F10 or the Menu key) takes focus; the arrow keys, Home
// and End then move between enabled items and Escape or Tab closes it.
const ITEM_SELECTOR = '[role="menuitem"]';

export function menuItems(menu) {
  return Array.from(menu?.querySelectorAll?.(ITEM_SELECTOR) || [])
    .filter((item) => !item.disabled && item.getAttribute?.("aria-disabled") !== "true");
}

/**
 * @param {HTMLElement} menu
 * @param {"first" | "last" | number} position an end of the menu, or a step from the focused item
 */
export function focusMenuItem(menu, position = "first") {
  const items = menuItems(menu);
  if (!items.length) {
    menu?.focus?.({ preventScroll: true });
    return false;
  }
  const index = items.indexOf(menu.ownerDocument?.activeElement);
  let next;
  if (position === "first") next = 0;
  else if (position === "last") next = items.length - 1;
  else if (index < 0) next = position > 0 ? 0 : items.length - 1;
  else next = (index + position + items.length) % items.length;
  items[next].focus({ preventScroll: true });
  return true;
}

export function handleMenuKeydown(event, menu, { close } = {}) {
  const key = String(event?.key || "");
  if (key === "ArrowDown") focusMenuItem(menu, 1);
  else if (key === "ArrowUp") focusMenuItem(menu, -1);
  else if (key === "Home") focusMenuItem(menu, "first");
  else if (key === "End") focusMenuItem(menu, "last");
  else if (key === "Escape" || key === "Tab") close?.();
  else return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  return true;
}
