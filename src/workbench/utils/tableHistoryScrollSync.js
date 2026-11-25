/**
 * Anti-jitter synchronized dual-pane scrolling & hysteresis virtual window
 * helpers for TableChangeHistoryView.
 *
 * Eliminates dual-scroller ping-pong feedback loops under macOS WKWebView
 * momentum scrolling and avoids unnecessary Vue virtual-slice churn while
 * scrolling inside the pre-rendered overscan buffer.
 */

export function computeHysteresisVirtualWindow({
  total = 0,
  scrollTop = 0,
  viewportHeight = 520,
  rowHeight = 30,
  bufferRows = 20,
  triggerMargin = 8,
  currentStart = 0,
  smallTableLimit = 120,
  force = false,
} = {}) {
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  if (safeTotal === 0) return { start: 0, end: 0 };
  if (safeTotal <= smallTableLimit) return { start: 0, end: safeTotal };

  const safeRowHeight = Math.max(1, Number(rowHeight) || 30);
  const safeViewport = Math.max(240, Number(viewportHeight) || 520);
  const safeTop = Math.max(0, Number(scrollTop) || 0);
  const visibleCount = Math.ceil(safeViewport / safeRowHeight) + 1;
  const windowSize = visibleCount + bufferRows * 2;
  const maxStart = Math.max(0, safeTotal - windowSize);

  const firstVisible = Math.min(safeTotal - 1, Math.floor(safeTop / safeRowHeight));
  const lastVisible = Math.min(safeTotal - 1, firstVisible + visibleCount);

  const clampedCurrentStart = Math.min(maxStart, Math.max(0, Math.floor(Number(currentStart) || 0)));
  const currentEnd = Math.min(safeTotal, clampedCurrentStart + windowSize);

  const topSafe = clampedCurrentStart === 0 || firstVisible - clampedCurrentStart >= triggerMargin;
  const bottomSafe = currentEnd >= safeTotal || currentEnd - 1 - lastVisible >= triggerMargin;

  if (!force && topSafe && bottomSafe) {
    return { start: clampedCurrentStart, end: currentEnd };
  }

  const nextStart = Math.min(maxStart, Math.max(0, firstVisible - bufferRows));
  const nextEnd = Math.min(safeTotal, nextStart + windowSize);
  return { start: nextStart, end: nextEnd };
}

function clampScroll(value, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.max(0, max), value));
}

export function createDualPaneScrollSync({
  getBefore = () => null,
  getAfter = () => null,
  onSync = () => {},
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  driverLockMs = 220,
  echoWindowMs = 160,
  programmaticLockMs = 120,
  epsilon = 2,
} = {}) {
  let activeDriver = "";
  let lastDriverAt = 0;
  let programmaticLockUntil = 0;
  const peerEcho = { before: null, after: null };

  function getEl(side) {
    return side === "before" ? getBefore() : getAfter();
  }

  function getPeerSide(side) {
    return side === "before" ? "after" : "before";
  }

  function isEcho(side, top, left, ts) {
    const rec = peerEcho[side];
    if (!rec) return false;
    if (ts - rec.at > echoWindowMs) {
      peerEcho[side] = null;
      return false;
    }
    return Math.abs(top - rec.top) <= epsilon && Math.abs(left - rec.left) <= epsilon;
  }

  function claimDriver(side) {
    if (side !== "before" && side !== "after") return;
    activeDriver = side;
    lastDriverAt = now();
  }

  function handleScroll(side, sourceOverride = null) {
    if (side !== "before" && side !== "after") return false;
    const source = sourceOverride || getEl(side);
    if (!source) return false;

    const ts = now();
    if (ts < programmaticLockUntil) return false;

    const maxTop = Math.max(0, (source.scrollHeight || 0) - (source.clientHeight || 0));
    const maxLeft = Math.max(0, (source.scrollWidth || 0) - (source.clientWidth || 0));
    const top = clampScroll(Number(source.scrollTop) || 0, maxTop);
    const left = clampScroll(Number(source.scrollLeft) || 0, maxLeft);

    if (activeDriver && activeDriver !== side) {
      // Passive peer must NEVER hijack leadership and pull the active scroller backwards
      // during trackpad momentum or asynchronous WebKit scroll event delivery.
      if (isEcho(side, top, left, ts) || ts - lastDriverAt < driverLockMs) {
        return false;
      }
    } else if (!activeDriver && isEcho(side, top, left, ts)) {
      return false;
    }

    activeDriver = side;
    lastDriverAt = ts;

    const peerSide = getPeerSide(side);
    const peer = getEl(peerSide);
    if (peer) {
      const peerMaxTop = Math.max(0, (peer.scrollHeight || 0) - (peer.clientHeight || 0));
      const peerMaxLeft = Math.max(0, (peer.scrollWidth || 0) - (peer.clientWidth || 0));
      const targetTop = clampScroll(top, peerMaxTop);
      const targetLeft = clampScroll(left, peerMaxLeft);
      let wrote = false;
      if (Math.abs((Number(peer.scrollTop) || 0) - targetTop) >= 0.5) {
        peer.scrollTop = targetTop;
        wrote = true;
      }
      if (Math.abs((Number(peer.scrollLeft) || 0) - targetLeft) >= 0.5) {
        peer.scrollLeft = targetLeft;
        wrote = true;
      }
      if (wrote) {
        peerEcho[peerSide] = {
          top: Number(peer.scrollTop) || 0,
          left: Number(peer.scrollLeft) || 0,
          at: ts,
        };
      }
    }

    onSync({
      side,
      top,
      left,
      clientHeight: Number(source.clientHeight) || 0,
      force: false,
    });
    return true;
  }

  function scrollBothTo(targetTop, targetLeft = null) {
    const beforeEl = getBefore();
    const afterEl = getAfter();
    const ts = now();
    const clampedTop = Math.max(0, Math.round(Number(targetTop) || 0));
    const clampedLeft = targetLeft === null ? null : Math.max(0, Math.round(Number(targetLeft) || 0));

    programmaticLockUntil = ts + programmaticLockMs;
    activeDriver = "";

    for (const [side, el] of [["before", beforeEl], ["after", afterEl]]) {
      if (!el) continue;
      const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
      const maxLeft = Math.max(0, (el.scrollWidth || 0) - (el.clientWidth || 0));
      el.scrollTop = clampScroll(clampedTop, maxTop);
      if (clampedLeft !== null) {
        el.scrollLeft = clampScroll(clampedLeft, maxLeft);
      }
      peerEcho[side] = {
        top: Number(el.scrollTop) || 0,
        left: Number(el.scrollLeft) || 0,
        at: ts,
      };
    }

    const refEl = beforeEl || afterEl;
    onSync({
      side: "programmatic",
      top: refEl ? Math.max(0, Number(refEl.scrollTop) || 0) : clampedTop,
      left: refEl ? Math.max(0, Number(refEl.scrollLeft) || 0) : (clampedLeft ?? 0),
      clientHeight: Number(refEl?.clientHeight) || 0,
      force: true,
    });
  }

  function reset() {
    activeDriver = "";
    lastDriverAt = 0;
    programmaticLockUntil = 0;
    peerEcho.before = null;
    peerEcho.after = null;
  }

  return {
    claimDriver,
    handleScroll,
    scrollBothTo,
    reset,
    getActiveDriver: () => activeDriver,
  };
}
