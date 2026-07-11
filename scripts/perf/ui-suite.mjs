import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

import {
  createPerfFixtureColumns,
  createPerfInsertMatrix,
  listPerfFixtureScenarios,
  perfFixtureMetadata,
} from "./fixtures.mjs";
import { terminateOwnedProcessTree } from "./process-tree.mjs";
import {
  collectEnvironmentMetadata,
  collectGitProvenance,
  createReportEnvelope,
  summarizeSamples,
  writePerformanceReport,
} from "./report.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIRECTORY = path.dirname(MODULE_PATH);
const DEFAULT_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const STARTUP_TIMEOUT_MS = 20_000;
// Windows antivirus can make a fresh Vite process transform modules slowly.
// Interaction collection starts only after navigation, so this is not a product budget.
const NAVIGATION_TIMEOUT_MS = 180_000;
const MAX_PROCESS_LOG_BYTES = 64 * 1024;
const TABLE_SEARCH_DEBOUNCE_MS = 150;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function findAvailablePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function appendBoundedLog(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length > MAX_PROCESS_LOG_BYTES ? next.slice(-MAX_PROCESS_LOG_BYTES) : next;
}

function spawnVite(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.__dbscoutStdout = "";
  child.__dbscoutStderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    child.__dbscoutStdout = appendBoundedLog(child.__dbscoutStdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    child.__dbscoutStderr = appendBoundedLog(child.__dbscoutStderr, chunk);
  });
  return child;
}

async function waitForServerDefault(url, { child, timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(
        `Vite exited before startup (code ${child.exitCode}): ${child.__dbscoutStderr || child.__dbscoutStdout || "no output"}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite startup timeout after ${timeoutMs}ms: ${lastError?.message || "not reachable"}`);
}

async function launchBrowserDefault() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    globalThis.__DBSCOUT_PERF_ENABLED__ = true;
    globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__ = false;
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function closeBrowserHandle(handle) {
  const browser = handle?.browser || handle;
  if (browser && typeof browser.close === "function") await browser.close();
}

export async function ensureNavigationVisible(page, { timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
  const database = page.locator(".wb-database-item").first();
  if (await database.isVisible()) return false;
  const toggle = page
    .locator('button[aria-label="展开导航栏"], button[aria-label="展开数据库栏"]')
    .filter({ visible: true })
    .first();
  await toggle.click();
  await database.waitFor({ state: "visible", timeout: timeoutMs });
  return true;
}

async function measureDoubleRaf(page, label, action) {
  const startedAt = await page.evaluate(() => performance.now());
  await action();
  const duration = await page.evaluate(
    (start) => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
    }),
    startedAt,
  );
  await page.evaluate(
    ({ name, durationMs }) => {
      globalThis.__DBSCOUT_PERFORMANCE__?.recordDuration?.(name, durationMs, {
        phase: "interaction",
        completion: "doubleRaf",
      });
    },
    { name: label, durationMs: duration },
  );
  return duration;
}

async function beginBrowserCollection(page, { scenario, samples }) {
  await page.evaluate(({ scenarioName, sampleCount }) => {
    const recorder = globalThis.__DBSCOUT_PERFORMANCE__;
    recorder?.reset?.();
    recorder?.beginRun?.({
      scenario: scenarioName,
      profile: "deterministic-v1",
      engine: "playwright-chromium",
      sampleCount,
    });
    const collector = {
      frameIntervals: [],
      longTasks: [],
      lastFrameAt: null,
      rafId: 0,
      observer: null,
    };
    const sampleFrame = (timestamp) => {
      if (collector.lastFrameAt !== null) collector.frameIntervals.push(timestamp - collector.lastFrameAt);
      collector.lastFrameAt = timestamp;
      collector.rafId = requestAnimationFrame(sampleFrame);
    };
    collector.rafId = requestAnimationFrame(sampleFrame);
    if (typeof PerformanceObserver === "function") {
      try {
        collector.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            collector.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
          }
        });
        collector.observer.observe({ entryTypes: ["longtask"] });
      } catch {
        collector.observer = null;
      }
    }
    globalThis.__DBSCOUT_UI_PERF_COLLECTOR__ = collector;
  }, { scenarioName: scenario, sampleCount: samples });
}

async function finishBrowserCollection(page) {
  return page.evaluate(() => {
    const collector = globalThis.__DBSCOUT_UI_PERF_COLLECTOR__ || {};
    if (collector.rafId) cancelAnimationFrame(collector.rafId);
    collector.observer?.disconnect?.();
    const recorderSnapshot = globalThis.__DBSCOUT_PERFORMANCE__?.endRun?.()
      || globalThis.__DBSCOUT_PERFORMANCE__?.snapshot?.()
      || null;
    const result = {
      recorderSnapshot,
      frameIntervals: [...(collector.frameIntervals || [])],
      longTasks: [...(collector.longTasks || [])],
      mountedRows: document.querySelectorAll(".wb-grid-row").length,
      mountedCells: document.querySelectorAll("td[data-row-key][data-column-name]").length,
      browserHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      userAgent: navigator.userAgent,
      url: location.href,
    };
    delete globalThis.__DBSCOUT_UI_PERF_COLLECTOR__;
    return result;
  });
}

async function resetGridPosition(page, grid) {
  await grid.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function runGridScenario({ browserHandle, url, scenario, samples, warmups }) {
  const page = browserHandle?.page;
  if (!page) throw new Error("Playwright browser handle must include a page");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  await page.locator(".mysql-workbench").waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await beginBrowserCollection(page, { scenario, samples });
  await ensureNavigationVisible(page);

  const database = page.locator(".wb-database-item", { hasText: "perf_db" }).first();
  await database.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  if ((await database.getAttribute("aria-expanded")) !== "true") {
    await measureDoubleRaf(page, "ui.database-select", () => database.click());
  }

  const table = page.locator(".wb-table-item[data-table-name]").first();
  await table.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await measureDoubleRaf(page, "ui.table-open", () => table.click());
  const grid = page.locator(".wb-grid-wrap").first();
  await grid.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await page.locator("td[data-row-key][data-column-name]").first().waitFor({
    state: "visible",
    timeout: STARTUP_TIMEOUT_MS,
  });

  for (let index = 0; index < warmups; index += 1) {
    await resetGridPosition(page, grid);
    await measureDoubleRaf(page, "ui.grid-scroll-warmup", () => grid.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }));
  }

  const interactionSamples = [];
  for (let index = 0; index < samples; index += 1) {
    await resetGridPosition(page, grid);
    const duration = await measureDoubleRaf(page, "ui.grid-scroll", () => grid.evaluate(
      (element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      },
    ));
    interactionSamples.push(duration);
  }
  const collected = await finishBrowserCollection(page);
  return { ...collected, interactionSamples, warmupCount: warmups };
}

async function dispatchSearchInput(page, query, { staleQuery = "" } = {}) {
  return page.evaluate(
    ({ debounceMs, finalQuery, firstQuery }) => new Promise((resolve, reject) => {
      const input = document.querySelector(".wb-table-search-field-input");
      const panel = document.querySelector(".wb-table-panel");
      if (!(input instanceof HTMLInputElement) || !panel) {
        reject(new Error("table search controls are unavailable"));
        return;
      }
      const apply = (value) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const startedAt = performance.now();
      globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__ = [];
      let inputDispatchEndMs = 0;
      let timeoutId = 0;
      let staleTimer = 0;
      const finish = () => {
        const selected = panel.querySelector("td.selected.search-match");
        if (!selected || !selected.textContent?.includes(finalQuery)) return false;
        clearTimeout(timeoutId);
        clearTimeout(staleTimer);
        observer.disconnect();
        const inputToResultMs = performance.now() - startedAt;
        const searchTrace = [...(globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__ || [])]
          .map((entry) => ({ ...entry, atMs: entry.at - startedAt }));
        delete globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__;
        resolve({
          inputToResultMs,
          debounceToFirstResultMs: Math.max(0, inputToResultMs - debounceMs),
          rowKey: selected.getAttribute("data-row-key") || "",
          columnName: selected.getAttribute("data-column-name") || "",
          text: selected.textContent || "",
          inputValue: input.value,
          inputDispatchEndMs,
          searchTrace,
        });
        return true;
      };
      const observer = new MutationObserver(finish);
      observer.observe(panel, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
      timeoutId = setTimeout(() => {
        observer.disconnect();
        delete globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__;
        const selected = panel.querySelector("td.selected");
        reject(new Error(`table search result timeout for ${finalQuery}: ${JSON.stringify({
          inputValue: input.value,
          hitCount: panel.querySelector(".wb-search-hit-count")?.textContent || "",
          status: document.querySelector(".wb-status-bar")?.textContent || "",
          mountedRows: panel.querySelectorAll(".wb-grid-row").length,
          selectedColumn: selected?.getAttribute("data-column-name") || "",
          selectedText: selected?.textContent || "",
          searchMatches: panel.querySelectorAll("td.search-match").length,
        })}`));
      }, 10_000);
      if (firstQuery) {
        apply(firstQuery);
        inputDispatchEndMs = performance.now() - startedAt;
        staleTimer = setTimeout(() => {
          apply(finalQuery);
          inputDispatchEndMs = performance.now() - startedAt;
        }, 50);
      } else {
        apply(finalQuery);
        inputDispatchEndMs = performance.now() - startedAt;
      }
      finish();
    }),
    { debounceMs: TABLE_SEARCH_DEBOUNCE_MS, finalQuery: query, firstQuery: staleQuery },
  );
}

async function measureSearchNavigation(page, direction, previousColumn) {
  return page.evaluate(
    ({ buttonLabel, oldColumn }) => new Promise((resolve, reject) => {
      const panel = document.querySelector(".wb-table-panel");
      const button = panel?.querySelector(`button[aria-label="${buttonLabel}"]`);
      if (!(button instanceof HTMLButtonElement) || !panel) {
        reject(new Error(`${buttonLabel} button is unavailable`));
        return;
      }
      const startedAt = performance.now();
      let timeoutId = 0;
      const finish = () => {
        const selected = panel.querySelector("td.selected.search-match");
        const columnName = selected?.getAttribute("data-column-name") || "";
        if (!selected || columnName === oldColumn) return false;
        clearTimeout(timeoutId);
        observer.disconnect();
        resolve({
          durationMs: performance.now() - startedAt,
          rowKey: selected.getAttribute("data-row-key") || "",
          columnName,
          text: selected.textContent || "",
        });
        return true;
      };
      const observer = new MutationObserver(finish);
      observer.observe(panel, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
      timeoutId = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`${buttonLabel} selection timeout`));
      }, 2_000);
      button.click();
      finish();
    }),
    { buttonLabel: direction === "previous" ? "上一个匹配" : "下一个匹配", oldColumn: previousColumn },
  );
}

async function clearSearchAndWaitForSelection(page, input, selectedIdentity) {
  await input.fill("");
  await page.locator(
    `td.selected[data-row-key="${selectedIdentity.rowKey}"][data-column-name="${selectedIdentity.columnName}"]`,
  ).waitFor({ state: "attached", timeout: STARTUP_TIMEOUT_MS });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function runTableSearchScenario({ browserHandle, url, scenario, samples, warmups }) {
  const page = browserHandle?.page;
  if (!page) throw new Error("Playwright browser handle must include a page");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  await page.locator(".mysql-workbench").waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await beginBrowserCollection(page, { scenario, samples });
  await ensureNavigationVisible(page);

  const database = page.locator(".wb-database-item", { hasText: "perf_db" }).first();
  await database.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  if ((await database.getAttribute("aria-expanded")) !== "true") await database.click();
  await page.locator(".wb-table-item[data-table-name]").first().click();
  const grid = page.locator(".wb-grid-wrap").first();
  await grid.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  const firstCell = page.locator(".wb-grid-row td[data-row-key][data-column-name]").first();
  await firstCell.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });

  const firstRowHeader = page.locator(".wb-grid-row .wb-row-header").first();
  await firstRowHeader.click({ button: "right" });
  await page.getByRole("menuitem", { name: "往上新增行" }).click();
  const draftRow = page.locator("tr.wb-insert-row").first();
  await draftRow.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await draftRow.locator("td[data-column-name]").first().dblclick();
  const draftInput = draftRow.locator("input").first();
  await draftInput.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await draftInput.fill("draft-search-sentinel");
  await draftInput.press("Enter");
  await draftInput.waitFor({ state: "detached", timeout: STARTUP_TIMEOUT_MS });
  await page.keyboard.press("Escape");
  await firstCell.click();
  const selectedIdentity = {
    rowKey: await firstCell.getAttribute("data-row-key"),
    columnName: await firstCell.getAttribute("data-column-name"),
  };
  const input = page.locator(".wb-table-search-field-input").first();
  await page.locator(".wb-filter-mode-toggle").first().click();
  await page.getByRole("menuitem", { name: "精确" }).click();
  const verification = {
    selectedCell: false,
    staleInput: false,
    nextPrevious: false,
    clearRestore: false,
    sortRestart: false,
    draftPreserved: false,
  };
  let mountedRows = await page.locator(".wb-grid-row").count();

  for (let index = 0; index < warmups; index += 1) {
    await dispatchSearchInput(page, `search-target-${String(129 + index).padStart(6, "0")}`);
    await clearSearchAndWaitForSelection(page, input, selectedIdentity);
  }

  const inputToResultSamples = [];
  const debounceToFirstResultSamples = [];
  const nextHitSamples = [];
  const searchTraceSamples = [];
  const inputDispatchSamples = [];
  for (let index = 0; index < samples; index += 1) {
    const rowNumber = 129 + (index % 20);
    const query = `search-target-${String(rowNumber).padStart(6, "0")}`;
    const result = await dispatchSearchInput(page, query, {
      staleQuery: index === 0 ? "search-target-000128" : "",
    });
    inputToResultSamples.push(result.inputToResultMs);
    debounceToFirstResultSamples.push(result.debounceToFirstResultMs);
    searchTraceSamples.push(result.searchTrace);
    inputDispatchSamples.push(result.inputDispatchEndMs);
    verification.selectedCell ||= result.text.includes(query) && Boolean(result.rowKey);
    if (index === 0) verification.staleInput = result.inputValue === query && result.text.includes(query);

    const next = await measureSearchNavigation(page, "next", result.columnName);
    nextHitSamples.push(next.durationMs);
    const previous = await measureSearchNavigation(page, "previous", next.columnName);
    verification.nextPrevious ||= previous.columnName === result.columnName && previous.rowKey === result.rowKey;
    mountedRows = Math.max(mountedRows, await page.locator(".wb-grid-row").count());
    await clearSearchAndWaitForSelection(page, input, selectedIdentity);
  }
  verification.clearRestore = await firstCell.evaluate((cell) => cell.classList.contains("selected"));

  const sortQuery = "search-target-000129";
  await dispatchSearchInput(page, sortQuery);
  await page.locator('.wb-grid th[data-column-index="0"] .wb-column-sort-trigger').click();
  await page.getByRole("menuitem", { name: "升序排序" }).click();
  await page.locator(".wb-sort-chip").waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  const sortedSelected = page.locator("td.selected.search-match", { hasText: sortQuery }).first();
  try {
    await sortedSelected.waitFor({ state: "attached", timeout: 5_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const panel = document.querySelector(".wb-table-panel");
      const selected = panel?.querySelector("td.selected");
      return {
        inputValue: panel?.querySelector(".wb-table-search-field-input")?.value || "",
        hitCount: panel?.querySelector(".wb-search-hit-count")?.textContent || "",
        selectedColumn: selected?.getAttribute("data-column-name") || "",
        selectedText: selected?.textContent || "",
        searchMatchCount: panel?.querySelectorAll("td.search-match").length || 0,
        sortChip: panel?.querySelector(".wb-sort-chip")?.textContent || "",
        loading: Boolean(panel?.querySelector(".wb-grid-loading")),
        draftRows: panel?.querySelectorAll("tr.wb-insert-row").length || 0,
      };
    });
    throw new Error(`sorted table search selection failed: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  verification.sortRestart = true;
  verification.draftPreserved = (await page.locator("tr.wb-insert-row").count()) === 1
    && (await page.locator("tr.wb-insert-row").first().textContent()).includes("draft-search-sentinel");
  mountedRows = Math.max(mountedRows, await page.locator(".wb-grid-row").count());

  const collected = await finishBrowserCollection(page);
  return {
    ...collected,
    interactionSamples: inputToResultSamples,
    inputToResultSamples,
    debounceToFirstResultSamples,
    nextHitSamples,
    searchTraceSamples,
    inputDispatchSamples,
    verification,
    mountedRows,
    warmupCount: warmups,
  };
}

export async function createImportWorkbookFile(scenario = "import-10k") {
  const XLSX = await import("xlsx");
  const columns = createPerfFixtureColumns(scenario);
  const rows = createPerfInsertMatrix(scenario);
  if (rows.length > 1) rows.at(-1)[0] = rows[0][0];
  const worksheet = XLSX.utils.aoa_to_sheet([
    columns.map((column) => column.column_name),
    ...rows,
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Import");
  return {
    name: `${scenario}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
    })),
  };
}

async function prepareImportWizard(page, { url, file }) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  await page.locator(".mysql-workbench").waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await ensureNavigationVisible(page);
  const database = page.locator(".wb-database-item", { hasText: "perf_db" }).first();
  await database.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  if ((await database.getAttribute("aria-expanded")) !== "true") await database.click();
  const table = page.locator(".wb-table-item[data-table-name]").first();
  await table.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await table.click();
  await page.locator(".wb-grid-wrap").first().waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });

  await page.locator('.wb-split-more-btn[aria-label="更多选项"]').first().click();
  const importButton = page.locator(".wb-split-menu button", { hasText: "导入" }).first();
  await importButton.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await importButton.click();
  const dialog = page.locator(".wb-import-wizard");
  await dialog.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await dialog.locator(".wb-import-step", { hasText: "10000 行数据" }).waitFor({
    state: "visible",
    timeout: STARTUP_TIMEOUT_MS,
  });
  await dialog.locator(".wb-import-step .wb-dialog-actions button").last().click();
  await dialog.locator(".wb-import-mapping-row").first().waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  await dialog.locator(".wb-import-step .wb-dialog-actions button").last().click();
  const start = dialog.locator(".wb-import-start-btn");
  await start.waitFor({ state: "visible", timeout: STARTUP_TIMEOUT_MS });
  return start;
}

async function runImportScenario({ browserHandle, url, scenario, samples, warmups }) {
  const page = browserHandle?.page;
  if (!page) throw new Error("Playwright browser handle must include a page");
  const file = await createImportWorkbookFile(scenario);
  for (let index = 0; index < warmups; index += 1) {
    const start = await prepareImportWizard(page, { url, file });
    await measureDoubleRaf(page, "ui.import-preflight-warmup", () => start.click());
  }

  const interactionSamples = [];
  const frameIntervals = [];
  const longTasks = [];
  let lastCollection = {};
  for (let index = 0; index < samples; index += 1) {
    const start = await prepareImportWizard(page, { url, file });
    await beginBrowserCollection(page, { scenario, samples });
    interactionSamples.push(
      await measureDoubleRaf(page, "ui.import-preflight", () => start.click()),
    );
    lastCollection = await finishBrowserCollection(page);
    frameIntervals.push(...(lastCollection.frameIntervals || []));
    longTasks.push(...(lastCollection.longTasks || []));
  }
  return {
    ...lastCollection,
    frameIntervals,
    longTasks,
    interactionSamples,
    warmupCount: warmups,
  };
}

export function selectProductScenarioRunner(scenario) {
  if (scenario === "import-10k") return runImportScenario;
  if (scenario === "table-search-10k-20-no-pk") return runTableSearchScenario;
  return runGridScenario;
}

export function assertUiScenarioBudget(result = {}) {
  if (result.scenario === "table-search-10k-20-no-pk") {
    const checks = [
      ["input-to-result", result.inputToResultSamples, 300],
      ["debounce-to-result", result.debounceToFirstResultSamples, 150],
      ["next-hit", result.nextHitSamples, 20],
    ];
    for (const [label, values, target] of checks) {
      if (!Array.isArray(values) || values.length < 100) {
        const observedP95 = Array.isArray(values) && values.length ? summarizeSamples(values).p95 : null;
        const traceP95 = label === "input-to-result"
          ? Object.fromEntries(["frontend:run:start", "frontend:selection-saved", "frontend:scheduled", "begin:start", "begin:end", "next:start", "next:end"].map((phase) => {
            const phaseSamples = (result.searchTraceSamples || [])
              .map((trace) => trace.find((entry) => entry.phase === phase)?.atMs)
              .filter(Number.isFinite);
            return [phase, phaseSamples.length ? summarizeSamples(phaseSamples).p95 : null];
          }))
          : null;
        const dispatchP95 = result.inputDispatchSamples?.length
          ? summarizeSamples(result.inputDispatchSamples).p95
          : null;
        const rawDiagnostic = label === "input-to-result"
          ? (values || []).map((duration, index) => ({
            duration,
            dispatch: result.inputDispatchSamples?.[index],
            trace: result.searchTraceSamples?.[index],
          }))
          : null;
        throw new Error(`${label} requires at least 100 samples (observed p95 ${observedP95} ms, dispatch p95 ${dispatchP95} ms, trace ${JSON.stringify(traceP95)}, raw ${JSON.stringify(rawDiagnostic)})`);
      }
      const p95 = summarizeSamples(values).p95;
      if (p95 > target) throw new Error(`${label} p95 ${p95} ms exceeds ${target} ms budget`);
    }
    for (const [name, passed] of Object.entries(result.verification || {})) {
      if (!passed) throw new Error(`table search verification failed: ${name}`);
    }
    const requiredChecks = ["selectedCell", "staleInput", "nextPrevious", "clearRestore", "sortRestart", "draftPreserved"];
    for (const name of requiredChecks) {
      if (result.verification?.[name] !== true) throw new Error(`table search verification failed: ${name}`);
    }
    if (Number(result.mountedRows) > 500) {
      throw new Error(`table search mounted rows ${result.mountedRows} exceeds 500-row bound`);
    }
    return;
  }
  if (result.scenario !== "import-10k") return;
  const longestTask = Math.max(
    0,
    ...(Array.isArray(result.longTasks) ? result.longTasks : [])
      .map((task) => Number(task?.duration) || 0),
  );
  if (longestTask > 100) {
    throw new Error(`import-10k long task ${longestTask} ms exceeds 100 ms budget`);
  }
}

async function runProductScenario(options) {
  return selectProductScenarioRunner(options.scenario)(options);
}

export function createUiReportEnvelope({ result, fixture, environment, git, runId }) {
  const summarized = summarizeSamples(result.interactionSamples || []);
  const { rawSamples, ...summary } = summarized;
  return createReportEnvelope({
    runId,
    label: `ui-${result.scenario}`,
    evidenceClass: "supporting",
    environment,
    fixture,
    provenance: {
      ...git,
      debugAssertions: fixture.debugAssertions,
      frontendSource: fixture.frontendSource,
      usesExternalDatabase: fixture.usesExternalDatabase,
    },
    scenarioVersion: "1.0.0",
    harnessVersion: "1.0.0",
    warmupCount: result.warmupCount ?? 5,
    sampleCount: result.samples,
    cases: [{
      name: `ui-${result.scenario}`,
      rawSamples,
      summary,
      frameIntervals: [...(result.frameIntervals || [])],
      longTasks: structuredClone(result.longTasks || []),
      mountedRows: result.mountedRows,
      mountedCells: result.mountedCells,
      browserHeapBytes: result.browserHeapBytes,
      userAgent: result.userAgent,
      recorderSnapshot: structuredClone(result.recorderSnapshot),
      inputToResultSamples: [...(result.inputToResultSamples || [])],
      debounceToFirstResultSamples: [...(result.debounceToFirstResultSamples || [])],
      nextHitSamples: [...(result.nextHitSamples || [])],
      searchTraceSamples: structuredClone(result.searchTraceSamples || []),
      inputDispatchSamples: [...(result.inputDispatchSamples || [])],
      verification: structuredClone(result.verification || {}),
    }],
  });
}

function combineFailures(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 0) return null;
  if (primaryError && cleanupErrors.length === 0) return primaryError;
  if (!primaryError && cleanupErrors.length === 1) return cleanupErrors[0];
  const failures = [...(primaryError ? [primaryError] : []), ...cleanupErrors];
  return new AggregateError(
    failures,
    failures.map((error) => error?.message || String(error)).join("; "),
  );
}

export async function runUiSuite({
  rootDirectory = DEFAULT_ROOT,
  scenario = "smoke",
  samples = 5,
  warmups = 5,
  findPort = findAvailablePort,
  spawnProcess = spawnVite,
  waitForServer = waitForServerDefault,
  launchBrowser = launchBrowserDefault,
  runScenario = runProductScenario,
  cleanupProcess = terminateOwnedProcessTree,
} = {}) {
  const allowedScenarios = new Set(listPerfFixtureScenarios().map((entry) => entry.name));
  if (!allowedScenarios.has(scenario)) throw new RangeError(`Unknown UI performance scenario: ${scenario}`);
  const sampleCount = parsePositiveInteger(samples, 5);
  const warmupCount = parsePositiveInteger(warmups, 5);
  const port = await findPort("127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const url = `${baseUrl}/?perfProfile=deterministic-v1&scenario=${encodeURIComponent(scenario)}`;
  const vitePath = path.resolve(rootDirectory, "node_modules/vite/bin/vite.js");
  const child = spawnProcess(
    process.execPath,
    [vitePath, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: rootDirectory, env: { ...process.env, DBSCOUT_PERF_ENABLED: "1" } },
  );
  let browserHandle;
  let scenarioResult;
  let primaryError;
  const cleanupErrors = [];
  try {
    await waitForServer(baseUrl, { child, timeoutMs: STARTUP_TIMEOUT_MS });
    browserHandle = await launchBrowser();
    scenarioResult = await runScenario({
      browserHandle,
      browser: browserHandle,
      url,
      baseUrl,
      scenario,
      samples: sampleCount,
      warmups: warmupCount,
    });
    assertUiScenarioBudget({ scenario, ...scenarioResult });
  } catch (error) {
    primaryError = error;
  } finally {
    if (browserHandle) {
      try {
        await closeBrowserHandle(browserHandle);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await cleanupProcess({ child, port });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const failure = combineFailures(primaryError, cleanupErrors);
  if (failure) throw failure;
  return {
    evidenceClass: "supporting",
    engine: "playwright-chromium",
    profile: "deterministic-v1",
    scenario,
    samples: sampleCount,
    warmupCount,
    url,
    ...scenarioResult,
  };
}

function cliOptions(argv) {
  const valueAfter = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
  };
  return {
    scenario: valueAfter("--scenario", "smoke"),
    samples: parsePositiveInteger(valueAfter("--samples", "5"), 5),
    warmups: parsePositiveInteger(valueAfter("--warmups", "5"), 5),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  const options = cliOptions(process.argv.slice(2));
  const result = await runUiSuite(options);
  const [metadata, git] = await Promise.all([
    perfFixtureMetadata(
      `?perfProfile=deterministic-v1&scenario=${encodeURIComponent(options.scenario)}`,
    ),
    collectGitProvenance({ rootDirectory: DEFAULT_ROOT }),
  ]);
  const environment = collectEnvironmentMetadata();
  environment.browserUserAgent = result.userAgent;
  environment.id = createHash("sha256")
    .update(JSON.stringify(environment))
    .digest("hex")
    .slice(0, 16);
  const runId = `ui-${options.scenario}-${new Date().toISOString().replace(/[^0-9A-Za-z]+/gu, "-")}`;
  const report = createUiReportEnvelope({ result, fixture: metadata, environment, git, runId });
  const reportPath = await writePerformanceReport(report, {
    outputDirectory: path.resolve(DEFAULT_ROOT, "output/performance"),
  });
  process.stdout.write(`${JSON.stringify({
    runId,
    evidenceClass: report.evidenceClass,
    reportPath,
    scenario: options.scenario,
    warmups: options.warmups,
    samples: options.samples,
    p50: report.cases[0].summary.p50,
    p95: report.cases[0].summary.p95,
    frameIntervals: report.cases[0].frameIntervals.length,
    longTasks: report.cases[0].longTasks.length,
    mountedRows: report.cases[0].mountedRows,
    mountedCells: report.cases[0].mountedCells,
  }, null, 2)}\n`);
}
