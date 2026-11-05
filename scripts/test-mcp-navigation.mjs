import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0, open: false } });
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.goto(server.resolvedUrls.local[0]);
      await page.getByRole("option", { name: "player", exact: true }).waitFor();
      await page.evaluate(async () => {
        const { onMockEvent } = await import("/src/workbench/mock/mockEventBus.js");
        window.controlAction = (action, args = {}) => new Promise((resolve, reject) => {
          const requestId = crypto.randomUUID();
          const timer = setTimeout(() => { unlisten(); reject(new Error(`timeout ${action}`)); }, 10000);
          const unlisten = onMockEvent("control-ui-result", ({ payload }) => {
            if (payload.requestId !== requestId) return;
            clearTimeout(timer);
            unlisten();
            resolve(payload);
          });
          window.__DBSCOUT_SIMULATE_UI_ACTION__(action, { ...args, requestId });
        });
      });
      const action = (name, args) => page.evaluate(({ name, args }) => window.controlAction(name, args), { name, args });
      const opened = await action("open_table", { table: "player", demoStep: "1/4" });
      assert.equal(opened.ok, true, opened.message);
      assert.ok(opened.context.loadedRowCount > 0);
      const scrolled = await action("scroll_table", { table: "player", direction: "down", screens: 1 });
      assert.equal(scrolled.ok, true, scrolled.message);
      assert.ok(scrolled.context.viewport.scrollTop > 0);
      assert.ok(scrolled.context.viewport.visibleRowKeys.length > 0);
      const current = await action("get_view_state");
      assert.equal(current.context.viewport.scrollTop, scrolled.context.viewport.scrollTop);
      const invalid = await action("focus_cell", { table: "player", column: "missing", rowIdentity: { id: 1 } });
      assert.equal(invalid.ok, false);
      const first = await action("scroll_table", { table: "player", direction: "top" });
      assert.equal(first.ok, true, first.message);
      assert.equal(first.context.viewport.scrollTop, 0);
      const columns = first.context.columns;
      const key = first.context.viewport.visibleRowKeys[0];
      const selected = await action("focus_cell", { table: "player", column: columns[0], rowKey: key });
      assert.equal(selected.ok, true, selected.message);
      assert.equal(selected.context.selectedCell.rowKey, key);
      assert.equal(selected.context.selectedCell.columnName, columns[0]);
      const tail = await action("scroll_table", { table: "player", direction: "bottom" });
      assert.equal(tail.ok, true, tail.message);
      assert.ok(tail.context.viewport.scrollTop > 0);
      const fromTail = await action("focus_row", { table: "player", rowIdentity: { id: "1" } });
      assert.equal(fromTail.ok, true, fromTail.message);
      assert.equal(fromTail.context.selectedCell.rowKey, "id=1");
      const filtered = await action("open_table", { table: "player", filter: "__no_matching_record__", filterMode: "exact" });
      assert.equal(filtered.ok, true, filtered.message);
      const other = await action("open_table", { table: "hero" });
      assert.equal(other.ok, true, other.message);
      const identity = Object.fromEntries(key.split("&").map((part) => part.split("=")));
      const located = await action("focus_row", { table: "player", rowIdentity: identity });
      assert.equal(located.ok, true, located.message);
      assert.equal(located.context.selectedCell.rowKey, key);
      assert.ok(located.context.relationFilter);
      assert.notEqual(located.context.tabId, filtered.context.tabId);
      assert.ok(located.context.tabs.some((tab) => tab.id === filtered.context.tabId));
      assert.equal(located.context.tabs.find((tab) => tab.id === filtered.context.tabId).filter, "__no_matching_record__");
      await page.screenshot({ path: `/tmp/blackcat-mcp-${engine.name()}.png` });
      console.log(`${engine.name()}: cold/warm open, scroll, fresh context, invalid column, selection, isolated key lookup passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
