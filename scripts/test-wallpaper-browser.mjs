import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const base = process.env.DBSCOUT_WALLPAPER_TEST_URL || "http://127.0.0.1:1437";
const output = process.env.DBSCOUT_WALLPAPER_SCREENSHOTS || "/tmp/blackcat-wallpaper-review";
await mkdir(output, { recursive: true });
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.evaluate(() => localStorage.setItem("dbscout_language", "zh-CN"));
    await page.reload();
    const open = async () => {
      await page.locator('[data-wb-rail-id="settings"]').click();
      await page.getByRole("button", { name: "选择壁纸…", exact: true }).click();
      await page.getByRole("dialog", { name: "壁纸", exact: true }).waitFor();
    };
    await open();
    assert.equal(await page.getByRole("radio").count(), 10);
    for (const id of ["night-launch", "silent-orbits", "dune-dawn", "planet-dawn", "indigo-folds", "dune-sphere", "ocean-clouds", "rose-quartz"]) {
      await page.locator(`[data-wallpaper-id="${id}"]`).click();
      await page.waitForFunction((value) => document.querySelector(".wb-wallpaper-art")?.getAttribute("src") === `/wallpapers/${value}.webp`, id);
      await page.waitForFunction(() => document.querySelector(".wb-wallpaper-art")?.naturalWidth > 0);
    }
    await page.locator('[data-wallpaper-id="indigo-folds"]').click();
    await page.getByRole("radio", { name: "靛蓝层叠", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector('[data-wallpaper-id="dune-sphere"]').getAttribute("aria-checked") === "true");
    await page.getByRole("radio", { name: "靛蓝层叠", exact: true }).click();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.querySelector(".mysql-workbench").dataset.theme = value;
        document.querySelector(".wb-wallpaper-overlay").dataset.theme = value;
      }, theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${output}/${name}-${theme}.png` });
    }
    await page.keyboard.press("Escape");
    await page.getByText("hero", { exact: true }).first().dblclick();
    await page.locator(".wb-grid-row").first().waitFor();
    for (const selector of [".wb-grid-shell", ".wb-table-panel", ".wb-grid-wrap"]) {
      assert.equal(await page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", selector);
    }
    assert.notEqual(await page.locator(".wb-inspector").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", "inspector text has a readability tint");
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".wb-wallpaper-art")?.getAttribute("src") === "/wallpapers/indigo-folds.webp");
    await open();
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#765432"; ctx.fillRect(0, 0, 32, 32);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "wallpaper.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.waitForFunction(() => document.querySelector('[data-wallpaper-id="custom"]').getAttribute("aria-checked") === "true");
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".wb-wallpaper-art")?.getAttribute("src")?.startsWith("blob:"));
    await open();
    await page.getByRole("button", { name: "恢复默认", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".wb-wallpaper-canvas"));
    assert.equal(await page.locator('[data-wallpaper-id="custom"] img').count(), 1, "reset retains custom media");
    assert.deepEqual(errors, []);
    console.log(`${name}: eight originals, keyboard selection, light/dark, reload, custom persistence and reset passed`);
  } finally { await browser.close(); }
}
