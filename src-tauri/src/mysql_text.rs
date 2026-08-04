use sqlx::{mysql::MySqlRow, ColumnIndex, Error, Row};

/// Decode a value whose SQL semantics are known to be text.
///
/// MySQL 8.4 can mark INFORMATION_SCHEMA object names with the binary flag.
/// SQLx 0.8.6 rejects those values before its UTF-8 decoder runs, even though
/// the payload is valid text. The unchecked API skips only that compatibility
/// preflight; the normal String decoder still validates the payload.
pub fn string<I>(row: &MySqlRow, index: I) -> Result<String, Error>
where
    I: ColumnIndex<MySqlRow>,
{
    row.try_get_unchecked(index)
}

pub fn optional_string<I>(row: &MySqlRow, index: I) -> Result<Option<String>, Error>
where
    I: ColumnIndex<MySqlRow>,
{
    row.try_get_unchecked(index)
}
