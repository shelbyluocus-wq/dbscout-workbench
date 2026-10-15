// Placement and timing for the table-comment hover card on the relation
// surfaces. Kept free of the DOM so the rules can be tested directly.

export const TIP_GAP = 6;
export const TIP_MARGIN = 8;
// A first hover waits a moment so passing the pointer over a list stays calm;
// moving on to the next table name shortly after shows it at once.
export const TIP_SHOW_DELAY = 380;
export const TIP_WARM_MS = 500;

// Above the anchor when there is room, otherwise below; left-aligned with it
// and kept inside the viewport.
export function placeTableTip(anchor, tip, viewport) {
  const width = Math.max(0, Number(tip?.width) || 0);
  const height = Math.max(0, Number(tip?.height) || 0);
  const viewWidth = Math.max(0, Number(viewport?.width) || 0);
  const viewHeight = Math.max(0, Number(viewport?.height) || 0);
  const roomAbove = anchor.top - TIP_GAP - TIP_MARGIN;
  const roomBelow = viewHeight - anchor.bottom - TIP_GAP - TIP_MARGIN;
  const side = roomAbove >= height || roomAbove >= roomBelow ? "above" : "below";
  const top = side === "above" ? anchor.top - TIP_GAP - height : anchor.bottom + TIP_GAP;
  const maxLeft = Math.max(TIP_MARGIN, viewWidth - width - TIP_MARGIN);
  const left = Math.min(Math.max(anchor.left, TIP_MARGIN), maxLeft);
  return { side, left: Math.round(left), top: Math.round(Math.max(TIP_MARGIN, top)) };
}

// Shared across every card so moving between names feels continuous.
export function createTipWarmth(now = () => Date.now()) {
  let warmUntil = 0;
  return {
    delay() {
      return now() < warmUntil ? 0 : TIP_SHOW_DELAY;
    },
    cool() {
      warmUntil = now() + TIP_WARM_MS;
    },
  };
}
