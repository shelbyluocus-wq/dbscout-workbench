// A short line for the relation graph after its depth changes ("depth 2
// adds 38 tables", or that it adds none), so a depth switch always answers
// visibly. Changes of center, scope or data stay quiet.
import { shallowRef, watch } from "vue";
import { t } from "../i18n/index.js";
import { depthChangeNotice } from "../utils/relationGraph.js";

export function useGraphDepthNotice(graph) {
  const notice = shallowRef(null);
  let id = 0;
  watch(graph, (next, previous) => {
    const depth = next?.options?.depth;
    const previousDepth = previous?.options?.depth;
    if (!depth || !previousDepth || depth === previousDepth) return;
    if (next.center !== previous.center || next.scope !== previous.scope) return;
    id += 1;
    notice.value = {
      id,
      text: depthChangeNotice({ depth, previousDepth, before: previous.nodes.length, after: next.nodes.length }, t),
    };
  });
  return notice;
}
