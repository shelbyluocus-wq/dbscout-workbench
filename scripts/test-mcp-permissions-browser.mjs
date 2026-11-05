import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const base = process.env.DBSCOUT_MCP_TEST_URL || "http://127.0.0.1:1431";
const screenshots = process.env.DBSCOUT_MCP_SCREENSHOTS || join(tmpdir(), "blackcat-mcp-permissions");
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("dbscout_language", "zh-CN"));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const entry = page.locator('[data-wb-rail-id="blackcatMcp"]');
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "黑猫 MCP", exact: true });
  await dialog.waitFor();
  const names = ["读取绑定项目代码", "后台关联扫描", "修改本地关联规则"];
  for (const name of names) assert.equal(await dialog.getByRole("switch", { name, exact: true }).isChecked(), false);
  assert.equal(await dialog.getByRole("switch").count(), 8);
  const scan = dialog.getByRole("switch", { name: names[1], exact: true });
  await scan.check();
  assert.equal(await scan.isChecked(), true);
  assert.equal(await dialog.getByRole("switch", { name: names[0], exact: true }).isChecked(), false);
  assert.equal(await dialog.getByRole("switch", { name: names[2], exact: true }).isChecked(), false);
  await page.keyboard.press("Escape");
  await entry.click();
  assert.equal(await dialog.getByRole("switch", { name: names[1], exact: true }).isChecked(), true);
  await dialog.getByRole("switch", { name: names[1], exact: true }).uncheck();
  await dialog.screenshot({ path: join(screenshots, "permissions-desktop.png") });
  await page.setViewportSize({ width: 800, height: 600 });
  await dialog.getByRole("switch", { name: names[2], exact: true }).scrollIntoViewIfNeeded();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600);
  await dialog.screenshot({ path: join(screenshots, "permissions-small.png") });
  assert.deepEqual(errors, []);
  console.log(`MCP permission defaults, independent toggles, reopen and small-window layout passed. Screenshots: ${screenshots}`);
} finally {
  await browser.close();
}
