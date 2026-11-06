// macOS appearance/behaviour integration. Currently exposes the system
// "double-click a window's title bar to" setting so the custom titlebar can
// mimic native apps.

/// Maps `defaults read -g AppleActionOnDoubleClick` output to the actions the
/// frontend understands. Missing or unrecognized values fall back to "zoom"
/// (the historical system default).
pub fn normalize_double_click_action(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "minimize" | "minimise" => "minimize",
        "none" => "none",
        // "fill" (macOS 15+) resizes to fill the screen; closest in-app
        // behaviour is the same toggle we use for zoom.
        "maximize" | "zoom" | "fill" => "zoom",
        _ => "zoom",
    }
}

#[cfg(target_os = "macos")]
fn parse_defaults_output(output: &std::process::Output) -> Option<String> {
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

// Async so `defaults` never blocks the main thread — this runs on every
// window focus.
#[tauri::command]
pub async fn macos_titlebar_double_click_action() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = tokio::process::Command::new("defaults")
            .args(["read", "-g", "AppleActionOnDoubleClick"])
            .output()
            .await
        {
            if let Some(raw) = parse_defaults_output(&output) {
                return normalize_double_click_action(&raw).to_string();
            }
        }
    }
    "zoom".to_string()
}

// Maps `defaults read -g AppleAccentColor` (an integer) to the accent hex.
// Missing key / unknown values fall back to system blue.
pub fn accent_hex_for(value: Option<i64>) -> &'static str {
    match value {
        Some(-1) => "#8C8C8C",
        Some(0) => "#FF5257",
        Some(1) => "#F7821B",
        Some(2) => "#FFC600",
        Some(3) => "#62BA46",
        Some(5) => "#A550A7",
        Some(6) => "#F74F9E",
        // 4 = blue (default); also the fallback for missing/unknown.
        _ => "#007AFF",
    }
}

// Async so `defaults` never blocks the main thread — re-read on window focus.
#[tauri::command]
pub async fn macos_accent_color() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = tokio::process::Command::new("defaults")
            .args(["read", "-g", "AppleAccentColor"])
            .output()
            .await
        {
            if let Some(raw) = parse_defaults_output(&output) {
                if let Ok(n) = raw.parse::<i64>() {
                    return accent_hex_for(Some(n)).to_string();
                }
            }
        }
    }
    accent_hex_for(None).to_string()
}

#[tauri::command]
pub fn macos_align_traffic_lights(
    window: tauri::WebviewWindow,
    titlebar_height: f64,
) -> Result<(), String> {
    if !titlebar_height.is_finite() || !(20.0..=160.0).contains(&titlebar_height) {
        return Err("Invalid titlebar height".into());
    }
    #[cfg(target_os = "macos")]
    window
        .with_webview(move |webview| unsafe {
            use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
            use objc2_foundation::NSPoint;

            let Some(native_window) = webview.ns_window().cast::<NSWindow>().as_ref() else {
                return;
            };
            if native_window
                .styleMask()
                .contains(NSWindowStyleMask::FullScreen)
            {
                return;
            }
            let Some(close) = native_window.standardWindowButton(NSWindowButton::CloseButton) else {
                return;
            };
            let Some(container) = close.superview().and_then(|view| view.superview()) else {
                return;
            };
            let mut frame = container.frame();
            frame.size.height = titlebar_height;
            frame.origin.y = native_window.frame().size.height - titlebar_height;
            container.setFrame(frame);
            let center = NSPoint::new(
                0.0,
                native_window.frame().size.height - titlebar_height / 2.0,
            );
            let spacing = native_window
                .standardWindowButton(NSWindowButton::MiniaturizeButton)
                .map(|button| button.frame().origin.x - close.frame().origin.x)
                .unwrap_or(20.0);
            for (index, kind) in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ]
            .into_iter()
            .enumerate()
            {
                if let Some(button) = native_window.standardWindowButton(kind) {
                    if let Some(parent) = button.superview() {
                        let local_center = parent.convertPoint_fromView(center, None);
                        let mut origin = button.frame().origin;
                        origin.x = 13.0 + index as f64 * spacing;
                        origin.y = local_center.y - button.frame().size.height / 2.0;
                        button.setFrameOrigin(origin);
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{accent_hex_for, normalize_double_click_action};

    #[test]
    fn parses_system_defaults_values() {
        assert_eq!(normalize_double_click_action("Minimize"), "minimize");
        assert_eq!(normalize_double_click_action("minimize\n"), "minimize");
        assert_eq!(normalize_double_click_action("None"), "none");
        assert_eq!(normalize_double_click_action("Maximize"), "zoom");
        assert_eq!(normalize_double_click_action("Fill"), "zoom");
    }

    #[test]
    fn accent_mapping_matches_system_palette() {
        assert_eq!(accent_hex_for(None), "#007AFF");
        assert_eq!(accent_hex_for(Some(-1)), "#8C8C8C");
        assert_eq!(accent_hex_for(Some(0)), "#FF5257");
        assert_eq!(accent_hex_for(Some(1)), "#F7821B");
        assert_eq!(accent_hex_for(Some(2)), "#FFC600");
        assert_eq!(accent_hex_for(Some(3)), "#62BA46");
        assert_eq!(accent_hex_for(Some(4)), "#007AFF");
        assert_eq!(accent_hex_for(Some(5)), "#A550A7");
        assert_eq!(accent_hex_for(Some(6)), "#F74F9E");
        assert_eq!(accent_hex_for(Some(99)), "#007AFF");
    }

    #[test]
    fn unknown_or_empty_values_fall_back_to_zoom() {
        assert_eq!(normalize_double_click_action(""), "zoom");
        assert_eq!(normalize_double_click_action("  "), "zoom");
        assert_eq!(normalize_double_click_action("unexpected"), "zoom");
    }
}
