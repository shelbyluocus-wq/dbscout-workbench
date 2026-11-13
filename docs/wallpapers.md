# Local wallpapers

Settings → Wallpaper opens a live picker with None, eight bundled stills and a
custom-media slot. No database data, account preference or remote service is used.
The default remains None. Reset restores None / 25% visibility / no blur / static
playback, but retains the custom file until Remove is used.

## Architecture

- `wallpaperState.js`: bounded settings, file signatures and actual decode checks,
  cancellable actions, local errors and cross-window refresh.
- `wallpaperStorage.js`: small metadata in `dbscout.wallpaper.v1`; one custom
  file in IndexedDB `dbscout-wallpaper-v1`. Store ArrayBuffer + MIME metadata,
  not Blob records (WebKit compatibility), and expose Blob URLs to the renderer.
- `composables/useWallpaper.js`: one shared store per window; deferred initialization.
- `WallpaperCanvas.vue` + `wallpaperCanvas.css`: one continuous cover-fit canvas,
  image/video-only opacity and blur. Hidden windows and reduced motion pause video.
  Data reading surfaces keep a contrast tint; floating surfaces, frozen cells,
  selections and code editors keep their existing surfaces.
- `WallpaperSettingsDialog.vue` + `wallpaperSettings.css`: radio-grid keyboard
  selection, local file input, visibility / blur and video motion controls.
- `i18n/wallpaperMessages.js`: English, Simplified Chinese and Traditional Chinese.

PNG/JPEG/WebP: at most 20 MiB. MP4: at most 100 MiB; actual playback depends on
system codecs, with H.264 recommended. Unsupported/corrupt files and failed saves
retain the previous selection. No custom files are uploaded. Custom bytes are
retained as supplied (not metadata-stripped or transcoded).

## Upstream reference

Cindy revision `2ccd71c310c6346954cb7a5af357c757a58af785`:
`docs/design-rules/wallpaper.md`, `WallpaperSection.tsx`, `WallpaperPresenter.ts`,
`lib/wallpaper.ts` and custom wallpaper storage. Blackcat uses its own Vue and
browser-storage implementation; it does not import Cindy's Electron services,
CDN, character art or desktop transparency system. Eight unchanged WebPs and
thumbnails total 3,493,120 bytes and ship locally for offline use. Attribution and
Apache 2.0 license accompany them in `public/wallpapers/`.

## Verification

```sh
node --test src/workbench/wallpaperState.test.js src/workbench/wallpaperStorage.test.js
WALLPAPER_BROWSER_TEST=1 node --test src/workbench/wallpaperStorage.test.js
node scripts/test-wallpaper-browser.mjs
node --test src/workbench/typographyTokens.test.js src/workbench/themeContrast.test.js
node node_modules/vite/bin/vite.js build
```

The UI browser test expects Vite on `http://127.0.0.1:1437` (override with
`DBSCOUT_WALLPAPER_TEST_URL`), tests Chromium and WebKit, and writes light/dark
screenshots to `/tmp/blackcat-wallpaper-review` (override with
`DBSCOUT_WALLPAPER_SCREENSHOTS`). Native packaged MP4 codec support still needs a
real macOS/Windows desktop check; browser-image tests are not that acceptance.
