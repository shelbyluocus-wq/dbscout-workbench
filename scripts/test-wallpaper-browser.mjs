import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const base = process.env.DBSCOUT_WALLPAPER_TEST_URL || "http://127.0.0.1:1437";
const output = process.env.DBSCOUT_WALLPAPER_SCREENSHOTS || "/tmp/blackcat-wallpaper-review";
const BUILTIN = [
  "mist-ridges", "frost-folds", "dune-dawn", "ocean-clouds", "night-ridges", "indigo-folds",
  "dune-night", "night-launch", "silent-orbits", "planet-dawn", "dune-sphere", "rose-quartz",
];
// Empty spots of every frame strip: sidebar title bar, tab strip, inspector
// title bar, rail, sidebar. With the sidebar closed the first lands on a tab
// and the last on the content sheet, so only the middle three are frame.
const FRAME_POINTS = [[250, 20], [880, 12], [1000, 20], [20, 400], [250, 700]];
const FRAME_STRIPS = [
  ".wb-titlebar", ".wb-titlebar-sidebar", ".wb-titlebar-tabs", ".wb-titlebar-inspector-controls",
  ".wb-activity-rail", ".wb-sidebar-slot", ".wb-sidebar", ".wb-pane-tabbar.is-top-edge-pane", ".wb-workspace", ".wb-main",
];
const ENGINES = (process.env.DBSCOUT_WALLPAPER_ENGINES || "chromium,webkit").split(",");
await mkdir(output, { recursive: true });

for (const [name, engine] of Object.entries({ chromium, webkit }).filter(([key]) => ENGINES.includes(key))) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
    const errors = [];
    if (process.env.DEBUG_WALLPAPER) page.on("console", (message) => console.log("console", message.type(), message.text()));
    page.on("pageerror", (error) => {
      if (!/ResizeObserver loop/.test(error.message)) errors.push(error.message);
    });
    const art = page.locator(".wb-wallpaper-art");
    const artSource = () => art.getAttribute("src");
    const artOpacity = async () => Number(await art.evaluate((element) => getComputedStyle(element).opacity));
    const waitForArt = async (source, opacity) => {
      await page.waitForFunction(({ source, opacity }) => {
        const element = document.querySelector(".wb-wallpaper-art");
        const matches = typeof source === "string" ? element?.getAttribute("src") === source : element?.getAttribute("src")?.startsWith("blob:");
        return matches && Math.abs(Number(getComputedStyle(element).opacity) - opacity) < 0.011;
      }, { source, opacity });
    };
    const start = async (theme) => {
      await page.evaluate((value) => {
        localStorage.setItem("dbscout_language", "zh-CN");
        localStorage.setItem("dbscout_theme", value);
      }, theme);
      await page.reload();
      await page.locator(".mysql-workbench").waitFor();
    };
    const open = async () => {
      await page.locator('[data-wb-rail-id="settings"]').click();
      await page.getByRole("button", { name: /^选择壁纸…/ }).click();
      await page.getByRole("dialog", { name: "壁纸", exact: true }).waitFor();
    };
    const close = () => page.keyboard.press("Escape");
    // Actions are latest-wins, so let a choice land before the next change.
    const settled = () => page.waitForFunction(() => !document.querySelector(".wb-wallpaper-panel [role=status]")?.textContent.includes("正在保存"));
    const pick = async (id) => {
      await page.locator(`[data-wallpaper-id="${id}"]`).click();
      await page.waitForFunction((value) => document.querySelector(`[data-wallpaper-id="${value}"]`).getAttribute("aria-checked") === "true", id);
      await settled();
    };
    const edit = (appearance) => page.locator(`[data-wallpaper-appearance="${appearance}"]`).click();
    const setSlider = async (id, value) => {
      await page.locator(`#${id}`).evaluate((element, next) => {
        element.value = String(next);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await page.waitForFunction(({ id, value }) => document.querySelector(`output[for="${id}"]`).textContent.startsWith(String(value)), { id, value });
      await settled();
    };
    const framePixels = async () => {
      const shot = (await page.screenshot()).toString("base64");
      return page.evaluate(async ({ shot, points }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${shot}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3).join(","));
      }, { shot, points: FRAME_POINTS });
    };
    const sidebarToggle = page.locator("#wb-topbar-sidebar-actions .wb-topbar-collapse-btn");

    await page.goto(base);
    await page.evaluate(() => localStorage.clear());

    const sheetVeil = () => page.locator(".wb-main").evaluate((element) => getComputedStyle(element, "::before").backgroundColor);

    // A new installation shows the recommended pair, each at its own strength,
    // on the whole window.
    await start("dark");
    await waitForArt("/wallpapers/indigo-folds.webp", 0.48);
    await start("light");
    await waitForArt("/wallpapers/frost-folds.webp", 1);
    assert.equal(await page.locator(".mysql-workbench").getAttribute("data-wallpaper-scope"), "window");
    assert.match(await sheetVeil(), /0\.463\)$/);

    await open();
    // A side panel over a clear backdrop: the window beside it stays in view.
    const panel = await page.locator(".wb-wallpaper-panel").boundingBox();
    assert.ok(panel.x > 800 && panel.width <= 362, `panel ${JSON.stringify(panel)}`);
    assert.equal(await page.locator(".wb-wallpaper-overlay").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
    // Scope and the amount behind content change the window as they move.
    await page.locator('[data-wallpaper-scope="frame"]').click();
    await page.waitForFunction(() => document.querySelector(".mysql-workbench").dataset.wallpaperScope === "frame");
    assert.match(await sheetVeil(), /0\.9\)$/);
    assert.equal(await page.locator("#wb-wallpaper-content").count(), 0);
    await page.locator('[data-wallpaper-scope="window"]').click();
    await page.locator("#wb-wallpaper-content").waitFor();
    await page.locator("#wb-wallpaper-content").evaluate((element) => {
      for (const value of [60, 80, 100]) {
        element.value = String(value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await page.waitForFunction(() => /0\.12\)$/.test(getComputedStyle(document.querySelector(".wb-main"), "::before").backgroundColor));
    await setSlider("wb-wallpaper-content", 50);
    assert.match(await sheetVeil(), /0\.51\)$/);
    assert.equal(await page.locator(".wb-wallpaper-grid [role=radio]").count(), BUILTIN.length + 2);
    assert.equal(await page.getByRole("radio", { name: "霜白层叠（推荐）", exact: true }).getAttribute("aria-checked"), "true");
    for (const id of BUILTIN) {
      await pick(id);
      await page.waitForFunction((value) => {
        const element = document.querySelector(".wb-wallpaper-art");
        return element?.getAttribute("src") === `/wallpapers/${value}.webp` && element.naturalWidth > 0;
      }, id);
    }
    // Arrow keys move and select; up and down follow the four-column grid.
    await pick("frost-folds");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector('[data-wallpaper-id="dune-dawn"]').getAttribute("aria-checked") === "true");
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.querySelector('[data-wallpaper-id="dune-night"]').getAttribute("aria-checked") === "true");
    await settled();

    // A picture that fights the appearance is dimmed until frame text is readable.
    await pick("night-launch");
    await setSlider("wb-wallpaper-visibility", 100);
    await waitForArt("/wallpapers/night-launch.webp", 0.14);
    await page.getByText("与浅色模式反差较大，已自动减淡以保证文字清晰。", { exact: true }).waitFor();
    await pick("mist-ridges");
    await waitForArt("/wallpapers/mist-ridges.webp", 1);
    assert.equal(await page.getByText("已自动减淡", { exact: false }).count(), 0);
    await setSlider("wb-wallpaper-visibility", 60);

    // The other appearance is set up without leaving this one.
    await edit("dark");
    await pick("dune-night");
    await setSlider("wb-wallpaper-blur", 6);
    assert.equal(await artSource(), "/wallpapers/mist-ridges.webp");
    assert.equal(await art.evaluate((element) => getComputedStyle(element).filter), "blur(0px)");
    await page.getByRole("button", { name: "浅色模式改用配套的「沙海晨光」", exact: true }).click();
    await waitForArt("/wallpapers/dune-dawn.webp", 0.6 * 0.23);
    await edit("light");
    await pick("mist-ridges");
    for (const theme of ["light", "dark"]) {
      await start(theme);
      await open();
      await page.waitForTimeout(400);
      // Both segmented controls center their text, including the appearance hint.
      const segments = await page.locator(".wb-wallpaper-segment button").evaluateAll((buttons) => buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const text = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        const range = document.createRange();
        range.selectNodeContents(text);
        const label = range.getBoundingClientRect();
        return {
          label: button.textContent,
          alignment: getComputedStyle(button).alignItems,
          centerOffset: Math.abs(label.top + label.height / 2 - box.top - box.height / 2),
        };
      }));
      assert.equal(segments.length, 4);
      for (const segment of segments) {
        assert.equal(segment.alignment, "center", `${name}/${theme}: ${segment.label}`);
        assert.ok(segment.centerOffset <= 2, `${name}/${theme}: ${JSON.stringify(segment)}`);
      }
      await page.screenshot({ path: `${output}/${name}-${theme}-dialog.png` });
      await close();
    }
    await waitForArt("/wallpapers/dune-night.webp", 0.48);
    assert.equal(await art.evaluate((element) => getComputedStyle(element).filter), "blur(6px)");

    // The frame is one surface: a flat-colour picture must look identical in
    // every strip, with the sidebar open and closed, in both appearances.
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
      const context = canvas.getContext("2d"); context.fillStyle = "#3f7f74"; context.fillRect(0, 0, 32, 32);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await open();
    // A file dropped onto the panel becomes the custom wallpaper.
    await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "wallpaper.png", { type: "image/png" }));
      const target = document.querySelector(".wb-wallpaper-panel");
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!document.querySelector(".wb-wallpaper-dropzone")) throw new Error("no drop target shown");
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, png);
    await page.waitForFunction(() => document.querySelector('[data-wallpaper-id="custom"]').getAttribute("aria-checked") === "true");
    await setSlider("wb-wallpaper-blur", 0);
    await edit("light");
    await pick("custom");
    await close();
    for (const theme of ["dark", "light"]) {
      await start(theme);
      await page.getByText("hero", { exact: true }).first().dblclick();
      await page.locator(".wb-grid-row").first().waitFor();
      await page.waitForFunction(() => {
        const element = document.querySelector(".wb-wallpaper-art");
        return element?.getAttribute("src")?.startsWith("blob:") && element.classList.contains("is-measured");
      });
      await page.waitForTimeout(450);
      const plain = await page.locator(".wb-wallpaper-canvas").evaluate((element) => getComputedStyle(element).backgroundColor.match(/\d+/g).slice(0, 3).join(","));
      for (const collapsed of [false, true]) {
        if (((await sidebarToggle.getAttribute("aria-label")) === "展开数据库栏") !== collapsed) await sidebarToggle.click();
        await page.waitForTimeout(450);
        for (const selector of FRAME_STRIPS) {
          assert.equal(await page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", `${theme} ${selector}`);
        }
        const pixels = await framePixels();
        const frame = collapsed ? pixels.slice(1, 4) : pixels;
        assert.equal(new Set(frame).size, 1, `${name} ${theme} collapsed=${collapsed}: frame strips differ ${frame.join(" | ")}`);
        assert.notEqual(frame[0], plain, "the picture shows through the frame");
        await page.screenshot({ path: `${output}/${name}-${theme}-${collapsed ? "collapsed" : "open"}.png` });
      }
      await sidebarToggle.click();
      // Reading surfaces: one veil for the sheet, opaque headers and frozen cells.
      for (const selector of [".wb-grid-shell", ".wb-table-panel", ".wb-grid-wrap"]) {
        assert.equal(await page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", selector);
      }
      for (const selector of [".wb-inspector", ".wb-grid-wrap thead th"]) {
        assert.notEqual(await page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", selector);
      }
      const sheet = await sheetVeil();
      assert.match(sheet, /0\.51\)$/, `sheet veil ${sheet}`);
    }

    // Custom media survives a reload; restoring the recommended pair keeps the file.
    await start("light");
    await page.waitForFunction(() => document.querySelector(".wb-wallpaper-art")?.getAttribute("src")?.startsWith("blob:"));
    await open();
    await page.getByRole("button", { name: "恢复推荐搭配", exact: true }).click();
    await waitForArt("/wallpapers/frost-folds.webp", 1);
    assert.match(await sheetVeil(), /0\.463\)$/);
    assert.equal(await page.locator('[data-wallpaper-id="custom"] img').count(), 1, "reset retains custom media");
    await pick("none");
    await page.waitForFunction(() => !document.querySelector(".wb-wallpaper-canvas"));
    assert.equal(await page.locator(".mysql-workbench.has-wallpaper").count(), 0);
    await close();
    await start("dark");
    await waitForArt("/wallpapers/indigo-folds.webp", 0.48);
    assert.deepEqual(errors, []);
    console.log(`${name}: recommended pair, side panel, scope and content veil, twelve pictures, keyboard, dimming, per-mode settings, drop, one continuous frame, reload and reset passed`);
  } finally { await browser.close(); }
}
