use std::path::Path;
use std::fs;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum ColorSpace {
    Rgb,
    Cmyk,
    Lab,
    DeviceN(u32),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpectralRange {
    pub start_nm: f32,
    pub end_nm: f32,
    pub step_nm: f32,
    pub bands: Vec<f32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum FieldType {
    Id,
    DeviceCoord(usize), // index into device_coords
    LabL,
    LabA,
    LabB,
    XyzX,
    XyzY,
    XyzZ,
    Spectral(f32), // wavelength in nm
    Custom(String),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CgatsField {
    pub name: String,
    pub field_type: FieldType,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CgatsSample {
    pub sample_id: Option<String>,
    pub sample_loc: Option<String>,
    pub device_coords: Vec<f64>,
    pub lab: Option<[f64; 3]>,
    pub xyz: Option<[f64; 3]>,
    pub spectral: Option<Vec<f64>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CgatsDataset {
    pub file_type: String, // "CGATS.17", "CTI3", "ISO28178", "CSV"
    pub originator: Option<String>,
    pub created: Option<String>,
    pub descriptor: Option<String>,
    pub target_instrument: Option<String>,
    pub illuminant: Option<String>,
    pub observer: Option<String>,
    pub measurement_condition: Option<String>,
    pub color_rep: ColorSpace,
    pub fields: Vec<CgatsField>,
    pub samples: Vec<CgatsSample>,
    pub spectral_range: Option<SpectralRange>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DatasetSummary {
    pub patch_count: usize,
    pub color_space: String,
    pub has_spectral: bool,
    pub has_lab: bool,
    pub spectral_start: Option<f32>,
    pub spectral_end: Option<f32>,
    pub illuminant: Option<String>,
    pub sample_preview: Vec<CgatsSample>,
}

impl CgatsDataset {
    pub fn new() -> Self {
        CgatsDataset {
            file_type: "CTI3".to_string(),
            originator: None,
            created: None,
            descriptor: None,
            target_instrument: None,
            illuminant: None,
            observer: None,
            measurement_condition: None,
            color_rep: ColorSpace::Rgb,
            fields: Vec::new(),
            samples: Vec::new(),
            spectral_range: None,
        }
    }

    /// Generates a DatasetSummary for frontend inspection
    pub fn summary(&self) -> DatasetSummary {
        let cs = match self.color_rep {
            ColorSpace::Rgb => "RGB".to_string(),
            ColorSpace::Cmyk => "CMYK".to_string(),
            ColorSpace::Lab => "LAB".to_string(),
            ColorSpace::DeviceN(n) => format!("DeviceN({})", n),
        };
        DatasetSummary {
            patch_count: self.samples.len(),
            color_space: cs,
            has_spectral: self.spectral_range.is_some(),
            has_lab: self.samples.first().map(|s| s.lab.is_some()).unwrap_or(false),
            spectral_start: self.spectral_range.as_ref().map(|s| s.start_nm),
            spectral_end: self.spectral_range.as_ref().map(|s| s.end_nm),
            illuminant: self.illuminant.clone(),
            sample_preview: self.samples.iter().take(5).cloned().collect(),
        }
    }

    /// Exports the dataset to canonical Argyll `.ti3` format
    pub fn to_canonical_ti3(&self, output_path: &Path) -> Result<(), String> {
        // Validation: must have device coords, and either LAB or Spectral (or XYZ)
        if self.samples.is_empty() {
            return Err("Dataset is empty.".to_string());
        }

        let first = &self.samples[0];
        if first.device_coords.is_empty() {
            return Err("Dataset lacks device coordinates (RGB/CMYK).".to_string());
        }
        if first.lab.is_none() && first.xyz.is_none() && first.spectral.is_none() {
            return Err("Dataset lacks required measurement data (L*a*b*, XYZ, or spectral) for profiling.".to_string());
        }

        let mut out = String::new();
        out.push_str("CTI3\n");
        
        if let Some(desc) = &self.descriptor {
            out.push_str(&format!("DESCRIPTOR \"{}\"\n", desc));
        } else {
            out.push_str("DESCRIPTOR \"ICCery Imported Dataset\"\n");
        }
        
        if let Some(orig) = &self.originator {
            out.push_str(&format!("ORIGINATOR \"{}\"\n", orig));
        }
        if let Some(inst) = &self.target_instrument {
            out.push_str(&format!("TARGET_INSTRUMENT \"{}\"\n", inst));
        }

        let device_class = match self.color_rep {
            ColorSpace::Rgb => "DISPLAY",
            ColorSpace::Cmyk => "OUTPUT",
            ColorSpace::DeviceN(_) => "OUTPUT",
            ColorSpace::Lab => "OUTPUT",
        };
        out.push_str(&format!("DEVICE_CLASS \"{}\"\n", device_class));

        let color_rep_str = match self.color_rep {
            ColorSpace::Rgb => "RGB",
            ColorSpace::Cmyk => "CMYK",
            ColorSpace::Lab => "LAB",
            ColorSpace::DeviceN(n) => return Err(format!("DeviceN({}) not supported for basic ti3 export", n)),
        };
        out.push_str(&format!("COLOR_REP \"{}\"\n", color_rep_str));

        if let Some(sr) = &self.spectral_range {
            out.push_str(&format!("SPECTRAL_BANDS \"{}\"\n", sr.bands.len()));
            out.push_str(&format!("SPECTRAL_START_NM \"{}\"\n", sr.start_nm));
            out.push_str(&format!("SPECTRAL_END_NM \"{}\"\n", sr.end_nm));
        }

        // Define fields for BEGIN_DATA_FORMAT
        let mut format_fields = vec!["SAMPLE_ID".to_string()];
        
        // Always try to include SAMPLE_LOC
        if self.samples.iter().any(|s| s.sample_loc.is_some()) {
            format_fields.push("SAMPLE_LOC".to_string());
        }

        match self.color_rep {
            ColorSpace::Rgb => {
                format_fields.push("RGB_R".to_string());
                format_fields.push("RGB_G".to_string());
                format_fields.push("RGB_B".to_string());
            }
            ColorSpace::Cmyk => {
                format_fields.push("CMYK_C".to_string());
                format_fields.push("CMYK_M".to_string());
                format_fields.push("CMYK_Y".to_string());
                format_fields.push("CMYK_K".to_string());
            }
            _ => {}
        }

        if first.lab.is_some() {
            format_fields.push("LAB_L".to_string());
            format_fields.push("LAB_A".to_string());
            format_fields.push("LAB_B".to_string());
        } else if first.xyz.is_some() {
            format_fields.push("XYZ_X".to_string());
            format_fields.push("XYZ_Y".to_string());
            format_fields.push("XYZ_Z".to_string());
        }

        if let Some(sr) = &self.spectral_range {
            for nm in &sr.bands {
                format_fields.push(format!("SPEC_{}", nm));
            }
        }

        out.push_str(&format!("NUMBER_OF_FIELDS {}\n", format_fields.len()));
        out.push_str("BEGIN_DATA_FORMAT\n");
        out.push_str(&format_fields.join(" "));
        out.push_str("\nEND_DATA_FORMAT\n\n");

        out.push_str(&format!("NUMBER_OF_SETS {}\n", self.samples.len()));
        out.push_str("BEGIN_DATA\n");

        // Write rows
        let mut row_idx = 1;
        for sample in &self.samples {
            let mut row_data = Vec::new();
            
            // ID
            let id = sample.sample_id.clone().unwrap_or_else(|| row_idx.to_string());
            // Argyll does not tolerate spaces in values unless quoted, and quotes are messy.
            let safe_id = id.replace(" ", "_");
            row_data.push(safe_id);

            // LOC
            if format_fields.contains(&"SAMPLE_LOC".to_string()) {
                let loc = sample.sample_loc.clone().unwrap_or_else(|| format!("A{}", row_idx));
                let safe_loc = loc.replace(" ", "_");
                row_data.push(safe_loc);
            }

            // Device coords (scale 0-1 or 0-255 to 0-100 logic handled upstream in parser)
            for val in &sample.device_coords {
                row_data.push(format!("{:.4}", val));
            }

            // Colorimetry
            if let Some(lab) = sample.lab {
                row_data.push(format!("{:.4}", lab[0]));
                row_data.push(format!("{:.4}", lab[1]));
                row_data.push(format!("{:.4}", lab[2]));
            } else if let Some(xyz) = sample.xyz {
                row_data.push(format!("{:.4}", xyz[0]));
                row_data.push(format!("{:.4}", xyz[1]));
                row_data.push(format!("{:.4}", xyz[2]));
            }

            // Spectral
            if let Some(spec) = &sample.spectral {
                for val in spec {
                    row_data.push(format!("{:.5}", val));
                }
            }

            out.push_str(&row_data.join(" "));
            out.push_str("\n");
            row_idx += 1;
        }

        out.push_str("END_DATA\n");

        fs::write(output_path, out).map_err(|e| format!("Failed to write ti3: {}", e))
    }

    /// Parses a dataset from file (currently supports Argyll .ti3 format)
    pub fn parse(path: &Path) -> Result<Self, String> {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let lines: Vec<&str> = content.lines().collect();

        if lines.is_empty() {
            return Err("File is empty".into());
        }

        let mut dataset = CgatsDataset::new();
        let mut in_data_format = false;
        let mut in_data = false;
        let mut format_keys = Vec::new();

        for line in lines.iter() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            if in_data_format {
                if line == "END_DATA_FORMAT" {
                    in_data_format = false;
                    continue;
                }
                for key in line.split_whitespace() {
                    format_keys.push(key.to_string());
                }
                continue;
            }

            if in_data {
                if line == "END_DATA" {
                    in_data = false;
                    continue;
                }
                // parse row based on format_keys
                let vals: Vec<&str> = line.split_whitespace().collect();
                if vals.len() < format_keys.len() {
                    continue; // Skip malformed rows
                }

                let mut sample = CgatsSample {
                    sample_id: None,
                    sample_loc: None,
                    device_coords: Vec::new(),
                    lab: None,
                    xyz: None,
                    spectral: None,
                };

                let mut lab_tmp = [0.0; 3];
                let mut lab_set = [false; 3];
                let mut xyz_tmp = [0.0; 3];
                let mut xyz_set = [false; 3];
                let mut spec_tmp = Vec::new();

                for (i, key) in format_keys.iter().enumerate() {
                    let v = vals[i];
                    match key.as_str() {
                        "SAMPLE_ID" | "SAMPLE_NAME" | "SampleID" => sample.sample_id = Some(v.to_string()),
                        "SAMPLE_LOC" => sample.sample_loc = Some(v.to_string()),
                        "RGB_R" | "RGB_G" | "RGB_B" | "CMYK_C" | "CMYK_M" | "CMYK_Y" | "CMYK_K" => {
                            if let Ok(num) = v.parse::<f64>() {
                                sample.device_coords.push(num);
                            }
                        }
                        "LAB_L" | "L*" => { if let Ok(num) = v.parse::<f64>() { lab_tmp[0] = num; lab_set[0] = true; } }
                        "LAB_A" | "a*" => { if let Ok(num) = v.parse::<f64>() { lab_tmp[1] = num; lab_set[1] = true; } }
                        "LAB_B" | "b*" => { if let Ok(num) = v.parse::<f64>() { lab_tmp[2] = num; lab_set[2] = true; } }
                        "XYZ_X" => { if let Ok(num) = v.parse::<f64>() { xyz_tmp[0] = num; xyz_set[0] = true; } }
                        "XYZ_Y" => { if let Ok(num) = v.parse::<f64>() { xyz_tmp[1] = num; xyz_set[1] = true; } }
                        "XYZ_Z" => { if let Ok(num) = v.parse::<f64>() { xyz_tmp[2] = num; xyz_set[2] = true; } }
                        k if k.starts_with("SPEC_") || k.starts_with("SPECTRAL_") || k.starts_with("NM_") => {
                            if let Ok(num) = v.parse::<f64>() {
                                spec_tmp.push(num);
                            }
                        }
                        _ => {}
                    }
                }

                if lab_set[0] && lab_set[1] && lab_set[2] {
                    sample.lab = Some(lab_tmp);
                }
                if xyz_set[0] && xyz_set[1] && xyz_set[2] {
                    sample.xyz = Some(xyz_tmp);
                }
                if !spec_tmp.is_empty() {
                    sample.spectral = Some(spec_tmp);
                }

                dataset.samples.push(sample);
                continue;
            }

            if line == "BEGIN_DATA_FORMAT" {
                in_data_format = true;
                continue;
            }
            if line == "BEGIN_DATA" {
                in_data = true;
                continue;
            }

            // Simple Key-Value header parse
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.is_empty() { continue; }
            let key = parts[0];
            let val = if parts.len() > 1 { line[key.len()..].trim().trim_matches('"') } else { "" };

            match key {
                "COLOR_REP" => {
                    dataset.color_rep = match val {
                        "RGB" => ColorSpace::Rgb,
                        "CMYK" => ColorSpace::Cmyk,
                        "LAB" => ColorSpace::Lab,
                        _ => ColorSpace::Rgb, // fallback
                    };
                }
                "DESCRIPTOR" => dataset.descriptor = Some(val.to_string()),
                "ORIGINATOR" => dataset.originator = Some(val.to_string()),
                "ILLUMINATION_NAME" => dataset.illuminant = Some(val.to_string()),
                "OBSERVER_ANGLE" => dataset.observer = Some(val.to_string()),
                "TARGET_INSTRUMENT" => dataset.target_instrument = Some(val.to_string()),
                _ => {}
            }
        }

        // Validate
        if dataset.samples.is_empty() {
            return Err("No samples found in dataset".into());
        }

        // Normalise device coords if they appear to be 0-255 scaling
        // Argyll requires 0.0 - 100.0
        let has_large_val = dataset.samples.iter().any(|s| s.device_coords.iter().any(|&v| v > 105.0));
        if has_large_val {
            for sample in &mut dataset.samples {
                for coord in &mut sample.device_coords {
                    *coord = (*coord / 255.0) * 100.0;
                }
            }
        }

        Ok(dataset)
    }
}
