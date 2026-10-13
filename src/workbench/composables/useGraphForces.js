// Runs the relation-graph spring simulation on animation frames and exposes
// the current positions. Frames only run while something moves, so a graph at
// rest costs nothing.
import { onBeforeUnmount, shallowRef } from "vue";
import { createGraphSimulation, startPositions } from "../utils/relationGraphForces.js";
import { prefersReducedMotion } from "./useGraphViewport.js";

export function useGraphForces() {
  const positions = shallowRef(new Map());
  let simulation = null;
  let frame = 0;

  function step() {
    frame = 0;
    if (!simulation) return;
    const moving = simulation.tick();
    positions.value = simulation.snapshot();
    if (moving) frame = globalThis.requestAnimationFrame(step);
  }

  function wake() {
    if (frame || !simulation || typeof globalThis.requestAnimationFrame !== "function") return;
    frame = globalThis.requestAnimationFrame(step);
  }

  function stop() {
    if (frame) globalThis.cancelAnimationFrame?.(frame);
    frame = 0;
  }

  // `homes` maps id -> rest position. The first picture appears at rest;
  // later ones animate from what was drawn before.
  function rebuild(nodes, links, homes) {
    stop();
    const previous = positions.value.size && !prefersReducedMotion() ? positions.value : null;
    const starts = startPositions(nodes, homes, previous);
    simulation = createGraphSimulation({
      nodes: nodes.map((node) => {
        const home = homes.get(node.id) || { x: 0, y: 0 };
        const start = starts.get(node.id) || home;
        return { id: node.id, radius: node.radius, homeX: home.x, homeY: home.y, x: start.x, y: start.y };
      }),
      links,
    });
    positions.value = simulation.snapshot();
    wake();
  }

  function pin(id, point) {
    if (!simulation?.has(id)) return;
    simulation.pin(id, point.x, point.y);
    positions.value = simulation.snapshot();
    wake();
  }

  function release(id) {
    simulation?.unpin(id);
    wake();
  }

  onBeforeUnmount(() => {
    stop();
    simulation = null;
  });

  return { positions, rebuild, pin, release };
}
