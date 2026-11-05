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
