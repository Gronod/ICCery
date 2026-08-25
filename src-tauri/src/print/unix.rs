#![allow(dead_code)]

use std::path::Path;
use crate::print::{
    PrintOptions, Printer, PrinterCapabilities, PrinterPaperSize, PrinterTray,
};

/// Parse `lpstat -e` output into a list of printer destination names.
pub fn parse_lpstat_e(output: &str) -> Vec<String> {
    output
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Parse `lpstat -d` output to determine the default system printer destination.
pub fn parse_lpstat_d(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("system default destination:") {
            let dest = rest.trim();
            if !dest.is_empty() {
                return Some(dest.to_string());
            }
        }
    }
    None
}

/// Parse `lpstat -p` output to extract printer names and status indicators.
pub fn parse_lpstat_p(output: &str) -> Vec<(String, String)> {
    let mut results = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("printer ") {
            let mut parts = rest.split_whitespace();
            if let Some(name) = parts.next() {
                let name = name.to_string();
                let lower = rest.to_lowercase();
                let status = if lower.contains("is idle") || lower.contains("idle") {
                    "Idle".to_string()
                } else if lower.contains("is printing") || lower.contains("now printing") || lower.contains("printing") {
                    "Printing".to_string()
                } else if lower.contains("disabled") || lower.contains("stopped") {
                    "Stopped".to_string()
                } else {
                    "Unknown".to_string()
                };
                results.push((name, status));
            }
        }
    }
    results
}

/// Merge printer lists from `lpstat -e`, `lpstat -p`, and `lpstat -d`.
pub fn merge_printer_info(
    destinations: &[String],
    statuses: &[(String, String)],
    default_dest: Option<&str>,
) -> Vec<Printer> {
    use std::collections::HashMap;

    let status_map: HashMap<&str, &str> = statuses
        .iter()
        .map(|(name, status)| (name.as_str(), status.as_str()))
        .collect();

    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    for name in destinations {
        if seen.insert(name.clone()) {
            let status = status_map.get(name.as_str()).copied().unwrap_or("Idle");
            let is_default = default_dest.map_or(false, |d| d == name);
            result.push(Printer {
                name: name.clone(),
                status: status.to_string(),
                is_default,
            });
        }
    }

    for (name, status) in statuses {
        if seen.insert(name.clone()) {
            let is_default = default_dest.map_or(false, |d| d == name);
            result.push(Printer {
                name: name.clone(),
                status: status.clone(),
                is_default,
            });
        }
    }

    result
}

/// Query available CUPS printers, connection statuses, and default destination.
pub fn get_printers() -> Result<Vec<Printer>, String> {
    let e_output = std::process::Command::new("lpstat")
        .arg("-e")
        .output();
    let destinations = match e_output {
        Ok(out) if out.status.success() => {
            parse_lpstat_e(&String::from_utf8_lossy(&out.stdout))
        }
        _ => Vec::new(),
    };

    let p_output = std::process::Command::new("lpstat")
        .arg("-p")
        .output();
    let statuses = match p_output {
        Ok(out) => {
            parse_lpstat_p(&String::from_utf8_lossy(&out.stdout))
        }
        Err(e) => {
            if destinations.is_empty() {
                return Err(format!("Failed to execute 'lpstat': {}", e));
            }
            Vec::new()
        }
    };

    let d_output = std::process::Command::new("lpstat")
        .arg("-d")
        .output();
    let default_dest = match d_output {
        Ok(out) => parse_lpstat_d(&String::from_utf8_lossy(&out.stdout)),
        _ => None,
    };

    Ok(merge_printer_info(&destinations, &statuses, default_dest.as_deref()))
}

/// Parse `lpoptions -p <printer> -l` output into trays and paper sizes.
pub fn parse_lpoptions_l(output: &str) -> (Vec<PrinterTray>, Vec<PrinterPaperSize>) {
    let mut trays = Vec::new();
    let mut paper_sizes = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some((key_part, values_part)) = trimmed.split_once(':') {
            let key_name = key_part.split('/').next().unwrap_or("").trim();
            let values = values_part.split_whitespace();

            if key_name.eq_ignore_ascii_case("InputSlot") || key_name.eq_ignore_ascii_case("MediaSource") {
                for (idx, val) in values.enumerate() {
                    let clean_val = val.trim_start_matches('*');
                    trays.push(PrinterTray {
                        id: (idx + 1) as u16,
                        name: clean_val.to_string(),
                    });
                }
            } else if key_name.eq_ignore_ascii_case("PageSize") || key_name.eq_ignore_ascii_case("MediaSize") {
                for (idx, val) in values.enumerate() {
                    let clean_val = val.trim_start_matches('*');
                    paper_sizes.push(PrinterPaperSize {
                        id: (idx + 1) as u16,
                        name: clean_val.to_string(),
                    });
                }
            }
        }
    }

    (trays, paper_sizes)
}

/// Query CUPS printer capabilities via `lpoptions -p <printer> -l`.
pub fn get_printer_capabilities(printer_name: &str) -> Result<PrinterCapabilities, String> {
    let output = std::process::Command::new("lpoptions")
        .args(["-p", printer_name, "-l"])
        .output();

    let (trays, paper_sizes) = match output {
        Ok(out) if out.status.success() => {
            parse_lpoptions_l(&String::from_utf8_lossy(&out.stdout))
        }
        _ => (Vec::new(), Vec::new()),
    };

    Ok(PrinterCapabilities {
        trays,
        paper_sizes,
        supports_orientation: true,
    })
}

/// Construct `lp` command line arguments for target printing with options.
pub fn build_lp_args(
    printer_name: &str,
    tiff_path: &str,
    options: Option<&PrintOptions>,
) -> Vec<String> {
    let path = Path::new(tiff_path);
    let title = format!(
        "ICCery Target - {}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("Profiling Target")
    );

    let mut args = vec![
        "-d".to_string(),
        printer_name.to_string(),
        "-t".to_string(),
        title,
    ];

    let ppd_fallback = options
        .and_then(|o| o.ppd_uncorrected_passthrough)
        .unwrap_or(false);

    if ppd_fallback {
        args.push("-o".to_string());
        args.push("ColorModel=Gray".to_string());
        args.push("-o".to_string());
        args.push("cm-calibration".to_string());
    } else {
        args.push("-o".to_string());
        args.push("raw".to_string());
    }

    if let Some(opts) = options {
        if let Some(ref orient) = opts.orientation {
            args.push("-o".to_string());
            if orient.eq_ignore_ascii_case("landscape") {
                args.push("orientation-requested=4".to_string());
            } else {
                args.push("orientation-requested=3".to_string());
            }
        }

        if let Some(ref page_size) = opts.paper_size {
            if !page_size.trim().is_empty() {
                args.push("-o".to_string());
                args.push(format!("PageSize={}", page_size.trim()));
            }
        }
    }

    args.push(tiff_path.to_string());
    args
}

/// Spool target TIFF to CUPS printer bypassing ColorSync and PPD color management.
pub fn print_target(
    printer_name: &str,
    tiff_path: &str,
    options: Option<&PrintOptions>,
) -> Result<(), String> {
    let path = Path::new(tiff_path);
    if !path.exists() {
        return Err(format!("Target TIFF file not found: {}", tiff_path));
    }

    let args = build_lp_args(printer_name, tiff_path, options);

    let output = std::process::Command::new("lp")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to execute 'lp' command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exited with status code {}", output.status.code().unwrap_or(-1))
        };
        return Err(format!("CUPS print job failed: {}", msg));
    }

    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_lpstat_e() {
        let sample = "Epson-Stylus-SX420W\nHP_Officejet_Pro_8600\n\n";
        let parsed = parse_lpstat_e(sample);
        assert_eq!(parsed, vec!["Epson-Stylus-SX420W", "HP_Officejet_Pro_8600"]);
    }

    #[test]
    fn test_parse_lpstat_d() {
        let sample_valid = "system default destination: Epson-Stylus-SX420W\n";
        assert_eq!(
            parse_lpstat_d(sample_valid),
            Some("Epson-Stylus-SX420W".to_string())
        );

        let sample_none = "no system default destination\n";
        assert_eq!(parse_lpstat_d(sample_none), None);

        let sample_empty = "";
        assert_eq!(parse_lpstat_d(sample_empty), None);
    }

    #[test]
    fn test_parse_lpstat_p() {
        let sample = "\
printer Epson-Stylus-SX420W is idle.  enabled since Thu 28 May 2026 12:52:43 BST\n\
printer HP_LaserJet now printing HP_LaserJet-42.  enabled since ...\n\
printer Zebra_Label disabled since Wed 10 Jun 2026 - reason: out of ribbon\n\
";
        let parsed = parse_lpstat_p(sample);
        assert_eq!(
            parsed,
            vec![
                ("Epson-Stylus-SX420W".to_string(), "Idle".to_string()),
                ("HP_LaserJet".to_string(), "Printing".to_string()),
                ("Zebra_Label".to_string(), "Stopped".to_string()),
            ]
        );
    }

    #[test]
    fn test_merge_printer_info() {
        let destinations = vec![
            "Epson-Stylus-SX420W".to_string(),
            "HP_LaserJet".to_string(),
            "Virtual_PDF".to_string(),
        ];
        let statuses = vec![
            ("Epson-Stylus-SX420W".to_string(), "Idle".to_string()),
            ("HP_LaserJet".to_string(), "Printing".to_string()),
            ("Zebra_Label".to_string(), "Stopped".to_string()),
        ];
        let default_dest = Some("Epson-Stylus-SX420W");

        let merged = merge_printer_info(&destinations, &statuses, default_dest);
        assert_eq!(merged.len(), 4);

        assert_eq!(
            merged[0],
            Printer {
                name: "Epson-Stylus-SX420W".to_string(),
                status: "Idle".to_string(),
                is_default: true,
            }
        );
        assert_eq!(
            merged[1],
            Printer {
                name: "HP_LaserJet".to_string(),
                status: "Printing".to_string(),
                is_default: false,
            }
        );
        assert_eq!(
            merged[2],
            Printer {
                name: "Virtual_PDF".to_string(),
                status: "Idle".to_string(),
                is_default: false,
            }
        );
        assert_eq!(
            merged[3],
            Printer {
                name: "Zebra_Label".to_string(),
                status: "Stopped".to_string(),
                is_default: false,
            }
        );
    }

    #[test]
    fn test_parse_lpoptions_l() {
        let sample = "\
PageSize/Media Size: *A4 Letter Legal A3\n\
InputSlot/Media Source: *Auto Upper Lower Rear Manual\n\
Duplex/2-Sided Printing: *None DuplexNoTumble DuplexTumble\n\
";
        let (trays, paper_sizes) = parse_lpoptions_l(sample);
        assert_eq!(trays.len(), 5);
        assert_eq!(trays[0].name, "Auto");
        assert_eq!(trays[1].name, "Upper");
        assert_eq!(trays[4].name, "Manual");

        assert_eq!(paper_sizes.len(), 4);
        assert_eq!(paper_sizes[0].name, "A4");
        assert_eq!(paper_sizes[1].name, "Letter");
    }

    #[test]
    fn test_build_lp_args_raw() {
        let args = build_lp_args("Epson-Stylus-SX420W", "/tmp/target.tif", None);
        assert_eq!(
            args,
            vec![
                "-d",
                "Epson-Stylus-SX420W",
                "-t",
                "ICCery Target - target.tif",
                "-o",
                "raw",
                "/tmp/target.tif"
            ]
        );
    }

    #[test]
    fn test_build_lp_args_ppd_fallback() {
        let opts = PrintOptions {
            ppd_uncorrected_passthrough: Some(true),
            ..Default::default()
        };
        let args = build_lp_args("Epson-Stylus-SX420W", "/tmp/target.tif", Some(&opts));
        assert_eq!(
            args,
            vec![
                "-d",
                "Epson-Stylus-SX420W",
                "-t",
                "ICCery Target - target.tif",
                "-o",
                "ColorModel=Gray",
                "-o",
                "cm-calibration",
                "/tmp/target.tif"
            ]
        );
    }

    #[test]
    fn test_build_lp_args_with_orientation_and_size() {
        let opts = PrintOptions {
            orientation: Some("landscape".to_string()),
            paper_size: Some("A4".to_string()),
            ppd_uncorrected_passthrough: Some(false),
            ..Default::default()
        };
        let args = build_lp_args("Epson-Stylus-SX420W", "/tmp/target.tif", Some(&opts));
        assert_eq!(
            args,
            vec![
                "-d",
                "Epson-Stylus-SX420W",
                "-t",
                "ICCery Target - target.tif",
                "-o",
                "raw",
                "-o",
                "orientation-requested=4",
                "-o",
                "PageSize=A4",
                "/tmp/target.tif"
            ]
        );
    }

    #[test]
    fn test_print_target_file_not_found() {
        let res = print_target("Epson-Stylus-SX420W", "/non/existent/target.tif", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("not found"));
    }
}
