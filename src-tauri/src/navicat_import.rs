use std::collections::HashMap;
use std::path::PathBuf;

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::natural_sort::compare_sort_values;
use crate::navicat_crypto::{decrypt_navicat_password, CipherPreference, DecryptedPassword};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavicatImportedConnection {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub host: String,
    pub port: String,
    pub username: String,
    pub password: String,
    pub database: String,
    pub url: String,
    pub password_status: String,
    pub warnings: Vec<String>,
    pub source: String,
    pub source_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavicatScanResult {
    pub supported: bool,
    pub platform: String,
    pub source: String,
    pub connections: Vec<NavicatImportedConnection>,
    pub skipped_unsupported: usize,
    pub notice: String,
}

#[derive(Debug, Clone)]
struct RawNavicatEntry {
    name: String,
    kind: String,
    source: String,
    source_label: String,
    values: HashMap<String, String>,
    cipher_preference: CipherPreference,
}

fn current_platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

fn first_non_empty<'a>(values: &'a HashMap<String, String>, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = values.get(*key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn parse_bool_flag(values: &HashMap<String, String>, keys: &[&str]) -> Option<bool> {
    for key in keys {
        if let Some(raw) = values.get(*key) {
            let normalized = raw.trim().to_ascii_lowercase();
            if matches!(normalized.as_str(), "1" | "true" | "yes") {
                return Some(true);
            }
            if matches!(normalized.as_str(), "0" | "false" | "no") {
                return Some(false);
            }
        }
    }
    None
}

fn normalize_port(raw: &str, default_port: &str) -> String {
    let trimmed = raw.trim();
    if let Ok(port) = trimmed.parse::<u16>() {
        if port > 0 {
            return port.to_string();
        }
    }
    default_port.to_string()
}

fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        let is_unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if is_unreserved {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn percent_decode_lossy(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(val) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or_default(),
                16,
            ) {
                out.push(val);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn split_host_and_port(raw_host: &str, fallback_port: &str) -> (String, String) {
    let trimmed = raw_host.trim();
    if trimmed.is_empty() {
        return (String::new(), fallback_port.to_string());
    }
    // IPv6 bracket notation: [::1]:27017
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((addr, after)) = rest.split_once(']') {
            let port = after
                .strip_prefix(':')
                .map(|p| normalize_port(p, fallback_port))
                .unwrap_or_else(|| fallback_port.to_string());
            return (format!("[{addr}]"), port);
        }
    }
    if let Some((host, port)) = trimmed.rsplit_once(':') {
        if !host.contains(':') && port.parse::<u16>().ok().filter(|&p| p > 0).is_some() {
            return (host.trim().to_string(), port.trim().to_string());
        }
    }
    (trimmed.to_string(), fallback_port.to_string())
}

fn resolve_password(
    values: &HashMap<String, String>,
    preference: CipherPreference,
    requires_password: bool,
) -> (String, String) {
    let encrypted = first_non_empty(values, &["pwd", "password"]);
    let save_password = parse_bool_flag(values, &["savepassword", "savepwd"]);

    if encrypted.is_empty() {
        if save_password == Some(false) || requires_password {
            return (String::new(), "missing".into());
        }
        return (String::new(), "empty".into());
    }

    match decrypt_navicat_password(&encrypted, preference) {
        DecryptedPassword::Decrypted(plain) => (plain, "decrypted".into()),
        DecryptedPassword::Unreadable => (String::new(), "unreadable".into()),
    }
}

fn is_mongo_uri(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    lower.starts_with("mongodb://") || lower.starts_with("mongodb+srv://")
}

fn build_mongo_url_from_parts(
    host_list: &str,
    username: &str,
    password: &str,
    database: &str,
    query_pairs: &[(&str, String)],
) -> String {
    let mut url = String::from("mongodb://");
    if !username.is_empty() {
        url.push_str(&percent_encode_component(username));
        if !password.is_empty() {
            url.push(':');
            url.push_str(&percent_encode_component(password));
        }
        url.push('@');
    }
    url.push_str(host_list);
    if !database.is_empty() || !query_pairs.is_empty() {
        url.push('/');
        if !database.is_empty() {
            url.push_str(&percent_encode_component(database));
        }
    }
    if !query_pairs.is_empty() {
        url.push('?');
        for (index, (k, v)) in query_pairs.iter().enumerate() {
            if index > 0 {
                url.push('&');
            }
            url.push_str(k);
            url.push('=');
            url.push_str(&percent_encode_component(v));
        }
    }
    url
}

fn parse_mysql_entry(entry: &RawNavicatEntry, index: usize) -> Option<NavicatImportedConnection> {
    let raw_host = first_non_empty(&entry.values, &["host", "server", "hostname"]);
    if raw_host.is_empty() {
        return None;
    }
    let fallback_port = normalize_port(&first_non_empty(&entry.values, &["port"]), "3306");
    let (host, port) = split_host_and_port(&raw_host, &fallback_port);
    if host.is_empty() {
        return None;
    }
    let username = {
        let user = first_non_empty(&entry.values, &["username", "user"]);
        if user.is_empty() {
            "root".to_string()
        } else {
            user
        }
    };
    let database = first_non_empty(
        &entry.values,
        &["initialdatabase", "database", "dbname", "defaultdatabase"],
    );
    let (password, password_status) = resolve_password(&entry.values, entry.cipher_preference, true);

    let mut warnings = Vec::new();
    if parse_bool_flag(&entry.values, &["usessh", "ssh"]) == Some(true) {
        warnings.push("ssh_tunnel".into());
    }
    if parse_bool_flag(&entry.values, &["usessl", "ssl"]) == Some(true) {
        warnings.push("ssl_enabled".into());
    }

    let name = if entry.name.trim().is_empty() {
        format!("{username}@{host}:{port}")
    } else {
        entry.name.trim().to_string()
    };

    Some(NavicatImportedConnection {
        id: format!("{}:mysql:{}", entry.source, index),
        name,
        kind: "mysql".into(),
        host,
        port,
        username,
        password,
        database,
        url: String::new(),
        password_status,
        warnings,
        source: entry.source.clone(),
        source_label: entry.source_label.clone(),
    })
}

fn parse_mongodb_entry(entry: &RawNavicatEntry, index: usize) -> Option<NavicatImportedConnection> {
    let mut warnings = Vec::new();
    if parse_bool_flag(&entry.values, &["usessh", "ssh"]) == Some(true) {
        warnings.push("ssh_tunnel".into());
    }

    let use_uri_flag = parse_bool_flag(&entry.values, &["useuri"]);
    let raw_uri_candidate = first_non_empty(&entry.values, &["uri", "connectionuri", "connectionstring"]);
    let raw_host_field = first_non_empty(&entry.values, &["host", "hosts", "server", "hostname"]);

    let uri_string = if use_uri_flag != Some(false) && is_mongo_uri(&raw_uri_candidate) {
        Some(raw_uri_candidate)
    } else if is_mongo_uri(&raw_host_field) {
        Some(raw_host_field.clone())
    } else {
        None
    };

    if let Some(raw_uri) = uri_string {
        let mut parsed = Url::parse(raw_uri.trim()).ok()?;
        let host = parsed.host_str()?.to_string();
        let port = parsed.port().unwrap_or(27017).to_string();
        let mut username = percent_decode_lossy(parsed.username());
        if username.is_empty() {
            username = first_non_empty(&entry.values, &["username", "user"]);
            if !username.is_empty() {
                let _ = parsed.set_username(&username);
            }
        }
        let database = percent_decode_lossy(parsed.path().trim_start_matches('/'))
            .split('/')
            .next()
            .unwrap_or_default()
            .to_string();

        let (password, password_status) = if let Some(uri_pwd) = parsed.password() {
            if !uri_pwd.is_empty() {
                (percent_decode_lossy(uri_pwd), "decrypted".to_string())
            } else {
                let (dec, status) =
                    resolve_password(&entry.values, entry.cipher_preference, !username.is_empty());
                if !dec.is_empty() && !username.is_empty() {
                    let _ = parsed.set_password(Some(&dec));
                }
                (dec, status)
            }
        } else {
            let (dec, status) =
                resolve_password(&entry.values, entry.cipher_preference, !username.is_empty());
            if !dec.is_empty() && !username.is_empty() {
                let _ = parsed.set_password(Some(&dec));
            }
            (dec, status)
        };

        let name = if entry.name.trim().is_empty() {
            if username.is_empty() {
                format!("{host}:{port}")
            } else {
                format!("{username}@{host}:{port}")
            }
        } else {
            entry.name.trim().to_string()
        };

        return Some(NavicatImportedConnection {
            id: format!("{}:mongodb:{}", entry.source, index),
            name,
            kind: "mongodb".into(),
            host,
            port,
            username,
            password,
            database,
            url: parsed.to_string(),
            password_status,
            warnings,
            source: entry.source.clone(),
            source_label: entry.source_label.clone(),
        });
    }

    if raw_host_field.is_empty() {
        return None;
    }

    let fallback_port = normalize_port(&first_non_empty(&entry.values, &["port"]), "27017");
    let host_tokens: Vec<(String, String)> = raw_host_field
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| split_host_and_port(part, &fallback_port))
        .filter(|(h, _)| !h.is_empty())
        .collect();
    let (primary_host, primary_port) = host_tokens.first()?.clone();

    let username = first_non_empty(&entry.values, &["username", "user"]);
    let database = first_non_empty(
        &entry.values,
        &["initialdatabase", "database", "dbname", "defaultdatabase"],
    );
    let (password, password_status) =
        resolve_password(&entry.values, entry.cipher_preference, !username.is_empty());

    let auth_source = first_non_empty(
        &entry.values,
        &["authsource", "authdatabase", "authenticationdatabase", "authdb"],
    );
    let auth_mechanism = first_non_empty(&entry.values, &["authmechanism"]);
    let use_replica_set = parse_bool_flag(&entry.values, &["usereplicaset"]);
    let replica_set = if use_replica_set == Some(false) {
        String::new()
    } else {
        first_non_empty(&entry.values, &["replicaset", "replicasetname"])
    };
    let use_ssl = parse_bool_flag(&entry.values, &["usessl", "ssl", "usetls", "tls"]) == Some(true);

    let mut query_pairs: Vec<(&str, String)> = Vec::new();
    if !auth_source.is_empty() {
        query_pairs.push(("authSource", auth_source));
    }
    if let Some(mechanism) = crate::mongodb::canonical_auth_mechanism(&auth_mechanism) {
        query_pairs.push(("authMechanism", mechanism.to_string()));
    }
    if !replica_set.is_empty() {
        query_pairs.push(("replicaSet", replica_set));
    }
    if use_ssl {
        query_pairs.push(("tls", "true".into()));
    }

    let url = if host_tokens.len() > 1 || !query_pairs.is_empty() {
        let host_list = host_tokens
            .iter()
            .map(|(h, p)| format!("{h}:{p}"))
            .collect::<Vec<_>>()
            .join(",");
        build_mongo_url_from_parts(&host_list, &username, &password, &database, &query_pairs)
    } else {
        String::new()
    };

    let name = if entry.name.trim().is_empty() {
        if username.is_empty() {
            format!("{primary_host}:{primary_port}")
        } else {
            format!("{username}@{primary_host}:{primary_port}")
        }
    } else {
        entry.name.trim().to_string()
    };

    Some(NavicatImportedConnection {
        id: format!("{}:mongodb:{}", entry.source, index),
        name,
        kind: "mongodb".into(),
        host: primary_host,
        port: primary_port,
        username,
        password,
        database,
        url,
        password_status,
        warnings,
        source: entry.source.clone(),
        source_label: entry.source_label.clone(),
    })
}

fn parse_navicat_entry(entry: &RawNavicatEntry, index: usize) -> Option<NavicatImportedConnection> {
    match entry.kind.as_str() {
        "mysql" => parse_mysql_entry(entry, index),
        "mongodb" => parse_mongodb_entry(entry, index),
        _ => None,
    }
}

fn sort_imported_connections(connections: &mut [NavicatImportedConnection]) {
    connections.sort_by(|left, right| {
        let kind_rank = |kind: &str| match kind {
            "mysql" => 0u8,
            "mongodb" => 1u8,
            _ => 2u8,
        };
        kind_rank(&left.kind)
            .cmp(&kind_rank(&right.kind))
            .then_with(|| compare_sort_values(&left.name, &right.name))
            .then_with(|| left.host.cmp(&right.host))
            .then_with(|| left.port.cmp(&right.port))
    });
}

fn ncx_cipher_preference(version: Option<&str>) -> CipherPreference {
    let Some(ver) = version.map(str::trim).filter(|v| !v.is_empty()) else {
        return CipherPreference::AesFirst;
    };
    let mut parts = ver.split('.');
    let major = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(1);
    let minor = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(2);
    if major < 1 || (major == 1 && minor < 2) {
        CipherPreference::BlowfishFirst
    } else {
        CipherPreference::AesFirst
    }
}

pub fn parse_navicat_ncx_xml(xml: &str) -> Result<NavicatScanResult, String> {
    let cleaned = xml.trim_start_matches('\u{feff}');
    let doc = roxmltree::Document::parse(cleaned)
        .map_err(|error| format!("Navicat 导出文件 (.ncx) 格式无效: {error}"))?;

    let root = doc.root_element();
    let preference = ncx_cipher_preference(root.attribute("Ver").or_else(|| root.attribute("ver")));

    let mut raw_entries = Vec::new();
    let mut skipped_unsupported = 0usize;

    for node in doc.descendants().filter(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("Connection")) {
        let mut values = HashMap::new();
        for attr in node.attributes() {
            values.insert(attr.name().to_ascii_lowercase(), attr.value().to_string());
        }

        let conn_type = first_non_empty(&values, &["conntype", "type"]).to_ascii_uppercase();
        let (kind, source_label) = match conn_type.as_str() {
            "MYSQL" | "CTMYSQL" => ("mysql", "MySQL"),
            "MARIADB" | "CTMARIADB" => ("mysql", "MariaDB"),
            "MONGO" | "MONGODB" | "CTMONGO" | "CTMONGODB" => ("mongodb", "MongoDB"),
            _ => {
                skipped_unsupported += 1;
                continue;
            }
        };

        let name = first_non_empty(&values, &["connectionname", "name"]);
        raw_entries.push(RawNavicatEntry {
            name,
            kind: kind.to_string(),
            source: "ncx".to_string(),
            source_label: source_label.to_string(),
            values,
            cipher_preference: preference,
        });
    }

    let mut connections: Vec<NavicatImportedConnection> = raw_entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| parse_navicat_entry(entry, index))
        .collect();
    sort_imported_connections(&mut connections);

    Ok(NavicatScanResult {
        supported: true,
        platform: current_platform_name().to_string(),
        source: "ncx".to_string(),
        connections,
        skipped_unsupported,
        notice: String::new(),
    })
}

#[cfg(target_os = "windows")]
fn read_windows_registry_connections() -> Result<NavicatScanResult, String> {
    use std::io::ErrorKind;
    use winreg::enums::*;
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    const SUPPORTED_HIVES: &[(&str, &str, &str)] = &[
        ("Software\\PremiumSoft\\Navicat\\Servers", "mysql", "MySQL"),
        (
            "Software\\PremiumSoft\\NavicatMARIADB\\Servers",
            "mysql",
            "MariaDB",
        ),
        (
            "Software\\PremiumSoft\\NavicatMONGODB\\Servers",
            "mongodb",
            "MongoDB",
        ),
    ];

    const UNSUPPORTED_HIVES: &[&str] = &[
        "Software\\PremiumSoft\\NavicatPG\\Servers",
        "Software\\PremiumSoft\\NavicatOra\\Servers",
        "Software\\PremiumSoft\\NavicatMSSQL\\Servers",
        "Software\\PremiumSoft\\NavicatSQLite\\Servers",
        "Software\\PremiumSoft\\NavicatREDIS\\Servers",
        "Software\\PremiumSoft\\NavicatSNOWFLAKE\\Servers",
    ];

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mut raw_entries = Vec::new();
    let mut skipped_unsupported = 0usize;

    for &(subkey_path, kind, source_label) in SUPPORTED_HIVES {
        let servers_key = match hkcu.open_subkey_with_flags(subkey_path, KEY_READ) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => continue,
        };

        for server_name in servers_key.enum_keys().flatten() {
            let Ok(server_key) = servers_key.open_subkey_with_flags(&server_name, KEY_READ) else {
                continue;
            };
            let mut values = HashMap::new();
            for (val_name, reg_val) in server_key.enum_values().flatten() {
                let parsed = match reg_val.vtype {
                    REG_SZ | REG_EXPAND_SZ => String::from_reg_value(&reg_val)
                        .ok()
                        .map(|s| s.trim_end_matches('\0').to_string()),
                    REG_DWORD => u32::from_reg_value(&reg_val).ok().map(|n| n.to_string()),
                    REG_QWORD => u64::from_reg_value(&reg_val).ok().map(|n| n.to_string()),
                    _ => None,
                };
                if let Some(text) = parsed {
                    values.insert(val_name.to_ascii_lowercase(), text);
                }
            }
            raw_entries.push(RawNavicatEntry {
                name: server_name,
                kind: kind.to_string(),
                source: "registry".to_string(),
                source_label: source_label.to_string(),
                values,
                cipher_preference: CipherPreference::BlowfishFirst,
            });
        }
    }

    for &subkey_path in UNSUPPORTED_HIVES {
        if let Ok(servers_key) = hkcu.open_subkey_with_flags(subkey_path, KEY_READ) {
            skipped_unsupported += servers_key.enum_keys().filter_map(Result::ok).count();
        }
    }

    let mut connections: Vec<NavicatImportedConnection> = raw_entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| parse_navicat_entry(entry, index))
        .collect();
    sort_imported_connections(&mut connections);

    Ok(NavicatScanResult {
        supported: true,
        platform: "windows".to_string(),
        source: "registry".to_string(),
        connections,
        skipped_unsupported,
        notice: String::new(),
    })
}

#[cfg(not(target_os = "windows"))]
fn read_windows_registry_connections() -> Result<NavicatScanResult, String> {
    Ok(NavicatScanResult {
        supported: false,
        platform: current_platform_name().to_string(),
        source: "registry".to_string(),
        connections: Vec::new(),
        skipped_unsupported: 0,
        notice: String::new(),
    })
}

#[tauri::command]
pub async fn scan_navicat_connections() -> Result<NavicatScanResult, String> {
    tokio::task::spawn_blocking(read_windows_registry_connections)
        .await
        .map_err(|error| format!("扫描 Navicat 连接失败: {error}"))?
}

#[tauri::command]
pub async fn import_navicat_ncx_file(
    path: Option<String>,
    content: Option<String>,
) -> Result<Option<NavicatScanResult>, String> {
    if let Some(xml) = content {
        return parse_navicat_ncx_xml(&xml).map(Some);
    }

    let chosen_path = if let Some(explicit) = path.filter(|p| !p.trim().is_empty()) {
        Some(PathBuf::from(explicit))
    } else {
        tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .add_filter("Navicat Connections (*.ncx)", &["ncx"])
                .pick_file()
        })
        .await
        .map_err(|error| format!("打开文件选择器失败: {error}"))?
    };

    let Some(file_path) = chosen_path else {
        return Ok(None);
    };

    let raw_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|error| format!("读取 .ncx 文件失败: {error}"))?;
    let xml = String::from_utf8(raw_bytes)
        .map_err(|_| "无法读取 .ncx 文件：请确认为 UTF-8 编码的 Navicat 连接导出文件".to_string())?;
    parse_navicat_ncx_xml(&xml).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(kind: &str, name: &str, pairs: &[(&str, &str)]) -> RawNavicatEntry {
        RawNavicatEntry {
            name: name.to_string(),
            kind: kind.to_string(),
            source: "registry".to_string(),
            source_label: if kind == "mongodb" { "MongoDB" } else { "MySQL" }.to_string(),
            values: pairs
                .iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), (*v).to_string()))
                .collect(),
            cipher_preference: CipherPreference::BlowfishFirst,
        }
    }

    #[test]
    fn parses_windows_registry_mysql_entry_with_blowfish_password_and_warnings() {
        let entry = raw(
            "mysql",
            "线上配置库",
            &[
                ("Host", "192.168.1.223"),
                ("Port", "8306"),
                ("UserName", "root"),
                ("Pwd", "15057D7BA390"),
                ("SavePassword", "1"),
                ("InitialDatabase", "newsg_4cfg"),
                ("UseSSH", "1"),
                ("UseSSL", "1"),
            ],
        );

        let parsed = parse_navicat_entry(&entry, 0).expect("mysql entry");
        assert_eq!(parsed.name, "线上配置库");
        assert_eq!(parsed.kind, "mysql");
        assert_eq!(parsed.host, "192.168.1.223");
        assert_eq!(parsed.port, "8306");
        assert_eq!(parsed.username, "root");
        assert_eq!(parsed.password, "123456");
        assert_eq!(parsed.database, "newsg_4cfg");
        assert_eq!(parsed.password_status, "decrypted");
        assert_eq!(parsed.warnings, vec!["ssh_tunnel", "ssl_enabled"]);
    }

    #[test]
    fn parses_mongodb_host_port_with_auth_source_and_replica_set_into_url() {
        let entry = raw(
            "mongodb",
            "游戏日志 Mongo",
            &[
                ("Host", "10.0.0.8"),
                ("Port", "27018"),
                ("UserName", "admin"),
                ("Pwd", "0EA71F51DD37BFB60CCBA219BE3A"),
                ("AuthDatabase", "admin"),
                ("ReplicaSet", "rs0"),
                ("UseSSL", "1"),
            ],
        );

        let parsed = parse_navicat_entry(&entry, 1).expect("mongodb entry");
        assert_eq!(parsed.kind, "mongodb");
        assert_eq!(parsed.host, "10.0.0.8");
        assert_eq!(parsed.port, "27018");
        assert_eq!(parsed.username, "admin");
        assert_eq!(parsed.password, "This is a test");
        assert_eq!(parsed.password_status, "decrypted");
        assert_eq!(
            parsed.url,
            "mongodb://admin:This%20is%20a%20test@10.0.0.8:27018/?authSource=admin&replicaSet=rs0&tls=true"
        );
    }

    #[test]
    fn mongodb_keeps_only_auth_mechanisms_the_driver_accepts() {
        let entry = |mechanism: &str| {
            raw(
                "mongodb",
                "本地 Mongo",
                &[
                    ("Host", "localhost"),
                    ("Port", "28018"),
                    ("UserName", "admin"),
                    ("AuthDatabase", "admin"),
                    ("AuthMechanism", mechanism),
                ],
            )
        };

        let navicat_label = parse_navicat_entry(&entry("Password"), 0).expect("mongodb entry");
        assert_eq!(navicat_label.url, "mongodb://admin@localhost:28018/?authSource=admin");

        let lowercase = parse_navicat_entry(&entry("scram-sha-256"), 0).expect("mongodb entry");
        assert_eq!(
            lowercase.url,
            "mongodb://admin@localhost:28018/?authSource=admin&authMechanism=SCRAM-SHA-256"
        );
    }

    #[test]
    fn parses_mongodb_uri_mode_and_injects_separate_decrypted_password() {
        let entry = raw(
            "mongodb",
            "Atlas 集群",
            &[
                ("UseURI", "1"),
                ("URI", "mongodb+srv://gameuser@cluster0.example.net/gamedb?authSource=admin"),
                ("Pwd", "15057D7BA390"),
            ],
        );

        let parsed = parse_navicat_entry(&entry, 2).expect("mongodb uri entry");
        assert_eq!(parsed.host, "cluster0.example.net");
        assert_eq!(parsed.port, "27017");
        assert_eq!(parsed.username, "gameuser");
        assert_eq!(parsed.password, "123456");
        assert_eq!(parsed.database, "gamedb");
        assert_eq!(
            parsed.url,
            "mongodb+srv://gameuser:123456@cluster0.example.net/gamedb?authSource=admin"
        );
    }

    #[test]
    fn parses_ncx_v14_mysql_and_mongodb_and_skips_unsupported_engines() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.4">
  <Connection ConnectionName="游戏库 10" ConnType="MYSQL" Host="10.0.0.10" Port="3306" UserName="root" Password="833E4ABBC56C89041A9070F043641E3B" SavePassword="true" />
  <Connection ConnectionName="游戏库 2" ConnType="MARIADB" Host="10.0.0.2" Port="3307" UserName="dev" Password="" SavePassword="false" />
  <Connection ConnectionName="活动 Mongo" ConnType="MONGO" Host="10.0.0.20" Port="27017" UserName="" Password="" />
  <Connection ConnectionName="分析 PG" ConnType="PGSQL" Host="10.0.0.30" Port="5432" UserName="pg" />
  <Connection ConnectionName="缓存 Redis" ConnType="REDIS" Host="10.0.0.31" Port="6379" />
</Connections>"#;

        let result = parse_navicat_ncx_xml(xml).expect("parse ncx");
        assert_eq!(result.source, "ncx");
        assert_eq!(result.skipped_unsupported, 2);
        assert_eq!(result.connections.len(), 3);

        // Natural sort keeps 游戏库 2 before 游戏库 10, MySQL before MongoDB
        assert_eq!(result.connections[0].name, "游戏库 2");
        assert_eq!(result.connections[0].source_label, "MariaDB");
        assert_eq!(result.connections[0].password_status, "missing");

        assert_eq!(result.connections[1].name, "游戏库 10");
        assert_eq!(result.connections[1].password, "123456");
        assert_eq!(result.connections[1].password_status, "decrypted");

        assert_eq!(result.connections[2].name, "活动 Mongo");
        assert_eq!(result.connections[2].kind, "mongodb");
        assert_eq!(result.connections[2].password_status, "empty");
    }

    #[test]
    fn parses_ncx_v11_blowfish_passwords() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.1">
  <Connection ConnectionName="Legacy" ConnType="MYSQL" Host="127.0.0.1" Port="3306" UserName="root" Password="15057D7BA390" SavePassword="true" />
</Connections>"#;

        let result = parse_navicat_ncx_xml(xml).expect("parse v1.1 ncx");
        assert_eq!(result.connections.len(), 1);
        assert_eq!(result.connections[0].password, "123456");
        assert_eq!(result.connections[0].password_status, "decrypted");
    }
}
