# Local wallpapers

Settings → Wallpaper opens a side panel with None, twelve bundled stills and a
local custom-media library with no application-imposed count limit. The backdrop stays clear, so the window beside the panel
shows every change as it happens; the miniature at the top shows the edited
appearance and the chosen scope. Switching Light/Dark in the panel immediately
switches the app's saved appearance preference as well. No
database data, account preference or remote service is used.

Light and dark appearance each keep their own choice, visibility and blur; the
workbench shows the one that matches the current appearance (including Follow
system). A new installation starts with the recommended pair: `frost-folds` in
light at 100% visibility and `indigo-folds` in dark at 48%, both with no blur,
shown on the whole window with 56% behind content. Restore recommended pair returns to
that and static playback, but retains custom files until individually deleted.
Add accepts multiple files, as does dropping files onto the panel. Each custom
tile has an accessible delete button; deleting a selected picture clears only
appearances using that picture to None, preserving their visibility and blur.
Original source files are never deleted. Available local storage still limits
the total library size. The picker lists pictures made for the current appearance first (marked
Recommended), and offers the matching counterpart for the other appearance
(`mist-ridges` ↔ `night-ridges`, `frost-folds` ↔ `indigo-folds`,
`dune-dawn` ↔ `dune-night`).

Scope and the "behind content" amount are shared by both appearances:

- **Whole window** (default, also for settings saved before scopes existed):
  the picture shows behind every page. The content veil is
  `0.9 − 0.78 × behind content` (90% at 0, 12% at 100%). Text stays readable
  at any amount because the frame ceiling already holds on the bare picture and
  the veil only moves colours toward the workspace colour.
- **Frame only**: the original near-solid sheet (90%).

Slider changes and bundled pictures show at once and are saved behind them;
during a drag only the latest value is kept and an older save never makes the
slider jump back. A failed save puts the saved settings back and shows the
error. Custom media is shown only after its decode. The panel's arrow keys
follow the 4-column grid, and a picture or MP4 can be dropped onto the panel.

Saved settings from the single-wallpaper version (`{ id, visibility, blur }`)
apply to both appearances, so an existing choice, including None, is kept.

## Presentation rules

- The frame (title bar, activity rail, sidebar, tab strips) is transparent over
  one canvas, so it reads as a single continuous surface. Never give a frame
  pane a tint of its own: a second layer is what makes neighbouring strips differ.
- The main area sits on one rounded sheet (`--wb-wallpaper-sheet`, the
  workspace colour at `--wb-wallpaper-veil`, a percentage set on the shell);
  the inspector and the active tab use the same veil. Page backgrounds (grid,
  database home, SQL library/editor/results, table design, table folders) step
  aside for it, and so do the database home's search row and the cell detail
  panel under the grid (its glass card and time-of-day haze give way to the
  picture). The home list header and the SQL library's section headings are clear at
  rest and turn near-solid sheet colour once rows scroll beneath them. Table headers, row numbers, frozen cells, code gutters,
  selections, inputs, menus and dialogs stay opaque so scrolled content never
  shows through them.
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
  picture); individually identified custom files, shared by both appearances, in IndexedDB
  `dbscout-wallpaper-v1`. Store ArrayBuffer + MIME metadata, not Blob records
  (WebKit compatibility), and expose Blob URLs to the renderer. Legacy `custom`
  records remain available without replacing their bytes; new imports have
  independent IDs and never replace an earlier import.
- `wallpaperTone.js`: readable-opacity ceilings per appearance from sampled
  pixels. Its reference colours must stay at least as demanding as every
  bundled colour theme; the unit test enforces it.
- `composables/useWallpaper.js`: one shared store per window; deferred
  initialization. `MySqlWorkbench.vue` feeds it the effective theme.
- `WallpaperCanvas.vue` + `wallpaperCanvas.css`: one continuous cover-fit canvas,
  image/video-only opacity and blur. Hidden windows and reduced motion pause video.
- `WallpaperSettingsDialog.vue` + `wallpaperSettings.css`: the side panel —
  light/dark switch, miniature, scope / visibility / behind content / blur and
  video motion controls, radio-grid keyboard selection, local file input and
  drop target. The sidebar settings row names the picture on screen.
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
