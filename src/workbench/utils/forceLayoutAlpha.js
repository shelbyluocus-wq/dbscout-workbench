// How lively the relation graph's force layout is, shared by the layout
// engine (in its worker) and the page, which must not load the engine itself.
export const LAYOUT_ALPHA = Object.freeze({
  // A picture nobody has seen yet.
  fresh: 1,
  // Tables added or removed, or the layout restored: the rest only adjusts.
  update: 0.3,
  // Kept up while a table is dragged so its neighbours make room.
  drag: 0.3,
  // Below this the layout is at rest and stops working.
  rest: 0.001,
});
