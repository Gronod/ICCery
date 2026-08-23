#[cfg(test)]
mod integration_tests {
    use crate::print::Printer;
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
            let args_raw = build_lp_args(printer, &path, false);
            assert_eq!(args_raw[0], "-d");
            assert_eq!(args_raw[1], printer);
            assert_eq!(args_raw[2], "-t");
            assert_eq!(args_raw[3], format!("ICCery Target - {}", page));
            assert_eq!(args_raw[4], "-o");
            assert_eq!(args_raw[5], "raw");
            assert_eq!(args_raw[6], path);

            let args_fallback = build_lp_args(printer, &path, true);
            assert_eq!(args_fallback[4], "-o");
            assert_eq!(args_fallback[5], "ColorModel=Gray");
            assert_eq!(args_fallback[6], "-o");
            assert_eq!(args_fallback[7], "cm-calibration");
            assert_eq!(args_fallback[8], path);
        }
    }

    #[test]
    fn test_print_target_nonexistent_file_handling() {
        let res = print_target("Test_Printer", "/non/existent/path/target_page_99.tif", false);
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("Target TIFF file not found"));
    }
}
