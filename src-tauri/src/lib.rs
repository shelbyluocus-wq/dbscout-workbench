mod commands;
mod db;
mod ddl;
mod demo;
mod sync;
mod validation;
pub mod types;

pub use types::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
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
            commands::add_connection,
            commands::restore_connection,
            commands::save_export_file,
            commands::save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DB Scout Workbench");
}
