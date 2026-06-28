pub enum ReadOnlyLimit {
    Inject(u32),
    None,
}

pub fn validate_read_only_sql(sql: &str, limit: ReadOnlyLimit) -> Result<String, String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL is empty".to_string());
    }

    // Reject multiple statements.
    let without_strings = mask_quoted_strings(trimmed);
    if without_strings
        .split(';')
        .filter(|part| !part.trim().is_empty())
        .count()
        > 1
    {
        return Err("multiple SQL statements are not allowed".to_string());
    }

    // Require SELECT.
    let first_word = without_strings
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if first_word != "SELECT" {
        return Err(format!(
            "read-only queries must start with SELECT, got: {}",
            first_word
        ));
    }

    // Reject dangerous keywords.
    let upper = without_strings.to_ascii_uppercase();
    let forbidden = [
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "DROP",
        "CREATE",
        "ALTER",
        "RENAME",
        "GRANT",
        "REVOKE",
        "EXECUTE",
        "CALL",
        "LOAD_FILE",
        "INTO OUTFILE",
        "INTO DUMPFILE",
    ];
    for keyword in forbidden {
        if upper.contains(keyword) {
            return Err(format!("forbidden keyword in read-only query: {}", keyword));
        }
    }

    let mut result = trimmed.to_string();
    if let ReadOnlyLimit::Inject(limit_value) = limit {
        result = inject_limit(&result, limit_value)?;
    }

    Ok(result)
}

pub fn mask_quoted_strings(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\'' {
            out.push('\'');
            while let Some(inner) = chars.next() {
                out.push('?');
                if inner == '\\' {
                    if let Some(_next) = chars.next() {
                        out.push('?');
                    }
                } else if inner == '\'' {
                    break;
                }
            }
        } else if ch == '"' {
            out.push('"');
            while let Some(inner) = chars.next() {
                out.push('?');
                if inner == '\\' {
                    if let Some(_next) = chars.next() {
                        out.push('?');
                    }
                } else if inner == '"' {
                    break;
                }
            }
        } else if ch == '`' {
            out.push('`');
            while let Some(inner) = chars.next() {
                out.push(if inner == '`' { '`' } else { '?' });
                if inner == '`' {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn inject_limit(sql: &str, limit: u32) -> Result<String, String> {
    let masked = mask_quoted_strings(sql);
    let upper_masked = masked.to_ascii_uppercase();

    if let Some(limit_pos) = find_top_level_limit(&upper_masked) {
        let after_limit = &sql[limit_pos + 5..];
        let number = after_limit
            .trim()
            .split_whitespace()
            .next()
            .and_then(|token| token.parse::<u32>().ok())
            .ok_or_else(|| "invalid LIMIT clause".to_string())?;
        if number > limit {
            let before = &sql[..limit_pos];
            let rest = &sql[limit_pos + 5..];
            let rest_trimmed = rest.trim_start();
            let after_number = rest_trimmed
                .find(|ch: char| !ch.is_ascii_digit())
                .map(|idx| &rest_trimmed[idx..])
                .unwrap_or("");
            return Ok(format!(
                "{} LIMIT {}{}",
                before.trim_end(),
                limit,
                after_number
            ));
        }
        return Ok(sql.to_string());
    }

    let mut result = sql.trim_end().to_string();
    if result.ends_with(';') {
        result.pop();
    }
    Ok(format!("{} LIMIT {}", result.trim_end(), limit))
}

fn find_top_level_limit(sql: &str) -> Option<usize> {
    let mut depth = 0i32;
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'L' | b'l' if depth == 0 => {
                if sql[i..].to_ascii_uppercase().starts_with("LIMIT ")
                    || sql[i..].to_ascii_uppercase().starts_with("LIMIT\t")
                {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_select() {
        assert!(
            validate_read_only_sql("INSERT INTO t VALUES (1)", ReadOnlyLimit::Inject(10)).is_err()
        );
        assert!(validate_read_only_sql("UPDATE t SET x = 1", ReadOnlyLimit::Inject(10)).is_err());
        assert!(validate_read_only_sql("DELETE FROM t", ReadOnlyLimit::Inject(10)).is_err());
    }

    #[test]
    fn rejects_multiple_statements() {
        assert!(validate_read_only_sql("SELECT 1; SELECT 2", ReadOnlyLimit::Inject(10)).is_err());
    }

    #[test]
    fn injects_limit_when_missing() {
        let sql = validate_read_only_sql("SELECT * FROM users", ReadOnlyLimit::Inject(50)).unwrap();
        assert!(sql.ends_with("LIMIT 50"));
    }

    #[test]
    fn caps_existing_limit() {
        let sql =
            validate_read_only_sql("SELECT * FROM users LIMIT 200", ReadOnlyLimit::Inject(50))
                .unwrap();
        assert!(sql.ends_with("LIMIT 50"));
    }

    #[test]
    fn keeps_valid_existing_limit() {
        let sql = validate_read_only_sql("SELECT * FROM users LIMIT 10", ReadOnlyLimit::Inject(50))
            .unwrap();
        assert!(sql.ends_with("LIMIT 10"));
    }

    #[test]
    fn ignores_limit_in_subquery() {
        let sql = validate_read_only_sql(
            "SELECT * FROM (SELECT id FROM users LIMIT 5) AS u",
            ReadOnlyLimit::Inject(20),
        )
        .unwrap();
        assert!(sql.ends_with("LIMIT 20"));
    }
}
