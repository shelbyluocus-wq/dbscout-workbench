import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

// Renders the promo video: serves the repository root (the page reads the app
// icon from src-tauri/icons), seeks promo.html frame by frame, synthesizes the
// soundtrack with synth.py and encodes both with ffmpeg.
//
//   node docs/promo/render.mjs                 # full video -> docs/promo/blackcat-promo.mp4
//   node docs/promo/render.mjs --probe 4.6 21  # still frames only -> output/promo/probe
//
// Environment: FFMPEG (default "ffmpeg", needs libx264 + aac), PYTHON (default "python3").
const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const work = join(root, "output", "promo");
const FPS = 30;
const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".js": "text/javascript" };

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}/docs/promo/promo.html`;

const args = process.argv.slice(2);
const probe = args[0] === "--probe";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(base);
  const duration = await page.evaluate(() => window.DURATION);
  // Visit every scene once so all images and fonts are decoded before capture.
  for (let t = 0; t < duration; t += 0.5) await page.evaluate((t) => window.renderAt(t), t);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);

  const shoot = async (t, path, quality) => {
    await page.evaluate((t) => window.renderAt(t), t);
    await page.screenshot({ path, type: "jpeg", quality });
  };
  if (probe) {
    const dir = join(work, "probe");
    mkdirSync(dir, { recursive: true });
    for (const t of args.slice(1).map(Number)) await shoot(t, join(dir, `t${t.toFixed(2).padStart(6, "0")}.jpg`), 85);
    console.log(`probe frames in ${dir}`);
  } else {
    const dir = join(work, "frames");
    mkdirSync(dir, { recursive: true });
    const frames = Math.round(duration * FPS);
    for (let f = 0; f < frames; f++) {
      await shoot(f / FPS, join(dir, `f${String(f).padStart(5, "0")}.jpg`), 92);
      if (f % 300 === 0) console.log(`frame ${f}/${frames}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}

if (!probe) {
  const run = (cmd, argv) => {
    const result = spawnSync(cmd, argv, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${cmd} exited with ${result.status}`);
  };
  const wav = join(work, "promo.wav");
  run(process.env.PYTHON || "python3", [join(here, "synth.py"), wav]);
  run(process.env.FFMPEG || "ffmpeg", [
    "-v", "error", "-y", "-framerate", String(FPS), "-i", join(work, "frames", "f%05d.jpg"), "-i", wav,
    "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-maxrate", "1500k", "-bufsize", "3000k", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", "-shortest",
    join(here, "blackcat-promo.mp4"),
  ]);
  console.log("wrote docs/promo/blackcat-promo.mp4");
}
