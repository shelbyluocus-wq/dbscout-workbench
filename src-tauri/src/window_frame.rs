use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const MAIN_WINDOW_LABEL: &str = "main";
/// First Windows 11 build. Windows 10 paints the undecorated shadow inset as a
/// solid black frame on the left, right, and bottom; the top inset is zero, so
/// that edge stays clean. Windows 11 draws the same inset as a normal shadow.
const WINDOWS_11_FIRST_BUILD: u32 = 22_000;

/// Windows 10 cannot show an undecorated drop shadow without that black frame.
pub(crate) fn keep_system_window_shadow(windows_build: u32) -> bool {
    windows_build >= WINDOWS_11_FIRST_BUILD
}

pub(crate) fn soften_main_window_frame<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        soften_window_frame(&window);
    }
}

/// Applied while a window is still hidden, so the black frame never flashes.
/// Edge resizing stays available through the borderless hit test that runs
/// when the shadow is off.
pub(crate) fn soften_window_frame<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    if !keep_system_window_shadow(current_windows_build()) {
        let _ = window.set_shadow(false);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

#[cfg(target_os = "windows")]
fn current_windows_build() -> u32 {
    #[repr(C)]
    struct OsVersionInfoW {
        size: u32,
        major_version: u32,
        minor_version: u32,
        build_number: u32,
        platform_id: u32,
        csd_version: [u16; 128],
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
    }

    unsafe {
        let mut info = OsVersionInfoW {
            size: std::mem::size_of::<OsVersionInfoW>() as u32,
            major_version: 0,
            minor_version: 0,
            build_number: 0,
            platform_id: 0,
            csd_version: [0; 128],
        };
        if RtlGetVersion(&mut info) == 0 {
            info.build_number
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::keep_system_window_shadow;

    #[test]
    fn windows_10_drops_the_shadow_that_paints_a_black_frame() {
        assert!(!keep_system_window_shadow(19045));
        assert!(!keep_system_window_shadow(0));
    }

    #[test]
    fn windows_11_keeps_the_system_shadow() {
        assert!(keep_system_window_shadow(22000));
        assert!(keep_system_window_shadow(26100));
    }
}
