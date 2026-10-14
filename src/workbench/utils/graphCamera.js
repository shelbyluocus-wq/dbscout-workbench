// The canvas graph's camera, after Obsidian's: the wheel sets a target zoom
// (about 1.5× per notch) that the view eases toward while the point under
// the pointer stays put, dragging empty space pans and a released drag
// coasts to a stop, and "fit" glides to show the whole drawing. Positions
// are graph units; `scale` is screen pixels per unit; `x`/`y` is the graph
// point at the middle of the view.

export const CAMERA_MAX_SCALE = 8;
const WHEEL_NOTCH = 100;
const WHEEL_FACTOR = 1.5;
const WHEEL_STEP_MAX = 2.25;
const LINE_HEIGHT_PX = 16;
// Share of the remaining way covered each frame.
const EASE = 0.24;
const INERTIA_DECAY = 0.9;
const INERTIA_STOP_PX = 0.3;
const SETTLED = 1e-3;

export function wheelFactor(event) {
  const unit = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? 400 : 1;
  const notches = -(Number(event.deltaY) || 0) * unit / WHEEL_NOTCH;
  return Math.min(WHEEL_STEP_MAX, Math.max(1 / WHEEL_STEP_MAX, WHEEL_FACTOR ** notches));
}

export function createGraphCamera() {
  const view = { scale: 1, x: 0, y: 0 };
  const target = { scale: 1, x: 0, y: 0 };
  const size = { width: 0, height: 0 };
  const limits = { min: 0.02, max: CAMERA_MAX_SCALE };
  // While zooming, this graph point stays under this screen point.
  let anchor = null;
  let velocityX = 0;
  let velocityY = 0;

  function clampScale(value) {
    return Math.min(limits.max, Math.max(limits.min, value));
  }

  function setSize(width, height) {
    size.width = width;
    size.height = height;
  }

  function setLimits({ min = limits.min, max = limits.max } = {}) {
    limits.min = Math.max(1e-4, Math.min(min, max));
    limits.max = Math.max(limits.min, max);
    target.scale = clampScale(target.scale);
  }

  function toGraph(screenX, screenY) {
    return { x: (screenX - size.width / 2) / view.scale + view.x, y: (screenY - size.height / 2) / view.scale + view.y };
  }

  function toScreen(x, y) {
    return { x: (x - view.x) * view.scale + size.width / 2, y: (y - view.y) * view.scale + size.height / 2 };
  }

  function stopMotion() {
    anchor = null;
    velocityX = 0;
    velocityY = 0;
  }

  function jumpTo({ scale = view.scale, x = view.x, y = view.y }) {
    stopMotion();
    view.scale = target.scale = clampScale(scale);
    view.x = target.x = x;
    view.y = target.y = y;
  }

  // The scale that shows `box` with `padding` pixels around it.
  function fitScale(box, padding = 24) {
    if (!box || !size.width || !size.height) return view.scale;
    const width = Math.max(1, size.width - padding * 2);
    const height = Math.max(1, size.height - padding * 2);
    return Math.min(width / Math.max(box.width, 1), height / Math.max(box.height, 1));
  }

  function fitTo(box, { padding = 24, maxScale = Infinity, animate = true } = {}) {
    if (!box) return;
    const scale = clampScale(Math.min(maxScale, fitScale(box, padding)));
    const next = { scale, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (!animate) {
      jumpTo(next);
      return;
    }
    stopMotion();
    Object.assign(target, next);
  }

  function zoomAt(factor, screenX = size.width / 2, screenY = size.height / 2) {
    const point = toGraph(screenX, screenY);
    velocityX = 0;
    velocityY = 0;
    anchor = { screenX, screenY, x: point.x, y: point.y };
    target.scale = clampScale(target.scale * factor);
  }

  function panBy(dx, dy) {
    anchor = null;
    view.x -= dx / view.scale;
    view.y -= dy / view.scale;
    target.x = view.x;
    target.y = view.y;
    target.scale = view.scale;
  }

  // A released pan keeps going with this velocity (pixels per frame) and slows down.
  function coast(vx, vy) {
    velocityX = vx;
    velocityY = vy;
  }

  // Advances one frame; true while still moving.
  function step() {
    let moving = false;
    const ratio = target.scale / view.scale;
    if (Math.abs(ratio - 1) > SETTLED) {
      view.scale *= ratio ** EASE;
      moving = true;
    } else {
      view.scale = target.scale;
    }
    if (anchor) {
      view.x = target.x = anchor.x - (anchor.screenX - size.width / 2) / view.scale;
      view.y = target.y = anchor.y - (anchor.screenY - size.height / 2) / view.scale;
      if (!moving) anchor = null;
    } else {
      const dx = target.x - view.x;
      const dy = target.y - view.y;
      if (Math.abs(dx) * view.scale > 0.05 || Math.abs(dy) * view.scale > 0.05) {
        view.x += dx * EASE;
        view.y += dy * EASE;
        moving = true;
      } else {
        view.x = target.x;
        view.y = target.y;
      }
    }
    if (Math.hypot(velocityX, velocityY) > INERTIA_STOP_PX) {
      panBy(velocityX, velocityY);
      velocityX *= INERTIA_DECAY;
      velocityY *= INERTIA_DECAY;
      moving = true;
    } else {
      velocityX = 0;
      velocityY = 0;
    }
    return moving;
  }

  return { view, target, size, limits, setSize, setLimits, toGraph, toScreen, jumpTo, fitScale, fitTo, zoomAt, panBy, coast, step, stopMotion };
}
