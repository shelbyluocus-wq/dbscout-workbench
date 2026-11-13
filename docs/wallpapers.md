# Local wallpapers

Settings → Wallpaper opens a live picker with None, twelve bundled stills and a
custom-media slot. No database data, account preference or remote service is used.

Light and dark appearance each keep their own choice, visibility and blur; the
workbench shows the one that matches the current appearance (including Follow
system). A new installation starts with the recommended pair: `mist-ridges` in
light and `night-ridges` in dark, both at 60% visibility with no blur. Restore
recommended pair returns to that and static playback, but retains the custom
file until Remove is used. The picker edits either appearance without switching
the app, lists pictures made for the edited appearance first (marked
Recommended), and offers the matching counterpart for the other appearance
(`mist-ridges` ↔ `night-ridges`, `frost-folds` ↔ `indigo-folds`,
`dune-dawn` ↔ `dune-night`).

Saved settings from the single-wallpaper version (`{ id, visibility, blur }`)
apply to both appearances, so an existing choice, including None, is kept.

## Presentation rules

- The frame (title bar, activity rail, sidebar, tab strips) is transparent over
  one canvas, so it reads as a single continuous surface. Never give a frame
  pane a tint of its own: a second layer is what makes neighbouring strips differ.
- The main area sits on one rounded sheet (`--wb-wallpaper-sheet`, 90% of the
  workspace colour); the inspector and the active tab use the same veil. Table
  headers, frozen cells, selections, editors, menus and dialogs stay opaque.
- Frame labels are drawn straight on the picture, so `wallpaperTone.js` measures
  the loaded picture and caps its opacity where the quietest frame label still
  meets WCAG AA (4.5:1) against its harshest region. Shown opacity is
  `visibility × ceiling`. Pictures made for an appearance reach full strength
  there; opposing ones are dimmed (about 14–23%) and the picker says so. Playing
  video and unreadable media use the black/white worst case.
- The macOS sidebar-blur tints stand down while a wallpaper is shown.

## Architecture

- `wallpaperState.js`: the catalog (`suits`, `pair`), per-appearance settings,
  the recommended defaults, legacy migration, file signatures and actual decode
  checks, cancellable actions, local errors and cross-window refresh.
- `wallpaperStorage.js`: small metadata in `dbscout.wallpaper.v1` (read
  synchronously at start through `peek()` so the first frame already has the
  picture); one custom file, shared by both appearances, in IndexedDB
  `dbscout-wallpaper-v1`. Store ArrayBuffer + MIME metadata, not Blob records
  (WebKit compatibility), and expose Blob URLs to the renderer.
- `wallpaperTone.js`: readable-opacity ceilings per appearance from sampled
  pixels. Its reference colours must stay at least as demanding as every
  bundled colour theme; the unit test enforces it.
- `composables/useWallpaper.js`: one shared store per window; deferred
  initialization. `MySqlWorkbench.vue` feeds it the effective theme.
- `WallpaperCanvas.vue` + `wallpaperCanvas.css`: one continuous cover-fit canvas,
  image/video-only opacity and blur. Hidden windows and reduced motion pause video.
- `WallpaperSettingsDialog.vue` + `wallpaperSettings.css`: preview, light/dark
  switch, radio-grid keyboard selection, local file input, visibility / blur and
  video motion controls.
- `i18n/wallpaperMessages.js`: English, Simplified Chinese and Traditional Chinese.

PNG/JPEG/WebP: at most 20 MiB. MP4: at most 100 MiB; actual playback depends on
system codecs, with H.264 recommended. Unsupported/corrupt files and failed saves
retain the previous selection. No custom files are uploaded. Custom bytes are
retained as supplied (not metadata-stripped or transcoded).

## Bundled pictures

Eight unchanged WebPs and thumbnails from Cindy (3,493,120 bytes) and four
pictures generated for Blackcat (`mist-ridges`, `night-ridges`, `frost-folds`,
`dune-night`; 177,660 bytes with thumbnails, 2048×1152 plus 320×180) ship
locally for offline use. Attribution and the Apache 2.0 license accompany them
in `public/wallpapers/`. A new bundled picture needs a `suits` value only when
it reaches full strength in that appearance.

## Upstream reference

Cindy revision `2ccd71c310c6346954cb7a5af357c757a58af785`:
`docs/design-rules/wallpaper.md`, `WallpaperSection.tsx`, `WallpaperPresenter.ts`,
`lib/wallpaper.ts` and custom wallpaper storage. Blackcat uses its own Vue and
browser-storage implementation; it does not import Cindy's Electron services,
CDN, character art or desktop transparency system.

## Verification

```sh
node --test src/workbench/wallpaperState.test.js src/workbench/wallpaperStorage.test.js src/workbench/wallpaperTone.test.js
WALLPAPER_BROWSER_TEST=1 node --test src/workbench/wallpaperStorage.test.js
node scripts/test-wallpaper-browser.mjs
node --test src/workbench/typographyTokens.test.js src/workbench/themeContrast.test.js
node node_modules/vite/bin/vite.js build
```

The UI browser test expects Vite on `http://127.0.0.1:1437` (override with
`DBSCOUT_WALLPAPER_TEST_URL`), tests Chromium and WebKit, and writes light/dark
screenshots to `/tmp/blackcat-wallpaper-review` (override with
`DBSCOUT_WALLPAPER_SCREENSHOTS`). It checks the frame with a flat-colour custom
picture: every frame strip must come out the same pixel, with the sidebar open
and closed. Native packaged MP4 codec support and the macOS sidebar blur still
need a real macOS/Windows desktop check; browser tests are not that acceptance.
