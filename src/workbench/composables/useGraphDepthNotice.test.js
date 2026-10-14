import test from "node:test";
import assert from "node:assert/strict";
import { effectScope, nextTick, shallowRef } from "vue";

import { useGraphDepthNotice } from "./useGraphDepthNotice.js";

function picture(depth, count, { center = "hub", scope = "local" } = {}) {
  return { scope, center, options: depth ? { depth } : {}, nodes: Array.from({ length: count }, (_, at) => ({ id: `t${at}` })) };
}

test("only a depth change raises a notice, and every change raises a new one", async () => {
  const scope = effectScope();
  const graph = shallowRef(picture(1, 12));
  const notice = scope.run(() => useGraphDepthNotice(graph));
  assert.equal(notice.value, null);
  graph.value = picture(2, 50);
  await nextTick();
  assert.match(notice.value.text, /38/u);
  const first = notice.value.id;
  graph.value = picture(1, 12);
  await nextTick();
  assert.notEqual(notice.value.id, first);
  const shrunk = notice.value.id;
  // New data, a new center or the whole database: quiet.
  graph.value = picture(1, 14);
  await nextTick();
  graph.value = picture(2, 30, { center: "other" });
  await nextTick();
  graph.value = picture(0, 300, { scope: "database" });
  await nextTick();
  assert.equal(notice.value.id, shrunk);
  scope.stop();
});
