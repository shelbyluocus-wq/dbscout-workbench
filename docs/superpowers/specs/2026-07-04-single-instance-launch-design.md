# Single-Instance Launch Design

Date: 2026-07-04

## Goal

黑猫 should only have one active app instance at a time. If the user starts 黑猫 again while it is already running, the existing main window should be revealed and focused instead of opening a second app window.

## User Experience

- First launch behaves exactly as it does today.
- A second launch does not show a duplicate window and does not display a warning.
- If the existing window is hidden to tray, minimized, or behind other windows, it is shown, unminimized, and focused.
- This matches the existing tray “显示主窗口” and global shortcut reveal behavior, so all “bring 黑猫 back” entry points feel consistent.

## Recommended Approach

Use Tauri's official single-instance plugin rather than a custom lock file or platform-specific mutex.

Why this approach:

- It is designed for the desktop app lifecycle and supports the project's Windows + macOS target.
- It avoids stale lock-file and abnormal-exit edge cases.
- It keeps the behavior close to Tauri's supported patterns and lowers future maintenance cost.

Rejected alternatives:

- Custom file/process lock: workable, but more fragile across crashes and platforms.
- Windows-only mutex: reliable on Windows, but would require a separate macOS path and could create inconsistent behavior.

## Backend Design

Add a small shared helper for revealing the main window. It should:

1. Find the `main` webview window.
2. Call `show()`.
3. Call `unminimize()`.
4. Call `set_focus()`.
5. Ignore individual best-effort failures, matching the existing tray and shortcut behavior.

Use this helper from:

- Tray menu “显示主窗口”.
- Tray icon double-click.
- Global shortcut reveal path.
- Runtime global shortcut registration in commands.
- The single-instance callback when a second launch is detected.

Register the Tauri single-instance plugin early in the builder chain so the second launch is handled before a duplicate window is created.

## Error Handling

The second-launch callback should be silent from the user's perspective. If focusing fails because the OS denies focus stealing or the window is briefly unavailable, the app should continue running normally. This is consistent with current reveal behavior, which treats window operations as best-effort.

## Testing and Verification

Implementation should include a focused Rust unit test around the shared reveal helper's call sequencing through an injectable window abstraction. This protects the intended behavior without needing to launch two desktop processes inside the test runner.

Manual verification should cover:

1. Launch 黑猫 once.
2. Launch 黑猫 a second time.
3. Confirm no duplicate window appears.
4. Hide/minimize the existing window and launch again.
5. Confirm the existing window is shown and focused.

Run the relevant Rust check/test command after implementation.