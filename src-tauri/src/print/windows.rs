use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::Graphics::Gdi::{
    CreateDCW, DeleteDC, GetDeviceCaps, SetICMMode, StretchDIBits,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HORZRES,
    ICM_OFF, LOGPIXELSX, LOGPIXELSY, SRCCOPY, VERTRES,
};
use windows::Win32::Graphics::Printing::{
    ClosePrinter, DocumentPropertiesW, EndDoc, EndPage, EnumPrintersW,
    OpenPrinterW, StartDocW, StartPage, DEVMODEW, DMICMMETHOD_NONE,
    DM_ICMMETHOD, DM_OUT_BUFFER, DOCINFOW, PRINTER_ENUM_CONNECTIONS,
    PRINTER_ENUM_LOCAL, PRINTER_INFO_2W, PRINTER_INFO_4W,
};

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Enumerate available printers on the system
pub fn get_printers() -> Result<Vec<String>, String> {
    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut bytes_needed = 0u32;
        let mut count = 0u32;

        // Query buffer size using Level 4 (fast local & network connections)
        let _ = EnumPrintersW(
            flags,
            PCWSTR::null(),
            4,
            None,
            0,
            &mut bytes_needed,
            &mut count,
        );

        if bytes_needed == 0 {
            // Fallback to Level 2
            let _ = EnumPrintersW(
                flags,
                PCWSTR::null(),
                2,
                None,
                0,
                &mut bytes_needed,
                &mut count,
            );

            if bytes_needed == 0 {
                return Ok(Vec::new());
            }

            let mut buffer = vec![0u8; bytes_needed as usize];
            let success = EnumPrintersW(
                flags,
                PCWSTR::null(),
                2,
                Some(buffer.as_mut_ptr()),
                bytes_needed,
                &mut bytes_needed,
                &mut count,
            );

            if !success.as_bool() {
                return Err("Failed to enumerate printers (Level 2)".to_string());
            }

            let p_info = buffer.as_ptr() as *const PRINTER_INFO_2W;
            let mut printers = Vec::new();
            for i in 0..count as usize {
                let info = *p_info.add(i);
                if !info.pPrinterName.is_null() {
                    let name = info.pPrinterName.to_string().map_err(|e| e.to_string())?;
                    printers.push(name);
                }
            }
            return Ok(printers);
        }

        let mut buffer = vec![0u8; bytes_needed as usize];
        let success = EnumPrintersW(
            flags,
            PCWSTR::null(),
            4,
            Some(buffer.as_mut_ptr()),
            bytes_needed,
            &mut bytes_needed,
            &mut count,
        );

        if !success.as_bool() {
            return Err("Failed to enumerate printers (Level 4)".to_string());
        }

        let p_info = buffer.as_ptr() as *const PRINTER_INFO_4W;
        let mut printers = Vec::new();
        for i in 0..count as usize {
            let info = *p_info.add(i);
            if !info.pPrinterName.is_null() {
                let name = info.pPrinterName.to_string().map_err(|e| e.to_string())?;
                printers.push(name);
            }
        }
        Ok(printers)
    }
}

/// Print target TIFF file to printer with GDI ICM bypass and DIB drawing
pub fn print_target(printer_name: &str, tiff_path: &str) -> Result<(), String> {
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
    let doc_name = format!("ICCery Target - {}", path.file_name().and_then(|n| n.to_str()).unwrap_or("Profiling Target"));
    let doc_name_wide = to_wide(&doc_name);

    unsafe {
        // Open printer handle
        let mut h_printer = HANDLE::default();
        let open_res = OpenPrinterW(PCWSTR(printer_wide.as_ptr()), &mut h_printer, None);
        if !open_res.as_bool() || h_printer.is_invalid() {
            return Err(format!("Failed to open printer '{}'", printer_name));
        }

        // Configure DEVMODE if possible
        let devmode_size = DocumentPropertiesW(
            HWND::default(),
            h_printer,
            PCWSTR(printer_wide.as_ptr()),
            None,
            None,
            0,
        );

        let mut devmode_buf = if devmode_size > 0 {
            let mut buf = vec![0u8; devmode_size as usize];
            let res = DocumentPropertiesW(
                HWND::default(),
                h_printer,
                PCWSTR(printer_wide.as_ptr()),
                Some(buf.as_mut_ptr() as *mut DEVMODEW),
                None,
                DM_OUT_BUFFER,
            );
            if res >= 0 {
                let p_devmode = buf.as_mut_ptr() as *mut DEVMODEW;
                // Attempt to explicitly disable driver ICM if supported in DEVMODE
                (*p_devmode).dmFields |= DM_ICMMETHOD;
                (*p_devmode).dmICMMethod = DMICMMETHOD_NONE as i32;
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
        let prev_icm = SetICMMode(hdc, ICM_OFF as i32);
        if prev_icm == 0 {
            // Note: Some printer drivers report 0 if ICM is unsupported or already off
        }

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

        // Query DC dimensions and DPI
        let dpi_x = GetDeviceCaps(hdc, LOGPIXELSX);
        let dpi_y = GetDeviceCaps(hdc, LOGPIXELSY);
        let page_width = GetDeviceCaps(hdc, HORZRES);
        let page_height = GetDeviceCaps(hdc, VERTRES);

        // Calculate destination dimensions assuming standard 300 DPI target
        let target_dpi = 300.0f64;
        let mut dest_width = ((img_width as f64 / target_dpi) * dpi_x as f64).round() as i32;
        let mut dest_height = ((img_height as f64 / target_dpi) * dpi_y as f64).round() as i32;

        // If target exceeds page bounds, scale proportionally to fit printable area
        if dest_width > page_width || dest_height > page_height {
            let scale_x = page_width as f64 / dest_width as f64;
            let scale_y = page_height as f64 / dest_height as f64;
            let scale = scale_x.min(scale_y);
            dest_width = (dest_width as f64 * scale).round() as i32;
            dest_height = (dest_height as f64 * scale).round() as i32;
        }

        let dest_x = (page_width - dest_width).max(0) / 2;
        let dest_y = (page_height - dest_height).max(0) / 2;

        // Build BITMAPINFO structure for top-down 24-bit DIB
        let mut bmi = BITMAPINFO {
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
            bmiColors: [windows::Win32::Graphics::Gdi::RGBQUAD::default()],
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
