mod account;
mod agent;
mod agent_runtime;
mod audit;
mod audit_history;
mod audit_postimage;
mod audit_restore;
mod audit_sync;
mod backup;
mod batch_import;
mod clickhouse;
mod mongodb;
mod clipboard;
mod cocos_build;
mod commands;
mod config_relations;
mod control_server;
mod database_sync_jobs;
mod db;
mod macos_appearance;
mod ddl;
mod demo;
mod mysql_column_types;
mod mysql_text;
mod natural_sort;
mod path_reveal;
mod perf;
mod perf_fixture;
mod release_paths;
mod replace;
pub mod runtime_resources;
pub mod schema_cache;
mod sql_console;
mod sql_history;
mod svn_updater;
mod svn_client;
mod svn_workspace;
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
#[cfg(test)]
mod test_temp_dir;
pub mod types;
mod validation;
mod window_frame;
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

mod control_table_tools;

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
            // Windows 10's undecorated shadow is a black frame on three sides;
            // drop it before the first reveal.
            window_frame::soften_main_window_frame(app.handle());
            window_reveal::prepare_initial_window(app.handle());
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
            // macOS tints the transparent template for the menu bar's actual
            // background, independently of the workbench's light/dark theme.
            #[cfg(target_os = "macos")]
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-template.png"
            ))?;
            #[cfg(not(target_os = "macos"))]
            let tray_icon = app.default_window_icon().cloned().unwrap();
            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(cfg!(target_os = "macos"))
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
                    // A single primary click opens and focuses the workbench;
                    // secondary clicks remain available for the tray menu.
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
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
            config_relations::commands::config_relations_overview,
            config_relations::commands::config_relations_table,
            config_relations::commands::config_relations_graph,
            config_relations::commands::config_relations_row_targets,
            config_relations::commands::config_relations_row_references,
            config_relations::commands::config_relations_review_list,
            config_relations::commands::config_relations_review,
            config_relations::commands::config_relations_refresh,
            config_relations::commands::config_relations_discover_clients,
            config_relations::commands::config_relations_inspect_client,
            config_relations::commands::config_relations_bind_client,
            config_relations::commands::config_relations_unbind_client,
            config_relations::commands::config_relations_pick_client_dir,
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
            audit_history::list_audit_tables,
            audit_history::list_audit_operations,
            audit_history::list_audit_operation_details,
            audit_restore::preview_audit_table_restore,
            audit_restore::restore_audit_table,
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
            path_reveal::reveal_local_path,
            release_paths::release_pick_exclusion,
            svn_workspace::svn_wc_info,
            svn_workspace::svn_wc_status,
            svn_workspace::svn_wc_file_diff,
            svn_workspace::svn_wc_commit,
            svn_workspace::svn_wc_revert,
            svn_workspace::svn_wc_resolve,
            svn_workspace::svn_wc_log,
            svn_workspace::svn_wc_pick_folder,
            cocos_build::cocos_inspect_project,
            cocos_build::cocos_find_editors,
            cocos_build::cocos_output_status,
            cocos_build::cocos_build_start,
            cocos_build::cocos_build_cancel,
            cocos_build::cocos_pick_editor,
            cocos_build::cocos_pick_project,
            cocos_build::cocos_pick_config,
            commands::get_account,
            commands::set_account_server,
            commands::register_account,
            commands::login_account,
            commands::logout_account,
            commands::list_shared_audit_logs,
            commands::sync_audit_now,
            commands::register_global_shortcut,
            commands::unregister_global_shortcut,
            macos_appearance::macos_titlebar_double_click_action,
            macos_appearance::macos_accent_color,
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
            control_server::set_external_mcp_permissions,
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
