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
  await page.getByRole("menuitem", { name: "往下新增 1 行", exact: true }).click();
}

async function writeClipboard(page, text) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

async function cellValues(row, columnIndexes) {
  return await row.locator("td[data-column-index]").evaluateAll((cells, indexes) => indexes.map((index) => {
    const cell = cells.find((candidate) => Number(candidate.dataset.columnIndex) === index);
    return cell?.querySelector("input:not(.wb-cell-ime-hold)")?.value ?? cell?.textContent?.trim() ?? "";
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

async function checkDirectCellInput(page, grid) {
  const header = grid.locator('tr[data-row-selection-index="0"] > .wb-row-header');
  await header.click();
  await page.keyboard.press(shortcut("C"));
  await header.click({ button: "right" });
  await page.getByRole("menuitem", { name: "粘贴整行到当前行上方", exact: true }).click();
  const copy = grid.locator("tr.wb-insert-row").first();
  const number = copy.locator('td[data-column-index="3"]');
  const original = (await number.textContent()).trim();
  assert.match(original, /^[0-9]+$/);
  const detail = page.locator(".wb-detail-input");
  for (const [value, focusGrid] of [["87", false], ["26", true]]) {
    await number.click();
    if (focusGrid) await grid.focus();
    await page.keyboard.type(value);
    await waitForInputValue(number.locator("input"), value);
    await waitForInputValue(detail, value);
    await page.keyboard.press("Tab");
    await waitForValues(copy, [3], [value]);
  }
  await waitForValues(grid.locator("tr.wb-grid-row").first(), [3], [original]);

  const cdp = await page.context().newCDPSession(page);
  try {
    for (const row of [copy, grid.locator("tr.wb-grid-row").first()]) {
      const cell = row.locator('td[data-column-index="2"]');
      await cell.click();
      await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
      const input = cell.locator("input");
      assert.equal(await input.evaluate(el => el === document.activeElement && !el.classList.contains("wb-cell-ime-hold")), true);
      await waitForInputValue(input, "ni");
      await cdp.send("Input.insertText", { text: "你好" });
      await waitForInputValue(input, "你好");
      await waitForInputValue(detail, "你好");
      await page.keyboard.press("Tab");
      await waitForValues(row, [2], ["你好"]);
      await cell.click();
      await cdp.send("Input.insertText", { text: "替换" });
      await waitForInputValue(input, "替换");
      await waitForInputValue(detail, "替换");
      await page.keyboard.press("Escape");
      await waitForValues(row, [2], ["你好"]);
      await waitForInputValue(detail, "你好");

      await cdp.send("Input.imeSetComposition", { text: "qu", selectionStart: 2, selectionEnd: 2 });
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
      await page.keyboard.press("Tab");
      await waitForValues(row, [2], ["你好"]);
    }
  } finally {
    await cdp.detach();
  }
}

async function assertInputContextMenu(page, input) {
  await page.evaluate(() => {
    window.__wbContextMenuPrevented = null;
    document.addEventListener("contextmenu", (event) => {
      setTimeout(() => { window.__wbContextMenuPrevented = event.defaultPrevented; }, 0);
    }, { capture: true, once: true });
  });
  await input.click({ button: "right" });
  await page.waitForFunction(() => window.__wbContextMenuPrevented !== null);
  assert.equal(await page.evaluate(() => window.__wbContextMenuPrevented), true);
  const menu = page.locator(".wb-input-context-menu");
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitem").count(), 2);
  assert.equal(await menu.getByRole("menuitem", { name: "粘贴", exact: true }).isEnabled(), true);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
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
  browser = await chromium.launch({ headless: true, channel: process.env.DBSCOUT_TEST_BROWSER_CHANNEL || undefined });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addInitScript(() => localStorage.setItem("dbscout_language", "zh-CN"));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let grid = await openPlayerGrid(page);
  await checkDirectCellInput(page, grid);
  await page.reload({ waitUntil: "domcontentloaded" });
  grid = await openPlayerGrid(page);

  const fillRows = Array.from({ length: 5 }, (_, index) => page.locator(`tr[data-row-selection-index="${index}"]`));
  const fillBefore = await Promise.all(fillRows.map((row) => cellValues(row, [3])));
  const fillSource = Number(fillBefore[4][0]);
  const fillCell = (row) => fillRows[row].locator('td[data-column-index="3"]');
  const waitForFillValues = (values) => Promise.all(fillRows.map((row, index) => waitForValues(row, [3], [values[index]])));
  const fillUpValues = [fillBefore[0][0], String(fillSource - 3), String(fillSource - 2), String(fillSource - 1), String(fillSource)];

  // Single-number upward fill copies by default; holding Control toggles to series.
  await fillCell(4).click();
  await page.keyboard.down("Control");
  await dragBetween(page, page.locator(".wb-fill-handle"), fillCell(1));
  await page.keyboard.up("Control");
  await waitForFillValues(fillUpValues);
  await waitForCellSelection(page, ["1:3", "2:3", "3:3", "4:3"]);

  // A second upward drag on the multi-cell arithmetic range extends the series by default.
  await dragBetween(page, page.locator(".wb-fill-handle"), fillCell(0));
  await waitForFillValues([String(fillSource - 4), ...fillUpValues.slice(1)]);
  await waitForCellSelection(page, ["0:3", "1:3", "2:3", "3:3", "4:3"]);
  await page.keyboard.press(shortcut("Z"));
  await waitForFillValues(fillUpValues);
  await page.keyboard.press(shortcut("Z"));
  await waitForFillValues(fillBefore.map(([value]) => value));

  // Single-number downward fill copies by default; switching via options menu turns it into series,
  // and a single Ctrl/Cmd+Z reverts both the initial fill and the mode switch together.
  await fillCell(0).click();
  const fillDownSource = Number(fillBefore[0][0]);
  await dragBetween(page, page.locator(".wb-fill-handle"), fillCell(3));
  await waitForFillValues([String(fillDownSource), String(fillDownSource), String(fillDownSource), String(fillDownSource), fillBefore[4][0]]);
  await waitForCellSelection(page, ["0:3", "1:3", "2:3", "3:3"]);
  await page.locator(".wb-fill-options-trigger").click();
  await page.getByRole("menuitemradio", { name: "填充序列", exact: true }).click();
  await waitForFillValues([String(fillDownSource), String(fillDownSource + 1), String(fillDownSource + 2), String(fillDownSource + 3), fillBefore[4][0]]);
  await waitForCellSelection(page, ["0:3", "1:3", "2:3", "3:3"]);
  await page.keyboard.press(shortcut("Z"));
  await waitForFillValues(fillBefore.map(([value]) => value));

  // Two-number selection fills arithmetic series by default and shows the live preview tooltip during drag.
  const step = Number(fillBefore[1][0]) - Number(fillBefore[0][0]);
  await fillCell(0).click();
  await fillCell(1).click({ modifiers: ["Shift"] });
  const handleBox = await page.locator(".wb-fill-handle").boundingBox();
  const row3Box = await fillCell(3).boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(row3Box.x + row3Box.width / 2, row3Box.y + row3Box.height / 2, { steps: 6 });
  const previewTip = page.locator(".wb-fill-preview-tip");
  await previewTip.waitFor({ state: "visible", timeout: 2000 });
  const tipSeriesText = (await previewTip.textContent()).trim();
  assert.ok(tipSeriesText.includes(String(fillDownSource + step * 3)), `preview tip should show end series value: ${tipSeriesText}`);
  await page.keyboard.down("Control");
  await page.waitForFunction(
    (expected) => document.querySelector(".wb-fill-preview-tip")?.textContent?.includes(expected),
    String(fillBefore[1][0]),
  );
  await page.keyboard.up("Control");
  await page.mouse.up();
  await waitForFillValues([
    String(fillDownSource),
    String(fillDownSource + step),
    String(fillDownSource + step * 2),
    String(fillDownSource + step * 3),
    fillBefore[4][0],
  ]);
  await page.keyboard.press(shortcut("Z"));
  await waitForFillValues(fillBefore.map(([value]) => value));
  console.log("WPS/Excel fill rules, live preview tooltip, option switch, selection and batch undo passed.");

  // Selecting a cell focuses its hidden IME input. Clipboard events from that
  // input must paste into the grid, not disappear into the empty input.
  const copySource = page.locator('tr[data-row-selection-index="0"] td[data-column-index="1"]');
  const pasteRow = page.locator('tr[data-row-selection-index="1"]');
  const pasteTarget = pasteRow.locator('td[data-column-index="1"]');
  const pasteBefore = await cellValues(pasteRow, [1]);
  const copiedValue = (await copySource.textContent()).trim();
  assert.notEqual(copiedValue, pasteBefore[0]);
  await copySource.click();
  await page.keyboard.press(shortcut("C"));
  await page.waitForFunction((text) => navigator.clipboard.readText().then((value) => value === text), copiedValue);
  await pasteTarget.click();
  await page.waitForFunction(() => document.activeElement?.matches("input.wb-cell-ime-hold"));
  await page.keyboard.press(shortcut("V"));
  await waitForValues(pasteRow, [1], [copiedValue]);
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(pasteRow, [1], pasteBefore);
  await page.keyboard.press(redoShortcut);
  await waitForValues(pasteRow, [1], [copiedValue]);
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(pasteRow, [1], pasteBefore);
  await copySource.click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  await pasteTarget.click({ button: "right" });
  await page.getByRole("menuitem", { name: "粘贴", exact: true }).click();
  await waitForValues(pasteRow, [1], [copiedValue]);
  await grid.focus();
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(pasteRow, [1], pasteBefore);
  console.log("Selected cell keyboard/menu copy/paste, undo and redo passed.");

  const excelFirstRow = page.locator('tr[data-row-selection-index="0"]');
  const excelSecondRow = page.locator('tr[data-row-selection-index="1"]');
  const excelFirstBefore = await cellValues(excelFirstRow, [1, 2]);
  const excelSecondBefore = await cellValues(excelSecondRow, [1, 2]);
  const excelCell = excelFirstRow.locator('td[data-column-index="1"]');
  await excelCell.dblclick();
  const excelInput = excelCell.locator("input");
  await excelInput.press(shortcut("A"));
  await writeClipboard(page, '"say ""hello"""\r\n');
  await excelInput.press(shortcut("V"));
  await waitForInputValue(excelInput, 'say "hello"');
  await excelInput.press("Enter");
  await waitForValues(excelFirstRow, [1], ['say "hello"']);
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(excelFirstRow, [1, 2], excelFirstBefore);
  await excelCell.dblclick();
  await writeClipboard(page, "excel_a\texcel_nick_a\r\nexcel_b\texcel_nick_b\r\n");
  await excelInput.press(shortcut("V"));
  await waitForValues(excelFirstRow, [1, 2], ["excel_a", "excel_nick_a"]);
  await waitForValues(excelSecondRow, [1, 2], ["excel_b", "excel_nick_b"]);
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(excelFirstRow, [1, 2], excelFirstBefore);
  await waitForValues(excelSecondRow, [1, 2], excelSecondBefore);
  console.log("Excel single-cell and rectangle editing paste, save and undo passed.");

  if (!process.argv.includes("--excel-only")) {
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
    firstInsertRow.locator('td[data-column-index="1"]'),
    secondInsertRow.locator('td[data-column-index="2"]'),
  );
  await waitForCellSelection(page, ["1:1", "1:2", "2:1", "2:2"]);
  await page.keyboard.type("same_value");
  await page.keyboard.press("Enter");
  await waitForValues(firstInsertRow, [1, 2], ["same_value", "same_value"]);
  await waitForValues(secondInsertRow, [1, 2], ["same_value", "same_value"]);
  assert.equal(await page.locator("tr.wb-insert-row").count(), 2, "Enter must keep both rows as drafts");
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(firstInsertRow, [1, 2], ["", ""]);
  await waitForValues(secondInsertRow, [1, 2], ["", ""]);
  await page.keyboard.press(redoShortcut);
  await waitForValues(firstInsertRow, [1, 2], ["same_value", "same_value"]);
  await waitForValues(secondInsertRow, [1, 2], ["same_value", "same_value"]);
  await page.keyboard.press(shortcut("Z"));
  await waitForValues(firstInsertRow, [1, 2], ["", ""]);
  await waitForValues(secondInsertRow, [1, 2], ["", ""]);

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

  // Row copy includes off-screen fields omitted by column virtualization.
  const allColumnIndexes = Array.from(
    { length: Number(await grid.getAttribute("aria-colcount")) - 1 },
    (_, index) => index,
  );
  const expectedFullRows = [firstInsertRow, secondInsertRow]
    .map(async (row) => (await cellValues(row, allColumnIndexes)).join("\t"));
  const fullRowTsv = (await Promise.all(expectedFullRows)).join("\n");
  await dragBetween(page, firstInsertRow.locator(".wb-row-header"), secondInsertRow.locator(".wb-row-header"), {
    startXOffset: 5,
  });
  await waitForRowSelection(page, ["1", "2"]);
  await page.keyboard.press(shortcut("C"));
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), fullRowTsv);

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
  // A clicked context-menu button is removed on close. Restore grid keyboard
  // focus explicitly before testing undo (also required on the baseline).
  await page.locator(".wb-grid-wrap").focus();
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
  await assertInputContextMenu(page, insertInput);
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
  await assertInputContextMenu(page, savedInput);
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

  console.log("Grid insert-row drag, clipboard, and undo browser regressions passed.");
  }
  assert.deepEqual(consoleErrors, []);
} finally {
  await browser?.close();
  await stopServer();
}
