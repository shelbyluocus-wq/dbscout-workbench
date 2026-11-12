// Usage:
//   node render.mjs stills <outDir> <t1,t2,...>
//   node render.mjs video <out.mp4> <startFrame> <endFrame>
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../..');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require('playwright');

const FPS = 60;
const [mode, out, a, b] = process.argv.slice(2);

const logo = 'data:image/png;base64,' + readFileSync(path.join(REPO, 'src-tauri/icons/black-cat-icon.png')).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => { console.error('PAGE ERROR', e); process.exit(1); });
await page.addInitScript((src) => { window.__LOGO = src; }, logo);
await page.goto(pathToFileURL(path.join(here, 'film.html')).href);
await page.waitForFunction(() => window.__READY);
console.log('ready', await page.evaluate(() => window.__READY));

if (mode === 'stills') {
  mkdirSync(out, { recursive: true });
  for (const t of a.split(',').map(Number)) {
    await page.evaluate(([f, fps]) => window.renderFrame(f, fps), [Math.round(t * FPS), FPS]);
    await page.screenshot({ path: path.join(out, `t${t.toFixed(2).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 });
  }
} else {
  const start = Number(a), end = Number(b);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res) => ff.on('close', res));
  const t0 = Date.now();
  for (let f = start; f < end; f++) {
    await page.evaluate(([fr, fps]) => window.renderFrame(fr, fps), [f, FPS]);
    const buf = await page.screenshot({ type: 'jpeg', quality: 97 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if ((f - start) % 60 === 0) console.log('frame', f, ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }
  ff.stdin.end();
  console.log('ffmpeg exit', await done);
}
await browser.close();
