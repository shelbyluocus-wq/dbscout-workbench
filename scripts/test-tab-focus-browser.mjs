import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, open: false },
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1264, height: 815 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/__tab-focus-test", (route) => route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><link rel="stylesheet" href="/src/workbench/workbench.css"></head><body></body></html>',
      }));
      await page.goto(`${server.resolvedUrls.local[0]}__tab-focus-test`);
      await page.evaluate(async () => {
        const { createApp, h, ref } = await import("/node_modules/.vite/deps/vue.js");
        const { default: Tabs } = await import("/src/workbench/components/WorkbenchTabs.vue");
        const host = document.createElement("div");
        document.body.append(host);
        const tabs = ref(["goodsprop", "act25duolun2prop", "arenanpcprop"].map((id) => ({
          id, kind: "data", tableName: id, connectionId: "demo", database: "newsg_4cfg",
        })));
        const active = ref("act25duolun2prop");
        window.tabFocusTest = { activate: (id) => { active.value = id; } };
        createApp({ render: () => h("div", { id: "tab-focus-test", class: "mysql-workbench" }, [
          h(Tabs, {
            tabs: tabs.value, activeTabId: active.value,
            "onActivate-tab": (id) => { active.value = id; },
            "onClose-tab": (id) => {
              tabs.value = tabs.value.filter((tab) => tab.id !== id);
              if (active.value === id) active.value = tabs.value.at(-1).id;
            },
          }),
          h("input", { id: "table-search", value: active.value }),
        ]) }).mount(host);
      });
      const tabs = page.locator("#tab-focus-test .wb-tab");
      const second = tabs.filter({ hasText: "act25duolun2prop" });
      const third = tabs.filter({ hasText: "arenanpcprop" });
      await second.focus();
      await page.keyboard.press("Enter");
      assert.equal(await second.evaluate((node) => node.matches(":focus-visible")), true);
      await page.evaluate(() => window.tabFocusTest.activate("arenanpcprop"));
      await page.waitForFunction(() => document.querySelector("#tab-focus-test .wb-tab.active")?.textContent.includes("arenanpcprop"));
      assert.equal(await second.evaluate((node) => node.matches(":focus-visible")), false, "departed tab must not retain its focus outline");
      assert.equal(await third.evaluate((node) => node === document.activeElement), true, "keyboard focus follows the active tab");
      await page.keyboard.press("Enter");
      assert.match(await page.locator("#tab-focus-test .wb-tab.active").innerText(), /arenanpcprop/);
      await page.locator("#table-search").focus();
      await page.evaluate(() => window.tabFocusTest.activate("goodsprop"));
      await page.waitForFunction(() => document.querySelector("#tab-focus-test .wb-tab.active")?.textContent.includes("goodsprop"));
      assert.equal(await page.locator("#table-search").evaluate((node) => node === document.activeElement), true, "switching must not steal search focus");
      await third.focus();
      assert.equal(await third.evaluate((node) => node.matches(":focus-visible")), true, "inactive tabs retain accessible keyboard focus");
      await page.keyboard.press("Space");
      await third.locator(".wb-tab-close").click();
      await page.waitForFunction(() => document.querySelector("#tab-focus-test .wb-tab.active")?.textContent.includes("act25duolun2prop"));
      assert.equal(await second.evaluate((node) => node === document.activeElement), true, "closing a focused tab restores focus to its successor");
      await second.locator(".wb-tab-close").focus();
      await page.keyboard.press("Space");
      await second.waitFor({ state: "detached" });
      assert.equal(await tabs.first().getAttribute("aria-pressed"), "true", "keyboard close selects the surviving tab");
      assert.deepEqual(errors, []);
      console.log(`${engine.name()}: tab switch, keyboard activation, search focus and focused close passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
