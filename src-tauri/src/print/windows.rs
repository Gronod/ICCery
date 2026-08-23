use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::Graphics::Gdi::{
    CreateDCW, DeleteDC, GetDeviceCaps, StretchDIBits,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DEVMODEW, DEVMODE_FIELD_FLAGS,
    DIB_RGB_COLORS, HDC, HORZRES, LOGPIXELSX, LOGPIXELSY, RGBQUAD, SRCCOPY, VERTRES,
};
use windows::Win32::Graphics::Printing::{
    ClosePrinter, DocumentPropertiesW, EnumPrintersW, OpenPrinterW,
    PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_1W, PRINTER_INFO_4W,
};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

use crate::print::{
    PrintOptions, Printer, PrinterCapabilities, PrinterDevModeStore, PrinterPaperSize, PrinterTray,
};

#[repr(C)]
struct DOCINFOW {
    cbSize: i32,
    lpszDocName: PCWSTR,
    lpszOutput: PCWSTR,
    lpszDatatype: PCWSTR,
    fwType: u32,
}

extern "system" {
    fn SetICMMode(hdc: HDC, mode: i32) -> i32;
    fn StartDocW(hdc: HDC, lpdi: *const DOCINFOW) -> i32;
    fn StartPage(hdc: HDC) -> i32;
    fn EndPage(hdc: HDC) -> i32;
    fn EndDoc(hdc: HDC) -> i32;
    fn DeviceCapabilitiesW(
        pdevicename: PCWSTR,
        pport: PCWSTR,
        fwcapability: u16,
        poutput: *mut u16,
        pdevmode: *const DEVMODEW,
    ) -> i32;
}

const ICM_OFF: i32 = 1;
const DM_IN_PROMPT: u32 = 4;
const DM_IN_BUFFER: u32 = 8;
const DM_OUT_BUFFER: u32 = 2;
const DM_ORIENTATION: u32 = 0x00000001;
const DM_DEFAULTSOURCE: u32 = 0x00000200;
const DM_ICMMETHOD: u32 = 0x00800000;
const DMICMMETHOD_NONE: u32 = 1;
const DMORIENT_PORTRAIT: i16 = 1;
const DMORIENT_LANDSCAPE: i16 = 2;

const DC_PAPERS: u16 = 2;
const DC_BINS: u16 = 6;
const DC_BINNAMES: u16 = 12;
const DC_PAPERNAMES: u16 = 16;
const IDOK: i32 = 1;

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn extract_null_terminated_string(wide_slice: &[u16]) -> String {
    let len = wide_slice.iter().position(|&c| c == 0).unwrap_or(wide_slice.len());
    String::from_utf16_lossy(&wide_slice[..len]).trim().to_string()
}

/// Enumerate available printers on the system
pub fn get_printers() -> Result<Vec<Printer>, String> {
    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut bytes_needed = 0u32;
        let mut count = 0u32;

        let _ = EnumPrintersW(
            flags,
            PCWSTR::null(),
            4,
            None,
            &mut bytes_needed,
            &mut count,
        );

        if bytes_needed == 0 {
            let _ = EnumPrintersW(
                flags,
                PCWSTR::null(),
                1,
                None,
                &mut bytes_needed,
                &mut count,
            );

            if bytes_needed == 0 {
                return Ok(Vec::new());
            }

            let mut buffer = vec![0u8; bytes_needed as usize];
            let res = EnumPrintersW(
                flags,
                PCWSTR::null(),
                1,
                Some(&mut buffer),
                &mut bytes_needed,
                &mut count,
            );

            if res.is_err() {
                return Err("Failed to enumerate printers (Level 1)".to_string());
            }

            let p_info = buffer.as_ptr() as *const PRINTER_INFO_1W;
            let mut printers = Vec::new();
            for i in 0..count as usize {
                let info = *p_info.add(i);
                if !info.pName.is_null() {
                    let name = info.pName.to_string().map_err(|e| e.to_string())?;
                    printers.push(Printer {
                        name,
                        status: "Ready".to_string(),
                        is_default: false,
                    });
                }
            }
            return Ok(printers);
        }

        let mut buffer = vec![0u8; bytes_needed as usize];
        let res = EnumPrintersW(
            flags,
            PCWSTR::null(),
            4,
            Some(&mut buffer),
            &mut bytes_needed,
            &mut count,
        );

        if res.is_err() {
            return Err("Failed to enumerate printers (Level 4)".to_string());
        }

        let p_info = buffer.as_ptr() as *const PRINTER_INFO_4W;
        let mut printers = Vec::new();
        for i in 0..count as usize {
            let info = *p_info.add(i);
            if !info.pPrinterName.is_null() {
                let name = info.pPrinterName.to_string().map_err(|e| e.to_string())?;
                printers.push(Printer {
                    name,
                    status: "Ready".to_string(),
                    is_default: false,
                });
            }
        }
        Ok(printers)
    }
}

/// Query hardware capabilities (paper trays and paper sizes) for a given printer
pub fn get_printer_capabilities(printer_name: &str) -> Result<PrinterCapabilities, String> {
    let printer_wide = to_wide(printer_name);

    unsafe {
        // Query trays (bins)
        let num_bins = DeviceCapabilitiesW(
            PCWSTR(printer_wide.as_ptr()),
            PCWSTR::null(),
            DC_BINS,
            std::ptr::null_mut(),
            std::ptr::null(),
        );

        let mut trays = Vec::new();
        if num_bins > 0 {
            let mut bin_ids = vec![0u16; num_bins as usize];
            let mut bin_names_raw = vec![0u16; num_bins as usize * 24];

            let res_ids = DeviceCapabilitiesW(
                PCWSTR(printer_wide.as_ptr()),
                PCWSTR::null(),
                DC_BINS,
                bin_ids.as_mut_ptr(),
                std::ptr::null(),
            );

            let res_names = DeviceCapabilitiesW(
                PCWSTR(printer_wide.as_ptr()),
                PCWSTR::null(),
                DC_BINNAMES,
                bin_names_raw.as_mut_ptr(),
                std::ptr::null(),
            );

            if res_ids > 0 && res_names > 0 {
                for i in 0..num_bins as usize {
                    let id = bin_ids[i];
                    let name_slice = &bin_names_raw[i * 24..(i + 1) * 24];
                    let name = extract_null_terminated_string(name_slice);
                    let display_name = if name.is_empty() {
                        format!("Tray {}", id)
                    } else {
                        name
                    };
                    trays.push(PrinterTray {
                        id,
                        name: display_name,
                    });
                }
            }
        }

        // Query paper sizes
        let num_papers = DeviceCapabilitiesW(
            PCWSTR(printer_wide.as_ptr()),
            PCWSTR::null(),
            DC_PAPERS,
            std::ptr::null_mut(),
            std::ptr::null(),
        );

        let mut paper_sizes = Vec::new();
        if num_papers > 0 {
            let mut paper_ids = vec![0u16; num_papers as usize];
            let mut paper_names_raw = vec![0u16; num_papers as usize * 64];

            let res_ids = DeviceCapabilitiesW(
                PCWSTR(printer_wide.as_ptr()),
                PCWSTR::null(),
                DC_PAPERS,
                paper_ids.as_mut_ptr(),
                std::ptr::null(),
            );

            let res_names = DeviceCapabilitiesW(
                PCWSTR(printer_wide.as_ptr()),
                PCWSTR::null(),
                DC_PAPERNAMES,
                paper_names_raw.as_mut_ptr(),
                std::ptr::null(),
            );

            if res_ids > 0 && res_names > 0 {
                for i in 0..num_papers as usize {
                    let id = paper_ids[i];
                    let name_slice = &paper_names_raw[i * 64..(i + 1) * 64];
                    let name = extract_null_terminated_string(name_slice);
                    let display_name = if name.is_empty() {
                        format!("Paper Size {}", id)
                    } else {
                        name
                    };
                    paper_sizes.push(PrinterPaperSize {
                        id,
                        name: display_name,
                    });
                }
            }
        }

        Ok(PrinterCapabilities {
            trays,
            paper_sizes,
            supports_orientation: true,
        })
    }
}

/// Open the native modal Printer Properties / Preferences dialog and retain DEVMODE changes
pub fn show_printer_properties(
    printer_name: &str,
    devmode_store: &PrinterDevModeStore,
) -> Result<(), String> {
    let printer_wide = to_wide(printer_name);

    unsafe {
        let mut h_printer = HANDLE::default();
        let open_res = OpenPrinterW(PCWSTR(printer_wide.as_ptr()), &mut h_printer, None);
        if open_res.is_err() || h_printer.is_invalid() {
            return Err(format!("Failed to open printer '{}'", printer_name));
        }

        let parent_hwnd = GetForegroundWindow();

        let devmode_size = DocumentPropertiesW(
            parent_hwnd,
            h_printer,
            PCWSTR(printer_wide.as_ptr()),
            None,
            None,
            0,
        );

        if devmode_size <= 0 {
            let _ = ClosePrinter(h_printer);
            return Err("Failed to query DEVMODE size for printer properties".to_string());
        }

        let mut in_buf = devmode_store
            .get(printer_name)
            .unwrap_or_else(|| vec![0u8; devmode_size as usize]);

        if in_buf.len() < devmode_size as usize {
            in_buf.resize(devmode_size as usize, 0);
        }

        // Populate initial DEVMODE if empty
        if in_buf.iter().all(|&b| b == 0) {
            let _ = DocumentPropertiesW(
                parent_hwnd,
                h_printer,
                PCWSTR(printer_wide.as_ptr()),
                Some(in_buf.as_mut_ptr() as *mut DEVMODEW),
                None,
                DM_OUT_BUFFER,
            );
        }

        let mut out_buf = vec![0u8; devmode_size as usize];

        let res = DocumentPropertiesW(
            parent_hwnd,
            h_printer,
            PCWSTR(printer_wide.as_ptr()),
            Some(out_buf.as_mut_ptr() as *mut DEVMODEW),
            Some(in_buf.as_ptr() as *const DEVMODEW),
            DM_IN_PROMPT | DM_IN_BUFFER | DM_OUT_BUFFER,
        );

        let _ = ClosePrinter(h_printer);

        if res == IDOK {
            devmode_store.set(printer_name, out_buf);
            Ok(())
        } else if res == 2 {
            // Cancelled by user
            Ok(())
        } else {
            Err("Printer properties dialog was dismissed or encountered an error".to_string())
        }
    }
}

/// Print target TIFF file to printer with GDI ICM bypass, DEVMODE overrides, and auto-fit scaling
pub fn print_target(
    printer_name: &str,
    tiff_path: &str,
    options: Option<&PrintOptions>,
    devmode_store: Option<&PrinterDevModeStore>,
) -> Result<(), String> {
    let path = Path::new(tiff_path);
    if !path.exists() {
        return Err(format!("Target TIFF file not found: {}", tiff_path));
    }

    // Load and convert the TIFF image
    let dyn_img = image::open(path).map_err(|e| format!("Failed to open TIFF image: {}", e))?;
    let rgb_img = dyn_img.to_rgb8();
    let img_width = rgb_img.width();
    let img_height = rgb_img.height();

    if img_width == 0 || img_height == 0 {
        return Err("Image has zero dimensions".to_string());
    }

    // Prepare 24-bit BGR DIB buffer with 4-byte row stride alignment
    let row_stride = ((img_width as usize * 3 + 3) / 4) * 4;
    let mut dib_bytes = vec![0u8; row_stride * img_height as usize];

    for y in 0..img_height as usize {
        for x in 0..img_width as usize {
            let pixel = rgb_img.get_pixel(x as u32, y as u32);
            let dst_idx = y * row_stride + x * 3;
            dib_bytes[dst_idx] = pixel[2];     // Blue
            dib_bytes[dst_idx + 1] = pixel[1]; // Green
            dib_bytes[dst_idx + 2] = pixel[0]; // Red
        }
    }

    let printer_wide = to_wide(printer_name);
    let doc_name = format!(
        "ICCery Target - {}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("Profiling Target")
    );
    let doc_name_wide = to_wide(&doc_name);

    unsafe {
        // Open printer handle
        let mut h_printer = HANDLE::default();
        let open_res = OpenPrinterW(PCWSTR(printer_wide.as_ptr()), &mut h_printer, None);
        if open_res.is_err() || h_printer.is_invalid() {
            return Err(format!("Failed to open printer '{}'", printer_name));
        }

        // Configure DEVMODE
        let devmode_size = DocumentPropertiesW(
            HWND::default(),
            h_printer,
            PCWSTR(printer_wide.as_ptr()),
            None,
            None,
            0,
        );

        let mut devmode_buf = if devmode_size > 0 {
            let mut buf = devmode_store
                .and_then(|s| s.get(printer_name))
                .unwrap_or_else(|| vec![0u8; devmode_size as usize]);

            if buf.len() < devmode_size as usize {
                buf.resize(devmode_size as usize, 0);
            }

            let p_devmode = buf.as_mut_ptr() as *mut DEVMODEW;
            let res = DocumentPropertiesW(
                HWND::default(),
                h_printer,
                PCWSTR(printer_wide.as_ptr()),
                Some(p_devmode),
                None,
                DM_OUT_BUFFER,
            );

            if res >= 0 {
                // Apply strict ICM bypass
                (*p_devmode).dmFields |= DEVMODE_FIELD_FLAGS(DM_ICMMETHOD);
                (*p_devmode).dmICMMethod = DMICMMETHOD_NONE;

                // Apply UI options if specified
                if let Some(opts) = options {
                    if let Some(tray_id) = opts.paper_source {
                        (*p_devmode).dmFields |= DEVMODE_FIELD_FLAGS(DM_DEFAULTSOURCE);
                        (*p_devmode).dmDefaultSource = tray_id as i16;
                    }

                    if let Some(ref orient) = opts.orientation {
                        (*p_devmode).dmFields |= DEVMODE_FIELD_FLAGS(DM_ORIENTATION);
                        if orient.eq_ignore_ascii_case("landscape") {
                            (*p_devmode).dmOrientation = DMORIENT_LANDSCAPE;
                        } else {
                            (*p_devmode).dmOrientation = DMORIENT_PORTRAIT;
                        }
                    }
                }

                Some(buf)
            } else {
                None
            }
        } else {
            None
        };

        let p_devmode_ptr = devmode_buf
            .as_mut()
            .map(|b| b.as_mut_ptr() as *const DEVMODEW);

        // Create printer Device Context (DC)
        let hdc = CreateDCW(
            PCWSTR::null(),
            PCWSTR(printer_wide.as_ptr()),
            PCWSTR::null(),
            p_devmode_ptr,
        );

        if hdc.is_invalid() {
            let _ = ClosePrinter(h_printer);
            return Err(format!("Failed to create Device Context for printer '{}'", printer_name));
        }

        // STRICT ICM BYPASS: Turn off Windows GDI Image Color Management
        let _ = SetICMMode(hdc, ICM_OFF);

        // Start Document
        let doc_info = DOCINFOW {
            cbSize: std::mem::size_of::<DOCINFOW>() as i32,
            lpszDocName: PCWSTR(doc_name_wide.as_ptr()),
            lpszOutput: PCWSTR::null(),
            lpszDatatype: PCWSTR::null(),
            fwType: 0,
        };

        let start_doc_res = StartDocW(hdc, &doc_info);
        if start_doc_res <= 0 {
            let _ = DeleteDC(hdc);
            let _ = ClosePrinter(h_printer);
            return Err("Failed to start print document (StartDocW)".to_string());
        }

        // Start Page
        let start_page_res = StartPage(hdc);
        if start_page_res <= 0 {
            let _ = EndDoc(hdc);
            let _ = DeleteDC(hdc);
            let _ = ClosePrinter(h_printer);
            return Err("Failed to start print page (StartPage)".to_string());
        }

        // Query printable device dimensions
        let dpi_x = GetDeviceCaps(hdc, LOGPIXELSX);
        let dpi_y = GetDeviceCaps(hdc, LOGPIXELSY);
        let page_width = GetDeviceCaps(hdc, HORZRES);
        let page_height = GetDeviceCaps(hdc, VERTRES);

        // AUTOMATIC BEHIND-THE-SCENES PAGE-FIT SCALER:
        // Proportionally scale the target TIFF to fill the available physical printable area
        let scale_x = page_width as f64 / img_width as f64;
        let scale_y = page_height as f64 / img_height as f64;
        let scale = scale_x.min(scale_y);

        let dest_width = (img_width as f64 * scale).floor() as i32;
        let dest_height = (img_height as f64 * scale).floor() as i32;

        let dest_x = (page_width - dest_width).max(0) / 2;
        let dest_y = (page_height - dest_height).max(0) / 2;

        // Build BITMAPINFO structure for top-down 24-bit DIB
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: img_width as i32,
                biHeight: -(img_height as i32), // Negative height denotes top-down DIB
                biPlanes: 1,
                biBitCount: 24,
                biCompression: BI_RGB.0,
                biSizeImage: dib_bytes.len() as u32,
                biXPelsPerMeter: ((dpi_x as f64 / 0.0254).round()) as i32,
                biYPelsPerMeter: ((dpi_y as f64 / 0.0254).round()) as i32,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD::default()],
        };

        // Draw unmanaged DIB to printer device context
        let lines_drawn = StretchDIBits(
            hdc,
            dest_x,
            dest_y,
            dest_width,
            dest_height,
            0,
            0,
            img_width as i32,
            img_height as i32,
            Some(dib_bytes.as_ptr() as *const c_void),
            &bmi,
            DIB_RGB_COLORS,
            SRCCOPY,
        );

        if lines_drawn <= 0 {
            let _ = EndPage(hdc);
            let _ = EndDoc(hdc);
            let _ = DeleteDC(hdc);
            let _ = ClosePrinter(h_printer);
            return Err("Failed to draw DIB bitmap to printer DC (StretchDIBits)".to_string());
        }

        // Finish Page and Document
        let _ = EndPage(hdc);
        let _ = EndDoc(hdc);
        let _ = DeleteDC(hdc);
        let _ = ClosePrinter(h_printer);

        Ok(())
    }
}

