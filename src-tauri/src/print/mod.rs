use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Printer {
    pub name: String,
    pub status: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrinterTray {
    pub id: u16,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrinterPaperSize {
    pub id: u16,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrinterMediaType {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrinterCapabilities {
    pub trays: Vec<PrinterTray>,
    pub paper_sizes: Vec<PrinterPaperSize>,
    #[serde(default)]
    pub media_types: Vec<PrinterMediaType>,
    pub supports_orientation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PrintOptions {
    pub paper_source: Option<u16>,
    pub orientation: Option<String>,
    pub paper_size: Option<String>,
    pub media_type: Option<String>,
    pub ppd_uncorrected_passthrough: Option<bool>,
    /// Optional CUPS option string ("name=value name=value ...") captured from
    /// the native macOS print panel. On macOS these are appended to the `lp`
    /// invocation as additional `-o name=value` arguments, taking precedence
    /// over auto-detected defaults. On other platforms this field is ignored.
    #[serde(default)]
    pub cups_options: Option<String>,
}

#[derive(Clone, Default)]
#[allow(dead_code)]
pub struct PrinterDevModeStore {
    pub devmodes: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

#[allow(dead_code)]
impl PrinterDevModeStore {
    pub fn new() -> Self {
        Self {
            devmodes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn get(&self, printer_name: &str) -> Option<Vec<u8>> {
        let map = self.devmodes.lock().ok()?;
        map.get(printer_name).cloned()
    }

    pub fn set(&self, printer_name: &str, devmode: Vec<u8>) {
        if let Ok(mut map) = self.devmodes.lock() {
            map.insert(printer_name.to_string(), devmode);
        }
    }
}

#[cfg(windows)]
pub mod windows;

#[cfg(any(target_os = "macos", test))]
pub mod macos;

#[cfg(any(unix, test))]
pub mod unix;

#[cfg(test)]
mod tests;

