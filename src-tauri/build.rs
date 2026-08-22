use std::process::Command;

fn main() {
    let build_date = Command::new("date")
        .args(["+%B %d, %Y"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "August 2026".to_string());

    println!("cargo:rustc-env=BUILD_DATE={}", build_date);
    tauri_build::build();
}
