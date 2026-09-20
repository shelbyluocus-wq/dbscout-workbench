// scripts/perf/grid-interaction.mjs
// 打开表 / 切换表 / 方向键 / 编辑框 / 提交 的交互延迟采样。每个动作先验证"确实发生了"（选中格移动、
// 编辑框聚焦、值已写回且无错误标记），再记三段时间：
//   blockingMs — 事件派发 → 两次微任务让位后的近似耗时，不代表全部布局或异步工作已完成
//   paintMs    — 事件派发 → 双 requestAnimationFrame（首帧可见），按帧量化
//   settledMs  — 首帧/保存确认与最后长任务结束的较晚时间；观察 300 ms 无长任务后回记，不含观察等待
//   confirmedMs — 提交到 pending 消失；随后必须确认值正确且没有错误标记
// 任一验证失败或超时 → 记入 failures，进程以非 0 退出；失败样本不进入统计。
// 合成事件（dispatchEvent）不含真实输入管线延迟，数字用于前后对比，不等于用户体感绝对值。
// 先启动前端：
//   开发构建：npm run dev                    （默认 http://127.0.0.1:1431）
//   生产构建：npx vite build && npx vite preview --host 127.0.0.1 --port 8099
//            （Windows 上 4xxx 段端口常被 Hyper-V 保留，报 EACCES 就换端口）
// 再运行：
//   node scripts/perf/grid-interaction.mjs --base http://127.0.0.1:8099 --scenario schema-800x60 --label before
//   node scripts/perf/grid-interaction.mjs --base http://127.0.0.1:8099 --scenario rows-1k-12-pk --label before
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
};
const base = option("--base", "http://127.0.0.1:1431");
const scenario = option("--scenario", "schema-800x60");
const label = option("--label", "before");
const arrowSamples = Number(option("--arrows", "40"));
const editSamples = Number(option("--edits", "8"));
const url = `${base}/?perfProfile=deterministic-v1&scenario=${scenario}`;

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[role=option]", { timeout: 60_000 });

const result = await page.evaluate(async ({ arrowSamples, editSamples }) => {
  const failures = [];
  const fail = (step, detail) => { failures.push({ step, detail: String(detail) }); };
  const now = () => performance.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const raf2 = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(now()))));
  // 两次微任务让位：Vue 的 flush 微任务在事件派发时已入队、排在我们前面，所以回来时渲染/补丁已完成。
  const afterFlush = async () => { await Promise.resolve(); await Promise.resolve(); return now(); };
  const waitUntil = async (predicate, timeoutMs = 15_000) => {
    const deadline = now() + timeoutMs;
    if (predicate()) return now();
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (predicate()) { observer.disconnect(); resolve(now()); }
        else if (now() > deadline) { observer.disconnect(); reject(new Error("timeout")); }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      setTimeout(() => { observer.disconnect(); reject(new Error("timeout")); }, timeoutMs);
    });
  };
  const stats = (samples) => {
    const sorted = samples.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    if (!sorted.length) return { n: 0 };
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { n: sorted.length, min: sorted[0], p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) };
  };
  const round = (value) => +value.toFixed(1);
  const mouse = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  const key = (el, name) => el.dispatchEvent(new KeyboardEvent("keydown", { key: name, code: name, bubbles: true, cancelable: true }));
  const activeName = () => document.querySelector(".wb-tab.active .wb-tab-name")?.textContent?.trim() || "";
  const clickTab = (name) => {
    const tab = [...document.querySelectorAll(".wb-tab")].find((el) => el.querySelector(".wb-tab-name")?.textContent.trim() === name);
    if (tab) mouse(tab, "click");
    return Boolean(tab);
  };
  const options = () => [...document.querySelectorAll("[role=option]")];
  const optionName = (el) => el.getAttribute("aria-label") || el.textContent.trim().split(/\s+/)[0];
  const selectedCoords = () => {
    const td = document.querySelector(".wb-grid-row td.selected");
    return td ? `${td.dataset.visualRowIndex}:${td.dataset.columnIndex}` : "";
  };

  // 长任务观察：settledMs 需要"最后一个长任务结束时刻"
  let lastLongTaskEndAt = 0;
  const longTasks = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks.push(Math.round(entry.duration));
      lastLongTaskEndAt = Math.max(lastLongTaskEndAt, entry.startTime + entry.duration);
    }
  }).observe({ type: "longtask" });
  const settleAfter = async (fromAt, quietMs = 300, maxWaitMs = 4_000) => {
    const deadline = fromAt + maxWaitMs;
    for (;;) {
      const lastBusy = Math.max(fromAt, lastLongTaskEndAt);
      if (now() - lastBusy >= quietMs) return lastBusy;
      if (now() > deadline) return -1;
      await sleep(25);
    }
  };
  // 记录环境帧周期，供 paintMs 换算成帧数
  const frameTimes = [];
  for (let i = 0; i < 12; i += 1) frameTimes.push(await new Promise((resolve) => requestAnimationFrame(resolve)));
  const frameIntervalMs = round((frameTimes.at(-1) - frameTimes[0]) / (frameTimes.length - 1));

  const measure = async (dispatch) => {
    const startedAt = now();
    dispatch();
    const flushedAt = await afterFlush();
    const paintedAt = await raf2();
    return { startedAt, blockingMs: round(flushedAt - startedAt), paintMs: round(paintedAt - startedAt), paintedAt };
  };

  const names = options().slice(0, 4).map(optionName);

  // ── 打开表 ──
  const opens = [];
  for (const name of names) {
    try {
      clickTab("首页");
      await waitUntil(() => options().length > 0);
      await raf2(); await sleep(300);
      const target = options().find((el) => optionName(el) === name);
      if (!target) throw new Error("option not found");
      const longTaskCountBefore = longTasks.length;
      const startedAt = now();
      mouse(target, "dblclick");
      const firstRowAt = await waitUntil(() => activeName() === name && document.querySelector(".wb-grid-row td[data-row-key]"));
      const paintedAt = await raf2();
      const settledAt = await settleAfter(paintedAt);
      if (settledAt < 0) throw new Error("did not settle within 4s");
      opens.push({
        name,
        firstRowDomMs: round(firstRowAt - startedAt),
        paintMs: round(paintedAt - startedAt),
        settledMs: round(settledAt - startedAt),
        longTasks: longTasks.slice(longTaskCountBefore),
      });
    } catch (error) {
      fail(`open ${name}`, error.message);
    }
  }

  // ── 切换标签 ──
  const switches = [];
  for (let i = 0; i < 16 && names.length > 1; i += 1) {
    const target = names[i % names.length];
    if (activeName() === target) continue;
    try {
      const sample = await measure(() => clickTab(target));
      await waitUntil(() => activeName() === target && document.querySelector(".wb-grid-row td[data-row-key]"), 5_000);
      if (activeName() !== target) throw new Error(`active tab is ${activeName()}`);
      const settledAt = await settleAfter(sample.paintedAt);
      if (settledAt < 0) throw new Error("switch did not settle");
      switches.push({ ...sample, settledMs: round(settledAt - sample.startedAt) });
      await sleep(250);
    } catch (error) {
      fail(`switch ${target}`, error.message);
    }
  }

  // ── 方向键 ──
  const wrap = document.querySelector(".wb-grid-wrap");
  const selectCell = async (rowIndex, columnIndex) => {
    wrap.scrollLeft = 0;
    wrap.dispatchEvent(new Event("scroll"));
    await raf2();
    let td = document.querySelector(`.wb-grid-row td[data-visual-row-index="${rowIndex}"][data-column-index="0"]`);
    if (!td) throw new Error(`no row at ${rowIndex}`);
    mouse(td, "mousedown"); mouse(td, "mouseup"); mouse(td, "click");
    await raf2();
    wrap.focus();
    for (let index = 0; index < columnIndex; index += 1) {
      key(wrap, "ArrowRight");
      await raf2();
    }
    td = document.querySelector(`.wb-grid-row td[data-visual-row-index="${rowIndex}"][data-column-index="${columnIndex}"]`);
    if (!td || !td.classList.contains("selected")) throw new Error("could not select requested logical cell");
    return td;
  };
  const arrows = [];
  try {
    await selectCell(5, 3);
    for (let i = 0; i < arrowSamples; i += 1) {
      const name = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"][i % 4];
      const before = selectedCoords();
      const sample = await measure(() => key(document.activeElement || wrap, name));
      const after = selectedCoords();
      const [r,c] = before.split(":").map(Number);
      const expected = `${r + (name === "ArrowDown" ? 1 : name === "ArrowUp" ? -1 : 0)}:${c + (name === "ArrowRight" ? 1 : name === "ArrowLeft" ? -1 : 0)}`;
      if (after !== expected) throw new Error(`expected ${expected}, got ${after}`);
      if (!after || after === before) { fail(`arrow #${i} ${name}`, `selection did not move (${before} -> ${after})`); continue; }
      arrows.push(sample);
      await sleep(40);
    }
  } catch (error) {
    fail("arrow setup", error.message);
  }

  // ── 编辑框打开 / 提交 ──
  const editorOpens = [];
  const commits = [];
  for (let i = 0; i < editSamples; i += 1) {
    try {
      const td = await selectCell(20 + i, 6);
      const rowKey = td.dataset.rowKey;
      const columnName = td.dataset.columnName;
      const openSample = await measure(() => key(document.activeElement || wrap, "Enter"));
      const input = document.querySelector(".wb-grid-row td.editing input");
      if (!input || document.activeElement !== input || input.closest("td")?.dataset.rowKey !== rowKey) {
        throw new Error("editor did not open on the selected cell / not focused");
      }
      editorOpens.push(openSample);
      const value = `edit-${Date.now()}-${i}`;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await raf2();
      const commitSample = await measure(() => key(input, "Enter"));
      await waitUntil(() => !document.querySelector(".wb-grid-row td.editing input"), 5_000);
      // 等待后端确认（pending 消失），再核对值与错误标记
      await waitUntil(() => !document.querySelector(`.wb-grid-row td[data-row-key="${CSS.escape(rowKey)}"].pending`), 5_000);
      const confirmedAt = now();
      const settledAt = await settleAfter(confirmedAt);
      if (settledAt < 0) throw new Error("commit did not settle");
      const cell = document.querySelector(`.wb-grid-row td[data-row-key="${CSS.escape(rowKey)}"][data-column-name="${CSS.escape(columnName)}"]`);
      if (!cell) throw new Error("edited cell not found after commit");
      if (cell.classList.contains("error")) throw new Error(`cell has error: ${cell.getAttribute("title")}`);
      if (cell.textContent.trim() !== value) throw new Error(`cell text "${cell.textContent.trim()}" != "${value}"`);
      commits.push({ ...commitSample, confirmedMs: round(confirmedAt - commitSample.startedAt), settledMs: settledAt < 0 ? -1 : round(settledAt - commitSample.startedAt) });
      await sleep(150);
    } catch (error) {
      fail(`edit #${i}`, error.message);
    }
  }

  const pick = (list, field) => list.map((entry) => entry[field]);
  return {
    ok: failures.length === 0,
    failures,
    frameIntervalMs,
    renderedRows: document.querySelectorAll(".wb-grid-row").length,
    renderedCells: document.querySelectorAll(".wb-grid-row td").length,
    opens,
    switch: { blocking: stats(pick(switches, "blockingMs")), paint: stats(pick(switches, "paintMs")), settled: stats(pick(switches, "settledMs")) },
    arrow: { blocking: stats(pick(arrows, "blockingMs")), paint: stats(pick(arrows, "paintMs")) },
    editorOpen: { blocking: stats(pick(editorOpens, "blockingMs")), paint: stats(pick(editorOpens, "paintMs")) },
    commit: { confirmed: stats(pick(commits, "confirmedMs")), blocking: stats(pick(commits, "blockingMs")), paint: stats(pick(commits, "paintMs")), settled: stats(pick(commits, "settledMs")) },
  };
}, { arrowSamples, editSamples });

await browser.close();

const git = (command) => { try { return execSync(command, { encoding: "utf8" }).trim(); } catch { return ""; } };
const environment = {
  platform: `${os.platform()} ${os.release()}`,
  cpu: os.cpus()[0]?.model || "",
  cores: os.cpus().length,
  memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  commit: git("git rev-parse HEAD"),
  dirty: git("git status --porcelain").length > 0,
  node: process.version,
};
const outputDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../output/performance");
fs.mkdirSync(outputDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "-");
const file = path.join(outputDirectory, `grid-interaction-${label}-${scenario}-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify({ label, scenario, url, environment, ...result }, null, 2));
console.log(JSON.stringify({ file, environment, ...result }, null, 2));
if (!result.ok) {
  console.error(`\n${result.failures.length} interaction check(s) failed — latency numbers above are NOT valid for acceptance.`);
  process.exitCode = 1;
}
