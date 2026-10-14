// How lively the relation graph's force layout is, shared by the layout
// engine (in its worker) and the page, which must not load the engine itself.
export const LAYOUT_ALPHA = Object.freeze({
  // A picture nobody has seen yet.
  fresh: 1,
  // Tables added or removed, or the layout restored: the rest only adjusts.
  update: 0.3,
  // Kept up while a table is dragged, for the few tables that follow it.
  drag: 0.2,
  // After a drag those tables come to rest; the rest of the picture never moved.
  dragSettle: 0.06,
  // Below this the layout is at rest and stops working.
  rest: 0.001,
});
