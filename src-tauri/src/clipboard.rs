use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Reads text through the native desktop clipboard. This command is used by
/// explicit UI paste actions, where WebKit's navigator.clipboard API otherwise
/// opens a second macOS permission menu and makes the first paste look broken.
#[tauri::command]
pub fn read_clipboard_text(app: AppHandle) -> Result<String, String> {
    app.clipboard()
        .read_text()
        .map_err(|error| format!("读取剪贴板失败：{error}"))
}
