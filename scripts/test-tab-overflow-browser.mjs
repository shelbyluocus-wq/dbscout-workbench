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
      const { useAliases } = await import("/src/workbench/composables/aliasStore.js");
      useAliases().setConnectionAlias("demo", "决胜2");
      const { useDatabaseDecorations } = await import("/src/workbench/composables/databaseDecorationStore.js");
      useDatabaseDecorations().setDatabaseDecoration("demo", "game_db", { icon: "rocket", color: "#ea580c", textColor: "preset:teal" });
      document.querySelector("#app").remove();
      const host = document.createElement("div");
      host.id = "overflow-test";
      host.className = "mysql-workbench";
      host.dataset.theme = "light";
      document.body.append(host);
      const tabs = ref([{ id: "home", kind: "home" }, ...Array.from({ length: 30 }, (_, index) => ({
        id: `tab-${index}`, kind: index % 5 === 3 ? "design" : "data", tableName: `config_table_${index}`, connectionId: "demo", database: "game_db",
      }))]);
      const active = ref("tab-29");
      createApp({ render: () => h(Tabs, {
        tabs: tabs.value, activeTabId: active.value,
        connections: [{ id: "demo", label: "root@127.0.0.1:3306" }],
        "onActivate-tab": (id) => { active.value = id; },
        "onClose-tab": (id) => {
          tabs.value = tabs.value.filter((tab) => tab.id !== id);
          if (active.value === id) active.value = tabs.value.at(-1).id;
        },
      }) }).mount(host);
    });    const trigger = page.locator(".wb-tab-overflow-button");
    const menu = page.locator(".wb-tab-overflow-menu");
    await trigger.waitFor();
    assert.match(await page.locator(".wb-tab.active").innerText(), /config_table_29/);
    await trigger.click();
    const hidden = await menu.getByRole("menuitem").count();
    assert.equal(await page.locator(".wb-tab").count() + hidden, 31);
    const firstItem = menu.getByRole("menuitem").first();
    assert.equal(await firstItem.locator(".wb-tab-overflow-connection").textContent(), "决胜2");
    assert.equal(await firstItem.locator(".wb-tab-db").textContent(), "game_db");
    // Pills name tables only; the menu still shows each tab's database in its
    // decoration colours (icon colour, and a text colour per appearance).
    assert.equal(await page.locator(".wb-tab .wb-tab-db").count(), 0);
    const sourceColors = async () => ({
      menu: await firstItem.locator(".wb-tab-db").evaluate((node) => getComputedStyle(node).color),
      menuIcon: await firstItem.locator(".wb-tab-db-icon.is-decorated").evaluate((node) => getComputedStyle(node).color),
    });
    const lightColors = await sourceColors();
    assert.equal(lightColors.menuIcon, "rgb(234, 88, 12)");
    await firstItem.hover();
    const designItems = menu.getByRole("menuitem").filter({ has: page.locator(".wb-tab-overflow-tag") });
    assert.ok(await designItems.count() > 0);
    assert.match(await designItems.first().locator(".wb-tab-overflow-name").textContent(), /config_table_\d*3$|config_table_\d*8$/);
    assert.equal(await page.locator(".wb-tab-overflow-layer").getAttribute("data-theme"), "light");
    const lightSurface = await menu.evaluate((node) => getComputedStyle(node).backgroundColor);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `output/playwright/tab-overflow-${name}-light.png` });
    await page.keyboard.press("Escape");
    await page.locator("#overflow-test").evaluate((node) => { node.dataset.theme = "dark"; });
    await trigger.click();
    assert.equal(await page.locator(".wb-tab-overflow-layer").getAttribute("data-theme"), "dark");
    const darkSurface = await menu.evaluate((node) => getComputedStyle(node).backgroundColor);
    const darkColors = await sourceColors();
    assert.equal(darkColors.menuIcon, lightColors.menuIcon);
    assert.notEqual(darkColors.menu, lightColors.menu);
    await firstItem.hover();
    assert.notEqual(darkSurface, lightSurface);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `output/playwright/tab-overflow-${name}-dark.png` });
    await page.keyboard.press("Escape");
    await page.locator("#overflow-test").evaluate((node) => { node.dataset.theme = "light"; });
    await trigger.click();
    const target = await firstItem.locator(".wb-tab-overflow-name").textContent();
    await firstItem.click();    assert.ok((await page.locator(".wb-tab.active").innerText()).includes(target));
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
