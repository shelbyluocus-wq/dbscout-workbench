import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

await mkdir("output/playwright", { recursive: true });
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.DBSCOUT_TAB_TEST_URL || "http://127.0.0.1:1431");
    await page.locator(".wb-object-tabs").first().waitFor();
    await page.evaluate(async () => {
      const { createApp, h, ref } = await import("/node_modules/.vite/deps/vue.js");
      const { default: Tabs } = await import("/src/workbench/components/WorkbenchTabs.vue");
      document.querySelector("#app").remove();
      const host = document.createElement("div");
      host.id = "overflow-test";
      document.body.append(host);
      const tabs = ref([{ id: "home", kind: "home" }, ...Array.from({ length: 30 }, (_, index) => ({
        id: `tab-${index}`, kind: "data", tableName: `config_table_${index}`, connectionId: "demo", database: "game_db",
      }))]);
      const active = ref("tab-29");
      createApp({ render: () => h(Tabs, {
        tabs: tabs.value, activeTabId: active.value,
        "onActivate-tab": (id) => { active.value = id; },
        "onClose-tab": (id) => {
          tabs.value = tabs.value.filter((tab) => tab.id !== id);
          if (active.value === id) active.value = tabs.value.at(-1).id;
        },
      }) }).mount(host);
    });
    const trigger = page.locator(".wb-tab-overflow-button");
    const menu = page.locator(".wb-tab-overflow-menu");
    await trigger.waitFor();
    assert.match(await page.locator(".wb-tab.active").innerText(), /config_table_29/);
    await trigger.click();
    const hidden = await menu.getByRole("menuitem").count();
    assert.equal(await page.locator(".wb-tab").count() + hidden, 31);
    const target = await menu.getByRole("menuitem").first().locator("span").textContent();
    await menu.getByRole("menuitem").first().click();
    assert.ok((await page.locator(".wb-tab.active").innerText()).includes(target));
    assert.equal(await menu.count(), 0);
    await trigger.click();
    await page.keyboard.press("End");
    assert.equal(await menu.getByRole("menuitem").last().evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
    await page.setViewportSize({ width: 600, height: 700 });
    await trigger.click();
    await page.screenshot({ path: `output/playwright/tab-overflow-${name}.png` });
    assert.ok(await menu.getByRole("menuitem").count() > hidden);
    await page.mouse.click(20, 500);
    assert.equal(await menu.count(), 0);
    await page.locator(".wb-tab.active .wb-tab-close").click();
    assert.match(await page.locator(".wb-tab.active").innerText(), /config_table_29/);
    assert.deepEqual(errors, []);
    console.log(`${name}: 30 tables, overflow selection, resizing, keyboard and close passed`);
  } finally {
    await browser.close();
  }
}
