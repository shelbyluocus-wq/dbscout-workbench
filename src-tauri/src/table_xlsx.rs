use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rust_xlsxwriter::{Format, Workbook};

const EXCEL_MAX_CELL_CHARS: usize = 32_767;
const EXCEL_MAX_DATA_ROWS_PER_SHEET: usize = 1_048_575;

pub type XlsxRow = HashMap<String, Option<String>>;

fn safe_path_component(value: &str, fallback: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_string();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn safe_sheet_name(value: &str, fallback: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|ch| match ch {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();
    let sanitized = sanitized.trim_matches('\'').trim();
    let source = if sanitized.is_empty() {
        fallback
    } else {
        sanitized
    };
    source.chars().take(31).collect()
}

fn validate_cell(value: &str, column: &str, row_number: usize) -> Result<(), String> {
    if value.chars().count() > EXCEL_MAX_CELL_CHARS {
        return Err(format!(
            "原表第 {row_number} 行字段 {column} 超过 Excel 单元格 32767 字符上限，无法生成完整 XLSX 备份"
        ));
    }
    Ok(())
}

fn write_workbook(
    path: &Path,
    table_name: &str,
    columns: &[String],
    rows: &[XlsxRow],
) -> Result<(), String> {
    if columns.is_empty() {
        return Err("目标表没有可导出的字段".to_string());
    }

    let mut workbook = Workbook::new();
    let header_format = Format::new().set_bold();
    let sheet_count = rows.len().max(1).div_ceil(EXCEL_MAX_DATA_ROWS_PER_SHEET);

    for sheet_index in 0..sheet_count {
        let worksheet = workbook.add_worksheet();
        let base_name = safe_sheet_name(table_name, "Table");
        let sheet_name = if sheet_count == 1 {
            base_name
        } else {
            let suffix = format!("_{}", sheet_index + 1);
            let keep = 31usize.saturating_sub(suffix.chars().count());
            format!(
                "{}{}",
                base_name.chars().take(keep).collect::<String>(),
                suffix
            )
        };
        worksheet
            .set_name(&sheet_name)
            .map_err(|error| format!("设置 XLSX 工作表名称失败: {error}"))?;

        for (column_index, column) in columns.iter().enumerate() {
            worksheet
                .write_string_with_format(0, column_index as u16, column, &header_format)
                .map_err(|error| format!("写入 XLSX 表头失败: {error}"))?;
        }

        let start = sheet_index * EXCEL_MAX_DATA_ROWS_PER_SHEET;
        let end = (start + EXCEL_MAX_DATA_ROWS_PER_SHEET).min(rows.len());
        for (local_index, row) in rows[start..end].iter().enumerate() {
            let excel_row = (local_index + 1) as u32;
            for (column_index, column) in columns.iter().enumerate() {
                let Some(Some(value)) = row.get(column) else {
                    continue;
                };
                validate_cell(value, column, start + local_index + 2)?;
                worksheet
                    .write_string(excel_row, column_index as u16, value)
                    .map_err(|error| format!("写入 XLSX 数据失败: {error}"))?;
            }
        }
    }

    let temp_path = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    workbook
        .save(&temp_path)
        .map_err(|error| format!("生成 XLSX 文件失败: {error}"))?;
    std::fs::rename(&temp_path, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        format!("保存 XLSX 文件失败: {error}")
    })
}

fn import_backup_root() -> Result<PathBuf, String> {
    let agent_dir = crate::agent::artifact::ensure_output_dir()?;
    let product_dir = agent_dir
        .parent()
        .ok_or_else(|| "无法确定黑猫文档目录".to_string())?;
    Ok(product_dir.join("Import Backups"))
}

fn unique_xlsx_path(
    root: &Path,
    database: &str,
    table_name: &str,
    suffix: &str,
) -> Result<PathBuf, String> {
    let database_dir = root.join(safe_path_component(database, "database"));
    std::fs::create_dir_all(&database_dir)
        .map_err(|error| format!("创建 XLSX 输出目录失败: {error}"))?;
    let table = safe_path_component(table_name, "table");
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
    Ok(database_dir.join(format!("{table}_{suffix}_{timestamp}.xlsx")))
}

pub fn write_import_backup(
    database: &str,
    table_name: &str,
    columns: &[String],
    rows: &[XlsxRow],
) -> Result<String, String> {
    let path = unique_xlsx_path(
        &import_backup_root()?,
        database,
        table_name,
        "before_import",
    )?;
    write_workbook(&path, table_name, columns, rows)
        .map_err(|error| format!("原表 XLSX 备份失败，导入已取消: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

pub async fn write_import_backup_async(
    database: String,
    table_name: String,
    columns: Vec<String>,
    rows: Vec<XlsxRow>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        write_import_backup(&database, &table_name, &columns, &rows)
    })
    .await
    .map_err(|error| format!("原表 XLSX 备份任务失败，导入已取消: {error}"))?
}

pub fn write_agent_export(
    database: &str,
    table_name: &str,
    columns: &[String],
    rows: &[XlsxRow],
) -> Result<String, String> {
    let root = crate::agent::artifact::ensure_output_dir()?;
    let path = unique_xlsx_path(&root, database, table_name, "export")?;
    write_workbook(&path, table_name, columns, rows)?;
    Ok(path.to_string_lossy().to_string())
}

pub async fn write_agent_export_async(
    database: String,
    table_name: String,
    columns: Vec<String>,
    rows: Vec<XlsxRow>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || write_agent_export(&database, &table_name, &columns, &rows))
        .await
        .map_err(|error| format!("XLSX 导出任务失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_windows_paths_and_excel_sheet_names() {
        assert_eq!(safe_path_component("a:b/c", "x"), "a_b_c");
        assert_eq!(safe_sheet_name("a:b/c", "x"), "a_b_c");
        assert_eq!(safe_sheet_name("", "Table"), "Table");
    }

    #[test]
    fn rejects_cells_that_cannot_be_preserved_in_xlsx() {
        let oversized = "a".repeat(EXCEL_MAX_CELL_CHARS + 1);
        assert!(validate_cell(&oversized, "notes", 2)
            .unwrap_err()
            .contains("32767"));
    }

    #[test]
    fn writes_a_real_xlsx_workbook_with_headers_and_rows() {
        let path = std::env::temp_dir().join(format!(
            "blackcat-table-xlsx-test-{}.xlsx",
            uuid::Uuid::new_v4().simple()
        ));
        let columns = vec!["id".to_string(), "name".to_string()];
        let rows = vec![HashMap::from([
            ("id".to_string(), Some("1".to_string())),
            ("name".to_string(), Some("黑猫".to_string())),
        ])];

        write_workbook(&path, "player", &columns, &rows).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"PK"));
        assert!(bytes.len() > 1_000);
        std::fs::remove_file(path).unwrap();
    }
}
