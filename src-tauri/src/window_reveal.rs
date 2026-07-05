use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const MAIN_WINDOW_LABEL: &str = "main";

pub(crate) trait RevealWindowOps {
    fn reveal_show(&self);
    fn reveal_unminimize(&self);
    fn reveal_focus(&self);
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
    }

    #[test]
    fn reveal_window_shows_unminimizes_and_focuses_in_order() {
        let window = FakeWindow::new();

        reveal_window(&window);

        assert_eq!(window.calls(), vec!["show", "unminimize", "focus"]);
    }
}
