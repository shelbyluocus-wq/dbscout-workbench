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
const shortcutModifier = process.platform === "darwin" ? "Meta" : "Control";
const shortcut = (key) => `${shortcutModifier}+${key}`;
const redoShortcut = process.platform === "darwin" ? "Meta+Shift+Z" : "Control+Y";
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

async function dragBetweenInSameTask(page, startLocator, endLocator) {
  const start = await startLocator.boundingBox();
  const end = await endLocator.boundingBox();
  assert.ok(start, "same-task drag start is not visible");
  assert.ok(end, "same-task drag end is not visible");
  await page.evaluate(({ from, to }) => {
    const startTarget = document.elementFromPoint(from.x, from.y);
    startTarget?.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: from.x,
      clientY: from.y,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: to.x,
      clientY: to.y,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0,
      clientX: to.x,
      clientY: to.y,
    }));
  }, {
    from: { x: start.x + start.width / 2, y: start.y + start.height / 2 },
    to: { x: end.x + end.width / 2, y: end.y + end.height / 2 },
  });
}

async function waitForCellSelection(page, expected, timeoutMs = 2_000) {
  const coordinates = [...expected].sort();
  await page.waitForFunction((target) => {
    const actual = [...document.querySelectorAll(".wb-grid td.range-selected")]
      .map((cell) => `${cell.dataset.visualRowIndex}:${cell.dataset.columnIndex}`)
      .sort();
    return JSON.stringify(actual) === JSON.stringify(target);
  }, coordinates, { timeout: timeoutMs });
}

async function waitForRowSelection(page, expected, timeoutMs = 2_000) {
  const indexes = [...expected].sort();
  await page.waitForFunction((target) => {
    const actual = [...document.querySelectorAll(".wb-grid tbody tr.row-selected[data-row-selection-index]")]
      .map((row) => row.dataset.rowSelectionIndex)
      .sort();
    return JSON.stringify(actual) === JSON.stringify(target);
  }, indexes, { timeout: timeoutMs });
}

async function openPlayerGrid(page) {
  const grid = page.getByRole("grid", { name: "player 数据网格", exact: true });
  if (!(await grid.isVisible())) {
    await page.getByRole("option", { name: "player", exact: true }).dblclick();
  }
  await grid.waitFor();
  return grid;
}

async function insertBelow(page, rowHeader) {
  await rowHeader.click({ button: "right" });
  await page.getByRole("menuitem", { name: "往下新增行", exact: true }).click();
}

async function writeClipboard(page, text) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

async function cellValues(row, columnIndexes) {
  return await row.locator("td[data-column-index]").evaluateAll((cells, indexes) => indexes.map((index) => {
    const cell = cells.find((candidate) => Number(candidate.dataset.columnIndex) === index);
    return cell?.querySelector("input")?.value ?? cell?.textContent?.trim() ?? "";
  }), columnIndexes);
}

async function waitForValues(row, columnIndexes, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = [];
  while (Date.now() < deadline) {
    actual = await cellValues(row, columnIndexes);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await delay(20);
  }
  assert.deepEqual(actual, expected);
}

async function waitForInputValue(input, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = "";
  while (Date.now() < deadline) {
    actual = await input.inputValue();
    if (actual === expected) return;
    await delay(20);
  }
  assert.equal(actual, expected);
}

async function assertNativeInputContextMenu(page, input) {
  await page.evaluate(() => {
    window.__wbContextMenuPrevented = null;
    document.addEventListener("contextmenu", (event) => {
      setTimeout(() => { window.__wbContextMenuPrevented = event.defaultPrevented; }, 0);
    }, { capture: true, once: true });
  });
  await input.click({ button: "right" });
  await page.waitForFunction(() => window.__wbContextMenuPrevented !== null);
  assert.equal(await page.evaluate(() => window.__wbContextMenuPrevented), false);
  assert.equal(await page.locator(".wb-context-menu").isVisible().catch(() => false), false);
}

async function assertInputDoesNotStartGridDrag(input) {
  const startedGridDrag = await input.evaluate(async (element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: rect.left + 4,
      clientY: rect.top + rect.height / 2,
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const started = element.closest(".wb-grid-wrap")?.classList.contains("is-selecting-range") || false;
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, buttons: 0 }));
    return started;
  });
  assert.equal(startedGridDrag, false, "dragging text inside an editor must not start a grid range");
}

async function assertLostMouseupEndsGridDrag(page, startLocator, dragClass) {
  const start = await startLocator.boundingBox();
  assert.ok(start, "lost-mouseup drag start is not visible");
  const activeBeforeBlur = await page.evaluate(async ({ point, className }) => {
    document.elementFromPoint(point.x, point.y)?.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: point.x,
      clientY: point.y,
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return document.querySelector(".wb-grid-wrap")?.classList.contains(className) || false;
  }, {
    point: { x: start.x + start.width / 2, y: start.y + start.height / 2 },
    className: dragClass,
  });
  assert.equal(activeBeforeBlur, true, `mousedown must start ${dragClass}`);

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const activeAfterBlur = await page.locator(".wb-grid-wrap").evaluate((element, className) => (
    element.classList.contains(className)
  ), dragClass);
  assert.equal(activeAfterBlur, false, `window blur must end ${dragClass}`);
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
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let grid = await openPlayerGrid(page);

  const firstRowHeader = page.locator('tr[data-row-selection-index="0"] > .wb-row-header');
  await insertBelow(page, firstRowHeader);

  const insertRow = page.locator('tr.wb-insert-row[data-row-selection-index="1"]');
  await insertRow.waitFor();
  const insertCell = insertRow.locator('td[data-column-index="1"]');
  const savedTargetCell = page.locator('tr[data-row-selection-index="2"] td[data-column-index="2"]');
  // Dispatch down, move, and up before Vue can flush the parent's drag prop.
  // This deterministically covers the local drag-state race regression.
  await dragBetweenInSameTask(page, insertCell, savedTargetCell);
  await waitForCellSelection(page, ["1:1", "1:2", "2:1", "2:2"]);

  const savedRow = page.locator('tr[data-row-selection-index="2"]');
  const originalSavedValues = await cellValues(savedRow, [1, 2]);
  await writeClipboard(page, "draft_user\tdraft_nick\nsaved_user\tsaved_nick");
  await page.keyboard.press(shortcut("V"));
  await waitForValues(insertRow, [1, 2], ["draft_user", "draft_nick"]);
  await waitForValues(savedRow, [1, 2], ["saved_user", "saved_nick"]);

  await page.keyboard.press(shortcut("Z"));
  await waitForValues(insertRow, [1, 2], ["", ""]);
  await waitForValues(savedRow, [1, 2], originalSavedValues);

  await page.keyboard.press(redoShortcut);
  await waitForValues(insertRow, [1, 2], ["draft_user", "draft_nick"]);
  await waitForValues(savedRow, [1, 2], ["saved_user", "saved_nick"]);

  await page.keyboard.press(shortcut("Z"));
  await waitForValues(savedRow, [1, 2], originalSavedValues);

  const insertRowHeader = insertRow.locator(".wb-row-header");
  const savedTargetHeader = page.locator('tr[data-row-selection-index="2"] > .wb-row-header');
  await dragBetween(page, insertRowHeader, savedTargetHeader, { startXOffset: 5 });
  await waitForRowSelection(page, ["1", "2"]);
  await assertLostMouseupEndsGridDrag(page, insertCell, "is-selecting-range");
  await assertLostMouseupEndsGridDrag(page, insertRowHeader, "is-row-selecting");

  await page.reload({ waitUntil: "domcontentloaded" });
  grid = await openPlayerGrid(page);
  const reloadedFirstHeader = page.locator('tr[data-row-selection-index="0"] > .wb-row-header');
  await insertBelow(page, reloadedFirstHeader);
  const firstInsertRow = page.locator('tr.wb-insert-row[data-row-selection-index="1"]');
  await firstInsertRow.waitFor();
  await insertBelow(page, firstInsertRow.locator(".wb-row-header"));
  const secondInsertRow = page.locator('tr.wb-insert-row[data-row-selection-index="2"]');
  await secondInsertRow.waitFor();

  await dragBetween(
    page,
    secondInsertRow.locator('td[data-column-index="2"]'),
    firstInsertRow.locator('td[data-column-index="1"]'),
  );
  await waitForCellSelection(page, ["1:1", "1:2", "2:1", "2:2"]);

  await writeClipboard(page, "alpha\tone\nbeta\ttwo");
  await page.keyboard.press(shortcut("V"));
  await waitForValues(firstInsertRow, [1, 2], ["alpha", "one"]);
  await waitForValues(secondInsertRow, [1, 2], ["beta", "two"]);
  assert.equal(await page.locator("tr.wb-insert-row").count(), 2, "bounded paste must not create an overflow insert row");

  const allColumnIndexes = await grid.locator("thead [data-column-index]").evaluateAll((cells) => (
    cells.map((cell) => Number(cell.dataset.columnIndex)).filter(Number.isInteger)
  ));
  const expectedFullRows = [firstInsertRow, secondInsertRow]
    .map(async (row) => (await cellValues(row, allColumnIndexes)).join("\t"));
  const fullRowTsv = (await Promise.all(expectedFullRows)).join("\n");
  await dragBetween(page, firstInsertRow.locator(".wb-row-header"), secondInsertRow.locator(".wb-row-header"), {
    startXOffset: 5,
  });
  await waitForRowSelection(page, ["1", "2"]);
  await page.keyboard.press(shortcut("C"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fullRowTsv);

  await dragBetween(
    page,
    firstInsertRow.locator('td[data-column-index="1"]'),
    secondInsertRow.locator('td[data-column-index="2"]'),
  );
  await waitForCellSelection(page, ["1:1", "1:2", "2:1", "2:2"]);
  await page.keyboard.press("Delete");
  await waitForValues(firstInsertRow, [1, 2], ["", ""]);
  await waitForValues(secondInsertRow, [1, 2], ["", ""]);
  await dragBetween(page, firstInsertRow.locator(".wb-row-header"), secondInsertRow.locator(".wb-row-header"), {
    startXOffset: 5,
  });
  await waitForRowSelection(page, ["1", "2"]);
  await page.keyboard.press(shortcut("V"));
  await waitForValues(firstInsertRow, [1, 2], ["alpha", "one"]);
  await waitForValues(secondInsertRow, [1, 2], ["beta", "two"]);

  await firstInsertRow.locator('td[data-column-index="1"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "alpha");
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(firstInsertRow, [1, 2], ["", ""]);
  await waitForValues(secondInsertRow, [1, 2], ["", ""]);

  await writeClipboard(page, "menu_alpha\tmenu_one\nmenu_beta\tmenu_two");
  await firstInsertRow.locator('td[data-column-index="1"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "粘贴", exact: true }).click();
  await waitForValues(firstInsertRow, [1, 2], ["menu_alpha", "menu_one"]);
  await waitForValues(secondInsertRow, [1, 2], ["menu_beta", "menu_two"]);

  const oldSelectionRow = page.locator('tr[data-row-selection-index="3"]');
  await dragBetween(
    page,
    oldSelectionRow.locator('td[data-column-index="1"]'),
    oldSelectionRow.locator('td[data-column-index="2"]'),
  );
  await waitForCellSelection(page, ["3:1", "3:2"]);
  await secondInsertRow.locator('td[data-column-index="2"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "menu_two");

  await page.reload({ waitUntil: "domcontentloaded" });
  grid = await openPlayerGrid(page);
  const inputPasteHeader = page.locator('tr[data-row-selection-index="0"] > .wb-row-header');
  await insertBelow(page, inputPasteHeader);
  const inputPasteRow = page.locator('tr.wb-insert-row[data-row-selection-index="1"]');
  const inputPasteCell = inputPasteRow.locator('td[data-column-index="1"]');
  await inputPasteCell.dblclick();
  const insertInput = inputPasteCell.locator("input");
  await insertInput.waitFor();
  await assertInputDoesNotStartGridDrag(insertInput);
  await assertNativeInputContextMenu(page, insertInput);
  await writeClipboard(page, "input_a\tinput_nick_a\ninput_b\tinput_nick_b");
  await insertInput.press(shortcut("V"));
  const generatedInputRow = page.locator('tr.wb-insert-row[data-row-selection-index="2"]');
  await generatedInputRow.waitFor();
  await waitForValues(inputPasteRow, [1, 2], ["input_a", "input_nick_a"]);
  await waitForValues(generatedInputRow, [1, 2], ["input_b", "input_nick_b"]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await openPlayerGrid(page);
  const editableSavedCell = page.locator('tr[data-row-selection-index="0"] td[data-column-index="1"]');
  const originalInputValue = (await cellValues(page.locator('tr[data-row-selection-index="0"]'), [1]))[0];
  await editableSavedCell.dblclick();
  const savedInput = editableSavedCell.locator("input");
  await savedInput.waitFor();
  await assertInputDoesNotStartGridDrag(savedInput);
  await assertNativeInputContextMenu(page, savedInput);
  await savedInput.press(shortcut("A"));
  await savedInput.type("temporary_value");
  await savedInput.press(shortcut("S"));
  await waitForValues(page.locator('tr[data-row-selection-index="0"]'), [1], ["temporary_value"]);
  const detailInput = page.locator(".wb-detail-input");
  await waitForInputValue(detailInput, "temporary_value");
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(page.locator('tr[data-row-selection-index="0"]'), [1], [originalInputValue]);
  await waitForInputValue(detailInput, originalInputValue);

  await page.reload({ waitUntil: "domcontentloaded" });
  await openPlayerGrid(page);
  const firstSavedBatchRow = page.locator('tr[data-row-selection-index="0"]');
  const secondSavedBatchRow = page.locator('tr[data-row-selection-index="1"]');
  const originalFirstBatchValues = await cellValues(firstSavedBatchRow, [1, 2]);
  const originalSecondBatchValues = await cellValues(secondSavedBatchRow, [1, 2]);
  await firstSavedBatchRow.locator('td[data-column-index="1"]').click();
  await writeClipboard(page, "batch_user_a\tbatch_nick_a\nbatch_user_b\tbatch_nick_b");
  await page.keyboard.press(shortcut("V"));
  // Undo immediately, while the paste transaction may still be saving.
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(firstSavedBatchRow, [1, 2], originalFirstBatchValues);
  await waitForValues(secondSavedBatchRow, [1, 2], originalSecondBatchValues);

  await page.keyboard.press(redoShortcut);
  await waitForValues(firstSavedBatchRow, [1, 2], ["batch_user_a", "batch_nick_a"]);
  await waitForValues(secondSavedBatchRow, [1, 2], ["batch_user_b", "batch_nick_b"]);

  assert.deepEqual(consoleErrors, []);

  console.log("Grid insert-row drag, clipboard, and undo browser regressions passed.");
} finally {
  await browser?.close();
  await stopServer();
}
