// Where each table of the relation graph is drawn: the ring layout, except
// tables the user dragged, which stay where they were dropped for the rest of
// the session (in the inline and the full-screen view alike). New pictures
// glide from the old one; a drag moves only the dragged table, directly.
import { getCurrentScope, onScopeDispose, ref, shallowRef } from "vue";
import { glideStarts } from "../utils/relationGraphGeometry.js";
import { glideFrames } from "./useGraphViewport.js";

const GLIDE_MS = 260;
const SESSION_LIMIT = 40;

// Dragged tables per graph key, in layout units (positions divided by the
// spread) so an arrangement keeps its shape when the view grows or shrinks.
const sessionArrangements = new Map();

function arrangementFor(key, create = false) {
  if (!key) return null;
  let arrangement = sessionArrangements.get(key);
  if (!arrangement && create) {
    if (sessionArrangements.size >= SESSION_LIMIT) sessionArrangements.delete(sessionArrangements.keys().next().value);
    arrangement = new Map();
    sessionArrangements.set(key, arrangement);
  }
  return arrangement || null;
}

export function forgetGraphArrangements() {
  sessionArrangements.clear();
}

export function useGraphArrangement() {
  const positions = shallowRef(new Map());
  // Whether this graph has tables the user moved (enables "restore layout").
  const arranged = ref(false);
  let key = "";
  // Without a key the arrangement lives as long as this graph does.
  let ownArrangement = null;
  let nodes = [];
  let homes = new Map();
  let spread = { x: 1, y: 1 };
  let stop = () => {};

  function store(create = false) {
    if (key) return arrangementFor(key, create);
    if (!ownArrangement && create) ownArrangement = new Map();
    return ownArrangement;
  }

  function targets() {
    const moved = store();
    const result = new Map();
    for (const node of nodes) {
      const unit = moved?.get(node.id);
      result.set(node.id, unit ? { x: unit.x * spread.x, y: unit.y * spread.y } : homes.get(node.id) || { x: 0, y: 0 });
    }
    return result;
  }

  function glide(next, { animate = true } = {}) {
    stop();
    const previous = positions.value;
    if (!animate || !previous.size) {
      positions.value = next;
      return;
    }
    const starts = glideStarts(nodes, next, previous);
    stop = glideFrames(GLIDE_MS, (eased) => {
      const frameMap = new Map();
      for (const [id, target] of next) {
        const start = starts.get(id) || target;
        frameMap.set(id, { x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased });
      }
      positions.value = frameMap;
    });
  }

  /**
   * A new picture: `layoutKey` names the graph (scope and center table),
   * `homes` holds the ring layout already stretched by `layoutSpread`.
   */
  function setLayout({ layoutKey = "", nodes: nextNodes = [], homes: nextHomes = new Map(), spread: nextSpread = { x: 1, y: 1 }, animate = true }) {
    key = layoutKey;
    nodes = nextNodes;
    homes = nextHomes;
    spread = { x: nextSpread.x || 1, y: nextSpread.y || 1 };
    const moved = store();
    arranged.value = Boolean(moved && nodes.some((node) => moved.has(node.id)));
    glide(targets(), { animate });
  }

  // Puts a table where the pointer is; it stays there.
  function move(id, point) {
    if (!homes.has(id) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    stop();
    store(true).set(id, { x: point.x / spread.x, y: point.y / spread.y });
    const next = new Map(positions.value);
    next.set(id, { x: point.x, y: point.y });
    positions.value = next;
    arranged.value = true;
  }

  // Back to the ring layout.
  function reset() {
    if (key) sessionArrangements.delete(key);
    ownArrangement = null;
    arranged.value = false;
    glide(targets());
  }

  if (getCurrentScope()) onScopeDispose(() => stop());

  return { positions, arranged, setLayout, move, reset, targets };
}
