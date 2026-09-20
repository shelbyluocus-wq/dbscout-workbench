# 网格交互性能优化实施计划（打开表 / 切换表 / 单元格编辑）

> **给执行本计划的 AI/工程师：** 本文档可独立执行，不依赖任何历史对话。每个 Task 独立成一次提交（`git commit`），按顺序做，做完一个跑一次验证再进入下一个。
> 请**只读本文标注的文件与行号范围**——仓库里有几个巨型文件（`useGridEditor.js` 190 KB、`MySqlWorkbench.vue` 186 KB、`commands.rs` 9700+ 行、`DataGrid.vue` 84 KB），整文件读一次就要 3–8 万 token，本计划已经把需要看的位置全部标出。
> 项目约定见仓库根目录 `CLAUDE.md`/`AGENTS.md`：Vue 3 `<script setup>`；JS 测试用 `node:test`；CSS 只用 `--wb-*` 令牌、不写魔法色值；Tauri 命令契约改动必须同步 `mock/mockBackend.js`；用户可感知的响应速度是最高优先级，但正确性和数据安全不可让步。
> 注意：`src/workbench/*.test.js` 里有多份"静态正则测试"（用正则匹配 `.vue` 源码文本，如 `workbenchShell.test.js`、`workbenchCssPolish.test.js`、`gridEditingAccessibility.test.js`、`homepageInteraction.test.js`）。改模板后这些断言会失败，属预期，请同步更新断言而不是绕开。
>
> **v2 修订（2026-09-19，依据两轮外部评审）：** ① Task 3 行身份失效改为在 `rowStore` 内集中判断（覆盖全部 10 处 `mutateTabRow` 调用与无主键表），不再靠调用点手工标记；② Task 1 框选类名判断与 `aria-selected` 语义改为读 `range-selected`，并给在框选内的行加缓存；③ Task 2/7 统一"逻辑列号"与"实际渲染列"的对应（`allColumnMeta` vs `renderSegments`），列窗口缓存比较全部列宽与冻结数，拖拽定位区分冻结带；④ Task 7 把 `columnWindow` 显式传进 `useGridEditor` 的第 5 个参数；⑤ Task 4 标签栏改为始终普通容器（不再在拖拽时切换组件类型），自适应列宽监听保留 `loading` 依赖；⑥ Task 5 增加复合主键按索引列序排序、`EXPLAIN` 验证、深分页说明；⑦ Task 6 `synchronous=NORMAL` 的风险描述改正（丢失量不限于一两条），降级为需重新确认的安全策略变更并给出替代方案；⑧ Task 0 测量脚本先验证动作成功再计时，区分 JS 阻塞、首帧、稳定三段，超时判失败，阈值改为"JS 段绝对值 + 相对基线倍数"。

**目标：** 让 60 列宽表上的方向键移动、编辑框打开、提交、切换标签接近单帧（≤ 16–30 ms），打开表首帧阻塞减半；真实 MySQL 上文本主键表的每一页不再全表扫描，单格保存不再被两次磁盘 fsync 卡住。

**架构思路：** 前端把"整个可见网格是一个 render 函数"改成"每行一个可跳过重渲染的组件 + 事件委托 + 列高亮 CSS 化"，把每个交互动作的渲染代价从 O(可见格子数) 降到 O(变化行数)；再合并一次动作里多余的渲染与强制布局。后端把默认分页排序改回可走索引的主键顺序，调整连接池与审计库参数。

**技术栈：** Vue 3 Composition API、Vite、Node `node:test`、Playwright（已在 devDependencies）、Tauri 2、Rust、sqlx 0.8（MySQL + SQLite）。

---

## 0. 基线与验收

### 0.1 已实测基线（生产构建 `vite build`，浏览器 + 内置模拟后端，后端延迟 0 → 纯前端成本）

| 动作 | 12 列（806 个可见格） | 60 列（3782 个可见格） |
|---|---|---|
| 打开表：首批行出现 / 画完 | 94 / 239 ms | 215–360 / 650–815 ms |
| 打开表：主线程长任务 | 113 + 60 ms | ≈ 280–475 + 200 + 95 + 170 ms（4 段） |
| 切换到已打开的表（画完） | — | p50 107 ms（单段长任务 85–110 ms） |
| 方向键移动选中格（双 rAF） | p50 42 / p95 59 ms | p50 198 / p95 269 ms |
| Enter 打开编辑框到聚焦 | 50 ms | 194 ms |
| Enter 提交到画面稳定 | 95 ms | 371 ms |

成本模型：每个可见格子每次渲染 ≈ 52 µs；一次方向键触发网格整体渲染 2 次，一次提交 4 次。

上表的来源与局限：在一台 Windows 10 工作站、Cursor 内置 Chromium（非 WebView2）、1440×960 视口、工作区有未提交改动的状态下用与 Task 0 脚本等价的代码采集，**只作量级参考，不作验收锚点**。执行者必须在自己的机器、自己的提交上用 Task 0 重新采基线，并把基线报告路径、`git rev-parse HEAD`、CPU/内存/刷新率写进提交说明；之后所有对比都以该基线为准。合成事件（`dispatchEvent`）测到的是"框架处理 + 渲染"段，不含真实键盘输入管线延迟，外推到用户体感时要留一帧余量。

### 0.2 验收标准

**先正确，后性能。** 每个 Task 先过本 Task 的手工/自动正确性清单，测量脚本中任何一次动作验证失败（选中格没动、值没保存、出现错误标记、超时）都算该 Task 未完成，不看耗时。

Task 0 脚本对每个动作报三段时间（定义见脚本注释）：`blockingMs`（事件派发到 Vue 渲染/补丁完成的 JS 段，不受刷新率量化）、`paintMs`（到双 `requestAnimationFrame`，按帧量化）、`settledMs`（到连续 300 ms 没有 ≥ 50 ms 长任务）。阈值同时用绝对值与相对基线倍数，两者都满足才通过；绝对值按 60 列 `schema-800x60` 生产构建给出，12 列 `rows-1k-12-pk` 括号内。

| 指标 | 绝对阈值（p50 / p95） | 相对阈值（同机同构建，对 Task 0 基线） |
|---|---|---|
| 方向键 `blockingMs` | ≤ 12 / 25 ms（12 列 ≤ 4 / 8 ms） | ≤ 基线 1/5 |
| 方向键 `paintMs` | ≤ 2 帧 | — |
| 编辑框打开 `blockingMs` | ≤ 20 / 40 ms | ≤ 基线 1/4 |
| 提交 `settledMs` | ≤ 80 / 150 ms | ≤ 基线 1/3 |
| 切换标签 `paintMs` | ≤ 50 / 80 ms | ≤ 基线 1/2 |
| 打开表 `paintMs` / `settledMs` | ≤ 400 / — ms；`settledMs` ≤ 900 ms | 打开过程中最长单段长任务 ≤ 基线 1/2 |

回归护栏：`node scripts/test-workbench.mjs` 全绿；`cd src-tauri && cargo test` 全绿；`npm run build` 成功；滚动 10 秒无明显掉帧（`grid.scroll.frame` 采样，见 `DataGrid.vue:546-560`）；12 列窄表的各项指标不得比基线差 10% 以上。

**真实环境复核（Task 5/6 与最终收尾必做）：** 用 `npm run tauri -- dev` 连接真实 MySQL，打开一张 varchar 主键、≥ 5 万行、≥ 40 列的表；在 WebView2 开发者工具控制台粘贴 Task 0 脚本里 `page.evaluate` 的函数体运行一次；同时看 `[dbscout:perf] invoke:open_table_session / invoke:fetch_table_page / invoke:update_cell` 日志的 `durationMs`。浏览器模拟后端的数字不能替代这一步。

### 0.3 阶段总览

| 阶段 | 内容 | 改动量 | 主要文件 | 预估 token（含读代码） | 收益 | 风险 | 决策状态 |
|---|---|---|---|---|---|---|---|
| Task 0 | 测量脚本 | +130 行新文件 | `scripts/perf/grid-interaction.mjs` | 3–5 万 | 之后每步可量化 | 无 | 否 |
| Task 1 | 行组件化 + 每行派生状态 + 列高亮 CSS 化 | ~400 行（新组件 ~200、DataGrid 改 ~150、CSS ~20、测试 ~50） | `DataGrid.vue`、新 `GridDataRow.vue`、`editState.js`、`workbench.css` | 12–18 万 | 方向键/编辑框/提交 5–10 倍 | 中（模板迁移细节多） | 否 |
| Task 2 | tbody 事件委托，去掉每格 5 个闭包 | ~120 行 | `DataGrid.vue`、`GridDataRow.vue` | 5–8 万 | 打开/切换表 20–30% | 低 | 否 |
| Task 3 | 渲染次数合并：行级版本号、行身份变化在 rowStore 内集中判断、提交只渲染 1–2 次、滚动测量减为 1 次 | ~150 行 | `rowStore.js`、`rowIndex.js`、`useVirtualGrid.js`（`useGridEditor.js` 不改，只核对） | 8–12 万 | 提交再减半 | 中 | 否 |
| Task 4 | 标签栏去掉 `TransitionGroup` 的强制布局；首帧零 buffer；自适应列宽并入首帧 | ~80 行 | `WorkbenchTabs.vue`、`useVirtualGrid.js`、`DataGrid.vue` | 5–8 万 | 打开/切换表 30–40% | 低 | 已决定：做（动画取舍见 §8 第 3 条） |
| Task 5 | 后端：默认排序走主键索引（含复合主键索引列序）；连接池参数；LIMIT/OFFSET 参数化；`EXPLAIN` 验证 | ~120 行 + 测试修正 | `db.rs`、`types.rs`、`natural_sort.rs` 测试 | 8–12 万 | 真实库上大表前若干页从"全表扫描 + filesort"变"索引顺序读"；深分页仍有 OFFSET 成本 | 低 | 已决定：做（主键索引顺序） |
| Task 6 | 后端：单条审计状态更新去事务、元数据查询并行、锁内无用克隆；`synchronous=NORMAL` 另议 | ~60 行 | `audit.rs`、`commands.rs`（3 处）、`db.rs` | 6–10 万 | 单格保存后端 -5~40 ms（取决于是否改 synchronous） | Step 1 属安全策略变更 | Step 2–4 做；Step 1 待重新确认（§8 第 2 条） |
| Task 7 | 横向列虚拟化：只渲染视口内 + 冻结 + 选中/编辑列，其余用占位格 | ~450 行（新组合式 ~150、DataGrid/GridDataRow ~200、useVirtualGrid ~60、测试 ~80） | 新 `useVirtualColumns.js`、`useVirtualGrid.js`、`DataGrid.vue`、`GridDataRow.vue` | 15–25 万 | 60 列以上表所有动作再 2–3 倍；打开/切换表格子数减半 | 高（拖拽/框选/填充柄边界多） | 已决定：做 |
| 可选 | 行载荷改列式；每表 DOM 保留；IPC 先于渲染发出 | 30–300 行 / 项 | 见第 7 节 | 3–20 万 / 项 | 见表 | 中 | 未定 |

Task 0–7 合计约 1400–1550 行改动、16–18 个文件，预估 60–100 万 token。每个 Task 建议开一个新会话执行，避免上下文膨胀。**Task 7 必须在 Task 1–4 之后做**（它依赖行组件与事件委托的结构）。

表中的"收益"是按成本模型推算的**估算**，各项之间有重叠（例如 Task 1 已把方向键的格子求值降到两行，Task 7 再减少列数时对方向键的收益就小于对打开/切换表的收益），不能逐项相乘；以 Task 0 每步实测为准。

---

## Task 0：交互延迟测量脚本

**Files:**
- Create: `scripts/perf/grid-interaction.mjs`

`output/` 目录已在 `.gitignore` 中，报告写到那里不会污染仓库。脚本依赖 Playwright（`scripts/perf/ui-suite.mjs` 已在用同一依赖；若报缺浏览器，执行 `npx playwright install chromium`）。

- [ ] **Step 1：新建脚本**

```js
// scripts/perf/grid-interaction.mjs
// 打开表 / 切换表 / 方向键 / 编辑框 / 提交 的交互延迟采样。每个动作先验证"确实发生了"（选中格移动、
// 编辑框聚焦、值已写回且无错误标记），再记三段时间：
//   blockingMs — 事件派发 → Vue 渲染/补丁完成（两次微任务让位后），纯 JS 段，不受刷新率量化
//   paintMs    — 事件派发 → 双 requestAnimationFrame（首帧可见），按帧量化
//   settledMs  — 事件派发 → 之后连续 300 ms 没有 ≥ 50 ms 的长任务（后续缓冲补齐/列宽自适应都算进来）
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
      switches.push({ ...sample, settledMs: round((await settleAfter(sample.paintedAt)) - sample.startedAt) });
      await sleep(250);
    } catch (error) {
      fail(`switch ${target}`, error.message);
    }
  }

  // ── 方向键 ──
  const wrap = document.querySelector(".wb-grid-wrap");
  const selectCell = async (rowIndex, columnIndex) => {
    const td = document.querySelectorAll(".wb-grid-row")[rowIndex]?.querySelectorAll("td")[columnIndex];
    if (!td) throw new Error(`no cell at ${rowIndex}:${columnIndex}`);
    mouse(td, "mousedown"); mouse(td, "mouseup"); mouse(td, "click");
    await raf2();
    wrap.focus();
    return td;
  };
  const arrows = [];
  try {
    await selectCell(5, 3);
    for (let i = 0; i < arrowSamples; i += 1) {
      const name = i % 2 ? "ArrowRight" : "ArrowDown";
      const before = selectedCoords();
      const sample = await measure(() => key(document.activeElement || wrap, name));
      const after = selectedCoords();
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
      const settledAt = await settleAfter(commitSample.paintedAt);
      const cell = document.querySelector(`.wb-grid-row td[data-row-key="${CSS.escape(rowKey)}"][data-column-name="${CSS.escape(columnName)}"]`);
      if (!cell) throw new Error("edited cell not found after commit");
      if (cell.classList.contains("error")) throw new Error(`cell has error: ${cell.getAttribute("title")}`);
      if (cell.textContent.trim() !== value) throw new Error(`cell text "${cell.textContent.trim()}" != "${value}"`);
      commits.push({ ...commitSample, settledMs: settledAt < 0 ? -1 : round(settledAt - commitSample.startedAt) });
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
    commit: { blocking: stats(pick(commits, "blockingMs")), paint: stats(pick(commits, "paintMs")), settled: stats(pick(commits, "settledMs")) },
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
```

- [ ] **Step 2：跑一次生产构建基线并保存**

```powershell
npx vite build
Start-Process npx.cmd -ArgumentList "vite preview --host 127.0.0.1 --port 8099 --strictPort" -WindowStyle Hidden
node scripts/perf/grid-interaction.mjs --base http://127.0.0.1:8099 --scenario schema-800x60 --label before
node scripts/perf/grid-interaction.mjs --base http://127.0.0.1:8099 --scenario rows-1k-12-pk --label before
```

预期：`ok: true`、`failures: []`，数字与 0.1 节同一量级（60 列 arrow paint p50 ≈ 200 ms）。若 `ok` 为 false，先修脚本或环境，不要带着失败样本记基线。把两份报告路径、`environment.commit` 与机器规格写进 Task 0 的提交说明；之后每个 Task 完成后用 `--label taskN` 重跑对比，相对阈值以这两份基线为准。

- [ ] **Step 3：提交** `git add scripts/perf/grid-interaction.mjs && git commit -m "perf(scripts): add grid interaction latency sampler"`

---

## Task 1：数据行组件化 + 每行派生状态 + 列高亮 CSS 化

这是收益最大的一步。原理：现在 `DataGrid.vue` 是单一 render 函数，`selectedCell`/`selectedRange`/`editingCell`/`editDraft`/`editState` 的任何变化都让全部可见 `<td>` 重新求值（每格 ≈ 25 次函数调用、6 次字符串拼接、6 次响应式 Map 读、5 个事件闭包）。改成每行一个子组件后，Vue 只重渲染 props 变化的行；关键是**子组件只能接收"派生后的标量/小对象"，绝不能直接接收 `selectedCell` 这类整块对象**，否则所有行仍会一起重渲染。

**Files:**
- Create: `src/workbench/components/GridDataRow.vue`
- Modify: `src/workbench/components/DataGrid.vue`
  - 数据行模板 `1572-1653`（迁走）、冻结行带 `1376-1460`（复用同一组件）、`renderCellColumns` `436-442`、`cellRangeClasses` `448-453`、`isActiveColumn` `421-423`、`gridCellDomId`/`activeCellDomId` `658-666`、`visibleRowsWithVisualIndex` `697-700`
- Modify: `src/workbench/editState.js`（新增 `collectCellStatesForTable`，放在 `getCellError` 之后，约第 482 行）
- Modify: `src/workbench/workbench.css:12968-12979`（`col-active` 三条规则改为动态规则模板）
- Test: `src/workbench/editState.test.js`（若不存在则新建）、`src/workbench/workbenchShell.test.js`、`src/workbench/gridEditingAccessibility.test.js`、`src/workbench/workbenchCssPolish.test.js`（更新静态断言）

先读：`DataGrid.vue:42-78`（props）、`180-186`、`421-453`、`572-608`、`658-700`、`1372-1460`、`1572-1653`；`editState.js:1-6`、`476-482`；`workbench.css:12898-12980`。**不要**读 `useGridEditor.js` 全文——本 Task 不改它。

- [ ] **Step 1：在 `editState.js` 增加按表聚合的单元格状态（失败测试先写）**

`src/workbench/editState.test.js` 追加：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createEditState, startCellCommit, failCellCommit, collectCellStatesForTable } from "./editState.js";

test("collectCellStatesForTable 按行聚合 pending 与 error，且只含目标表", () => {
  const edit = createEditState();
  const key = startCellCommit(edit, { tableName: "t1", rowKey: "id=1", columnName: "a", oldValue: "x", newValue: "y" });
  startCellCommit(edit, { tableName: "t1", rowKey: "id=2", columnName: "b", oldValue: "1", newValue: "2" });
  startCellCommit(edit, { tableName: "t2", rowKey: "id=1", columnName: "a", oldValue: "1", newValue: "2" });
  failCellCommit(edit, key, "boom");
  const states = collectCellStatesForTable(edit, "t1");
  assert.equal(states.size, 2);
  assert.equal(states.get("id=1").errors.get("a"), "boom");
  assert.equal(states.get("id=1").pending.has("a"), false);
  assert.equal(states.get("id=2").pending.has("b"), true);
  assert.equal(states.has("id=3"), false);
});
```

运行 `node --test src/workbench/editState.test.js`，预期失败：`collectCellStatesForTable is not a function`。

- [ ] **Step 2：实现**（`editState.js`，紧跟 `getCellError` 之后）

```js
// 按行聚合某张表的 pending / error 单元格：Map<rowKey, { pending: Set<column>, errors: Map<column, message> }>。
// 供网格在一次渲染里 O(1) 查每行状态，替代每格拼 cellKey 再查 Map。
export function collectCellStatesForTable(edit, tableName) {
  const states = new Map();
  const prefix = `${String(tableName ?? "")}${KEY_SEPARATOR}`;
  const bucket = (rowKey) => {
    let state = states.get(rowKey);
    if (!state) {
      state = { pending: new Set(), errors: new Map() };
      states.set(rowKey, state);
    }
    return state;
  };
  for (const key of edit?.pendingCells?.keys?.() || []) {
    if (!key.startsWith(prefix)) continue;
    const [, rowKey, columnName] = key.split(KEY_SEPARATOR);
    bucket(rowKey).pending.add(columnName);
  }
  for (const [key, message] of edit?.cellErrors?.entries?.() || []) {
    if (!key.startsWith(prefix)) continue;
    const [, rowKey, columnName] = key.split(KEY_SEPARATOR);
    bucket(rowKey).errors.set(columnName, message);
  }
  return states;
}
```

运行同一测试，预期通过。

- [ ] **Step 3：新建 `GridDataRow.vue`**

把 `DataGrid.vue:1572-1653` 的 `<tr class="wb-grid-row">…</tr>` 原样搬进来，并做如下替换（其余属性、`data-*`、`role`、事件名一律保留，`useGridEditor.js` 与 `useVirtualGrid.js` 通过 `td[data-column-index]`、`[data-row-key]`、`[data-visual-row-index]`、`td.editing input` 查 DOM）：

| 原表达式 | 改为 |
|---|---|
| `selectedCell?.rowKey === rowKey && selectedCell?.column === columnMeta.name && selectedCell?.tabId === tab.id` | `selectedColumn === columnMeta.name` |
| `selectedCell?.tabId === tab.id && selectedCell?.rowKey === rowKey`（行 `row-active`） | `isActiveRow` |
| `isActiveColumn(columnMeta.name)`（`col-active`） | **删除**（改由 Task 1 Step 6 的动态 CSS 规则实现） |
| `editingCell?.rowKey === rowKey && editingCell?.column === columnMeta.name` | `editingColumn === columnMeta.name` |
| `tab.selectedRowKeys.has(rowKey)` | `rowSelected` |
| `isRowInSelectedRange(tab, visualIndex)` | `inRowRange` |
| `...cellRangeClasses(tab, rowKey, columnMeta.name, visualIndex, columnMeta.columnIndex)` | `...(rangeClassesByColumn?.[columnMeta.name] || EMPTY)` |
| `isCellInSelectedRange(...)`（`aria-selected`） | `rangeClassesByColumn?.[columnMeta.name]?.['range-selected'] === true`。**注意**：`useGridEditor.getCellRangeClasses` 对不在框选内的格子返回的是一个 7 个属性全为 `false` 的冻结对象（`useGridEditor.js:82-90`），所以不能用"对象是否存在/是否有键"判断选中，只能看 `range-selected` 这个值；原 `isCellInSelectedRange` 的语义正是"该坐标在框选内" |
| `isCellPending(editState, tabScopeKey(tab), rowKey, columnMeta.name)` | `cellState?.pending.has(columnMeta.name) === true` |
| `getCellError(editState, tabScopeKey(tab), rowKey, columnMeta.name)` | `cellState?.errors.get(columnMeta.name) \|\| ''` |
| `:title="… \|\| ''"` | `:title="cellError(columnMeta.name) \|\| undefined"`（空值不再写属性） |
| `:id="gridCellDomId(tab.id, rowKey, columnMeta.name)"` | `:id="isActiveRow ? cellDomId(columnMeta.name) : undefined"`（`aria-activedescendant` 只需要选中格有 id） |
| `plainCellText(tab, row, columnMeta.name, rowKey)` / `highlightCellHtml(...)` | 改为通过 props 传入的**稳定函数引用** `displayText(row, columnName, rowKey)` / `highlightHtml(row, columnName, rowKey)`（父组件用 `const` 定义一次，不能在模板里写箭头函数，否则每次父渲染都换引用） |

组件脚本：

```vue
<script setup>
import { LoaderCircle } from "lucide-vue-next";

const EMPTY = Object.freeze({});

const props = defineProps({
  tabId: { type: String, required: true },
  row: { type: Object, required: true },            // 原始行对象（非响应式）
  rowKey: { type: String, required: true },
  rowVersion: { type: Number, default: 0 },          // Task 3 接入；行内容变化时父组件递增，用于触发本行重渲染
  originalIndex: { type: Number, required: true },
  visualIndex: { type: Number, required: true },
  rowNumber: { type: Number, required: true },       // rowWindowOffset + visualIndex + 1
  columns: { type: Array, required: true },          // renderCellColumns
  frozenColumnCount: { type: Number, default: 0 },
  frozenRowStyle: { type: Object, default: null },   // 冻结行带使用，普通行为 null
  frozenRowClass: { type: String, default: "" },     // 'frozen-row' / 'frozen-corner' 等，由父组件算好
  isLastFrozenRow: { type: Boolean, default: false },
  // ---- 每行派生状态（父组件按行算好；只有值变化的行才会重渲染）----
  isActiveRow: { type: Boolean, default: false },
  selectedColumn: { type: String, default: "" },
  editingColumn: { type: String, default: "" },
  editDraft: { type: String, default: "" },
  rowSelected: { type: Boolean, default: false },
  inRowRange: { type: Boolean, default: false },
  rangeClassesByColumn: { type: Object, default: null },
  cellState: { type: Object, default: null },        // { pending: Set, errors: Map } 或 null
  hasActiveCellSearch: { type: Boolean, default: false },
  // ---- 稳定函数引用 ----
  displayText: { type: Function, required: true },
  highlightHtml: { type: Function, required: true },
  isSearchMatch: { type: Function, required: true },
  cellDomId: { type: Function, required: true },     // (columnName) => id
  isLastFrozenColumn: { type: Function, required: true },
});

const emit = defineEmits(["row-select-start", "toggle-row-select", "row-contextmenu", "row-resize-start", "row-resize-reset", "edit-input", "cell-blur", "finish-edit", "cancel-edit", "tab-edit"]);

function cellError(columnName) {
  return props.cellState?.errors.get(columnName) || "";
}
function cellPending(columnName) {
  return props.cellState?.pending.has(columnName) === true;
}
</script>
```

模板中的行头（`wb-row-index`）保留原有内联事件，但改为 `emit(...)` 给父组件（父组件再调用原来的 `onRowSelectStart`/`emit('toggle-row-select', ...)`）。数据格上的 5 个鼠标事件（mousedown/mouseenter/mouseup/click/dblclick）**先原样保留**，Task 2 再改成委托。

- [ ] **Step 4：在 `DataGrid.vue` 计算每行派生状态并接入组件**

在 `<script setup>` 中（`visibleRowsWithVisualIndex` 之后）加入：

```js
import GridDataRow from "./GridDataRow.vue";
import { collectCellStatesForTable } from "../editState.js";

const activeCell = computed(() => (
  props.selectedCell?.tabId === props.tab?.id && props.selectedCell?.kind !== "fieldComment"
    ? props.selectedCell
    : null
));
// 注意：核对 useGridEditor.js:2283 startEditing 里 editingCell 是否带 tabId；若不带，这里不要比较 tabId。
const editingForTab = computed(() => props.editingCell || null);
const rangeForTab = computed(() => (
  props.selectedRange?.tabId === props.tab?.id ? props.selectedRange : null
));
const rowCellStates = computed(() => {
  void props.editState.mutationVersion;
  return collectCellStatesForTable(props.editState, tabScopeKey(props.tab));
});

// 框选类名按行缓存：同一个 selectedRange 对象、同一行、同一列集合 → 复用同一个结果对象，
// 这样父组件因别的原因重渲染时，框选内的行不会因为拿到"内容相同的新对象"而白白重渲染。
// 缓存键用 selectedRange 的对象身份：useGridEditor 每次改选区都会换一个新对象。
let rangeClassesCache = { range: null, columns: null, byRow: new Map() };
function computeRangeClassesForRow(rowKey, visualIndex, columns) {
  const out = {};
  for (const columnMeta of columns) {
    const classes = props.getCellRangeClasses(props.tab, rowKey, columnMeta.name, visualIndex, columnMeta.columnIndex);
    // getCellRangeClasses 对未选中格返回"全 false"的冻结对象，只有 range-selected 为 true 才算在框选内
    if (classes?.["range-selected"] === true) out[columnMeta.name] = classes;
  }
  return Object.keys(out).length ? out : null;
}
function rangeClassesForRow(rowKey, visualIndex) {
  const range = rangeForTab.value;
  const filling = props.isFilling || isFillDragging.value;
  // 填充柄拖拽时 useGridEditor 用的是"填充预览选区"而不是 selectedRange（useGridEditor.js:181-188），
  // 此时不能按 selectedRange 身份缓存，退回逐行计算（与改前行为一致，只在拖拽期间发生）。
  if (!range && !filling) return null;
  if (!filling && !isRowInSelectedRange(props.tab, visualIndex)) return null;
  const columns = renderColumns.value;
  if (filling) return computeRangeClassesForRow(rowKey, visualIndex, columns);
  if (rangeClassesCache.range !== range || rangeClassesCache.columns !== columns) {
    rangeClassesCache = { range, columns, byRow: new Map() };
  }
  const cacheKey = `${rowKey}\u001f${visualIndex}`;
  if (rangeClassesCache.byRow.has(cacheKey)) return rangeClassesCache.byRow.get(cacheKey);
  const result = computeRangeClassesForRow(rowKey, visualIndex, columns);
  rangeClassesCache.byRow.set(cacheKey, result);
  return result;
}

// 传给每行的稳定函数引用（不能在模板里写箭头函数）
const displayText = (row, columnName, rowKey) => plainCellText(props.tab, row, columnName, rowKey);
const highlightHtml = (row, columnName, rowKey) => highlightCellHtml(props.tab, row, columnName, rowKey);
const isSearchMatch = (row, columnName, rowKey) => isSearchMatchCell(props.tab, row, columnName, rowKey);
const cellDomIdFor = (rowKey) => (columnName) => gridCellDomId(props.tab?.id, rowKey, columnName);

const dataRowModels = computed(() => {
  const tab = props.tab;
  const cell = activeCell.value;
  const editing = editingForTab.value;
  const states = rowCellStates.value;
  return visibleRowsWithVisualIndex.value.map((entry) => {
    const { row, rowKey, originalIndex, visualIndex, rowVersion = 0 } = entry;
    const isActiveRow = Boolean(cell && cell.rowKey === rowKey);
    return {
      row, rowKey, originalIndex, visualIndex, rowVersion,
      rowNumber: rowWindowOffset.value + visualIndex + 1,
      isActiveRow,
      selectedColumn: isActiveRow ? String(cell.column || "") : "",
      editingColumn: editing?.rowKey === rowKey ? String(editing.column || "") : "",
      rowSelected: tab.selectedRowKeys?.has?.(rowKey) === true,
      inRowRange: Boolean(rangeForTab.value) && isRowInSelectedRange(tab, visualIndex),
      rangeClassesByColumn: rangeClassesForRow(rowKey, visualIndex),
      cellState: states.get(rowKey) || null,
      cellDomId: cellDomIdFor(rowKey),
    };
  });
});
```

`cellDomIdFor(rowKey)` 每次都会产生新函数——为避免它导致所有行重渲染，父组件用 `WeakMap`/`Map<rowKey, fn>` 缓存：

```js
const cellDomIdFns = new Map();
function cellDomIdFor(rowKey) {
  let fn = cellDomIdFns.get(rowKey);
  if (!fn) {
    fn = (columnName) => gridCellDomId(props.tab?.id, rowKey, columnName);
    cellDomIdFns.set(rowKey, fn);
    if (cellDomIdFns.size > 5000) cellDomIdFns.clear();
  }
  return fn;
}
```

模板里把原 `<tr class="wb-grid-row">…</tr>` 替换为下面的组件。注意：原来的 `<template v-for="{ row, originalIndex, rowKey, visualIndex } in visibleRowsWithVisualIndex">` 还包着 `anchoredInsertRowsAt(originalIndex)` 的插入行，保持那层结构不动，只把里面的数据 `<tr>` 换成组件；因此外层 `v-for` 改为遍历 `dataRowModels`（每个 `model` 同样带 `originalIndex`/`rowKey`/`visualIndex`），组件本身不再写 `v-for`：

```vue
<GridDataRow
  :key="model.rowKey"
  :tab-id="tab.id"
  v-bind="model"
  :columns="renderCellColumns"
  :frozen-column-count="frozenColumnCount"
  :has-active-cell-search="hasActiveCellSearch"
  :edit-draft="model.editingColumn ? editDraft : ''"
  :display-text="displayText"
  :highlight-html="highlightHtml"
  :is-search-match="isSearchMatch"
  :is-last-frozen-column="isLastFrozenColumn"
  @row-select-start="onRowSelectStart"
  @toggle-row-select="(...args) => emit('toggle-row-select', ...args)"
  @row-contextmenu="(...args) => emit('row-contextmenu', ...args)"
  @row-resize-start="startRowResize($event, 'data')"
  @row-resize-reset="resetRowHeight('data')"
  @edit-input="emit('edit-input', $event)"
  @cell-blur="emit('cell-blur')"
  @finish-edit="emit('finish-edit')"
  @cancel-edit="emit('cancel-edit')"
  @tab-edit="emit('tab-edit', $event)"
/>
```

`:edit-draft` 只在正在编辑的行传真实值，其它行恒为 `""`，这样打字时只有编辑行重渲染。

冻结行带（`1376-1460`）同样改用 `GridDataRow`，额外传 `frozen-row-style`、`frozen-row-class`、`is-last-frozen-row`。

- [ ] **Step 5：列高亮改为一条动态 CSS 规则**

删除模板里所有 `'col-active': isActiveColumn(...)`（`th` 上的可以保留：表头只有一行）。在 `DataGrid.vue` 增加：

```js
const gridInstanceId = `wb-grid-${Math.random().toString(36).slice(2, 8)}`;
let activeColumnStyleEl = null;
function ensureActiveColumnStyle() {
  if (activeColumnStyleEl || typeof document === "undefined") return activeColumnStyleEl;
  activeColumnStyleEl = document.createElement("style");
  activeColumnStyleEl.setAttribute("data-wb-active-column", gridInstanceId);
  document.head.appendChild(activeColumnStyleEl);
  return activeColumnStyleEl;
}
watch(
  () => [props.tab?.id, activeCell.value?.column || ""],
  ([, column]) => {
    const el = ensureActiveColumnStyle();
    if (!el) return;
    const index = renderColumns.value.find((meta) => meta.name === column)?.columnIndex;
    el.textContent = index == null ? "" : `
.wb-grid[data-grid-id="${gridInstanceId}"] .wb-grid-row td[data-column-index="${index}"]:not(.selected):not(.error):not(.row-selected) {
  background: color-mix(in srgb, var(--wb-cell-highlight) 18%, var(--wb-grid-row));
}
.wb-grid[data-grid-id="${gridInstanceId}"] .wb-grid-row.row-even td[data-column-index="${index}"]:not(.selected):not(.error):not(.row-selected) {
  background: color-mix(in srgb, var(--wb-cell-highlight) 18%, var(--wb-grid-row-alt));
}`;
  },
  { immediate: true, flush: "post" },
);
onBeforeUnmount(() => { activeColumnStyleEl?.remove(); activeColumnStyleEl = null; });
```

给 `<table class="wb-grid">` 加 `:data-grid-id="gridInstanceId"`。`workbench.css:12973-12979` 两条 `td.col-active` 规则删除（声明已搬入上面的模板字符串，令牌不变）；`th.col-active` 规则保留。

- [ ] **Step 6：更新静态测试并全量验证**

```powershell
node --test src/workbench/workbenchShell.test.js src/workbench/gridEditingAccessibility.test.js src/workbench/workbenchCssPolish.test.js
node scripts/test-workbench.mjs
```

对失败的正则断言：凡是断言 `DataGrid.vue` 中某段模板文本的，把目标文件换成 `GridDataRow.vue` 或改成新表达式；断言 `td.col-active` CSS 存在的改为断言动态规则字符串。

- [ ] **Step 7：手工冒烟（`npm run dev`，`?perfProfile=deterministic-v1&scenario=schema-800x60`）**

逐项确认：点击选中、方向键、Shift+方向键框选（框选只覆盖部分列时，未选中列的 `aria-selected` 必须为 false）、拖拽框选、Ctrl+点击的离散选择（`range-discrete`）、填充柄拖拽预览、双击编辑、Enter 提交后 `pending` 高亮出现再消失、故意输错触发 `error` 红标与 title、行头点击整行选中、右键菜单、冻结首行/首列、列宽拖拽、搜索高亮 `<mark>`。

- [ ] **Step 7b：用实际重渲染行数验证"只重绘变化行"**

组件拆分只是手段，必须验证结果。在 `GridDataRow.vue` 加一个仅开发构建生效的计数器：

```js
import { onUpdated } from "vue";
if (import.meta.env.DEV) {
  onUpdated(() => { globalThis.__wbRowUpdates = (globalThis.__wbRowUpdates || 0) + 1; });
}
```

`npm run dev` 打开 60 列表，在控制台：

```js
__wbRowUpdates = 0; /* 按一次方向键 */ await new Promise(r => setTimeout(r, 200)); __wbRowUpdates
```

期望：上下方向键 ≤ 2（离开的行 + 进入的行），左右方向键 ≤ 1（列高亮由 CSS 规则承担，不应触发行重渲染），编辑框里每敲一个字 ≤ 1，Enter 提交 ≤ 3。若数字等于可见行数（≈ 62），说明有某个 prop 每次都在变（最常见：模板里写了箭头函数、传了整块对象、`rangeClassesByColumn` 没走缓存），必须找出来修掉再进入 Step 8。

- [ ] **Step 8：测量并提交**

`node scripts/perf/grid-interaction.mjs --base … --scenario schema-800x60 --label task1`。预期：arrow `blockingMs` p50 从 ~150 ms 降到 ≤ 30 ms（此时每次方向键仍有 2 次渲染与强制布局，Task 3/4 继续降）。

建议拆成三次提交便于二分：① 仅抽出 `GridDataRow.vue`、props 先按原表达式逐格计算（行为不变）；② 接入每行派生状态与 `collectCellStatesForTable`；③ 列高亮改动态 CSS 规则。

`git commit -m "perf(grid): render data rows as memoizable components with per-row derived state"`

---

## Task 2：tbody 事件委托

每个 `<td>` 目前挂 5 个内联事件，60 列 × 62 行 = 18 910 个监听器闭包，打开/切换表时全部创建、Vue 对每个格子 patchEvent。改为 `<tbody>` 一组监听器，用 `data-*` 反查目标格子。

**Files:**
- Modify: `src/workbench/components/GridDataRow.vue`（删除 `<td>` 上的 5 个鼠标事件，给 `<td>` 加 `:data-original-index="originalIndex"`）
- Modify: `src/workbench/components/DataGrid.vue`（`<tbody>` 监听 + 解析函数；参考现有 `onCellRangeStart` 约 `845` 行、`endRangeSelection` `752` 行）

- [ ] **Step 1：解析函数**

先在 `DataGrid.vue` 明确两个概念，后面 Task 7 会依赖这个区分：

```js
// 逻辑列表：全部列，下标 === columnMeta.columnIndex === td 上的 data-column-index。
// Task 7 之后"实际渲染的列"会变成它的子集，任何按 data-column-index 反查列的地方都必须用这个，不能用 renderColumns。
const allColumnMeta = computed(() => (
  Array.isArray(props.activeColumnMeta) && props.activeColumnMeta.length
    ? props.activeColumnMeta
    : (props.activeColumns || []).map((column, columnIndex) => ({
      column, columnIndex, name: columnName(column),
      comment: column?.column_comment || column?.columnComment || "",
      isNumeric: isNumericColumnType(column?.column_type ?? column?.columnType),
    }))
));
// 现有 renderColumns 改为引用它（Task 7 再改成"渲染列"）：
const renderColumns = computed(() => allColumnMeta.value);
```

```js
function resolveDataCellTarget(event) {
  const target = event.target;
  if (!target?.closest) return null;
  if (target.closest("input, textarea, button, .wb-row-index, tr.wb-insert-row")) return null; // 插入行/行头/编辑框走各自原有路径
  const td = target.closest("td[data-column-index]");
  if (!td || !gridWrapRef.value?.contains(td)) return null;
  const columnIndex = Number(td.dataset.columnIndex);
  const columnMeta = allColumnMeta.value[columnIndex];   // 逻辑列号 → 逻辑列表，不能用 renderColumns
  const row = tabRowAt(props.tab, Number(td.dataset.originalIndex));
  if (!columnMeta || !row) return null;
  return { td, row, columnMeta, visualIndex: Number(td.dataset.visualRowIndex), rowKey: td.dataset.rowKey || "" };
}

let lastHoveredCell = null;
function onTbodyMouseDown(event) {
  if (event.button !== 0) return;
  const hit = resolveDataCellTarget(event);
  if (hit) onCellRangeStart(props.tab, hit.row, hit.columnMeta.name, hit.visualIndex, hit.columnMeta.columnIndex, event);
}
function onTbodyMouseOver(event) {   // mouseenter 不冒泡，用 mouseover 并按 td 去重
  const hit = resolveDataCellTarget(event);
  if (!hit || hit.td === lastHoveredCell) return;
  lastHoveredCell = hit.td;
  emit("cell-enter", props.tab, hit.row, hit.columnMeta.name, hit.visualIndex, hit.columnMeta.columnIndex);
}
function onTbodyClick(event) {
  const hit = resolveDataCellTarget(event);
  if (hit) emit("cell-click", props.tab, hit.row, hit.columnMeta.name, hit.visualIndex, hit.columnMeta.columnIndex);
}
function onTbodyDblClick(event) {
  const hit = resolveDataCellTarget(event);
  if (hit) emit("cell-dblclick", props.tab, hit.row, hit.columnMeta.name, hit.visualIndex, hit.columnMeta.columnIndex);
}
function onTbodyMouseLeave() {
  lastHoveredCell = null;   // 鼠标离开表格再回到同一格时必须重新触发 cell-enter；tab 切换时也在 watch(props.tab?.id) 里清一次
}
```

`<tbody @mousedown="onTbodyMouseDown" @mouseover="onTbodyMouseOver" @mouseleave="onTbodyMouseLeave" @mouseup="endRangeSelection" @click="onTbodyClick" @dblclick="onTbodyDblClick">`。冻结行带如果在独立 `<tbody>`/`<thead>` 里，同样挂一份。

- [ ] **Step 2：验证** — 与 Task 1 Step 7 相同的手工清单，重点：拖拽框选（依赖 `cell-enter`；包括鼠标拖出表格再拖回同一格）、双击编辑、右键、编辑框内点击不触发选区、插入行的点击/双击仍走原有内联处理。`node scripts/test-workbench.mjs`。

- [ ] **Step 3：测量提交** — `--label task2`，预期切换标签与打开表长任务各减 20–30%。`git commit -m "perf(grid): delegate cell pointer events to tbody"`

---

## Task 3：合并一次动作里的多次渲染

现状（已实测）：一次方向键 = 网格渲染 2 次；一次提交 = 网格渲染 4 次 + 行键索引整表重建 2 次 + `getBoundingClientRect` ≥ 6 次。

**Files:**
- Modify: `src/workbench/rowStore.js`（`DenseRowStore`：`117-129` `mutateRow`，`141-144` `_notify`，`156-172` `bindTabToStore`，`60-86` 页替换/追加）
- Modify: `src/workbench/utils/rowIndex.js:49-67`（`currentIndex` 的失效条件）
- Modify: `src/workbench/composables/useVirtualGrid.js:153-167`（`visibleRows` 输出 `rowVersion`）、`292-302`（`scrollCellIntoView`）、`217-239`（`visibleViewportHeight`）
- 核对但不改：`src/workbench/composables/useGridEditor.js` 的 6 处 `mutateTabRow` 调用（`2845`、`2879`、`2928`、`3136`、`3204`、`3267`）、`src/workbench/composables/useUndo.js` 的 3 处（`252`、`297`、`360`）、`src/workbench/utils/committedCellSync.js:24`，以及 `workspaceState.js` 的 `invalidateTabRows` 调用（`754`、`1200`、`1238`、`1273`）。**行身份是否变化由 `rowStore` 自己判断，这些调用点一行都不用改**——这正是为了覆盖乐观写入、后端确认、保存失败恢复、批量粘贴、撤销/重做、兄弟标签同步等全部路径，也自然覆盖无主键表（其行身份是全部列，见 `utils/rowIdentity.js:4-14`）。
- Test: `src/workbench/rowStore.test.js`、`src/workbench/rowIndex.test.js`（如无则新建）、`src/workbench/useVirtualGrid.test.js`

- [ ] **Step 1：行级版本号 + 行身份变化在 store 内集中判断（先写测试）**

设计：`mutateRow` 自己比较改动前后的键值，得到 `changedKeys`，通知订阅者时一并带出；订阅者（`bindTabToStore`，它知道 tab）用 `buildRowIdentity` 的同一套规则（有主键用主键列，没有主键用全部列）判断这次改动是否触及行身份，触及则递增 `store.identityGeneration` 并同步到所有 owner 的 `rowKeyCacheVersion`。任何调用方都不需要、也不允许再传"是否影响身份"的标志。

```js
// rowStore.test.js 追加
import { columnName } from "./utils/normalize.js";

test("mutateRow 只在值变化时递增行版本，并报告变化的键", () => {
  const store = new DenseRowStore([{ id: "1", name: "a" }, { id: "2", name: "b" }]);
  const seen = [];
  store.subscribe((generation, _store, detail) => seen.push(detail));
  const gen0 = store.generation;
  store.mutateRow(0, (row) => { row.name = "a"; return row; });          // 无变化：不通知
  assert.equal(store.generation, gen0);
  assert.equal(seen.length, 0);
  store.mutateRow(0, (row) => { row.name = "c"; return row; });          // 有变化
  assert.equal(store.generation, gen0 + 1);
  assert.equal(store.rowVersion(0), 1);
  assert.equal(store.rowVersion(1), 0);
  assert.deepEqual(seen.at(-1), { kind: "row", absoluteIndex: 0, changedKeys: ["name"] });
  store.replacePage([{ id: "5" }]);
  assert.equal(store.rowVersion(0), 0);
  assert.deepEqual(seen.at(-1), { kind: "structure" });
});

test("有主键表：改非主键列不刷新行键缓存版本，改主键列才刷新", () => {
  const tab = { id: "t", primaryKeys: ["id"], columns: [{ column_name: "id" }, { column_name: "name" }], rows: [{ id: "1", name: "a" }] };
  ensureTabRowStore(tab);
  const version0 = tab.rowKeyCacheVersion;
  mutateTabRow(tab, 0, (row) => { row.name = "b"; return row; });
  assert.equal(tab.rowKeyCacheVersion, version0);
  assert.notEqual(tab.dataVersion, undefined);
  mutateTabRow(tab, 0, (row) => { row.id = "2"; return row; });
  assert.notEqual(tab.rowKeyCacheVersion, version0);
});

test("无主键表：任何列变化都刷新行键缓存版本", () => {
  const tab = { id: "t", primaryKeys: [], columns: [{ column_name: "a" }, { column_name: "b" }], rows: [{ a: "1", b: "x" }] };
  ensureTabRowStore(tab);
  const version0 = tab.rowKeyCacheVersion;
  mutateTabRow(tab, 0, (row) => { row.b = "y"; return row; });
  assert.notEqual(tab.rowKeyCacheVersion, version0);
});

test("同一 store 的多个 owner tab 同步收到身份版本变化", () => {
  const tabA = { id: "a", primaryKeys: ["id"], columns: [{ column_name: "id" }, { column_name: "v" }], rows: [{ id: "1", v: "x" }] };
  const store = ensureTabRowStore(tabA);
  const tabB = { id: "b", primaryKeys: ["id"], columns: tabA.columns, rowStore: store };
  ensureTabRowStore(tabB);
  mutateTabRow(tabA, 0, (row) => { row.id = "9"; return row; });
  assert.equal(tabA.rowKeyCacheVersion, tabB.rowKeyCacheVersion);
});
```

实现要点（`rowStore.js`）：

```js
import { columnName } from "./utils/normalize.js";

function identityKeysOf(tab) {                        // 与 utils/rowIdentity.js buildRowIdentity 的规则保持一致
  const primaryKeys = Array.isArray(tab?.primaryKeys) ? tab.primaryKeys.filter(Boolean) : [];
  if (primaryKeys.length) return primaryKeys;
  return (Array.isArray(tab?.columns) ? tab.columns : []).map(columnName).filter(Boolean);
}

// DenseRowStore
constructor(...) { /* 现有字段之后 */ this._rowVersions = new Map(); this.identityGeneration = 0; }

rowVersion(absoluteIndex) {
  const loadedIndex = nonNegativeInteger(absoluteIndex) - this._absoluteStart;
  return this._rowVersions.get(loadedIndex) || 0;
}

mutateRow(absoluteIndex, mutation) {
  const normalizedIndex = absoluteInteger(absoluteIndex);
  if (normalizedIndex == null) return false;
  const loadedIndex = normalizedIndex - this._absoluteStart;
  if (loadedIndex < 0 || loadedIndex >= this._rows.length || typeof mutation !== "function") return false;
  const current = this._rows[loadedIndex];
  const snapshot = { ...current };                       // 行是扁平的字符串/null 值对象，浅拷贝足够
  const next = mutation(current, normalizedIndex);
  const target = next === undefined ? current : next;
  if (next !== undefined && next !== current) this._rows[loadedIndex] = next;
  const keys = new Set([...Object.keys(snapshot), ...Object.keys(target)]);
  const changedKeys = [...keys].filter((key) => target[key] !== snapshot[key]);
  if (target === current && changedKeys.length === 0) return true;   // 什么都没变：不通知、不改版本
  this._rowVersions.set(loadedIndex, (this._rowVersions.get(loadedIndex) || 0) + 1);
  this._notify({ kind: "row", absoluteIndex: normalizedIndex, changedKeys });
  return true;
}

_notify(detail = { kind: "structure" }) {
  this.generation += 1;
  if (detail.kind === "structure") this.identityGeneration += 1;
  for (const listener of this._listeners) listener(this.generation, this, detail);
}
```

`replacePage`（清空 `_rowVersions`）、`appendPage`、`prependPage`（把 `_rowVersions` 的键整体平移 `nextRows.length`）、`invalidate()` 都走默认的 `{ kind: "structure" }`，因此自动递增 `identityGeneration`（`workspaceState.js` 在主键列表变化时调用的 `invalidateTabRows` 由此覆盖）。

`bindTabToStore`（`156-172`）的订阅回调改为：

```js
store.subscribe((nextGeneration, _store, detail) => {
  if (detail?.kind === "row") {
    const touchesIdentity = [...owners].some((owner) => {
      const identityKeys = identityKeysOf(owner);
      return detail.changedKeys.some((key) => identityKeys.includes(key));
    });
    if (touchesIdentity) store.identityGeneration += 1;
  }
  for (const owner of [...owners].reverse()) {
    owner.dataVersion = nextGeneration;
    owner.rowKeyCacheVersion = store.identityGeneration;
  }
});
```

末尾初始化改为 `tab.dataVersion = store.generation; tab.rowKeyCacheVersion = store.identityGeneration;`。`mutateTabRow(tab, absoluteIndex, mutation)` 签名不变。

- [ ] **Step 2：行键索引只在身份代次变化时重建**

`rowIndex.js:57` 的 `cached.generation === Number(tab?.dataVersion ?? store.generation)` 改为 `cached.generation === Number(tab?.rowKeyCacheVersion ?? store.identityGeneration)`，`buildIndex` 记录的 `generation` 同步改成 `store.identityGeneration`。`rowIndex.js` 现有的 `identityShape`/`loadedLength`/`absoluteStart` 比较保留。补测试（`rowIndex.test.js`）：① 有主键表改非主键列后 `createRowIndex(tab).indexOfKey(...)` 不重建（用计数 `buildRowKey` 调用次数验证）；② 改主键列后重建且能用新键找到该行；③ 无主键表改任意列后重建。

- [ ] **Step 3：`visibleRows` 带出 `rowVersion`，并让 `GridDataRow` 接收**

`useVirtualGrid.js:162-166` 的 map 返回 `{ row, originalIndex, rowKey, rowVersion: store.rowVersion(absoluteIndex) }`；`DataGrid.vue` 的 `dataRowModels` 已透传 `rowVersion`（Task 1 预留）。这样乐观写入只让被改的那一行重渲染。

- [ ] **Step 4：核对 10 处 `mutateTabRow` 调用与两处确认回写**

不改签名、不加参数。逐个打开上面列出的 10 处调用，确认：① 回调都是"就地改字段并 `return row`"或"返回同一对象"，没有返回全新对象却期望旧引用继续有效的情况；② `useGridEditor.js:2879-2883` 与 `2928` 附近的确认/回滚写入，在值与当前值相同时因 Step 1 的"无变化不通知"不再触发第二次渲染——这是预期；③ `committedCellSync.js:24` 在值不匹配时 `return row` 不改动，也不会触发通知。手工回归：编辑主键列后方向键能正确落到同一行；Ctrl+Z / Ctrl+Y；分屏两个标签打开同一张表，在一边改一格另一边同步；保存失败（断开模拟后端或输入非法值）后单元格恢复旧值且能继续选中。

`2573-2601` `applySelectedPosition` 里对 `scrollCellIntoView` 的调用保持不变，改动在 Step 5。

- [ ] **Step 5：滚动定位只测一次**

`useVirtualGrid.js:292-302` 改为：

```js
function scrollCellIntoView(rowIndex, columnIndex) {
  // 行方向纯算术，不需要测量；列方向需要读格子几何，放到 DOM 更新之后只做一次。
  scrollRowIntoView(rowIndex);
  nextTick(() => scrollColumnIntoView(columnIndex));
}
```

`visibleViewportHeight`（`217-239`）里对 `.wb-cell-detail` 的 `getBoundingClientRect` 改为每帧最多测一次：

```js
let detailOverlapCache = { frame: -1, value: null };
function cellDetailRect(wrap) {
  const frame = typeof performance !== "undefined" ? Math.floor(performance.now() / 8) : 0;
  if (detailOverlapCache.frame !== frame) {
    detailOverlapCache = { frame, value: wrap?.closest?.(".wb-workbench-pane")?.querySelector?.(".wb-cell-detail")?.getBoundingClientRect?.() || null };
  }
  return detailOverlapCache.value;
}
```

跑 `node --test src/workbench/useVirtualGrid.test.js`，若有断言"rAF 后再次滚动"的测试，按新行为更新。

- [ ] **Step 5b：`virtualRange` 结果不变时返回同一对象**

`useVirtualGrid.js:108-151` 的 `virtualRange` 现在每次滚动都返回新对象，即便 `start/end/padTop/totalHeight` 全部没变，下游 `visibleRows` 与整个网格也会跟着重算。Vue 3.4+ 的 computed 只在返回值变化时才通知依赖方，所以只要复用上一次的对象即可：

```js
let lastVirtualRange = { start: 0, end: 0, padTop: 0, totalHeight: 0 };
const virtualRange = computed(() => {
  // …原有计算，得到 start / end / padTop / totalHeight…
  const next = { start, end, padTop, totalHeight };
  if (
    next.start === lastVirtualRange.start
    && next.end === lastVirtualRange.end
    && next.padTop === lastVirtualRange.padTop
    && next.totalHeight === lastVirtualRange.totalHeight
  ) return lastVirtualRange;
  lastVirtualRange = next;
  return next;
});
```

（提前返回 `{ start: 0, end: 0, padTop: 0, totalHeight: 0 }` 的分支也要走同样的比较。）效果：在 10 行 buffer 内的滚动不再触发任何网格渲染。

- [ ] **Step 6：验证与测量**

`node scripts/test-workbench.mjs`；手工：编辑主键列（应仍能正确重定位选中格）、Ctrl+Z 撤销、Ctrl+Y 重做、跳到末行再向上滚（`prependPage`）后编辑、鼠标滚轮连续滚动无卡顿。测量 `--label task3`，预期：提交 p50 ≤ 60 ms，方向键 ≤ 20 ms。

`git commit -m "perf(grid): per-row versions, identity-scoped row index, single scroll measurement"`

---

## Task 4：打开/切换表首帧

**Files:**
- Modify: `src/workbench/components/WorkbenchTabs.vue:286`（`<TransitionGroup name="wb-tab-reorder" …>`）
- Modify: `src/workbench/composables/useVirtualGrid.js:108-151`（`virtualRange` 的 buffer）
- Modify: `src/workbench/components/DataGrid.vue:976-996`（自适应列宽触发时机）与 `src/workbench/composables/useColumnResize.js:186-231`
- Test: `src/workbench/workbenchShell.test.js:184`、`src/workbench/homepageInteraction.test.js:256`（断言 `<TransitionGroup`，需更新）

- [ ] **Step 1：标签栏不再使用 `TransitionGroup`**

Vue 的 `TransitionGroup` 每次渲染都对每个子元素 `getBoundingClientRect()`、更新后再 `forceReflow`。打开/切换表时标签栏必然重渲染，于是带着几千个格子的页面被强制布局多次（profile 中 ≈ 120 ms）。

**不要**用"拖拽时 `TransitionGroup`、平时 `div`"的 `<component :is>` 切换：`div` 与 `TransitionGroup` 是不同的 vnode 类型，切换会让 Vue 卸载重建整棵标签列表，而 HTML5 拖拽的源节点一旦被替换，拖拽手势会被中断（两位评审都指出了这一点）。方案改为：

```vue
<div class="wb-tab-list" data-tauri-drag-region>
  <div v-for="tab in previewTabs" :key="tab.id" class="wb-tab" …原有属性不变…>
```

即直接用普通容器，放弃拖拽重排时的位移动画（`previewTabs` 已经在拖拽过程中实时重排 DOM 顺序，用户看到的是"即时跳位"而不是"滑动"）。`workbench.css` 里 `.wb-tab-reorder-move` 相关规则删除；`workbenchShell.test.js:184`、`homepageInteraction.test.js:256-258` 断言 `<TransitionGroup` 与 move 过渡的正则改为断言 `<div class="wb-tab-list"`。这是产品可感知的变化，见 §8 第 3 条的决策记录。

如果产品坚持保留滑动动画，替代方案是手写 FLIP：在 `dragover` 重排前用 `getBoundingClientRect` 记录各标签位置，重排后一帧内加 `transform` 过渡——这样测量只发生在拖拽过程中，而不是每次标签栏渲染。工作量约 40 行，本计划不展开。

- [ ] **Step 2：切表首帧零 buffer，空闲后恢复（需实测决定保留与否）**

`useVirtualGrid.js` 新增 `const bufferRows = ref(VIRTUAL_BUFFER)`；`virtualRange` 中 `VIRTUAL_BUFFER` 改读 `bufferRows.value`。增加：

```js
let restoreBufferHandle = 0;
watch(() => activeTab.value?.id, () => {
  bufferRows.value = 0;
  if (restoreBufferHandle) (globalThis.cancelIdleCallback || clearTimeout)(restoreBufferHandle);
  const restore = () => { restoreBufferHandle = 0; bufferRows.value = VIRTUAL_BUFFER; };
  // 等主线程空闲再补 buffer；最迟 120 ms 内一定补上，避免用户马上滚动时没有预渲染行
  restoreBufferHandle = typeof requestIdleCallback === "function"
    ? requestIdleCallback(restore, { timeout: 120 })
    : setTimeout(restore, 50);
});
```

首帧从 62 行降到 ~42 行（-30% 格子）。这一步的假设——"补齐 buffer 的工作不会撞上用户紧接着的操作"——**没有验证过**：用 Task 0 的 `settledMs` 与切换后立刻按方向键的 `blockingMs`（把脚本里切换标签与方向键两段连起来跑一遍即可）对比开/关这一步，若切换 `paintMs` 的收益小于紧接操作的损失，就撤掉这一步。

- [ ] **Step 3：自适应列宽在首帧前完成**

现在 `DataGrid.vue:979-996` 在 `nextTick` 后 `performAutoFit` → 改宽度 → 第二次整网格渲染 + 版面位移。改为：当 tab 还没有任何列宽（`ensureColumnWidthState(tab).widths` 为空）时，在渲染前同步算一次。**监听依赖必须保留 `props.tab?.loading`**（原监听就有）：排序/筛选/刷新会先把 `loading` 置 true 再回填数据，此时 tab id 与列数都不变，只有 `loading` 翻转能再次触发自适应。

```js
watch(
  () => [props.tab?.id, props.activeColumns.length, props.tab?.loading],
  ([tabId, colCount, loading]) => {
    if (!tabId || !colCount || loading) return;             // loading 从 true 变 false 时会再进来一次
    const state = ensureColumnWidthState(props.tab);
    if (state && Object.keys(state.widths).length === 0 && gridWrapRef.value) {
      autoFitColumns(gridWrapRef.value, props.tab, props.activeColumns, tabRows(props.tab)); // 首次：同步、无 rAF，首帧就是最终列宽
    } else {
      nextTick(() => performAutoFit());                       // 之后：维持原行为（刷新/排序后重算）
    }
  },
  { flush: "pre", immediate: true },
);
```

`autoFitColumns` 需从 `useColumnResize()` 解构导出（已存在）；`ensureColumnWidthState` 从 `useColumnResize.js` 导入。`gridTextMeasurers` 在切表瞬间取到的是旧表的 `.wb-cell-text` 字体——字体全表一致，可接受。原来 `986-996` 那个只监听 `props.tab?.id` 的重复自适应监听删掉（`closeToolbarMenu()` 与 `setupResizeObserver()` 保留）。

- [ ] **Step 4：验证与测量**

`node scripts/test-workbench.mjs`；手工：拖拽重排标签仍能正常完成（无动画）、拖拽中途按 Esc/松开都不残留状态、打开表列宽一次到位不跳动、点列头排序后列宽仍会重算、筛选后列宽重算、冻结列与列宽正确、切换标签后立刻滚动/按方向键无卡顿。测量 `--label task4`，预期切换 `paintMs` ≤ 50 ms，打开表 `paintMs` ≤ 400 ms。

`git commit -m "perf(grid): cheaper first frame on open/switch (no forced tab-bar layout, zero-buffer first frame, autofit before paint)"`

---

## Task 5：后端——默认排序走索引、连接池参数、LIMIT/OFFSET 参数化

**已决定（2026-09-19）：采用方案 A。** 背景：现在文本主键（varchar 等）表的默认顺序是"自然排序"（`item_2` 排在 `item_10` 前），代价是 MySQL 无法用主键索引，**每一页、每次 1000 行缓冲填充、每个 128 行的全表搜索批次都要全表扫描 + filesort**，耗时随表行数线性增长（10 万行约 0.1–0.5 s/页，百万行数秒/页）。方案 A：默认按主键索引顺序（与 Navicat 一致，`item_10` 会排在 `item_2` 前），用户点击列头排序时仍用自然排序（用户主动选择，接受代价）。

**Files:**
- Modify: `src-tauri/src/db.rs:1142-1153`（`default_primary_key_order_sql`）、`586-597`（`connect_database`）、`1367-1383`（页 SQL 与绑定）、`1197-1204`（搜索扫描 SQL）及其调用方 `read_db_search_scan_page_with_perf`（`1207` 起）、`656-695`（单表 `read_schema`）、`961-1034`（批量 `read_schemas_for_tables`，读主键索引列序）
- Modify: `src-tauri/src/types.rs`（`TableMeta` 增加 `primary_key_order`）
- Test: `src-tauri/src/db.rs:1644-1660`（`table_search_scan_sql_uses_natural_order_for_text_primary_keys` 需反转预期）、其它断言默认页 SQL 含 `LOCATE` 的测试、`src-tauri/tests/schema_batch.rs`（批量元数据测试，补主键列序断言）

先读：`db.rs:1111-1206`、`1334-1400`、`586-612`、`656-695`、`961-1063`、`1590-1665`（测试）；`types.rs` 中 `TableMeta` 定义（`rg "pub struct TableMeta" src-tauri/src/types.rs`）。**不要**读 `commands.rs` 全文。

- [ ] **Step 1：默认主键顺序改为普通列顺序**

```rust
fn default_primary_key_order_sql(table: &TableMeta) -> String {
    // 默认分页必须能走主键索引：文本主键不再套自然排序表达式（那会让每页全表 filesort）。
    // 用户显式点列排序时仍走 requested_sort_order_sql 的自然排序。
    let terms = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| {
            format!(
                "`{}`.`{}` ASC",
                escape_ident(&table.table_name),
                escape_ident(&column.column_name)
            )
        })
        .collect::<Vec<_>>();
    if terms.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", terms.join(", "))
    }
}
```

`search_scan_order_sql`（`1163`）沿用该函数，无需改。把 `1644` 行测试改名为 `table_search_scan_sql_uses_index_order_for_text_primary_keys` 并断言 SQL 含 `` ORDER BY `activecondprop`.`CondID` ASC, `activecondprop`.`Idx` ASC `` 且不含 `LOCATE`。`cargo test` 找出其它受影响断言一起修正。

- [ ] **Step 1b：复合主键必须按索引里的列序排，而不是表定义的列序**

上面的函数按 `table.columns` 的顺序（`information_schema.COLUMNS.ORDINAL_POSITION`）拼接主键列。若表定义是 `(a, b)` 而主键是 `PRIMARY KEY (b, a)`，`ORDER BY a, b` 仍然走不了索引、照样 filesort。要用索引自己的列序（`information_schema.STATISTICS.SEQ_IN_INDEX`）。

1. `types.rs` 的 `TableMeta` 增加字段 `#[serde(default)] pub primary_key_order: Vec<String>`（前端会收到这个多出来的字段，忽略即可；`mockBackend.js` 不必改）。
2. `db.rs:961-1034` `read_schemas_for_tables` 增加第三条查询（Task 6 Step 3 会把三条并行）：

```rust
// 主键索引列序：ORDER BY 必须按它排才能走 PRIMARY 索引
let key_order_sql = format!(
    "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS \
     WHERE TABLE_SCHEMA = ? AND INDEX_NAME = 'PRIMARY' AND TABLE_NAME IN ({}) \
     ORDER BY TABLE_NAME, SEQ_IN_INDEX",
    placeholders(table_names.len()),   // 复用文件里现有的 IN(...) 占位符拼接方式
);
```

按 `TABLE_NAME`（小写比较，与现有 `comments` 的做法一致）把 `COLUMN_NAME` 依序收进对应 `TableMeta.primary_key_order`。单表路径 `read_schema`（`656-695`）同样补上。

3. `default_primary_key_order_sql` 改为优先用 `primary_key_order`：

```rust
fn default_primary_key_order_sql(table: &TableMeta) -> String {
    let ordered: Vec<&str> = if !table.primary_key_order.is_empty() {
        table.primary_key_order.iter().map(String::as_str).collect()
    } else {
        table.columns.iter().filter(|c| c.is_primary_key).map(|c| c.column_name.as_str()).collect()
    };
    let terms = ordered
        .iter()
        .map(|name| format!("`{}`.`{}` ASC", escape_ident(&table.table_name), escape_ident(name)))
        .collect::<Vec<_>>();
    if terms.is_empty() { String::new() } else { format!(" ORDER BY {}", terms.join(", ")) }
}
```

测试：给 `TableMeta` 构造 `columns = [a, b]`、`primary_key_order = ["b", "a"]`，断言 ORDER BY 是 `` `t`.`b` ASC, `t`.`a` ASC ``；`primary_key_order` 为空时退回列序。

- [ ] **Step 1c：收益边界要写清楚**

- 这一步把"每页全表扫描 + filesort"变成"按主键索引顺序读"，**前若干页**和 1000 行缓冲填充受益最大；`LIMIT n OFFSET m` 在深分页时仍要跳过 m 行索引项（m = 90 万时仍是 90 万次索引游标推进），这是 OFFSET 分页的固有成本，彻底解决要靠键集分页（老设计文档 Task 20），不在本计划范围。
- 用户可见变化：文本主键表默认顺序从自然顺序变成字典序（`item_10` 在 `item_2` 前），发版说明里要写一句，并提示"点列头可按自然顺序排序"。

- [ ] **Step 2：连接池保活**

```rust
MySqlPoolOptions::new()
    .max_connections(5)
    .min_connections(1)                                 // 保留一条热连接，"停 10 分钟再点"不再重新握手
    .idle_timeout(Some(Duration::from_secs(300)))
    .acquire_timeout(MYSQL_POOL_ACQUIRE_TIMEOUT)
    .connect_with(options)
```

`test_before_acquire` 保持默认 `true`（局域网一次 ping ≈ 0.3 ms，不值得为省它引入断连重试）。

- [ ] **Step 3：`LIMIT/OFFSET` 改为绑定参数，让预处理语句缓存命中**

`db.rs:1367-1374`：

```rust
let sql = format!(
    "SELECT {} FROM {}{}{} LIMIT ? OFFSET ?",
    select_columns, table_ref, where_sql, order_sql
);
let mut query = sqlx::query(&sql);
for bind in &binds {
    query = query.bind(bind);
}
query = query.bind(page_size as u64).bind(offset as u64);
```

（`page_size`/`offset` 的具体整数类型看 `normalize_page_request`/`normalize_page_offset` 的返回值，统一转成 `u64` 绑定即可；MySQL 预处理语句允许 `LIMIT ?/OFFSET ?` 用整数参数。）

`build_search_scan_sql`（`1197`）同样改为 `LIMIT ? OFFSET ?`，并在调用处追加两个整数绑定（注意 `limit.clamp(1, 512)` 的语义要搬到绑定值上）。`cargo test` 中断言 SQL 文本含 `LIMIT 100` 之类的测试改为断言 `LIMIT ? OFFSET ?`。

- [ ] **Step 4：验证**

```powershell
cd src-tauri; cargo check; cargo test
```

**必须用真实 MySQL 验证执行计划**（SQL 文本里没有 `LOCATE` 不等于走了索引）。`$env:DBSCOUT_MYSQL_URL="mysql://…"; npm run tauri -- dev`，打开一张 varchar 主键、≥ 5 万行的表，再在 MySQL 客户端对应用实际发出的页 SQL（从 `SHOW FULL PROCESSLIST`/general log 里抄）跑 `EXPLAIN`：

| 场景 | 期望 |
|---|---|
| 单列 varchar 主键，第 1 页 | `type` 为 `index`，`key` 为 `PRIMARY`，`Extra` **不含** `Using filesort` |
| 复合主键 `(b, a)`，第 1 页 | 同上，且 `ORDER BY` 列序与 `SHOW INDEX` 的 `Seq_in_index` 一致 |
| 同一张表 `OFFSET 900000` | 仍走 `PRIMARY`，耗时线性增长（记录数值，作为键集分页的立项依据） |
| 用户点列头排序（自然排序路径） | 允许 `Using filesort`——这是用户主动选择 |
| 全表搜索批次（`build_search_scan_sql`） | 与第 1 页同样不含 `Using filesort` |

把 `EXPLAIN` 输出贴进提交说明。同时观察状态栏首帧时间与滚动加载。

`git commit -m "perf(mysql): index-friendly default page order (PK index column order), warm pool, bound LIMIT/OFFSET"`

---

## Task 6：后端——单格保存与冷打开的固定开销

**Step 1 是安全策略变更，不是普通性能优化——决策已重新打开，见 §8 第 2 条；未重新确认前只做 Step 2–4。**

背景与准确的风险描述：审计库（SQLite，WAL 模式）目前 `synchronous` 为默认 FULL，每次单格保存 = 2 个 SQLite 事务 = 2 次磁盘 fsync（SSD 上合计约 10–40 ms，机械盘更多）。若改为 `synchronous=NORMAL`：应用进程崩溃不会丢已提交事务；但**操作系统崩溃或断电时，自上一次 WAL 检查点以来所有已提交的审计事务都可能丢失**（SQLite 文档原文："A transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system crash"；WAL 只在检查点时同步，默认自动检查点约每 1000 页一次，期间可能累计几十到几百次保存）。之前计划里写的"最后一两条"是错误的。后果是：MySQL 里的修改已经生效，本机的追踪与回滚记录却没有——这与项目"正确性和数据安全不可让步"的原则直接相关，且正常保存/查看历史/回滚的测试都验证不了断电持久性。

可选方案（按安全性从高到低）：

| 方案 | 每次保存 fsync | 断电后果 | 说明 |
|---|---|---|---|
| A. 保持 FULL（不做 Step 1） | 2 | 无丢失 | 只拿 Step 2–4 的收益 |
| B. `synchronous=FULL` 写 pending 行，`synchronous=NORMAL` 翻 committed 状态 | 1 | pending 行一定在；committed 标记可能丢 → 该行停留在 pending | 需要先确认 `audit.rs` 里 pending 行在启动时如何处理（`rg "pending" src-tauri/src/audit.rs`）。若已有"启动时把陈旧 pending 归为 commit_unknown 并在界面提示"的逻辑，B 是最好的折中；若没有，B 会让一条已生效的修改显示为未完成 |
| C. `synchronous=NORMAL` + 空闲 2 s 后 `PRAGMA wal_checkpoint(PASSIVE)` | 0（检查点时 1） | 丢失范围收窄到"最近 2 s 内的保存" | 检查点会 fsync；需要一个空闲定时器（写路径 `try_send` 信号即可复用 `audit_sync` 的 worker） |
| D. `synchronous=NORMAL`（原计划） | 0 | 上一检查点以来的全部审计记录 | 不建议 |

`PRAGMA synchronous` 是按连接设置、随时可改的语句（不落盘，只是一次到 SQLite 线程的往返），审计库池是单连接，所以方案 B 可以在 `record_pending` 前后各切一次；实现时把切换封装在 `audit.rs` 内部，不要散落在 `commands.rs`。

**Files:**
- Modify: `src-tauri/src/audit.rs:108-144`（连接初始化，按选定方案设置 PRAGMA）、`394-426`（`mark_status_required_batch` 单条走无事务路径）
- Modify: `src-tauri/src/db.rs:961-1034`（`read_schemas_for_tables` 的 information_schema 查询并行，含 Task 5 Step 1b 新增的主键列序查询）
- Modify: `src-tauri/src/commands.rs:3139-3170`（`open_table_session` 锁内 `demo_schema_for_runtime`）与 `2056-2073`（同类调用；两处只读这两段）

- [ ] **Step 1：审计库持久性策略（待 §8 第 2 条重新确认后执行）**

按确认的方案实现；方案 B 的形态：

```rust
// audit.rs — 只在这里切换，调用方不感知
async fn with_synchronous<T>(pool: &SqlitePool, level: &str, work: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    sqlx::query(&format!("PRAGMA synchronous={level}")).execute(pool).await.map_err(|e| format!("设置审计库 synchronous 失败: {e}"))?;
    let result = work.await;
    let _ = sqlx::query("PRAGMA synchronous=FULL").execute(pool).await;
    result
}
```

`record_pending`/`record_pending_batch` 保持 FULL；`mark_status_required*` 用 `with_synchronous(pool, "NORMAL", …)` 包起来。无论选哪个方案，都在提交说明里写明"审计库持久性策略变更"并链接到本节。

- [ ] **Step 2：单条状态更新不开事务**（`audit.rs:402`）

```rust
async fn mark_status_required_batch(pool: &SqlitePool, ids: &[i64], status: &str) -> Result<(), String> {
    if let [id] = ids {
        // 单条时省掉 BEGIN/COMMIT 两次到 SQLite 线程的往返；语义与事务版一致。
        return mark_status_required(pool, *id, status).await;
    }
    // …原有多条事务逻辑不变…
}
```

**不要**改动 `commands.rs:4084-4092` 里"先标 committed 再 COMMIT MySQL"的顺序——那是刻意的"审计优先"设计（宁可多一条可回滚的记录，不可少一条），反向 SQL 带旧值守卫，误标不会造成错误回滚。

- [ ] **Step 3：元数据查询并行**（`db.rs:975-998`；Task 5 Step 1b 加入的主键列序查询作为第三个 future 一起 `try_join!`）

```rust
let columns_future = async {
    query
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取字段信息失败: {error}"))
};
let comments_future = async {
    comment_query
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取表信息失败: {error}"))
};
let (rows, comment_rows) = tokio::try_join!(columns_future, comments_future)?;
```

需要把 `comment_sql`/`comment_query`（以及 Task 5 Step 1b 的 `key_order_sql`/查询）的构造提到 `rows` 查询之前；`tokio` 已启用 `macros` feature。三条查询并发会同时占用池里 3 条连接（池上限 5，`WorkScheduler` 每池前台许可也是 5，只计 1 个许可）；打开表时不会与前台取页冲突，但若日后把批量元数据预取并发度调高，要一起复核这个占用。

- [ ] **Step 4：锁内不再为 MySQL 连接克隆整库表元数据**

`commands.rs:3151-3157` 与 `2068` 附近：先确认后续代码只在 Demo 分支使用返回的 `schema`（搜索该变量在 `3170-3300` 之间的用法），然后：

```rust
let schema = if connection.mysql_url.is_some()
    || connection.clickhouse_url.is_some()
    || connection.mongodb_url.is_some()
{
    Vec::new()
} else {
    demo_schema_for_runtime(&rt.demo_schema_overrides, rt.demo_profile, &database, &rt.selected_database, &rt.schema)
};
```

- [ ] **Step 5：验证**

`cd src-tauri; cargo check; cargo test`；真实库上：改一格 → 状态栏"已保存"；备份中心 → 变更审计里能看到该记录并可回滚；`npm run tauri -- dev` 下用 `[dbscout:perf] invoke:update_cell` 日志对比改前后耗时。

`git commit -m "perf(backend): cheaper audit writes, parallel schema metadata reads, no metadata clone under runtime lock"`

---

## Task 7：横向列虚拟化（列窗口）

**前置：Task 1–4 已完成。** 原理：现在无论视口多宽都渲染全部列，60 列表每行 60 个 `<td>`；改为只渲染"视口内 + 左右各 240 px 过扫描 + 冻结列 + 选中列 + 正在编辑的列"，其余列用一个带精确宽度的占位格代替，表格总宽不变，滚动条几何不变。窄表（全部列都装得下）走完全相同的旧 DOM 结构。

设计约束（老设计文档 `docs/plans/2026-07-10-system-performance-optimization.md` Task 28 的结论，直接采用）：几何全部用列宽前缀和计算，不测 DOM；剪贴板/框选/自适应列宽只读数据模型，不读可能不存在的格子；表头行、字段备注行、插入行、数据行必须渲染**完全相同的列段结构**，因为 `useColumnResize.applyColumnWidth` 按 DOM 下标改宽度。

**Files:**
- Create: `src/workbench/composables/useVirtualColumns.js`
- Create: `src/workbench/useVirtualColumns.test.js`
- Modify: `src/workbench/composables/useVirtualGrid.js`（`70-77` 新增 `scrollLeft`/`viewportWidth`；`184-187` `onGridScroll`；`272-290` `scrollColumnIntoView` 改算术；`327-339` ResizeObserver 记录宽度；`return` 中导出新成员）
- Modify: `src/workbench/components/WorkbenchPane.vue:170`（接收新成员）、`231` 之后（用 `selectedCell`/`editingCell` 设置 pinned 列）、`1604-1620`（新 prop 传给 DataGrid）
- Modify: `src/workbench/components/DataGrid.vue`（`425-442` `renderColumns`/`renderCellColumns` 改为按列段；表头 `1273-1318`、字段备注行 `1348-1369`、插入行 `1518-1571`/`1725-1778`、所有 `:colspan="1 + activeColumns.length"`；`updateFillOverlayPosition`）
- Modify: `src/workbench/components/GridDataRow.vue`（`columns` prop 改为 `segments`，渲染占位格）
- Modify: `src/workbench/composables/useGridEditor.js:132`（第 5 个参数解构里加 `columnWindow = null`）、`1391-1412`（`columnIndexFromPointer` 改几何计算，区分冻结带）
- Modify: `src/workbench/components/WorkbenchPane.vue:236`（传给 `useGridEditor` 的对象字面量里加 `columnWindow`）
- Test: `src/workbench/useVirtualGrid.test.js`、`src/workbench/workbenchShell.test.js`

先读：`useVirtualGrid.js` 全文（370 行）、`useColumnResize.js:22-33,116-135,186-211`、`useFreezePanes.js:30-120`、`DataGrid.vue:425-453,1263-1372`、`GridDataRow.vue` 全文、`useGridEditor.js:1385-1420`。

- [ ] **Step 1：纯函数 + 测试（先红）**

`src/workbench/useVirtualColumns.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { computeColumnWindow } from "./composables/useVirtualColumns.js";

const widths = (count, width = 120) => Array.from({ length: count }, () => width);
const sum = (list) => list.reduce((total, value) => total + value, 0);
const renderedWidth = (window, allWidths) => sum(window.segments.map((segment) => (
  segment.kind === "spacer" ? segment.width : allWidths[segment.index]
)));

test("全部列装得下时不产生占位格，结构与旧实现一致", () => {
  const window = computeColumnWindow({ widths: widths(8), frozenCount: 0, scrollLeft: 0, viewportWidth: 1400, gutterWidth: 38 });
  assert.equal(window.allRendered, true);
  assert.deepEqual(window.renderedIndexes, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(window.segments.some((segment) => segment.kind === "spacer"), false);
});

test("视口内列 + 过扫描被渲染，其余折叠成右侧占位格，总宽守恒", () => {
  const all = widths(60);
  const window = computeColumnWindow({ widths: all, frozenCount: 0, scrollLeft: 0, viewportWidth: 1000, gutterWidth: 38, overscanPx: 240 });
  // 可见宽 1000-38=962px，右界 962+240=1202px；列左边缘 120*i < 1202 → i ≤ 10，共 11 列
  assert.deepEqual(window.renderedIndexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(window.segments.at(-1).kind, "spacer");
  assert.equal(window.segments.at(-1).width, 120 * 49);
  assert.equal(renderedWidth(window, all), sum(all));
});

test("滚到中间时左右各一个占位格；冻结列永远渲染且位于最前", () => {
  const all = widths(60);
  const window = computeColumnWindow({ widths: all, frozenCount: 2, scrollLeft: 3000, viewportWidth: 1000, gutterWidth: 38, overscanPx: 240 });
  assert.deepEqual(window.renderedIndexes.slice(0, 2), [0, 1]);
  assert.equal(window.segments[0].kind, "column");
  assert.equal(window.segments[1].kind, "column");
  assert.equal(window.segments[2].kind, "spacer");
  assert.equal(window.segments.at(-1).kind, "spacer");
  assert.equal(renderedWidth(window, all), sum(all));
  assert.equal(window.frozenWidth, 240);
  assert.equal(window.frozenCount, 2);
});

test("pinned 列在窗口外时作为独立列段插入，左右占位格自动拆分", () => {
  const all = widths(60);
  const window = computeColumnWindow({ widths: all, frozenCount: 0, scrollLeft: 0, viewportWidth: 1000, gutterWidth: 38, pinned: [45] });
  assert.ok(window.renderedIndexes.includes(45));
  const kinds = window.segments.map((segment) => segment.kind);
  assert.deepEqual(kinds.slice(-3), ["spacer", "column", "spacer"]);
  assert.equal(renderedWidth(window, all), sum(all));
  assert.deepEqual([...window.renderedIndexes].sort((a, b) => a - b), window.renderedIndexes);
});

test("offsets 是前缀和，可直接用于列几何计算", () => {
  const window = computeColumnWindow({ widths: [100, 50, 70], frozenCount: 0, scrollLeft: 0, viewportWidth: 500, gutterWidth: 38 });
  assert.deepEqual(window.offsets, [0, 100, 150, 220]);
});
```

`node --test src/workbench/useVirtualColumns.test.js` → 预期 FAIL（模块不存在）。

- [ ] **Step 2：实现 `useVirtualColumns.js`**

```js
import { MIN_COL_WIDTH, ROW_INDEX_WIDTH } from "../constants.js";
import { ensureColumnWidthState } from "./useColumnResize.js";

export const COLUMN_OVERSCAN_PX = 240;

/**
 * 按前缀和计算需要渲染的列。返回的 segments 按列序排列，占位格带精确宽度，
 * 使得 Σ(渲染列宽) + Σ(占位格宽) 恒等于全部列宽之和（滚动条几何不变）。
 * 坐标系：x = 0 为第一列左边缘（行号栏不计入）；冻结列与行号栏是 sticky 的，
 * 所以非冻结列的可见区间是 [scrollLeft + frozenWidth, scrollLeft + viewportWidth - gutterWidth]。
 */
export function computeColumnWindow({
  widths,
  frozenCount = 0,
  scrollLeft = 0,
  viewportWidth = 0,
  gutterWidth = ROW_INDEX_WIDTH,
  overscanPx = COLUMN_OVERSCAN_PX,
  pinned = [],
} = {}) {
  const total = Array.isArray(widths) ? widths.length : 0;
  const offsets = new Array(total + 1);
  offsets[0] = 0;
  for (let index = 0; index < total; index += 1) {
    const width = Number(widths[index]);
    offsets[index + 1] = offsets[index] + (Number.isFinite(width) && width > 0 ? width : MIN_COL_WIDTH);
  }
  const frozen = Math.max(0, Math.min(total, Math.floor(frozenCount) || 0));
  const frozenWidth = offsets[frozen];
  const rendered = new Set();
  for (let index = 0; index < frozen; index += 1) rendered.add(index);

  const visibleWidth = Math.max(0, viewportWidth - gutterWidth);
  const windowAll = viewportWidth <= 0 || offsets[total] <= visibleWidth;
  if (windowAll) {
    for (let index = frozen; index < total; index += 1) rendered.add(index);
  } else {
    const left = Math.max(0, scrollLeft) + frozenWidth - overscanPx;
    const right = Math.max(0, scrollLeft) + visibleWidth + overscanPx;
    for (let index = frozen; index < total; index += 1) {
      if (offsets[index + 1] > left && offsets[index] < right) rendered.add(index);
    }
  }
  for (const index of pinned) {
    if (Number.isInteger(index) && index >= 0 && index < total) rendered.add(index);
  }

  const renderedIndexes = [...rendered].sort((a, b) => a - b);
  const segments = [];
  let cursor = 0;
  for (const index of renderedIndexes) {
    if (index > cursor) segments.push({ kind: "spacer", key: `spacer-${cursor}`, from: cursor, to: index, width: offsets[index] - offsets[cursor] });
    segments.push({ kind: "column", key: `column-${index}`, index });
    cursor = index + 1;
  }
  if (cursor < total) segments.push({ kind: "spacer", key: `spacer-${cursor}`, from: cursor, to: total, width: offsets[total] - offsets[cursor] });

  return {
    segments,
    renderedIndexes,
    allRendered: renderedIndexes.length === total,
    offsets,
    frozenCount: frozen,
    frozenWidth,
    totalWidth: offsets[total],
    signature: `${renderedIndexes.join(",")}|${segments.filter((segment) => segment.kind === "spacer").map((segment) => `${segment.from}:${segment.width}`).join(",")}`,
  };
}

/** 读取某个 tab 当前各列宽度（列顺序 = tab.columns 顺序），未知宽度用 MIN_COL_WIDTH。 */
export function columnWidthsOf(tab, columnMeta) {
  const state = ensureColumnWidthState(tab);
  return (Array.isArray(columnMeta) ? columnMeta : []).map((meta) => {
    const width = Number(state?.widths?.[meta?.name]);
    return Number.isFinite(width) && width > 0 ? width : MIN_COL_WIDTH;
  });
}
```

跑测试 → 全绿。

- [ ] **Step 3：`useVirtualGrid.js` 接入**

```js
import { computeColumnWindow, columnWidthsOf } from "./useVirtualColumns.js";
import { ROW_INDEX_WIDTH } from "../constants.js";   // 文件顶部已有 const ROW_INDEX_WIDTH = 38，改为从 constants 导入以免重复

const scrollLeft = ref(0);
const viewportWidth = ref(0);
const pinnedColumnIndexes = ref([]);      // 由 WorkbenchPane 设置：选中列、编辑列

let lastColumnWindow = null;
const columnWindow = computed(() => {
  const tab = activeTab.value;
  const meta = activeColumnMeta.value;
  const next = computeColumnWindow({
    widths: columnWidthsOf(tab, meta),
    frozenCount: fp.frozenColumnCountOf(tab),
    scrollLeft: scrollLeft.value,
    viewportWidth: viewportWidth.value,
    gutterWidth: ROW_INDEX_WIDTH,
    pinned: pinnedColumnIndexes.value,
  });
  // 只有"渲染哪些列 + 每个占位格多宽 + 每列的几何 offsets + 冻结数"全部相同才复用旧对象。
  // 不能只比 renderedIndexes/占位格/总宽：两列一增一减、总宽不变时 offsets 已经变了，
  // 复用旧对象会让 scrollColumnIntoView / 拖拽定位用到过期坐标。
  const sameGeometry = lastColumnWindow
    && lastColumnWindow.signature === next.signature
    && lastColumnWindow.frozenCount === next.frozenCount
    && lastColumnWindow.offsets.length === next.offsets.length
    && lastColumnWindow.offsets.every((value, index) => value === next.offsets[index]);
  if (sameGeometry) return lastColumnWindow;   // 过扫描范围内的横向滚动不触发任何重渲染
  lastColumnWindow = next;
  return next;
});
```

（`computeColumnWindow` 的返回值要补一个 `frozenCount` 字段；`offsets` 比较是 O(列数) 的整数比较，60 列约 60 次，可忽略。）

`onGridScroll`：追加 `scrollLeft.value = Math.max(0, event.target.scrollLeft);`。ResizeObserver 回调追加 `viewportWidth.value = entry.contentRect.width;`，`watch(gridWrapRef)` 初始化时 `viewportWidth.value = el.clientWidth`。`restoreGridScroll` 里设置 `wrap.scrollLeft` 后同步 `scrollLeft.value`。

`scrollColumnIntoView` 改为算术（不再 `querySelector`/`getBoundingClientRect`）：

```js
function scrollColumnIntoView(columnIndex) {
  const wrap = gridWrapRef.value;
  const window = columnWindow.value;
  if (!wrap || !window?.offsets || columnIndex == null) return;
  const frozenCount = fp.frozenColumnCountOf(activeTab.value);
  if (columnIndex < frozenCount || columnIndex + 1 >= window.offsets.length) return;   // 冻结列永远可见
  const viewLeft = wrap.scrollLeft + window.frozenWidth;
  const viewRight = wrap.scrollLeft + wrap.clientWidth - ROW_INDEX_WIDTH;
  const delta = columnIntoViewScrollDelta(window.offsets[columnIndex], window.offsets[columnIndex + 1], viewLeft, viewRight);
  if (delta === 0) return;
  wrap.scrollLeft += delta;
  scrollLeft.value = Math.max(0, wrap.scrollLeft);
}
```

`scrollInsertCellIntoView` 里对 `scrollColumnIntoView` 的调用保持不变。`return` 追加 `scrollLeft, viewportWidth, columnWindow, pinnedColumnIndexes`。

- [ ] **Step 4：`WorkbenchPane.vue` 设置 pinned 列并下传**

`useGridEditor` 创建之后（`231` 之后）加：

```js
watch(
  () => {
    const tab = activeDataTab.value;
    const names = (activeColumns.value || []).map(columnName);
    const picks = [];
    const cell = selectedCell.value;
    if (cell && cell.tabId === tab?.id && cell.kind !== "fieldComment") picks.push(names.indexOf(cell.column));
    const editing = editingCell.value;
    if (editing && editing.column) picks.push(names.indexOf(editing.column));
    return picks.filter((index) => index >= 0);
  },
  (indexes) => { pinnedColumnIndexes.value = indexes; },
  { immediate: true },
);
```

（`selectedCell`/`editingCell` 是 `useGridEditor` 返回的 ref；`columnName` 来自 `../utils/normalize.js`，文件里应已导入。）`<DataGrid …>` 增加 `:column-window="columnWindow"`。

同时把 `columnWindow` 交给 `useGridEditor`——它现在的第 5 个参数是一个**只含三个滚动函数的对象字面量**（`WorkbenchPane.vue:236`：`{ scrollRowIntoView, scrollCellIntoView, scrollInsertCellIntoView }`），`useGridEditor.js:132` 用解构接收，没有 `columnWindow`。两处都要改：

```js
// WorkbenchPane.vue:236
{ scrollRowIntoView, scrollCellIntoView, scrollInsertCellIntoView, columnWindow },

// useGridEditor.js:132
{ scrollRowIntoView, scrollCellIntoView = scrollRowIntoView, scrollInsertCellIntoView = () => {}, columnWindow = null },
```

`useGridEditor.js:124` 的 JSDoc 同步补上 `columnWindow?: import('vue').ComputedRef`。`scripts/perf/workbench-benchmarks.mjs:174-182` 构造 `useGridEditor` 时没传 `columnWindow`，默认 `null` 即走原 DOM 逻辑，不用改。

- [ ] **Step 5：`DataGrid.vue` 按列段渲染**

新增 prop `columnWindow: { type: Object, default: null }`。Task 2 已经把"逻辑列表"独立成 `allColumnMeta`（下标 === `columnIndex` === `data-column-index`）；本步把 `renderColumns` 改成"实际渲染的列"。改完后**逐个核对 `DataGrid.vue` 里每一处 `renderColumns` 的用途**，按下表决定用哪一个：

| 用途 | 应该用 |
|---|---|
| 按 `data-column-index` 反查列（Task 2 的 `resolveDataCellTarget`）、`isActiveColumn`/动态列高亮规则里找 `columnIndex`、`aria-colcount`、`selectedCell.column` → 列号换算 | `allColumnMeta`（逻辑） |
| `frozenColumnStyle`/`frozenColumnsWidth` 传给 `useFreezePanes` 的列表（冻结列永远是前 N 列且永远渲染） | `allColumnMeta`（几何要按全部列算） |
| 表头/字段备注行/插入行/数据行的 `v-for`、`renderCellSegments`、`renderedCellCount`、`colspan` | `renderSegments`/`renderColumns`（渲染） |
| 列宽自适应 `performAutoFit(…, props.activeColumns, …)` | 保持 `props.activeColumns`（全部列，数据驱动） |

新增：

```js
const renderSegments = computed(() => {
  const all = allColumnMeta.value;
  const window = props.columnWindow;
  if (!window?.segments?.length || window.allRendered) {
    return all.map((meta) => ({ kind: "column", key: meta.name, meta }));
  }
  return window.segments.map((segment) => (
    segment.kind === "column"
      ? { kind: "column", key: all[segment.index].name, meta: all[segment.index] }
      : { kind: "spacer", key: segment.key, width: segment.width }
  ));
});
const renderColumns = computed(() => renderSegments.value.filter((segment) => segment.kind === "column").map((segment) => segment.meta));
const renderCellSegments = computed(() => renderSegments.value.map((segment) => (
  segment.kind === "column"
    ? { ...segment, cellStyle: mergeStyles(colStyle(props.tab, segment.meta.name), frozenColumnStyle(segment.meta.columnIndex)) }
    : { ...segment, cellStyle: { width: `${segment.width}px`, minWidth: `${segment.width}px`, maxWidth: `${segment.width}px` } }
)));
const renderedCellCount = computed(() => renderSegments.value.length);
```

表头行（`1273`）、字段备注行（`1348`）、插入行（`1518`、`1725`）改为：

```vue
<template v-for="segment in renderCellSegments" :key="segment.key">
  <th v-if="segment.kind === 'spacer'" class="wb-col-spacer" aria-hidden="true" :style="segment.cellStyle"></th>
  <th v-else …原有全部属性，`columnMeta` 改写为 `segment.meta`… ></th>
</template>
```

所有 `:colspan="1 + activeColumns.length"` 改为 `:colspan="1 + renderedCellCount"`（`aria-colcount` 仍用逻辑列数）。`GridDataRow` 的 prop 由 `columns` 改为 `segments`（即 `renderCellSegments`），模板同样用 `<template v-for>` + `v-if spacer`。`workbench.css` 加：

```css
.wb-grid td.wb-col-spacer,
.wb-grid th.wb-col-spacer {
  padding: 0;
  border-left: 0;
  border-right: 0;
  background: transparent;
}
```

`updateFillOverlayPosition`（填充柄覆盖层）取选区四角格子的 DOM 矩形：找不到（列未挂载）时改用 `columnWindow.offsets` 与 `rowHeight` 算位置，或至少隐藏覆盖层而不是报错。

- [ ] **Step 6：`useGridEditor.js:1391-1412` `columnIndexFromPointer` 改为几何计算**

这段按鼠标 X 找列时遍历 DOM 格子，找不到就用 126 px 估算；列窗口之后未挂载的列没有 DOM，必须改成几何。用 Step 4 传入的 `columnWindow`（为 `null` 时退回原逻辑）。**冻结列是 sticky 的，它们在屏幕上的位置不随横向滚动变化，不能统一叠加 `scrollLeft`：**

```js
function columnIndexFromPointer(wrap, clientX) {
  const window = columnWindow?.value;
  if (!window?.offsets || window.offsets.length < 2) return columnIndexFromPointerByDom(wrap, clientX); // 原实现改名保留
  const wrapLeft = wrap.getBoundingClientRect().left;
  const total = window.offsets.length - 1;
  // 屏幕 X → 网格内容 X（去掉行号栏）。
  const localX = clientX - wrapLeft - ROW_INDEX_WIDTH;
  const frozenCount = window.frozenCount;
  const frozenWidth = window.frozenWidth;
  let contentX;
  if (localX < frozenWidth) {
    // 落在冻结带内：冻结列贴着行号栏，不受 scrollLeft 影响
    contentX = Math.max(0, localX);
    for (let index = 0; index < frozenCount; index += 1) {
      if (contentX < window.offsets[index + 1]) return index;
    }
    return Math.max(0, frozenCount - 1);
  }
  // 落在可滚动区：加上 scrollLeft，但结果不能落回冻结列（它们被 sticky 遮住）
  contentX = localX + wrap.scrollLeft;
  for (let index = frozenCount; index < total; index += 1) {
    if (contentX < window.offsets[index + 1]) return index;
  }
  return total - 1;
}
```

顺序查找 60 列足够快；列数上千再换二分。`rowIndexFromPointer`（`1414-1424`）已经是纯算术，不用改。

- [ ] **Step 7：验证**

```powershell
node --test src/workbench/useVirtualColumns.test.js src/workbench/useVirtualGrid.test.js src/workbench/workbenchShell.test.js
node scripts/test-workbench.mjs
```

**交互正确性是本 Task 的验收前提，全部通过后才看性能。** 手工（`schema-800x60`，把窗口拉窄到只能看到 8–10 列）：

1. 横向滚动流畅且滚动条长度不跳；滚动到中段后 `document.querySelectorAll('.wb-col-spacer').length === 2 * 渲染行数`（左右各一）。
2. 方向键 → 一路按到第 60 列再按回第 1 列，每一步选中格都在视口内且 `td.selected` 的 `data-column-index` 逐一递增/递减；Ctrl+→/Ctrl+← 跳到首尾列。
3. Shift+方向键框选跨越未挂载列后 Ctrl+C，粘贴到记事本列数与值完整；框选边框类名（`range-left/right`）在窗口边界处正确。
4. 双击最右列编辑并提交；在第 3 列开始编辑后横向滚到第 50 列，编辑框仍在（编辑列 pinned）。
5. 点击/双击/右键每种格子：可见列、冻结列、横向滚动后的列——点到的列与 `data-column-name` 一致（这是 `allColumnMeta` vs `renderColumns` 混用最容易露馅的地方）。
6. 鼠标拖拽框选时从可滚动区拖进冻结列、再拖回——选区列号连续、不跳变（验证 Step 6 的冻结带处理）。
7. 拖列宽（含被占位格夹着的列、冻结列、最后一列）；宽度改完后 `scrollColumnIntoView` 仍能精确定位（先拖宽第 5 列 200px，再用方向键从第 4 列到第 6 列）。
8. 冻结前 2 列后横向滚动、取消冻结；冻结到当前单元格。
9. 拖拽重排表头（限于可见列）后列窗口与数据对应正确。
10. 填充柄拖过视口边缘不报错、预览不错位。
11. 12 列窄表 DOM 结构与改前一致（`document.querySelectorAll('.wb-col-spacer').length === 0`），Task 0 指标不比 Task 4 差。
12. 插入草稿行（Ctrl+Insert 或工具栏新增行）在列窗口下能输入、Tab 跨列、保存。

- [ ] **Step 8：测量与提交**

`--label task7`，60 列：渲染格子数从 3782 降到 ≈ 42 行 × (10–13 列) ≈ 500；打开/切换表 `paintMs` 与 `settledMs` 预期再降约一半，方向键/编辑因 Task 1–3 已是行级重渲染，收益会小于打开/切换（这是估算，以实测为准）。

`git commit -m "perf(grid): horizontal column window with exact-width spacers"`

---

## 7. 其余可选改动（先做完 Task 0–7 再评估）

| 项 | 内容 | 预估 | 说明 |
|---|---|---|---|
| 行载荷改列式 | `rows: Vec<HashMap<String,String>>` → 列名一次 + `Vec<Vec<Option<String>>>`；同步 `types.rs`、`db.rs`、`clickhouse.rs`、`mongodb.rs`、`demo.rs`、`mockBackend.js`、`workspaceState.js` | ~300 行，中风险 | 1000 行页 JSON 体积 -30~50%，序列化/解析/分配减半 |
| 每表保留 DOM | 最近 N 个数据 tab 各自保留 `DataGrid` 实例（`v-show`），切换免重建 | ~300 行，架构改动 | 切换标签 100 ms → ~10 ms；内存换时间 |
| IPC 先于渲染发出 | `editState.js:67-76 enqueueMutationTask` 在队列空闲时同步启动任务，让 `invoke("update_cell")` 在 Vue flush 之前发出 | ~30 行，低风险 | Task 3 之后渲染只剩 ~10 ms，收益有限 |
| `test_before_acquire(false)` + 只读重试 | 每条查询省 1 次往返 | ~60 行 | 仅远程/VPN 数据库有感 |

---

## 8. 决策记录

| # | 事项 | 状态 | 说明 |
|---|---|---|---|
| 1 | **文本主键表的默认顺序**（Task 5）改为主键索引顺序；点列头排序时保留自然排序 | 已确认（2026-09-19） | 理由：自然排序表达式让 MySQL 无法走主键索引，每页/每次缓冲填充/每个搜索批次都全表扫描 + filesort，是真实数据库上最大的单项耗时。v2 补充：复合主键按索引列序（Step 1b）、深分页 OFFSET 成本仍在（Step 1c）、发版说明需提示顺序变化。 |
| 2 | **审计库 `synchronous=NORMAL`**（Task 6 Step 1） | **重新打开，待确认** | 2026-09-19 的确认基于"断电最多丢一两条"的错误描述。准确后果是"断电/系统崩溃可能丢失上一 WAL 检查点以来的全部审计记录（MySQL 数据不受影响）"。请在 Task 6 的方案 A/B/C 中选一个；未选定前 Task 6 只做 Step 2–4。 |
| 3 | **标签重排动画** | 需再确认一次范围 | 原确认为"非拖拽期间不再有位移动画"。v2 因"拖拽时切换组件类型会中断拖拽"改为**完全去掉位移动画**（拖拽仍可用，只是即时跳位）。若不接受，Task 4 Step 1 改走手写 FLIP 方案（+40 行）。 |
| 4 | **横向列虚拟化**（Task 7） | 已确认（2026-09-19） | 顺序放在 Task 1–4 之后；交互正确性清单（Step 7）通过是性能验收的前提。 |

第 7 节列出的其余项（行载荷改列式、每表 DOM 保留、IPC 先发、`test_before_acquire`）暂不做，等 Task 0–7 的测量结果出来再议。

**评审记录：** v1 经两位外部评审（一位侧重设计正确性，一位侧重引用准确性）。引用准确性核实约 50 处，准确率 > 95%；设计层面确认的缺陷全部在 v2 修正（见文首修订说明）。

## 9. 执行时的禁忌

- 不要整文件读取 `useGridEditor.js`、`MySqlWorkbench.vue`、`commands.rs`；按本文行号读片段，用 `rg`/grep 定位函数。
- 不要把行的 `:key` 从 `rowKey` 改成位置下标（会让滚动时每帧全量 patch）。
- 不要把 `selectedCell`/`selectedRange`/`editingCell` 整对象作为 prop 传进 `GridDataRow`（会让所有行一起重渲染，Task 1 白做）。
- 不要调整 `commands.rs` 里"审计标 committed → MySQL COMMIT"的顺序。
- Task 3 不要给 `mutateTabRow`/`mutateRow` 增加"是否影响行身份"之类的调用方参数；身份判断只能在 `rowStore.js` 里做一处，否则撤销/重做、兄弟标签同步、保存失败恢复、无主键表迟早有一条路径漏标。
- Task 4 不要在拖拽开始/结束时切换标签容器的组件类型（`div` ↔ `TransitionGroup`），会卸载重建正在被拖的节点。
- Task 2/7：按 `data-column-index` 反查列元数据一律用 `allColumnMeta`（逻辑列表），渲染循环一律用 `renderSegments`/`renderColumns`（实际渲染列）；两者混用会在横向滚动后点错列。
- Task 7 中表头行、字段备注行、插入行、数据行必须渲染完全相同的列段序列（同样的占位格位置与宽度），否则按 DOM 下标改列宽会改错列。
- Task 7 中任何列几何（滚到某列、拖拽定位列、填充柄位置）一律用 `columnWindow.offsets` 前缀和计算，不要去 `querySelector` 可能未挂载的格子；冻结列在屏幕上不随 `scrollLeft` 移动，几何换算要分开处理。
- 测量脚本报 `ok: false` 时不要拿它的耗时数字做任何结论。
- Tauri 命令请求/响应结构一旦改动，必须同步 `src/workbench/mock/mockBackend.js`，否则 `npm run dev` 与 Playwright 测量全部失效。
- 每个 Task 结束都要：`node scripts/test-workbench.mjs`、`cd src-tauri && cargo test`（涉及 Rust 时）、`node scripts/perf/grid-interaction.mjs --label taskN`，把三者结果写进提交说明。
