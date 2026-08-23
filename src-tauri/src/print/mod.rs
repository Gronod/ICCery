#[cfg(windows)]
pub mod windows;

#[cfg(windows)]
pub use windows::*;

#[cfg(not(windows))]
pub fn get_printers() -> Result<Vec<String>, String> {
    Err("Direct native printer querying is only supported on Windows in this build.".to_string())
}

#[cfg(not(windows))]
pub fn print_target(printer_name: &str, tiff_path: &str) -> Result<(), String> {
    let _ = (printer_name, tiff_path);
    Err("Direct native raw printing is currently implemented for Windows. macOS/Linux CUPS support is planned for the next sub-task.".to_string())
}
