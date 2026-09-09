mod account;
mod agent;
mod agent_runtime;
mod audit;
mod audit_sync;
mod backup;
mod batch_import;
mod clickhouse;
mod mongodb;
mod clipboard;
mod commands;
mod control_server;
mod database_sync_jobs;
mod db;
mod ddl;
mod demo;
mod mysql_column_types;
mod mysql_text;
mod natural_sort;
mod path_reveal;
mod perf;
mod perf_fixture;
mod replace;
pub mod runtime_resources;
pub mod schema_cache;
mod sql_console;
mod sql_history;
mod svn_updater;
mod sync;
mod sync_guard;
mod sync_verification;
mod system_fonts;
mod table_copy;
pub mod table_count;
mod table_design_validation;
mod table_replace;
pub mod table_search;
mod table_sessions;
mod table_transfer;
mod table_xlsx;
pub mod types;
mod validation;
mod window_reveal;
pub mod work_scheduler;

pub use types::AppState;

#[doc(hidden)]
pub mod integration_api {
    pub use crate::db::{
        connect_table_count_database, read_db_page_in_database,
        read_db_search_scan_page_in_database, read_db_table_count_in_database, read_schema,
        read_schemas_for_tables,
    };
}

use tauri_plugin_global_shortcut::GlobalShortcutExt;

const MCP_HEADLESS_ARG: &str = "--mcp-headless";

fn has_mcp_headless_arg<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|argument| argument.as_ref() == MCP_HEADLESS_ARG)
}

#[cfg(test)]
mod launch_mode_tests {
    use super::has_mcp_headless_arg;

    #[test]
    fn only_the_exact_mcp_headless_argument_hides_the_window() {
        assert!(has_mcp_headless_arg(["blackcat", "--mcp-headless"]));
        assert!(!has_mcp_headless_arg(["blackcat", "--mcp-headless=false"]));
        assert!(!has_mcp_headless_arg(["blackcat"]));
    }
}

pub fn run() {
    let launch_headless = has_mcp_headless_arg(std::env::args());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Concurrent MCP clients can race while starting the hidden host.
            // A second headless launch must not unexpectedly reveal the UI.
            if !has_mcp_headless_arg(argv.iter()) {
                window_reveal::reveal_main_window(app);
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::new())
        .manage(control_server::ControlServerState::default())
        .on_window_event(|window, event| {
            // Intercept the close button: hide to tray instead of quitting.
            // A real exit is only available from the tray menu (#10).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            // The configured main window starts hidden to avoid a flash during
            // MCP-only startup. Ordinary launches reveal it immediately.
            if !launch_headless {
                window_reveal::reveal_main_window(app.handle());
            }
            let handle = app.handle().clone();

            // System tray: provides "显示主窗口" and "退出" entries so the user
            // can fully quit the app after the close button is repurposed to
            // hide-to-tray (#10).
            let show_item = tauri::menu::MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show_item, &quit_item])?;
            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        window_reveal::reveal_main_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Double-click the tray icon to reveal the window.
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        window_reveal::reveal_main_window(&app);
                    }
                })
                .build(app)?;

            // Global shortcut "Alt+Shift+F" toggles the main window: shows+focuses
            // it when hidden/minimized, hides it when visible. Default binding;
            // the settings dialog can rebind it at runtime via
            // register_global_shortcut (#9). "Alt+Shift+F" is used instead of
            // the earlier "Shift+F" because the latter collides with input
            // methods / screenshot tools on Windows. Registration is
            // best-effort: if another app already owns the binding, we log and
            // continue rather than aborting startup.
            let shortcut_handle = app.handle().clone();
            if let Err(error) = app
                .global_shortcut()
                .on_shortcut("Alt+Shift+F", move |_app, _shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    window_reveal::toggle_main_window(&shortcut_handle);
                })
            {
                eprintln!("[dbscout] 全局快捷键 Alt+Shift+F 注册失败(可能已被其他程序占用): {error}; 主窗口快捷键本次不可用,其余功能不受影响");
            }

            tauri::async_runtime::spawn(async move {
                backup::scheduler::run(handle).await;
            });
            // Background outbox sync: pushes local audit rows to the central
            // server every 30s. No-op when logged out / unconfigured.
            audit_sync::spawn_background_sync(app.handle().clone());
            svn_updater::spawn_background_checks(app.handle().clone());
            // Table-session janitor: prunes idle-expired sessions every 60s and
            // emits `table-sessions-invalidated` so the frontend can reopen
            // affected tabs instead of surfacing a dead-session error.
            commands::spawn_table_session_janitor(app.handle().clone());
            // Loopback control endpoint powering the external MCP server
            // (read-only DB tools + UI navigation, token gated).
            control_server::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clipboard::read_clipboard_text,
            commands::svn_update_get_config,
            commands::svn_update_pick_directory,
            commands::svn_update_check,
            commands::svn_update_install,
            commands::svn_update_open_directory,
            commands::table_transfer_pick_script,
            commands::table_transfer_pick_project_dir,
            commands::table_transfer_discover_paths,
            commands::table_transfer_run,
            commands::table_transfer_cancel,
            commands::agent_runtime_status,
            commands::agent_runtime_check,
            commands::agent_runtime_install,
            commands::list_system_fonts,
            commands::perf_begin_run,
            commands::perf_snapshot,
            commands::perf_end_run,
            commands::perf_fixture_metadata,
            commands::perf_fixture_reset,
            commands::list_connections,
            commands::preview_database_sync,
            commands::sync_database_overwrite,
            commands::cancel_database_sync,
            commands::copy_tables,
            commands::rename_table,
            commands::drop_tables,
            commands::list_databases,
            commands::select_database,
            commands::list_tables,
            commands::get_table_schemas,
            commands::get_table_schema,
            commands::get_table_design,
            commands::preview_table_design_change,
            commands::cancel_table_design_validation,
            commands::apply_table_design_change,
            commands::open_table_session,
            commands::close_table_session,
            commands::fetch_table_page,
            commands::fetch_table_count,
            commands::cancel_table_count,
            commands::begin_table_search,
            commands::next_table_search_page,
            commands::cancel_table_search,
            commands::update_cell,
            commands::update_cells,
            commands::replace_in_table,
            commands::find_in_table,
            commands::insert_row,
            commands::import_rows,
            commands::replace_table_rows,
            commands::delete_rows,
            commands::search_values,
            commands::quick_search,
            commands::test_connection,
            commands::add_connection,
            commands::restore_connection,
            commands::remove_connection,
            commands::save_export_file,
            commands::save_export_files,
            commands::save_text_file,
            commands::list_audit_logs,
            commands::clear_audit_logs,
            commands::rollback_audit_entry,
            commands::list_snapshots,
            commands::create_snapshot,
            commands::restore_snapshot,
            commands::inspect_snapshot_file,
            commands::import_snapshot,
            commands::get_backup_config,
            commands::set_backup_config,
            commands::prune_snapshots,
            commands::delete_snapshot,
            commands::open_backup_path,
            commands::pick_backup_directory,
            commands::set_snapshot_enabled,
            commands::agent_start_session,
            commands::agent_send,
            commands::agent_abort,
            commands::agent_approve_tool,
            commands::agent_deny_tool,
            commands::agent_set_mode,
            commands::agent_set_auto_approve,
            commands::agent_list_sessions,
            commands::agent_delete_session,
            commands::agent_get_session_messages,
            agent::artifact::agent_open_artifact,
            agent::artifact::agent_reveal_artifact,
            path_reveal::reveal_local_path,
            commands::agent_pick_project_directory,
            commands::agent_validate_project_directory,
            commands::get_account,
            commands::set_account_server,
            commands::register_account,
            commands::login_account,
            commands::logout_account,
            commands::list_shared_audit_logs,
            commands::sync_audit_now,
            commands::register_global_shortcut,
            commands::unregister_global_shortcut,
            sql_console::start_sql_execution,
            sql_console::cancel_sql_execution,
            sql_console::begin_sql_transaction,
            sql_console::commit_sql_transaction,
            sql_console::rollback_sql_transaction,
            sql_console::open_sql_file,
            sql_console::save_sql_file,
            sql_console::save_sql_result_file,
            sql_history::list_sql_history,
            sql_history::save_sql_favorite,
            sql_history::delete_sql_history,
            sql_history::clear_sql_history,
            control_server::get_external_mcp_status,
            control_server::set_external_mcp_enabled,
            control_server::control_frontend_ready,
            control_server::control_frontend_unready,
            control_server::control_update_context,
            control_server::control_complete_ui_action,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build 黑猫")
        .run(|_app, _event| {
            if let tauri::RunEvent::Exit = _event {
                control_server::cleanup_discovery_file(_app);
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                window_reveal::reveal_main_window(_app);
            }
        });
}
