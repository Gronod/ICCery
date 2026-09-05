use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

static SEQ_COUNTER: AtomicU64 = AtomicU64::new(1);

const HISTORY_CAP: usize = 1000;
const STORE_VERSION: u32 = 1;
const MAX_STRING_LEN: usize = 200;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct VerificationRecord {
    pub id: String,             // backend-generated only: "vr-<epoch_millis>-<seq>"
    pub timestamp: String,      // ISO 8601 string
    pub printer_name: String,
    pub profile_name: String,
    pub avg_de: f64,
    pub max_de: f64,
    pub rms_de: f64,
    pub patch_count: u32,
    pub status: String,         // backend ALWAYS fills via classify_status
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct VerificationHistoryStore {
    pub version: u32,
    pub records: Vec<VerificationRecord>,
}

impl Default for VerificationHistoryStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            records: Vec::new(),
        }
    }
}

/// Generates a unique record identifier: "vr-<epoch_millis>-<seq>"
pub fn generate_record_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SEQ_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("vr-{}-{}", millis, seq)
}

/// Classifies status into ICCery verification bands (issue #95):
/// - < 1.0: "excellent"
/// - < 2.0: "good"
/// - < 3.5: "acceptable"
/// - >= 3.5: "warning"
pub fn classify_status(avg_de: f64) -> &'static str {
    if avg_de < 1.0 {
        "excellent"
    } else if avg_de < 2.0 {
        "good"
    } else if avg_de < 3.5 {
        "acceptable"
    } else {
        "warning"
    }
}

/// Validates record data constraints.
pub fn validate_record(record: &VerificationRecord) -> Result<(), String> {
    if record.profile_name.trim().is_empty() {
        return Err("Profile name cannot be empty.".to_string());
    }
    if record.profile_name.len() > MAX_STRING_LEN {
        return Err(format!("Profile name exceeds maximum length of {} characters.", MAX_STRING_LEN));
    }
    if record.printer_name.len() > MAX_STRING_LEN {
        return Err(format!("Printer name exceeds maximum length of {} characters.", MAX_STRING_LEN));
    }
    if record.timestamp.trim().is_empty() {
        return Err("Timestamp cannot be empty.".to_string());
    }
    if !record.avg_de.is_finite() || record.avg_de < 0.0 {
        return Err("Average ΔE must be a finite non-negative number.".to_string());
    }
    if !record.max_de.is_finite() || record.max_de < 0.0 {
        return Err("Peak ΔE must be a finite non-negative number.".to_string());
    }
    if !record.rms_de.is_finite() || record.rms_de < 0.0 {
        return Err("RMS ΔE must be a finite non-negative number.".to_string());
    }
    Ok(())
}

/// Loads verification history from a JSON file.
/// Missing, unreadable, or corrupted files safely return an empty vector.
pub fn load_history_file(path: &Path) -> Vec<VerificationRecord> {
    if !path.exists() {
        return Vec::new();
    }
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<VerificationHistoryStore>(&content) {
        Ok(store) => store.records,
        Err(_) => Vec::new(),
    }
}

/// Writes verification records to the specified JSON path.
/// Automatically creates parent directories if needed.
/// Evicts oldest records by timestamp if count exceeds HISTORY_CAP (1,000).
pub fn write_history_file(path: &Path, records: &[VerificationRecord]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let mut bounded_records: Vec<VerificationRecord> = records.to_vec();
    // Sort by timestamp ascending
    bounded_records.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    if bounded_records.len() > HISTORY_CAP {
        let excess = bounded_records.len() - HISTORY_CAP;
        bounded_records.drain(0..excess);
    }

    let store = VerificationHistoryStore {
        version: STORE_VERSION,
        records: bounded_records,
    };

    let json = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("Failed to serialize verification history: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed to write verification history: {}", e))?;

    Ok(())
}

/// Helper to escape CSV text fields according to RFC-4180.
fn escape_csv_field(val: &str) -> String {
    if val.contains('"') || val.contains(',') || val.contains('\n') || val.contains('\r') {
        format!("\"{}\"", val.replace('"', "\"\""))
    } else {
        val.to_string()
    }
}

/// Formats records into standard RFC-4180 CSV string.
pub fn to_csv(records: &[VerificationRecord]) -> String {
    let mut csv = String::from("id,timestamp,printer_name,profile_name,avg_de,max_de,rms_de,patch_count,status\r\n");
    for r in records {
        csv.push_str(&format!(
            "{},{},{},{},{:.4},{:.4},{:.4},{},{}\r\n",
            escape_csv_field(&r.id),
            escape_csv_field(&r.timestamp),
            escape_csv_field(&r.printer_name),
            escape_csv_field(&r.profile_name),
            r.avg_de,
            r.max_de,
            r.rms_de,
            r.patch_count,
            escape_csv_field(&r.status),
        ));
    }
    csv
}

/// Validates CSV destination file path.
pub fn validate_csv_dest(dest: &str) -> Result<PathBuf, String> {
    let trimmed = dest.trim();
    if trimmed.is_empty() {
        return Err("Destination path cannot be empty.".to_string());
    }
    let mut path = PathBuf::from(trimmed);
    if path.extension().is_none() || path.extension().unwrap_or_default() != "csv" {
        path.set_extension("csv");
    }
    Ok(path)
}

fn get_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_data.join("verification_history.json"))
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_verification_record(
    app: AppHandle,
    mut record: VerificationRecord,
) -> Result<VerificationRecord, String> {
    record.id = generate_record_id();
    record.status = classify_status(record.avg_de).to_string();
    validate_record(&record)?;

    let path = get_store_path(&app)?;
    let mut records = load_history_file(&path);
    records.push(record.clone());
    write_history_file(&path, &records)?;

    Ok(record)
}

#[tauri::command]
pub fn get_verification_history(
    app: AppHandle,
    profile_name: Option<String>,
    printer_name: Option<String>,
) -> Result<Vec<VerificationRecord>, String> {
    let path = get_store_path(&app)?;
    let mut records = load_history_file(&path);

    if let Some(ref prof) = profile_name {
        let prof_clean = prof.trim();
        if !prof_clean.is_empty() {
            records.retain(|r| r.profile_name == prof_clean);
        }
    }

    if let Some(ref prn) = printer_name {
        let prn_clean = prn.trim();
        if !prn_clean.is_empty() {
            records.retain(|r| r.printer_name == prn_clean);
        }
    }

    // Return chronological order (ascending timestamp)
    records.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    Ok(records)
}

#[tauri::command]
pub fn clear_verification_history(app: AppHandle) -> Result<(), String> {
    let path = get_store_path(&app)?;
    write_history_file(&path, &[])
}

#[tauri::command]
pub fn export_verification_history_csv(
    app: AppHandle,
    dest_path: String,
    profile_name: Option<String>,
    printer_name: Option<String>,
) -> Result<usize, String> {
    let validated_path = validate_csv_dest(&dest_path)?;
    let records = get_verification_history(app, profile_name, printer_name)?;
    let count = records.len();
    let csv_content = to_csv(&records);

    if let Some(parent) = validated_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create CSV parent directory: {}", e))?;
    }
    fs::write(&validated_path, csv_content)
        .map_err(|e| format!("Failed to write CSV file: {}", e))?;

    Ok(count)
}

// ---------------------------------------------------------------------------
// Unit Tests (Path-based, no AppHandle required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sample_record(id: &str, ts: &str, avg: f64) -> VerificationRecord {
        VerificationRecord {
            id: id.to_string(),
            timestamp: ts.to_string(),
            printer_name: "Canon PRO-1000".to_string(),
            profile_name: "ProLustre_Photo".to_string(),
            avg_de: avg,
            max_de: avg * 2.0,
            rms_de: avg * 1.2,
            patch_count: 50,
            status: classify_status(avg).to_string(),
        }
    }

    #[test]
    fn test_classify_status_bands() {
        // Boundaries: <1.0 excellent, <2.0 good, <3.5 acceptable, >=3.5 warning
        assert_eq!(classify_status(0.0), "excellent");
        assert_eq!(classify_status(0.999), "excellent");
        assert_eq!(classify_status(1.0), "good");
        assert_eq!(classify_status(1.999), "good");
        assert_eq!(classify_status(2.0), "acceptable");
        assert_eq!(classify_status(3.499), "acceptable");
        assert_eq!(classify_status(3.5), "warning");
        assert_eq!(classify_status(5.2), "warning");
    }

    #[test]
    fn test_validate_record_valid_and_invalid() {
        let valid = sample_record("vr-1", "2026-09-05T12:00:00Z", 0.85);
        assert!(validate_record(&valid).is_ok());

        let mut empty_prof = valid.clone();
        empty_prof.profile_name = "   ".to_string();
        assert!(validate_record(&empty_prof).is_err());

        let mut empty_ts = valid.clone();
        empty_ts.timestamp = "".to_string();
        assert!(validate_record(&empty_ts).is_err());

        let mut negative_de = valid.clone();
        negative_de.avg_de = -0.1;
        assert!(validate_record(&negative_de).is_err());

        let mut nan_de = valid.clone();
        nan_de.max_de = f64::NAN;
        assert!(validate_record(&nan_de).is_err());

        let mut inf_de = valid.clone();
        inf_de.rms_de = f64::INFINITY;
        assert!(validate_record(&inf_de).is_err());

        let mut long_name = valid.clone();
        long_name.profile_name = "a".repeat(201);
        assert!(validate_record(&long_name).is_err());
    }

    #[test]
    fn test_store_load_missing_and_corrupt() {
        let temp_dir = std::env::temp_dir().join("iccery_test_quality_store_corrupt");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let missing_path = temp_dir.join("nonexistent.json");
        let records = load_history_file(&missing_path);
        assert!(records.is_empty());

        let corrupt_path = temp_dir.join("corrupt.json");
        fs::write(&corrupt_path, "{ broken json ... ").unwrap();
        let records_corrupt = load_history_file(&corrupt_path);
        assert!(records_corrupt.is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_store_write_and_roundtrip() {
        let temp_dir = std::env::temp_dir().join("iccery_test_quality_store_roundtrip");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let file_path = temp_dir.join("verification_history.json");
        let rec1 = sample_record("vr-1", "2026-09-01T10:00:00Z", 0.75);
        let rec2 = sample_record("vr-2", "2026-09-02T10:00:00Z", 1.85);

        write_history_file(&file_path, &[rec1.clone(), rec2.clone()]).unwrap();
        let loaded = load_history_file(&file_path);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0], rec1);
        assert_eq!(loaded[1], rec2);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_cap_eviction_drops_oldest_by_timestamp() {
        let temp_dir = std::env::temp_dir().join("iccery_test_quality_store_eviction");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let file_path = temp_dir.join("capped_history.json");

        // Generate 1005 records with disordered timestamps
        let mut records = Vec::new();
        for i in 0..1005 {
            // ts ranges from 1000 to 2004
            let ts = format!("2026-01-01T{:04}Z", i);
            records.push(sample_record(&format!("vr-{}", i), &ts, 1.0));
        }

        // Shuffle slightly so input is out of order
        records.swap(0, 500);

        write_history_file(&file_path, &records).unwrap();
        let loaded = load_history_file(&file_path);

        assert_eq!(loaded.len(), HISTORY_CAP); // 1000 records
        // Oldest 5 records (ts 0000..0004) should have been evicted
        assert_eq!(loaded[0].timestamp, "2026-01-01T0005Z");
        assert_eq!(loaded[loaded.len() - 1].timestamp, "2026-01-01T1004Z");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_to_csv_escaping_and_formatting() {
        let mut rec1 = sample_record("vr-1", "2026-09-05T12:00:00Z", 0.85);
        rec1.printer_name = "Canon \"Pro\" 1000, Tray 1".to_string(); // quotes + comma
        rec1.profile_name = "FineArt, Velvet".to_string();

        let csv = to_csv(&[rec1]);
        let lines: Vec<&str> = csv.split("\r\n").filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "id,timestamp,printer_name,profile_name,avg_de,max_de,rms_de,patch_count,status");
        assert!(lines[1].contains("\"Canon \"\"Pro\"\" 1000, Tray 1\""));
        assert!(lines[1].contains("\"FineArt, Velvet\""));
    }

    #[test]
    fn test_validate_csv_dest() {
        assert!(validate_csv_dest("   ").is_err());

        let p1 = validate_csv_dest("/tmp/history.csv").unwrap();
        assert_eq!(p1.extension().unwrap(), "csv");

        let p2 = validate_csv_dest("/tmp/history").unwrap();
        assert_eq!(p2.extension().unwrap(), "csv");
        assert_eq!(p2.to_string_lossy(), "/tmp/history.csv");
    }
}
