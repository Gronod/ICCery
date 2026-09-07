//! Dark native window + WKWebView backing for macOS (#225).
//!
//! `backgroundColor` in `tauri.conf.json` paints the NSWindow, but WKWebView
//! still composites an opaque white layer until `drawsBackground` is disabled
//! and (on macOS 12+) `underPageBackgroundColor` is set. We do **not** set
//! `transparent: true` — that changes hit-testing and titlebar compositing.

/// Theme fallback already used in `index.html` (`var(--bg-card, #1a1a22)`).
pub const DARK_BG_U8: (u8, u8, u8, u8) = (0x1A, 0x1A, 0x22, 0xFF);

pub fn paint_dark_webview(window: &tauri::WebviewWindow) {
    let (r, g, b, a) = DARK_BG_U8;
    let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, a)));

    #[cfg(target_os = "macos")]
    {
        let _ = window.with_webview(|webview| unsafe {
            apply_native_dark_backing(&webview);
        });
    }
}

#[cfg(target_os = "macos")]
unsafe fn apply_native_dark_backing(webview: &tauri::webview::PlatformWebview) {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    use objc2_foundation::ns_string;

    let red = 26.0f64 / 255.0;
    let green = 26.0f64 / 255.0;
    let blue = 34.0f64 / 255.0;
    let alpha = 1.0f64;

    let Some(nscolor_cls) = AnyClass::get(c"NSColor") else {
        log::warn!("NSColor class missing; skipping dark window backing");
        return;
    };

    let color: *mut AnyObject = msg_send![
        nscolor_cls,
        colorWithSRGBRed: red,
        green: green,
        blue: blue,
        alpha: alpha
    ];

    let ns_window = webview.ns_window() as *mut AnyObject;
    if !ns_window.is_null() && !color.is_null() {
        let _: () = msg_send![ns_window, setBackgroundColor: color];
    }

    let wk = webview.inner() as *mut AnyObject;
    if wk.is_null() {
        log::warn!("WKWebView inner handle is null; cannot disable white backing");
        return;
    }

    // Private KVC key wry uses for transparency / backgroundColor on macOS.
    if let Some(nsnumber_cls) = AnyClass::get(c"NSNumber") {
        let no: *mut AnyObject = msg_send![nsnumber_cls, numberWithBool: false];
        if !no.is_null() {
            let _: () = msg_send![wk, setValue: no, forKey: ns_string!("drawsBackground")];
        }
    }

    // Public API on macOS 12+: covers overscroll / unpainted page.
    let setter = sel!(setUnderPageBackgroundColor:);
    let responds: bool = msg_send![wk, respondsToSelector: setter];
    if responds && !color.is_null() {
        let _: () = msg_send![wk, setUnderPageBackgroundColor: color];
    }

    log::info!("Applied dark WKWebView backing (#1A1A22)");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_bg_matches_theme_hex() {
        assert_eq!(DARK_BG_U8, (26, 26, 34, 255));
    }
}
