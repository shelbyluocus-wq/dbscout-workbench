import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { findAvailablePort } from "./dev-port.mjs";

// Deterministic mock data only; never opens a configured database connection.
const port = await findAvailablePort({ start: 15551, host: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: "ignore" });
let browser;
try {
  for (let i = 0; i < 150; i += 1) {
    if (server.exitCode != null) throw new Error("Vite exited before the test");
    try { if ((await fetch(base)).ok) break; } catch {}
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?perfProfile=deterministic-v1&scenario=rows-10k-20-pk`, { waitUntil: "networkidle" });
  await page.getByRole("option").filter({ hasText: "perf_rows_10k_20_pk" }).first().dblclick();
  await page.getByRole("button", { name: "跳到末行", exact: true }).click();
  const idCell = (id) => page.locator('.wb-grid-row td[data-column-index="0"]').filter({ hasText: new RegExp(`^${id}$`) });
  await idCell(9997).click();
  await idCell(9999).click({ modifiers: ["Shift"] });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const copy = async () => {
    await page.keyboard.press(`${modifier}+c`);
    await page.waitForFunction(() => document.body.innerText.includes("已复制"));
    return page.evaluate(() => navigator.clipboard.readText());
  };
  assert.equal(await copy(), "9997\n9998\n9999");
  await page.locator(".wb-grid-wrap").evaluate((wrap) => {
    wrap.scrollTop = 9000 * 28;
    wrap.dispatchEvent(new Event("scroll"));
  });
  await idCell(8997).waitFor({ state: "visible" });
  assert.equal(await copy(), "9997\n9998\n9999", "prepending must not change copied row identities");
  await page.keyboard.press(`${modifier}+a`);
  const text = await copy();
  assert.ok(text.split("\n").length >= 1000, "large copy must include all selected loaded rows");
  assert.ok(text.includes("9997\t"));
  assert.ok(text.includes("10000\t"));
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("clipboard_test_denied"); }; });
  await page.keyboard.press(`${modifier}+c`);
  await page.waitForFunction(() => document.body.innerText.includes("复制失败") && document.body.innerText.includes("clipboard_test_denied"));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, copiedRows: text.split("\n").length, prependSelection: "9997..9999", visibleClipboardFailure: true }));
} finally {
  await browser?.close();
  if (server.exitCode == null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
}
