//! Window / webview lifecycle helpers for #225.
//!
//! Helper-process death (WKWebView Web Content / GPU) does not produce an
//! ICCery Crash Reporter dialog. We log unexpected window destruction so the
//! rotating `iccery.log` still has a timestamped breadcrumb.

use std::sync::atomic::{AtomicBool, Ordering};

static USER_CLOSE_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn mark_user_close_requested() {
    USER_CLOSE_REQUESTED.store(true, Ordering::SeqCst);
}

pub fn was_user_close_requested() -> bool {
    USER_CLOSE_REQUESTED.load(Ordering::SeqCst)
}

pub fn describe_window_destroyed(label: &str, user_close: bool) -> String {
    if user_close {
        format!("Window destroyed after close request: {label}")
    } else {
        format!(
            "Window destroyed unexpectedly: {label} (possible Web Content / GPU process death)"
        )
    }
}

pub fn on_window_destroyed(label: &str) {
    let user_close = was_user_close_requested();
    let msg = describe_window_destroyed(label, user_close);
    if user_close {
        log::info!("{msg}");
    } else {
        log::error!("{msg}");
    }
}

/// True when a `RunEvent` debug string looks like WKWebView / wry helper death.
pub fn is_web_content_termination_event(debug_text: &str) -> bool {
    let lower = debug_text.to_ascii_lowercase();
    lower.contains("web content process terminated")
        || lower.contains("webcontentprocessdidterminate")
        || (lower.contains("webview") && lower.contains("terminat"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_close_message() {
        let msg = describe_window_destroyed("main", true);
        assert!(msg.contains("main"));
        assert!(msg.contains("close request"));
        assert!(!msg.contains("unexpectedly"));
    }

    #[test]
    fn unexpected_destroy_message() {
        let msg = describe_window_destroyed("main", false);
        assert!(msg.contains("main"));
        assert!(msg.contains("unexpectedly"));
        assert!(msg.contains("Web Content"));
    }

    #[test]
    fn detects_wry_web_content_line() {
        assert!(is_web_content_termination_event(
            "web content process terminated"
        ));
        assert!(is_web_content_termination_event(
            "WKWebView WebContentProcessDidTerminate"
        ));
        assert!(!is_web_content_termination_event("Main window shown"));
        assert!(!is_web_content_termination_event("Ready"));
    }

    #[test]
    fn close_flag_roundtrip() {
        // Reset in case another test ran first in this process.
        USER_CLOSE_REQUESTED.store(false, Ordering::SeqCst);
        assert!(!was_user_close_requested());
        mark_user_close_requested();
        assert!(was_user_close_requested());
        USER_CLOSE_REQUESTED.store(false, Ordering::SeqCst);
    }
}
