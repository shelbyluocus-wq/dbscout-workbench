//! Extra workbench windows that open the tables of one table folder.
//!
//! The main window keeps the tray, the saved tabs, the updater and the
//! external MCP connection. A folder window runs the same workbench page,
//! told by an initialization script which folder to open, shares every
//! backend connection and session store with the main window, and really
//! closes when its close button is pressed.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const TABLE_FOLDER_WINDOW_PREFIX: &str = "table-folder-";
/// Sent to an open folder window when its folder is opened again, so tables
/// added since then join the window.
pub(crate) const TABLE_FOLDER_WINDOW_OPEN_EVENT: &str = "table-folder-window-open";
/// A native macOS menu item chosen while a folder window has focus.
pub(crate) const APP_MENU_FORWARD_EVENT: &str = "app-menu-forward";

const FOLDER_WINDOW_WIDTH: f64 = 1180.0;
const FOLDER_WINDOW_HEIGHT: f64 = 780.0;
// Smaller than the main window's minimum so two windows fit side by side.
const FOLDER_WINDOW_MIN_WIDTH: f64 = 800.0;
const FOLDER_WINDOW_MIN_HEIGHT: f64 = 560.0;
const MAX_TABLES: usize = 500;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFolderWindowRequest {
    pub folder_id: String,
    #[serde(default)]
    pub folder_name: String,
    #[serde(default)]
    pub connection_id: String,
    pub database: String,
    #[serde(default)]
    pub table_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFolderWindowResult {
    /// The folder already had a window; it was brought forward instead.
    pub reused: bool,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowRolePayload<'a> {
    kind: &'static str,
    #[serde(flatten)]
    request: &'a TableFolderWindowRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppMenuForwardPayload {
    action: String,
    shortcut_action: Option<String>,
}

fn valid_folder_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn window_label(folder_id: &str) -> Result<String, String> {
    if !valid_folder_id(folder_id) {
        return Err("invalid folder id".to_string());
    }
    Ok(format!("{TABLE_FOLDER_WINDOW_PREFIX}{folder_id}"))
}

fn normalized_request(
    mut request: TableFolderWindowRequest,
) -> Result<TableFolderWindowRequest, String> {
    if request.database.trim().is_empty() {
        return Err("the folder has no database".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    request.table_names = request
        .table_names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty() && seen.insert(name.clone()))
        .take(MAX_TABLES)
        .collect();
    request.folder_name = request.folder_name.trim().chars().take(80).collect();
    Ok(request)
}

/// The script the folder window runs before the page: which folder it shows.
pub(crate) fn role_script(request: &TableFolderWindowRequest) -> Result<String, String> {
    let payload = serde_json::to_string(&WindowRolePayload {
        kind: "tableFolder",
        request,
    })
    .map_err(|error| error.to_string())?;
    Ok(format!(
        "Object.defineProperty(window, \"__DBSCOUT_WINDOW__\", {{ value: Object.freeze({payload}), configurable: false, writable: false }});"
    ))
}

fn window_title(request: &TableFolderWindowRequest) -> String {
    if request.folder_name.is_empty() {
        "黑猫".to_string()
    } else {
        format!("{} - 黑猫", request.folder_name)
    }
}

// Window creation must not run on the main thread's command path (it would
// deadlock on Windows), hence `async`.
#[tauri::command]
pub async fn open_table_folder_window(
    app: AppHandle,
    request: TableFolderWindowRequest,
) -> Result<TableFolderWindowResult, String> {
    let request = normalized_request(request)?;
    let label = window_label(&request.folder_id)?;

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        app.emit_to(label.as_str(), TABLE_FOLDER_WINDOW_OPEN_EVENT, &request)
            .map_err(|error| error.to_string())?;
        return Ok(TableFolderWindowResult { reused: true, label });
    }

    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(window_title(&request))
        .initialization_script(role_script(&request)?)
        .inner_size(FOLDER_WINDOW_WIDTH, FOLDER_WINDOW_HEIGHT)
        .min_inner_size(FOLDER_WINDOW_MIN_WIDTH, FOLDER_WINDOW_MIN_HEIGHT)
        .resizable(true)
        .center()
        .visible(false)
        .disable_drag_drop_handler();

    // Same chrome as the main window on each platform (tauri.*.conf.json).
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .transparent(true)
        .shadow(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).shadow(true);

    let window = builder.build().map_err(|error| error.to_string())?;
    crate::window_frame::soften_window_frame(&window);
    let _ = window.show();
    let _ = window.set_focus();
    Ok(TableFolderWindowResult {
        reused: false,
        label,
    })
}

/// macOS has one menu bar for the whole app, and the main window owns it.
/// When a folder window has focus, the main window hands the chosen item to
/// that window instead of acting on its own tabs. Returns whether a folder
/// window took it.
#[tauri::command]
pub fn forward_app_menu_action(
    app: AppHandle,
    action: String,
    shortcut_action: Option<String>,
) -> bool {
    let focused = app.webview_windows().into_iter().find(|(label, window)| {
        label.starts_with(TABLE_FOLDER_WINDOW_PREFIX) && window.is_focused().unwrap_or(false)
    });
    let Some((label, _)) = focused else {
        return false;
    };
    app.emit_to(
        label.as_str(),
        APP_MENU_FORWARD_EVENT,
        AppMenuForwardPayload {
            action,
            shortcut_action,
        },
    )
    .is_ok()
}

/// Only the main window hides to the tray; folder windows close.
pub(crate) fn hides_to_tray(label: &str) -> bool {
    !label.starts_with(TABLE_FOLDER_WINDOW_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(folder_id: &str) -> TableFolderWindowRequest {
        TableFolderWindowRequest {
            folder_id: folder_id.to_string(),
            folder_name: " Heroes ".to_string(),
            connection_id: "demo".to_string(),
            database: "game".to_string(),
            table_names: vec![
                "heroprop".to_string(),
                " ".to_string(),
                "heroprop".to_string(),
                "skillprop".to_string(),
            ],
        }
    }

    #[test]
    fn labels_accept_only_safe_folder_ids() {
        assert_eq!(window_label("fld-abc_1").unwrap(), "table-folder-fld-abc_1");
        assert!(window_label("").is_err());
        assert!(window_label("../main").is_err());
        assert!(window_label("a b").is_err());
        assert!(window_label(&"x".repeat(65)).is_err());
    }

    #[test]
    fn requests_drop_blank_and_repeated_tables() {
        let normalized = normalized_request(request("fld-1")).unwrap();
        assert_eq!(normalized.table_names, vec!["heroprop", "skillprop"]);
        assert_eq!(normalized.folder_name, "Heroes");
        let mut missing = request("fld-1");
        missing.database = " ".to_string();
        assert!(normalized_request(missing).is_err());
    }

    #[test]
    fn role_script_carries_the_folder_as_frozen_json() {
        let mut folder = normalized_request(request("fld-1")).unwrap();
        folder.folder_name = "a\"b</script>".to_string();
        let script = role_script(&folder).unwrap();
        assert!(script.contains("\"kind\":\"tableFolder\""));
        assert!(script.contains("\"folderId\":\"fld-1\""));
        assert!(script.contains("\"tableNames\":[\"heroprop\",\"skillprop\"]"));
        assert!(script.contains("a\\\"b</script>"));
        assert!(script.starts_with("Object.defineProperty(window, \"__DBSCOUT_WINDOW__\""));
    }

    #[test]
    fn only_the_main_window_hides_to_the_tray() {
        assert!(hides_to_tray("main"));
        assert!(!hides_to_tray("table-folder-fld-1"));
    }
}
