import { createWallpaperState } from "../wallpaperState.js";

export {
  WALLPAPERS, WALLPAPER_APPEARANCES, WALLPAPER_DEFAULTS, WALLPAPER_SCOPES, wallpaperContentVeil, WALLPAPER_LIMITS, WALLPAPER_ERROR_KEYS,
} from "../wallpaperState.js";

// One store per window, shared by the shell and settings panel. Component
// unmounts must not dispose it: another consumer can still be displaying its URL.
// No work occurs until first use; initialization is deferred to the next task.
let shared;
export function useWallpaper() {
  return shared ||= createWallpaperState();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    shared?.dispose();
    shared = undefined;
  });
}
