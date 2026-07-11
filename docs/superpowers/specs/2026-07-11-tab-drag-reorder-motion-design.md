# Tab Drag Reorder Motion Design

## Goal

Make the tab strip communicate its interaction correctly and make drag reordering feel immediate. The home tab must keep the normal arrow cursor, and neighboring tabs must visibly slide aside while the pointer is still dragging.

## Interaction

- The home tab and its text use the normal arrow cursor and cannot be text-selected.
- Data and design tabs keep the existing grab and grabbing cursors.
- Reordering starts only after the pointer crosses the midpoint of the target tab.
- Crossing that midpoint updates the preview order immediately, before mouse release.
- Tabs between the old and new positions slide horizontally into place over about 180 ms with a restrained ease-out curve.
- The dragged tab remains visually subdued and the active drop target keeps the existing position emphasis.
- Dropping commits the previewed order. Cancelling or ending a drag without a valid drop restores the persisted order.

## Motion And Accessibility

- Use transform-only movement so tab widths and the surrounding title bar remain stable.
- Avoid bounce, overshoot, scale, and decorative effects.
- When reduced motion is requested, reorder immediately without movement animation.

## Implementation Boundary

Keep the existing live preview ordering and drop behavior. Repair the style precedence that currently prevents the move transition from taking effect, and add the home-tab cursor rule. No tab state, persistence, or pane behavior changes are required.

## Verification

- A focused regression test checks the home-tab cursor and selection behavior.
- A focused regression test checks that the reorder move transition includes transform and is not overridden by the base tab transition.
- Existing homepage ordering and workspace tab-reorder tests continue to pass.
- Browser verification confirms that crossing a tab midpoint causes visible movement before mouse release and that reduced-motion mode removes the animation.
