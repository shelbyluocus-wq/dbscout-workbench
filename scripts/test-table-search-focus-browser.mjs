import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, open: false },
});

async function verifyConsecutiveClose(page, key) {
  const tabs = page.locator('.wb-tab');
  const home = tabs.filter({ hasText: 'Home' });
  const rows = page.locator('.wb-dbhome-object-row');
  const names = await rows.evaluateAll((nodes) => nodes.slice(0, 3).map((node) => node.dataset.tableName));
  assert.equal(names.length, 3);
  for (const name of names) {
    await home.click();
    await page.locator(`.wb-dbhome-object-row[data-table-name="${name}"]`).dblclick();
    await page.locator('.wb-tab.active').filter({ hasText: name }).waitFor();
    await page.locator('.wb-grid tbody td[data-column-name]').first().click();
  }
  const cell = page.locator('.wb-workbench-pane.is-focused .wb-grid tbody td[data-column-name]').first();
  await cell.dblclick();
  await page.keyboard.press(`${key}+w`);
  assert.equal(await tabs.count(), 4, 'a real cell editor protects the tab');
  await page.keyboard.press('Escape');
  await cell.click();
  await page.waitForFunction(() => document.activeElement?.matches('input.wb-cell-ime-hold'));
  await page.keyboard.down(key);
  try {
    for (const name of names.toReversed()) {
      await page.keyboard.press('w');
      await tabs.filter({ hasText: name }).waitFor({ state: 'detached', timeout: 3000 });
    }
  } finally {
    await page.keyboard.up(key);
  }
  assert.equal(await tabs.count(), 1);
  assert.equal(await home.getAttribute('aria-pressed'), 'true');

  // Closing the only table on the right should hand the next keystroke to the left.
  await page.locator(`.wb-dbhome-object-row[data-table-name="${names[0]}"]`).dblclick();
  await page.setViewportSize({ width: 2000, height: 900 });
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  const panes = page.locator('.wb-workbench-pane');
  await panes.nth(1).locator('td[data-column-name]').first().click();
  await page.keyboard.press(`${key}+w`);
  await panes.nth(1).waitFor({ state: 'detached' });
  await page.keyboard.press(`${key}+w`);
  await tabs.filter({ hasText: names[0] }).waitFor({ state: 'detached' });
  assert.equal(await home.getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 1264, height: 815 });
}

async function verifyCustomEditingShortcuts(page, key) {
  await page.locator('.wb-dbhome-object-row[data-table-name="hero"] .wb-dbhome-object-name-button').dblclick();
  const settings = page.locator('[data-wb-rail-id="settings"]');
  await settings.click();
  await page.getByRole("button", { name: "Change…", exact: true }).click();
  const dialog = page.locator(".wb-shortcut-dialog");
  for (const [label, shortcut] of [["Save", `${key}+Shift+k`], ["Undo", `${key}+y`]]) {
    const row = dialog.locator(".wb-shortcut-row").filter({ has: page.getByText(label, { exact: true }) });
    await row.getByRole("button", { name: "Change", exact: true }).click();
    await page.keyboard.press(shortcut);
    await row.locator("kbd").waitFor();
  }
  await dialog.locator(".wb-shortcut-dialog-close").click();
  if (await page.locator(".wb-sidebar-settings-sheet").isVisible()) await settings.click();
  await page.reload();
  await page.locator(".wb-tab.active").filter({ hasText: "hero" }).waitFor();

  const cell = page.locator('td[data-column-name="name"]').first();
  const original = (await cell.innerText()).trim();
  const editor = cell.locator("input[data-ime-editor]:not(.wb-cell-ime-hold)");
  await cell.dblclick();
  await editor.fill("Custom save test");
  await page.keyboard.press(`${key}+s`);
  assert.equal(await editor.isVisible(), true, "the previous save binding must leave the edit open");
  await page.keyboard.press(`${key}+Shift+k`);
  await editor.waitFor({ state: "detached" });
  const saved = cell.getByText("Custom save test", { exact: true });
  await saved.waitFor();
  await cell.click();
  assert.equal(await cell.evaluate((node, modifier) => {
    const event = new KeyboardEvent("keydown", {
      key: "z", code: "KeyZ", bubbles: true, cancelable: true,
      ctrlKey: modifier === "Control", metaKey: modifier === "Meta",
    });
    return node.dispatchEvent(event);
  }, key), true, "the previous undo binding must no longer be handled by the grid");
  await page.keyboard.press(`${key}+y`);
  await cell.getByText(original, { exact: true }).waitFor();
  await page.keyboard.press(`${key}+Shift+z`);
  await saved.waitFor();

  const detail = page.locator(".wb-cell-detail .wb-detail-input");
  if (!(await detail.isVisible())) await page.locator(".wb-cell-detail-toggle").click();
  await detail.fill("Custom detail save");
  await page.keyboard.press(`${key}+Shift+k`);
  await cell.getByText("Custom detail save", { exact: true }).waitFor();
  assert.equal(await detail.evaluate((node) => node === document.activeElement), true);
}

try {
  await server.listen();
  for (const [engine, platform, userAgent, key] of [
    [chromium, "Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Control"],
    [webkit, "MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Meta"],
  ]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1264, height: 815 }, userAgent });
      await page.addInitScript((platform) => {
        Object.defineProperty(navigator, "platform", { get: () => platform });
        Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
      }, platform);
      const errors = [];
      page.on("pageerror", (error) => {
        if (error.message !== "ResizeObserver loop completed with undelivered notifications.") errors.push(error.message);
      });
      await page.goto(server.resolvedUrls.local[0]);
      const rows = page.locator(".wb-dbhome-object-row");
      await rows.first().waitFor();
      const tableName = await rows.first().getAttribute("data-table-name");
      await rows.first().dblclick();
      const search = page.locator(".wb-workbench-pane.is-focused .wb-table-search-field-input");
      await page.waitForFunction(() => document.activeElement?.matches(".wb-table-search-field-input"));
      await page.keyboard.type("focus-check");
      assert.equal(await search.inputValue(), "focus-check", "typing after opening searches without clicking the input");
      await page.waitForTimeout(600);
      await page.locator(".wb-tab").first().click();
      await page.locator(`.wb-dbhome-object-row[data-table-name="${tableName}"]`).dblclick();
      await page.waitForFunction(() => document.activeElement?.matches(".wb-table-search-field-input"));
      assert.equal(await search.evaluate((input) => input.selectionEnd - input.selectionStart), "focus-check".length);
      await page.keyboard.type("replacement");
      assert.equal(await search.inputValue(), "replacement", "reopening selects the saved search text for replacement");
      for (const shortcut of ["Control+d", "Meta+d"]) {
        await search.focus();
        await page.keyboard.press(shortcut);
        const designTab = page.locator(".wb-tab.active.is-design-tab").filter({ hasText: tableName });
        await designTab.waitFor({ timeout: 5000 });
        await designTab.locator(".wb-tab-close").click();
        await search.waitFor();
      }
      await search.focus();
      const nextTab = key === "Meta" ? "Meta+Shift+]" : "Control+Tab";
      const previousTab = key === "Meta" ? "Meta+Shift+[" : "Control+Shift+Tab";
      await page.keyboard.press(nextTab);
      await page.locator(".wb-tab.active").filter({ hasText: "Home" }).waitFor({ timeout: 5000 });
      await page.keyboard.down(key);
      assert.deepEqual(await page.locator(".wb-tab-shortcut-badge").allTextContents(), ["`"]);
      for (const digit of "123456789") {
        await page.keyboard.press(digit);
      }
      await page.keyboard.up(key);
      assert.match(await page.locator(".wb-tab.active").innerText(), /Home/);
      await page.keyboard.press(previousTab);
      await search.waitFor({ timeout: 5000 });
      await page.keyboard.press(`${key}+Backquote`);
      await page.locator(".wb-tab.active").filter({ hasText: "Home" }).waitFor({ timeout: 5000 });
      await page.keyboard.press(previousTab);
      await search.waitFor({ timeout: 5000 });

      await search.focus();
      await page.keyboard.press(`${key}+f`);
      const find = page.locator(".wb-find-replace-dialog");
      await find.waitFor({ timeout: 5000 });
      await page.keyboard.press(`${key}+w`);
      await page.keyboard.press(nextTab);
      await page.keyboard.press(`${key}+d`);
      assert.equal(await find.isVisible(), true);
      assert.equal(await page.locator(".wb-tab.active").filter({ hasText: tableName }).count(), 1);
      assert.equal(await page.locator(".wb-tab.is-design-tab").count(), 0);
      await find.locator(".wb-dialog-close").click();

      await search.focus();
      await page.keyboard.press(`${key}+w`);
      await search.waitFor({ state: "detached", timeout: 5000 });
      assert.equal(await page.locator(".wb-tab").count(), 1);
      await verifyConsecutiveClose(page, key);
      await verifyCustomEditingShortcuts(page, key);
      assert.deepEqual(errors, []);
      console.log(`${engine.name()} (${platform}): table search focus, tab shortcuts, modal isolation, and custom save and undo after reload passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
