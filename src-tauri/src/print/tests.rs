#[cfg(test)]
mod integration_tests {
    use crate::print::{
        PrintOptions, Printer, PrinterCapabilities, PrinterDevModeStore, PrinterPaperSize,
        PrinterTray,
    };
    use crate::print::unix::{build_lp_args, parse_lpstat_d, parse_lpstat_e, parse_lpstat_p, print_target};

    #[test]
    fn test_printer_model_json_serialization() {
        let printer = Printer {
            name: "Epson-Stylus-Pro-4900".to_string(),
            status: "Idle".to_string(),
            is_default: true,
        };

        let json = serde_json::to_string(&printer).expect("Failed to serialize printer");
        assert!(json.contains(r#""name":"Epson-Stylus-Pro-4900""#));
        assert!(json.contains(r#""status":"Idle""#));
        assert!(json.contains(r#""is_default":true"#));

        let deserialized: Printer = serde_json::from_str(&json).expect("Failed to deserialize printer");
        assert_eq!(deserialized, printer);
    }

    #[test]
    fn test_printer_capabilities_serialization() {
        let caps = PrinterCapabilities {
            trays: vec![
                PrinterTray {
                    id: 1,
                    name: "Auto Sheet Feeder".to_string(),
                },
                PrinterTray {
                    id: 2,
                    name: "Rear Manual Feed".to_string(),
                },
            ],
            paper_sizes: vec![
                PrinterPaperSize {
                    id: 9,
                    name: "A4 (210 x 297 mm)".to_string(),
                },
                PrinterPaperSize {
                    id: 1,
                    name: "Letter (8.5 x 11 in)".to_string(),
                },
            ],
            supports_orientation: true,
        };

        let json = serde_json::to_string(&caps).expect("Failed to serialize capabilities");
        assert!(json.contains("Auto Sheet Feeder"));
        assert!(json.contains("Rear Manual Feed"));
        assert!(json.contains("A4 (210 x 297 mm)"));

        let deserialized: PrinterCapabilities =
            serde_json::from_str(&json).expect("Failed to deserialize capabilities");
        assert_eq!(deserialized, caps);
    }

    #[test]
    fn test_print_options_serialization() {
        let opts = PrintOptions {
            paper_source: Some(2),
            orientation: Some("landscape".to_string()),
            paper_size: Some("A4".to_string()),
            ppd_uncorrected_passthrough: Some(false),
        };

        let json = serde_json::to_string(&opts).expect("Failed to serialize PrintOptions");
        let deserialized: PrintOptions =
            serde_json::from_str(&json).expect("Failed to deserialize PrintOptions");
        assert_eq!(deserialized.paper_source, Some(2));
        assert_eq!(deserialized.orientation.as_deref(), Some("landscape"));
        assert_eq!(deserialized.paper_size.as_deref(), Some("A4"));
    }

    #[test]
    fn test_devmode_store_concurrency() {
        let store = PrinterDevModeStore::new();
        assert!(store.get("Epson-P900").is_none());

        let fake_devmode = vec![1, 2, 3, 4, 5];
        store.set("Epson-P900", fake_devmode.clone());
        assert_eq!(store.get("Epson-P900"), Some(fake_devmode));
    }

    #[test]
    fn test_auto_scaler_proportional_fit_math() {
        // Page printable area: 4800 x 6800 device units
        let page_w = 4800f64;
        let page_h = 6800f64;

        // Image: 2400 x 3000 (aspect ratio 0.8)
        let img_w = 2400f64;
        let img_h = 3000f64;

        let scale_x = page_w / img_w; // 2.0
        let scale_y = page_h / img_h; // 2.2666
        let scale = scale_x.min(scale_y); // 2.0

        let dest_w = (img_w * scale).floor() as i32;
        let dest_h = (img_h * scale).floor() as i32;

        assert_eq!(dest_w, 4800);
        assert_eq!(dest_h, 6000);
        assert!(dest_w <= page_w as i32);
        assert!(dest_h <= page_h as i32);

        let dest_x = (page_w as i32 - dest_w) / 2;
        let dest_y = (page_h as i32 - dest_h) / 2;

        assert_eq!(dest_x, 0);
        assert_eq!(dest_y, 400); // Vertically centered
    }

    #[test]
    fn test_lpstat_e_multiline_and_whitespace_handling() {
        let sample = "  \n  Epson_SureColor_P900  \n\n  Canon_imagePROGRAF_PRO_1000 \n\n";
        let parsed = parse_lpstat_e(sample);
        assert_eq!(parsed, vec!["Epson_SureColor_P900", "Canon_imagePROGRAF_PRO_1000"]);
    }

    #[test]
    fn test_lpstat_p_various_printer_states() {
        let sample = "\
printer Canon_PRO-1000 is idle. enabled since Fri 12 Jun 2026\n\
printer Epson_P900 is printing. enabled since Sat 13 Jun 2026\n\
printer HP_Z9 disabled since Sun 14 Jun 2026 - offline\n\
printer DNP_DS620 stopped since Mon 15 Jun 2026 - out of ribbon\n\
printer Custom_Queue unknown state\n\
";
        let parsed = parse_lpstat_p(sample);
        assert_eq!(
            parsed,
            vec![
                ("Canon_PRO-1000".to_string(), "Idle".to_string()),
                ("Epson_P900".to_string(), "Printing".to_string()),
                ("HP_Z9".to_string(), "Stopped".to_string()),
                ("DNP_DS620".to_string(), "Stopped".to_string()),
                ("Custom_Queue".to_string(), "Unknown".to_string()),
            ]
        );
    }

    #[test]
    fn test_lpstat_d_with_trailing_spaces_and_tabs() {
        let sample = "system default destination:   Canon_PRO-1000\t  \n";
        assert_eq!(parse_lpstat_d(sample), Some("Canon_PRO-1000".to_string()));
    }

    #[test]
    fn test_multi_page_batch_spool_arguments() {
        let pages = vec!["target_01.tif", "target_02.tif", "target_03.tif"];
        let printer = "Epson_Stylus_SX420W";

        for (_idx, page) in pages.iter().enumerate() {
            let path = format!("/tmp/profiling_run/{}", page);
            let args_raw = build_lp_args(printer, &path, None);
            assert_eq!(args_raw[0], "-d");
            assert_eq!(args_raw[1], printer);
            assert_eq!(args_raw[2], "-t");
            assert_eq!(args_raw[3], format!("ICCery Target - {}", page));
            assert_eq!(args_raw[4], "-o");
            assert_eq!(args_raw[5], "raw");
            assert_eq!(args_raw[6], path);

            let opts = PrintOptions {
                ppd_uncorrected_passthrough: Some(true),
                ..Default::default()
            };
            let args_fallback = build_lp_args(printer, &path, Some(&opts));
            assert_eq!(args_fallback[4], "-o");
            assert_eq!(args_fallback[5], "ColorModel=Gray");
            assert_eq!(args_fallback[6], "-o");
            assert_eq!(args_fallback[7], "cm-calibration");
            assert_eq!(args_fallback[8], path);
        }
    }

    #[test]
    fn test_print_target_nonexistent_file_handling() {
        let res = print_target("Test_Printer", "/non/existent/path/target_page_99.tif", None);
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("Target TIFF file not found"));
    }
}

