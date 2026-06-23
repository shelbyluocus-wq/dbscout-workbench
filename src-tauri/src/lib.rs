mod agent;
mod audit;
mod backup;
mod clickhouse;
mod commands;
mod db;
mod ddl;
mod demo;
mod sync;
pub mod types;
mod validation;

pub use types::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                backup::scheduler::run(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::preview_database_sync,
            commands::sync_database_overwrite,
            commands::copy_tables,
            commands::rename_table,
            commands::list_databases,
            commands::select_database,
            commands::list_tables,
            commands::get_table_schema,
            commands::get_table_design,
            commands::preview_table_design_change,
            commands::apply_table_design_change,
            commands::open_table_session,
            commands::fetch_table_page,
            commands::update_cell,
            commands::insert_row,
            commands::delete_rows,
            commands::search_values,
            commands::quick_search,
            commands::test_connection,
            commands::add_connection,
            commands::restore_connection,
            commands::remove_connection,
            commands::save_export_file,
            commands::save_text_file,
            commands::list_audit_logs,
            commands::rollback_audit_entry,
            commands::list_snapshots,
            commands::create_snapshot,
            commands::restore_snapshot,
            commands::get_backup_config,
            commands::set_backup_config,
            commands::prune_snapshots,
            commands::delete_snapshot,
            commands::pick_backup_directory,
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DB Scout Workbench");
}
