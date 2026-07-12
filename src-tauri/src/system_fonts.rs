use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
use std::process::Command;

use crate::types::SystemFontFamilyInfo;

static SYSTEM_FONT_CACHE: OnceLock<Vec<SystemFontFamilyInfo>> = OnceLock::new();

#[derive(Debug, Clone)]
struct RawFontFace {
    family: String,
    weight: u16,
}

pub fn list_system_font_families() -> Result<Vec<SystemFontFamilyInfo>, String> {
    if let Some(fonts) = SYSTEM_FONT_CACHE.get() {
        return Ok(fonts.clone());
    }

    let fonts = normalize_font_faces(load_platform_font_faces()?);
    if fonts.is_empty() {
        return Err("系统没有返回可用字体".into());
    }

    let _ = SYSTEM_FONT_CACHE.set(fonts.clone());
    Ok(fonts)
}

fn normalize_font_faces<I>(faces: I) -> Vec<SystemFontFamilyInfo>
where
    I: IntoIterator<Item = RawFontFace>,
{
    let mut families: BTreeMap<String, (String, BTreeSet<u16>)> = BTreeMap::new();
    for face in faces {
        let family = face.family.trim().trim_matches('\u{feff}');
        if family.is_empty() || family.len() > 160 || family.chars().any(char::is_control) {
            continue;
        }
        let weight = if (1..=1000).contains(&face.weight) {
            face.weight
        } else {
            400
        };
        let entry = families
            .entry(family.to_lowercase())
            .or_insert_with(|| (family.to_string(), BTreeSet::new()));
        entry.1.insert(weight);
    }

    families
        .into_values()
        .map(|(family, weights)| SystemFontFamilyInfo {
            family,
            weights: weights.into_iter().collect(),
        })
        .collect()
}

fn faces_from_database(database: &fontdb::Database) -> Vec<RawFontFace> {
    database
        .faces()
        .filter_map(|face| {
            let (family, _) = face.families.first()?;
            Some(RawFontFace {
                family: family.clone(),
                weight: face.weight.0,
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn face_name_matches_weight(face_name: &str, weight: u16) -> bool {
    let name = face_name.to_ascii_lowercase().replace([' ', '-', '_'], "");
    match weight {
        100 => name.contains("thin") || name.contains("hairline"),
        200 => name.contains("extralight") || name.contains("ultralight"),
        300 => {
            name.contains("light")
                && !name.contains("extralight")
                && !name.contains("ultralight")
                && !name.contains("semilight")
                && !name.contains("demilight")
        }
        350 => name.contains("semilight") || name.contains("demilight"),
        400 => true,
        500 => name.contains("medium"),
        600 => name.contains("semibold") || name.contains("demibold"),
        700 => {
            name.contains("bold")
                && !name.contains("extrabold")
                && !name.contains("ultrabold")
                && !name.contains("semibold")
                && !name.contains("demibold")
        }
        800 => name.contains("extrabold") || name.contains("ultrabold"),
        900 => name.contains("black") || name.contains("heavy"),
        950 => name.contains("extrablack") || name.contains("ultrablack"),
        _ => false,
    }
}

#[cfg(target_os = "windows")]
fn command_stdout(command: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|error| format!("无法启动 {command}: {error}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() {
            format!("{command} 返回失败状态")
        } else {
            format!("{command} 执行失败: {error}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(target_os = "windows")]
fn load_platform_font_faces() -> Result<Vec<RawFontFace>, String> {
    // WPF discovers packaged fonts outside the normal Windows font folders. fontdb then
    // reads real static faces. Named variable-font instances are kept only when their face
    // name matches the reported weight, which excludes synthetic Regular-as-Bold variants.
    const SCRIPT: &str = r#"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName PresentationCore; $english = [Globalization.CultureInfo]::GetCultureInfo('en-US'); [Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $family = $_.Source; $_.GetTypefaces() | ForEach-Object { $glyph = $null; if ($_.TryGetGlyphTypeface([ref]$glyph)) { $faceName = $glyph.FaceNames[$english]; if (-not $faceName) { $faceName = $glyph.FaceNames.Values | Select-Object -First 1 }; "{0}`t{1}`t{2}`t{3}" -f $family, $glyph.Weight.ToOpenTypeWeight(), $faceName, $glyph.FontUri.LocalPath } } }"#;
    let stdout = command_stdout(
        "powershell.exe",
        &[
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            SCRIPT,
        ],
    )?;

    let mut paths = BTreeSet::new();
    let mut faces = Vec::new();
    for line in stdout.lines() {
        let mut fields = line.splitn(4, '\t');
        let Some(family) = fields.next() else {
            continue;
        };
        let Some(weight) = fields.next().and_then(|value| value.parse::<u16>().ok()) else {
            continue;
        };
        let Some(face_name) = fields.next() else {
            continue;
        };
        let Some(path) = fields.next().map(str::trim).filter(|path| !path.is_empty()) else {
            continue;
        };
        paths.insert(path.to_string());
        if face_name_matches_weight(face_name, weight) {
            faces.push(RawFontFace {
                family: family.to_string(),
                weight,
            });
        }
    }

    let mut database = fontdb::Database::new();
    for path in paths {
        let _ = database.load_font_file(path);
    }
    faces.extend(faces_from_database(&database));
    if faces.is_empty() {
        return Err("Windows 没有返回可读取的字体文件".into());
    }
    Ok(faces)
}

#[cfg(not(target_os = "windows"))]
fn load_platform_font_faces() -> Result<Vec<RawFontFace>, String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    let faces = faces_from_database(&database);
    if faces.is_empty() {
        return Err("系统字体目录中没有可读取的字体文件".into());
    }
    Ok(faces)
}

#[cfg(test)]
mod tests {
    use super::{list_system_font_families, normalize_font_faces, RawFontFace};

    #[cfg(target_os = "windows")]
    use super::face_name_matches_weight;

    #[test]
    fn font_faces_are_trimmed_sorted_deduplicated_and_grouped() {
        let fonts = normalize_font_faces([
            RawFontFace {
                family: " Microsoft YaHei ".into(),
                weight: 400,
            },
            RawFontFace {
                family: "Arial".into(),
                weight: 700,
            },
            RawFontFace {
                family: "arial".into(),
                weight: 400,
            },
            RawFontFace {
                family: "Bad\nFont".into(),
                weight: 400,
            },
        ]);

        assert_eq!(fonts.len(), 2);
        assert_eq!(fonts[0].family, "Arial");
        assert_eq!(fonts[0].weights, vec![400, 700]);
        assert_eq!(fonts[1].family, "Microsoft YaHei");
    }

    #[test]
    fn nonstandard_installed_weights_are_preserved() {
        let fonts = normalize_font_faces([
            RawFontFace {
                family: "Cascadia Mono".into(),
                weight: 350,
            },
            RawFontFace {
                family: "Cascadia Mono".into(),
                weight: 400,
            },
        ]);

        assert_eq!(fonts[0].weights, vec![350, 400]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_named_instances_keep_real_weights_and_drop_synthetic_bold() {
        assert!(face_name_matches_weight("SemiLight", 350));
        assert!(face_name_matches_weight("Bold Italic", 700));
        assert!(face_name_matches_weight("Black", 900));
        assert!(!face_name_matches_weight("Regular", 700));
        assert!(!face_name_matches_weight("ExtraBold", 700));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_loader_returns_real_installed_faces_without_synthetic_bold() {
        let fonts = list_system_font_families().expect("Windows system fonts should load");
        let arial = fonts
            .iter()
            .find(|font| font.family == "Arial")
            .expect("Arial should be installed");
        let simhei = fonts
            .iter()
            .find(|font| font.family == "SimHei")
            .expect("SimHei should be installed");
        let simsun = fonts
            .iter()
            .find(|font| font.family == "SimSun")
            .expect("SimSun should be installed");
        let cascadia_mono = fonts
            .iter()
            .find(|font| font.family == "Cascadia Mono")
            .expect("Cascadia Mono should be installed");

        assert!(fonts.len() > 20);
        assert!(arial.weights.contains(&400));
        assert!(arial.weights.contains(&700));
        assert_eq!(simhei.weights, vec![400]);
        assert_eq!(simsun.weights, vec![400]);
        assert!(cascadia_mono.weights.contains(&350));
    }
}
