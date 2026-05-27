# Theme And Native Titlebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persisted light/dark themes that follow the operating system initially and keep the Tauri native titlebar synchronized with the Vue interface.

**Architecture:** A dedicated `useTheme` composable owns preference resolution, storage, media-query listening, and guarded native window theme calls. `MySqlWorkbench.vue` binds the resolved theme and renders one accessible floating toggle; `workbench.css` provides token-driven light and dark palettes across existing controls without changing database behavior.

**Tech Stack:** Vue 3 Composition API, Tauri 2 window API, CSS custom properties, Node.js test runner, Vite.

---

### Task 1: Define Theme State Behavior

**Files:**
- Create: `src/workbench/useTheme.test.js`
- Create: `src/workbench/composables/useTheme.js`

**Step 1: Write failing unit tests**

Require the theme helper to resolve a missing preference from `matchMedia`, restore a stored manual preference, persist toggles, react to system changes only before a manual override, and invoke a supplied native-theme adapter with each resolved theme.

**Step 2: Run the test to verify it fails**

Run: `node --test src/workbench/useTheme.test.js`

Expected: FAIL because `useTheme.js` does not exist yet.

**Step 3: Implement the composable minimally**

Export a Vue composable that stores only `"light"` or `"dark"` under a dedicated key, computes the effective theme from storage or `matchMedia("(prefers-color-scheme: dark)")`, listens for system changes while in system mode, exposes `toggleTheme()`, and calls a guarded asynchronous native sync function.

**Step 4: Run the focused test**

Run: `node --test src/workbench/useTheme.test.js`

Expected: PASS.

### Task 2: Wire The Workbench Toggle And Native Titlebar Sync

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/MySqlWorkbench.vue`

**Step 1: Write failing shell assertions**

Require `MySqlWorkbench.vue` to import and use `useTheme`, bind `data-theme` on `.mysql-workbench`, and render a bottom-right `wb-theme-toggle` button with accessible icon state.

**Step 2: Run the focused shell test to verify it fails**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because no theme root binding or toggle exists.

**Step 3: Implement component wiring**

Instantiate `useTheme`, pass a lazy native synchronizer backed by `getCurrentWindow().setTheme(theme)` when Tauri exists, bind the effective theme to the workbench root, and add an SVG sun/moon toggle button with Chinese accessible labels.

**Step 4: Run the focused shell test**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS for markup assertions before palette assertions are added.

### Task 3: Build The Light And Dark Palettes

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/workbench.css`

**Step 1: Write failing style assertions**

Require a `[data-theme="dark"]` token override, both `color-scheme` values, themed toggle styles, and token use for major surfaces that currently contain hard-coded light fills.

**Step 2: Run the focused shell test to verify it fails**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because dark palette and toggle styles do not exist.

**Step 3: Implement theme tokens and scoped replacements**

Add semantic surface/control/selection/text tokens to the light palette, override them for dark mode, replace visible hard-coded light fills across the workbench with those tokens, and style the floating icon button with focus-visible and hover states.

**Step 4: Run the focused shell test**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 4: Verify Behavior And Presentation

**Files:**
- No additional code changes expected.

**Step 1: Run all frontend tests**

Run: `node --test src/workbench/*.test.js`

Expected: All tests pass with zero failures.

**Step 2: Build the frontend**

Run: `npm run build`

Expected: Vite build exits with code 0.

**Step 3: Validate both theme views**

Open the local Vite UI, click the bottom-right theme icon, and check that light and dark modes preserve grid readability, active-cell contrast, and unobstructed status content.

**Step 4: Validate native window mode when available**

Open the Tauri development app and confirm the Windows titlebar switches to the same light or dark theme as the content after pressing the theme control.
