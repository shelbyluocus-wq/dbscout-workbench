import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

import { buildDevServerUrl, findAvailablePort } from "./dev-port.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const requestedUrl = process.env.DBSCOUT_GRID_TEST_URL || "";
let server = null;
let serverOutput = "";

async function waitForServer(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode != null) {
      throw new Error(`Vite exited before the browser test started.\n${serverOutput}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}.\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode != null) return;
  const exited = once(server, "exit");
  server.kill();
  await Promise.race([exited, delay(2_000)]);
  if (server.exitCode == null) {
    server.kill("SIGKILL");
    await exited;
  }
}

async function dragBetween(page, startLocator, endLocator, { startXOffset = null } = {}) {
  const start = await startLocator.boundingBox();
  const end = await endLocator.boundingBox();
  assert.ok(start, "drag start is not visible");
  assert.ok(end, "drag end is not visible");
  const from = {
    x: startXOffset == null ? start.x + start.width / 2 : start.x + startXOffset,
    y: start.y + start.height / 2,
  };
  const to = {
    x: startXOffset == null ? end.x + end.width / 2 : end.x + startXOffset,
    y: end.y + end.height / 2,
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

const url = requestedUrl || buildDevServerUrl(host, await findAvailablePort({ start: 15431, host }));
if (!requestedUrl) {
  const viteBin = path.join(rootDirectory, "node_modules", "vite", "bin", "vite.js");
  server = spawn(process.execPath, [viteBin, "--host", host, "--port", new URL(url).port, "--strictPort"], {
    cwd: rootDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, VITE_DEV_HOST: host, VITE_DEV_PORT: new URL(url).port },
  });
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
}

let browser;
try {
  await waitForServer(url);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByRole("option", { name: "player", exact: true }).dblclick();
  await page.getByRole("grid", { name: "player 数据网格", exact: true }).waitFor();

  const firstRowHeader = page.locator('tr[data-row-selection-index="0"] > .wb-row-header');
  await firstRowHeader.click({ button: "right" });
  await page.getByRole("menuitem", { name: "往下新增行", exact: true }).click();

  const insertRow = page.locator('tr.wb-insert-row[data-row-selection-index="1"]');
  await insertRow.waitFor();
  const insertCell = insertRow.locator('td[data-column-index="1"]');
  const savedTargetCell = page.locator('tr[data-row-selection-index="2"] td[data-column-index="2"]');
  await dragBetween(page, insertCell, savedTargetCell);

  const selectedCells = await page.locator(".wb-grid td.range-selected").evaluateAll((cells) => cells.map((cell) => (
    `${cell.dataset.visualRowIndex}:${cell.dataset.columnIndex}`
  )).sort());
  assert.deepEqual(selectedCells, ["1:1", "1:2", "2:1", "2:2"]);

  const insertRowHeader = insertRow.locator(".wb-row-header");
  const savedTargetHeader = page.locator('tr[data-row-selection-index="2"] > .wb-row-header');
  await dragBetween(page, insertRowHeader, savedTargetHeader, { startXOffset: 5 });

  const selectedRows = await page.locator(".wb-grid tbody tr.row-selected[data-row-selection-index]")
    .evaluateAll((rows) => rows.map((row) => row.dataset.rowSelectionIndex).sort());
  assert.deepEqual(selectedRows, ["1", "2"]);

  console.log("Grid insert-row browser drag regression passed.");
} finally {
  await browser?.close();
  await stopServer();
}
