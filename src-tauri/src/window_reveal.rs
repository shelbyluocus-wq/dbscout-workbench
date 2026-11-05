use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const MAIN_WINDOW_LABEL: &str = "main";

/// Position once, while hidden. Later tray/dock reveals preserve the user's placement.
pub(crate) fn prepare_initial_window<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Some(monitor) = window.current_monitor().ok().flatten()
            .or_else(|| window.primary_monitor().ok().flatten())
        {
            let area = monitor.work_area();
            let scale = monitor.scale_factor();
            let (width, height) = initial_window_size(
                area.size.width as f64 / scale,
                area.size.height as f64 / scale,
            );
            let _ = window.set_min_size(Some(tauri::LogicalSize::new(
                1120.0_f64.min(width), 720.0_f64.min(height),
            )));
            let _ = window.set_size(tauri::LogicalSize::new(width, height));
            // Use the actual outer size so the native title bar also fits.
            if let Ok(size) = window.outer_size() {
                let x = area.position.x + (area.size.width.saturating_sub(size.width) / 2) as i32;
                let y = area.position.y + (area.size.height.saturating_sub(size.height) / 2) as i32;
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(any(target_os = "macos", test))]
fn initial_window_size(work_width: f64, work_height: f64) -> (f64, f64) {
    ((work_width - 32.0).clamp(1.0, 1280.0), (work_height - 32.0).clamp(1.0, 820.0))
}

pub(crate) trait RevealWindowOps {
    fn reveal_show(&self);
    fn reveal_unminimize(&self);
    fn reveal_focus(&self);
    fn reveal_is_visible(&self) -> bool;
    fn reveal_is_minimized(&self) -> bool;
}

impl<R: Runtime> RevealWindowOps for WebviewWindow<R> {
    fn reveal_show(&self) {
        let _ = self.show();
    }

    fn reveal_unminimize(&self) {
        let _ = self.unminimize();
    }

    fn reveal_focus(&self) {
        let _ = self.set_focus();
    }

    fn reveal_is_visible(&self) -> bool {
        self.is_visible().unwrap_or(false)
    }

    fn reveal_is_minimized(&self) -> bool {
        self.is_minimized().unwrap_or(false)
    }
}

pub(crate) fn reveal_window<W: RevealWindowOps>(window: &W) {
    window.reveal_show();
    window.reveal_unminimize();
    window.reveal_focus();
}

pub(crate) fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        reveal_window(&window);
    }
}

/// Surface the window only when it is hidden (tray) or minimized, and never
/// steal focus. External-UI actions use this so an AI driving the workbench
/// does not pop the window over whatever the user is doing.
pub(crate) fn reveal_window_passive<W: RevealWindowOps>(window: &W) {
    if window.reveal_is_visible() && !window.reveal_is_minimized() {
        return;
    }
    window.reveal_show();
    window.reveal_unminimize();
}

pub(crate) fn reveal_main_window_passive<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        reveal_window_passive(&window);
    }
}

pub(crate) fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let is_visible = window.is_visible().unwrap_or(false);
    let is_minimized = window.is_minimized().unwrap_or(false);
    if is_visible && !is_minimized {
        let _ = window.hide();
    } else {
        reveal_window(&window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn initial_size_fits_small_and_retina_work_areas() {
        assert_eq!(initial_window_size(1440.0, 875.0), (1280.0, 820.0));
        assert_eq!(initial_window_size(1280.0, 697.0), (1248.0, 665.0));
        assert_eq!(initial_window_size(1024.0, 600.0), (992.0, 568.0));
    }

    struct FakeWindow {
        calls: RefCell<Vec<&'static str>>,
    }

    impl FakeWindow {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl RevealWindowOps for FakeWindow {
        fn reveal_show(&self) {
            self.calls.borrow_mut().push("show");
        }

        fn reveal_unminimize(&self) {
            self.calls.borrow_mut().push("unminimize");
        }

        fn reveal_focus(&self) {
            self.calls.borrow_mut().push("focus");
        }

        fn reveal_is_visible(&self) -> bool {
            self.calls.borrow().contains(&"visible")
        }

        fn reveal_is_minimized(&self) -> bool {
            self.calls.borrow().contains(&"minimized")
        }
    }

    #[test]
    fn reveal_window_shows_unminimizes_and_focuses_in_order() {
        let window = FakeWindow::new();

        reveal_window(&window);

        assert_eq!(window.calls(), vec!["show", "unminimize", "focus"]);
    }

    #[test]
    fn passive_reveal_leaves_a_visible_window_alone_and_never_focuses() {
        let window = FakeWindow::new();
        window.calls.borrow_mut().push("visible");
        reveal_window_passive(&window);
        assert_eq!(window.calls(), vec!["visible"]);

        let hidden = FakeWindow::new();
        reveal_window_passive(&hidden);
        assert_eq!(hidden.calls(), vec!["show", "unminimize"]);

        let minimized = FakeWindow::new();
        minimized.calls.borrow_mut().push("visible");
        minimized.calls.borrow_mut().push("minimized");
        reveal_window_passive(&minimized);
        assert_eq!(minimized.calls(), vec!["visible", "minimized", "show", "unminimize"]);
    }
}
