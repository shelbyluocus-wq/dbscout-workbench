import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

import { listPerfFixtureScenarios, perfFixtureMetadata } from "./fixtures.mjs";
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
const MAX_PROCESS_LOG_BYTES = 64 * 1024;

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

async function runProductScenario({ browserHandle, url, scenario, samples, warmups }) {
  const page = browserHandle?.page;
  if (!page) throw new Error("Playwright browser handle must include a page");
  await page.goto(url, { waitUntil: "domcontentloaded" });
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
