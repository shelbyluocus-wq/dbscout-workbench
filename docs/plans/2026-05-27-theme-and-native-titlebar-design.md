# Theme And Native Titlebar Design

**Status:** Approved on 2026-05-27

## Goal

Make the native titlebar feel like part of the workbench instead of a separate dark strip, and add a restrained dark mode that preserves the compact Navicat-like database workflow.

## Confirmed Behavior

- The initial theme follows the operating system when the user has not made a choice.
- Clicking the theme control switches between light and dark mode and saves that manual preference.
- A saved manual preference wins over later operating-system theme changes.
- With no manual preference, changes to the operating-system theme update the running app.
- The native Tauri titlebar and the Vue content area always receive the same resolved light or dark theme.

## Visual Direction

- Preserve the existing restrained desktop workbench composition, sizing, and teal accent.
- Keep light mode close to the current cool gray translucent surface palette, with the native titlebar explicitly set to light.
- Add a dark palette based on charcoal window surfaces, quiet separators, readable cool-gray text, and teal focus/selection accents.
- Apply theme tokens across the navigation tree, tabs, toolbar, grid, inspector, dialogs, menus, text editor, status bar, controls, and native scrollbar styling.
- Place one unobtrusive floating theme button at the bottom-right edge above the status bar. It uses an adaptive sun/moon SVG icon and an accessible label rather than a text toggle.

## Architecture

- Create `src/workbench/composables/useTheme.js` as the only owner of theme preference persistence, operating-system matching, and optional Tauri native theme synchronization.
- Keep `MySqlWorkbench.vue` responsible only for consuming the composable, exposing the resolved theme on the root workbench element, and rendering the toggle control.
- Drive both palettes from `--wb-*` CSS custom properties. Dark mode overrides tokens at the root `data-theme="dark"` boundary rather than duplicating component layout rules.
- Dynamically import the Tauri window API only when running inside Tauri so browser-only Vite development continues without errors.

## Failure Handling

- If `localStorage` is blocked or contains an unknown value, fall back to the system preference.
- If the native Tauri theme call is unavailable or fails in browser-only development, keep the resolved web theme working without surfacing a UI error.

## Verification

- Unit-test preference loading, system fallback, manual persistence, and native theme application behavior.
- Extend shell assertions for the root theme binding, right-bottom icon button, and dark token boundary.
- Run all frontend Node tests and the Vite production build.
- Open the browser UI to inspect light and dark layouts; run the desktop app when feasible to confirm the Windows native titlebar follows the selected mode.
