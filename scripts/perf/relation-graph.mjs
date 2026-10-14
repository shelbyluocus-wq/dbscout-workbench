// scripts/perf/relation-graph.mjs
// Frame-time sampler for large relation graphs on the generated relation lab
// (`?relationLab=<tables>`): the whole-database graph in full screen, at each
// requested size. Every phase drives real pointer and wheel input and records
//   frameMs  — intervals between animation frames (the page's responsiveness)
//   drawMs   — cost of each canvas frame the graph drew
//   longTasks — main-thread tasks over 50 ms (count and longest)
// Phases: first open (also time to the first picture and until the layout
// rests), reopen (a picture seen before must come back at rest), zoom, pan,
// hover and drag. Headless Chromium may rasterise in software, so absolute
// numbers are pessimistic; compare runs on the same machine.
// Start a frontend first, preferably a production preview:
//   npx vite build && npx vite preview --host 127.0.0.1 --port 8099
// then run:
//   node scripts/perf/relation-graph.mjs --base http://127.0.0.1:8099 --sizes 500,2000,5000 --label before
import { parseArgs } from "node:util";

import { collectEnvironmentMetadata, collectGitProvenance, summarizeSamples, writePerformanceReport } from "./report.mjs";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:1431" },
    sizes: { type: "string", default: "500,2000,5000" },
    label: { type: "string", default: "run" },
    table: { type: "string", default: "item" },
  },
});
const { base, label, table } = args;
const sizes = args.sizes.split(",").map(Number).filter((size) => size > 0);

const { chromium } = await import("playwright");

// p50 / p95 / max in milliseconds, rounded for reading.
function stats(values) {
  const { count, p50, p95, max } = summarizeSamples(values);
  const round = (value) => (value === null ? null : +value.toFixed(1));
  return { n: count, p50: round(p50), p95: round(p95), max: round(max) };
}

// English, the sidebar open (the lab is a database of the demo server) and
// the graph's own preferences at their defaults.
const STORAGE = Object.freeze({ dbscout_language: "en", dbscout_sidebar_collapsed: "0", dbscout_relation_graph_options: null, dbscout_relation_panel_sections: null });

async function openLab(page, size) {
  await page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }, STORAGE);
  await page.goto(`${base}/?relationLab=${size}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.locator(".wb-source-connection").filter({ hasText: "Demo GameDB" }).getByText("Demo GameDB").first().click();
  await page.locator(".wb-database-item", { hasText: "relation_lab" }).first().click();
  await page.getByRole("group", { name: /relation_lab/u }).locator(".wb-table-search input").fill(table);
  await page.locator(".wb-search-result").filter({ has: page.locator(".wb-table-name", { hasText: new RegExp(`^${table}$`, "u") }) }).first().click();
  await page.locator('.wb-grid-row td[data-column-index="0"]').first().waitFor({ timeout: 60_000 });
  await page.locator('.wb-inspector-view-toggle [role="tab"]').nth(1).click();
  await page.locator(".wb-relation-graph-section .wb-relation-graph-surface").waitFor({ timeout: 60_000 });
  await waitResting(page, ".wb-relation-graph-section");
}

function waitResting(page, scope) {
  return page.waitForFunction(
    (selector) => document.querySelector(selector)?.__relationGraph?.state().running === false,
    `${scope} .wb-relation-graph-surface`,
    { timeout: 180_000 },
  );
}

// Switches the full-screen scope and resolves once the new picture has been
// drawn; returns how long that took.
async function switchScope(page, full, name) {
  const before = await page.evaluate(() => {
    const probe = document.querySelector(".wb-relation-graph-fullscreen .wb-relation-graph-surface")?.__relationGraph;
    return { draws: probe?.state().draws || 0, tables: probe?.ids().length || 0, at: performance.now() };
  });
  await full.getByRole("button", { name }).click();
  const drawnAt = await page.waitForFunction((previous) => {
    const probe = document.querySelector(".wb-relation-graph-fullscreen .wb-relation-graph-surface")?.__relationGraph;
    if (!probe || probe.state().draws <= previous.draws || probe.ids().length === previous.tables) return false;
    return performance.now();
  }, before);
  return +((await drawnAt.jsonValue()) - before.at).toFixed(1);
}

// Starts recording animation-frame intervals and long tasks in the page.
async function startSampling(page) {
  await page.evaluate(() => {
    const sampler = { frames: [], long: [], running: true };
    const loop = (time) => {
      if (!sampler.running) return;
      sampler.frames.push(time);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try {
      sampler.observer = new PerformanceObserver((list) => sampler.long.push(...list.getEntries().map((entry) => entry.duration)));
      sampler.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      sampler.observer = null;
    }
    document.querySelector(".wb-relation-graph-fullscreen .wb-relation-graph-surface")?.__relationGraph?.drawTimes(true);
    window.__relationGraphSampler = sampler;
  });
}

async function stopSampling(page, surface) {
  const sample = await page.evaluate(() => {
    const sampler = window.__relationGraphSampler;
    sampler.running = false;
    sampler.observer?.disconnect();
    return { frames: sampler.frames, long: sampler.long };
  });
  const draws = await surface.evaluate((element) => element.__relationGraph.drawTimes(true)).catch(() => []);
  const deltas = sample.frames.slice(1).map((time, index) => time - sample.frames[index]);
  return {
    frameMs: stats(deltas),
    drawMs: stats(draws),
    longTasks: { count: sample.long.length, maxMs: sample.long.length ? +Math.max(...sample.long).toFixed(1) : 0 },
  };
}

async function measureSize(browser, size) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLab(page, size);
  await page.locator(".wb-relation-graph-section .wb-relation-graph-zoom button").last().click();
  const full = page.locator(".wb-relation-graph-fullscreen");
  await full.waitFor();
  await waitResting(page, ".wb-relation-graph-fullscreen");
  const surface = full.locator(".wb-relation-graph-surface");
  const result = { size, phases: {} };

  // First open of the whole database.
  await startSampling(page);
  const opened = await page.evaluate(() => performance.now());
  const firstPictureMs = await switchScope(page, full, "Whole database");
  await waitResting(page, ".wb-relation-graph-fullscreen");
  const rested = await page.evaluate(() => performance.now());
  const state = await surface.evaluate((element) => element.__relationGraph.state());
  result.tables = (await surface.evaluate((element) => element.__relationGraph.ids())).length;
  result.worker = state.worker;
  result.phases.firstOpen = {
    firstPictureMs,
    restingMs: +(rested - opened).toFixed(1),
    ...(await stopSampling(page, surface)),
  };

  // Reopen: back to the table's neighbourhood and to the whole database again.
  await full.getByRole("button", { name: "This table" }).click();
  await waitResting(page, ".wb-relation-graph-fullscreen");
  await startSampling(page);
  const reopenMs = await switchScope(page, full, "Whole database");
  const reopenState = await surface.evaluate((element) => element.__relationGraph.state());
  await page.waitForTimeout(500);
  result.phases.reopen = {
    firstPictureMs: reopenMs,
    alreadyResting: reopenState.running === false,
    ...(await stopSampling(page, surface)),
  };

  const box = await surface.boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // Zoom: wheel notches around the middle, then back out.
  await page.mouse.move(center.x, center.y);
  await startSampling(page);
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(40);
  }
  for (let step = 0; step < 4; step += 1) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(500);
  result.phases.zoom = await stopSampling(page, surface);

  // Pan: drag empty space and let it coast.
  await startSampling(page);
  await page.mouse.move(box.x + 24, box.y + 24);
  await page.mouse.down();
  await page.mouse.move(box.x + 324, box.y + 204, { steps: 40 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  result.phases.pan = await stopSampling(page, surface);

  // Hover: over thirty tables in turn.
  const ids = await surface.evaluate((element) => element.__relationGraph.ids());
  await startSampling(page);
  for (const id of ids.slice(0, 30)) {
    const point = await surface.evaluate((element, target) => element.__relationGraph.point(target), id);
    if (!point || point.x < box.x || point.y < box.y || point.x > box.x + box.width || point.y > box.y + box.height) continue;
    await page.mouse.move(point.x, point.y, { steps: 3 });
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(400);
  result.phases.hover = await stopSampling(page, surface);

  // Drag: the busiest table, from the whole picture, while its neighbours make room.
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.dblclick(box.x + 6, box.y + 6);
  await page.waitForTimeout(800);
  const hub = await surface.evaluate((element, target) => element.__relationGraph.point(target), table);
  await startSampling(page);
  if (hub) {
    await page.mouse.move(hub.x, hub.y);
    await page.mouse.down();
    await page.mouse.move(hub.x + 160, hub.y + 90, { steps: 60 });
    await page.mouse.up();
  }
  await page.waitForTimeout(800);
  result.phases.drag = await stopSampling(page, surface);
  result.errors = errors;
  await page.close();
  return result;
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const size of sizes) {
    const result = await measureSize(browser, size);
    results.push(result);
    const line = Object.entries(result.phases)
      .map(([name, phase]) => `${name}: draw p50 ${phase.drawMs.p50 ?? "-"} / p95 ${phase.drawMs.p95 ?? "-"} ms, frame p95 ${phase.frameMs.p95 ?? "-"} ms, long tasks ${phase.longTasks.count}`)
      .join("\n  ");
    console.log(`${size} (${result.tables} tables, worker ${result.worker}): first picture ${result.phases.firstOpen.firstPictureMs} ms, at rest ${result.phases.firstOpen.restingMs} ms, reopen ${result.phases.reopen.firstPictureMs} ms (at rest: ${result.phases.reopen.alreadyResting})\n  ${line}`);
  }
} finally {
  await browser.close();
}

const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "-");
const file = await writePerformanceReport(
  { label, base, environment: collectEnvironmentMetadata(), source: await collectGitProvenance(), results },
  { fileName: `relation-graph-${label}-${stamp}.json` },
);
console.log(`\nWritten to ${file}`);
if (results.some((result) => result.errors.length || !result.phases.reopen.alreadyResting)) process.exitCode = 1;
