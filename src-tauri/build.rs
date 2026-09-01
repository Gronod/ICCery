use std::path::Path;
use std::process::Command;

fn main() {
    let build_date = Command::new("date")
        .args(["+%B %d, %Y"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "August 2026".to_string());

    println!("cargo:rustc-env=BUILD_DATE={}", build_date);

    // Validate that ArgyllCMS sidecar binaries are staged before building
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let argyll_dir = Path::new(&manifest_dir).join("argyll");

    let platform_dir = match (target_os.as_str(), target_arch.as_str()) {
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        ("macos", "aarch64") => {
            if argyll_dir.join("macos-universal").join("instlist").exists() {
                "macos-universal"
            } else {
                "macos-aarch64"
            }
        },
        ("macos", "x86_64") => {
            if argyll_dir.join("macos-universal").join("instlist").exists() {
                "macos-universal"
            } else {
                "macos-x86_64"
            }
        },
        _ => "linux-x86_64",
    };

    let binary_name = if target_os == "windows" {
        "instlist.exe"
    } else {
        "instlist"
    };

    let sidecar_path = argyll_dir
        .join(platform_dir)
        .join(binary_name);

    if !sidecar_path.exists() {
        panic!(
            "\n=========================================================================\n\
             ArgyllCMS sidecars not found (missing: {})\n\
             Please run `npm run fetch-argyll` from the repository root before building.\n\
             =========================================================================\n",
            sidecar_path.display()
        );
    }

    tauri_build::build();
}
